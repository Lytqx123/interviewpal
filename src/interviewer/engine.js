// 面试引擎：管理面试会话状态机，驱动开场白生成与动态追问。
// LLM 优先，规则兜底（与 parser 一致的双路径模式）。
// 面试官"失忆"（方案书 §4.2）：每次 createSession 独立，不跨会话记忆。
//
// R2（重构计划）：读取 R1 预分析作战地图 → 生成 baseline plan →
// 执行中注入实时信号（difficulty/direction/depth/fluency）→ 动态决策
// （继续/追问/换线/结束），并输出 executionTrace。
// 状态机：PLANNED → RUNNING → ADJUSTING → CLOSED。
import crypto from 'node:crypto';
import { parseJsonFromText } from '../llm/provider.js';
import { buildOpeningPrompt, buildFollowupPrompt } from './prompts.js';
import { openingByRules, closingByRules, followupByRules, nextQuestionByRules } from './rules.js';
import { ingestSignal } from './signals.js';
import { roundMetaFromPlan } from './rounds.js';

export { ingestSignal };

// 每个轮次把 L4 主线按与 L7 定位的相关度重新排序，让一面先问简历/技术、二面先问业务/匹配、三面先问动机/价值。
const ROUND_MAINLINE_KEYWORDS = {
  round1: ['项目', '简历', '经历', '技术', '原理', '量化', '真实', '深度'],
  round2: ['业务', '职责', '匹配', '方案', '设计', '场景', '前沿', '公司', '理解'],
  round3: ['动机', '规划', '价值', '抗压', '稳定', '行为', '冲突', '合作', '综合'],
};

function scoreMainline(m, keywords) {
  const text = `${m.focus ?? ''} ${m.intent ?? ''} ${m.depthTarget ?? ''}`;
  return keywords.reduce((n, kw) => n + (text.includes(kw) ? 1 : 0), 0);
}

// 二面从 L7（业务面）与 roundContext（职位职责/公司业务/前沿话题）生成差异化题目。
function pickBaselineQuestion(m, roundKey, roundContext) {
  const base = m.keyQuestions?.[0] ?? `${m.focus ?? '必问主线'}：请展开讲讲。`;
  if (roundKey !== 'round2' || !roundContext) return base;
  const resp = roundContext.responsibilities?.[0];
  const biz = roundContext.companyBusiness?.[0];
  const frontier = roundContext.frontierTopics?.[0];
  const businessScore = scoreMainline(m, ROUND_MAINLINE_KEYWORDS.round2);
  if (businessScore <= 0) return base;
  const parts = [];
  const bizText = String(biz?.name || biz?.summary || '').slice(0, 40);
  if (bizText) parts.push(`结合我们公司业务「${bizText}」`);
  const respText = String(resp || '').slice(0, 30);
  if (respText) parts.push(`这个岗位职责是「${respText}」`);
  if (frontier && businessScore >= 2) {
    const topic = String(frontier.topic || frontier.summary || '').slice(0, 40);
    if (topic) parts.push(`最近行业出现这样的动态：「${topic}」`);
  }
  return parts.length ? `${parts.join('，')}。${base}` : base;
}

/**
 * 从预分析作战地图生成有序 baseline 问题队列（重构计划 R2 验收 2/6）。
 * L4 必问主线按 L7 轮次定位关键词重排，二面注入业务/前沿上下文。
 */
export function buildBaselinePlan(strategyPlan, roundKey = 'round1', roundContext = null) {
  const layers = strategyPlan?.layers;
  const mainlines = Array.isArray(layers?.mustAskMainlines) ? layers.mustAskMainlines : [];
  const positioning = layers?.roundPositioning?.[roundKey] ?? roundMetaFromPlan(strategyPlan, roundKey) ?? null;
  if (!mainlines.length) {
    return { roundKey, items: [], source: 'none', positioning };
  }
  const keywords = ROUND_MAINLINE_KEYWORDS[roundKey] ?? ROUND_MAINLINE_KEYWORDS.round1;
  const scored = mainlines
    .map((m, i) => ({ m, i, score: scoreMainline(m, keywords) }))
    .sort((a, b) => b.score - a.score || a.i - b.i);
  const items = scored.map(({ m }) => ({
    mainlineId: m.id,
    focus: m.focus,
    intent: m.intent,
    depthTarget: m.depthTarget,
    question: pickBaselineQuestion(m, roundKey, roundContext),
  }));
  return { roundKey, items, source: 'strategyPlan', positioning };
}

// 创建面试会话（状态机：PLANNED → RUNNING → ADJUSTING → CLOSED）。
// R2：strategyPlan 缺失时显式回退到规则模式（mode='rules-fallback'），不静默走旧路径。
export function createSession({
  resumeProfile,
  jobProfile,
  roundKey = 'round1',
  maxDepth = 3,
  llm = null,
  roundContext = null,
  strategyPlan = null,
} = {}) {
  if (!resumeProfile || !jobProfile) {
    throw new Error('resumeProfile and jobProfile required');
  }
  const hasPlan = Boolean(strategyPlan?.layers?.mustAskMainlines?.length);
  if (strategyPlan && !hasPlan) {
    console.warn('[interviewer] invalid strategyPlan, explicit fallback to rules mode');
  }
  const mode = hasPlan ? 'strategy' : 'rules-fallback';
  const baselinePlan = hasPlan
    ? buildBaselinePlan(strategyPlan, roundKey, roundContext)
    : { roundKey, items: [], source: 'none', positioning: null };
  return {
    sessionId: `iv_${crypto.randomBytes(6).toString('hex')}`,
    roundKey,
    jobType: jobProfile.jobType || 'tech',
    resumeProfile,
    jobProfile,
    roundContext,
    strategyPlan: hasPlan ? strategyPlan : null,
    baselinePlan,
    mode,
    baselineIndex: 0,
    currentMainlineId: null,
    adjustedMainlineId: null,
    turns: [],
    depth: 0,
    maxDepth,
    phase: 'opening',
    state: 'planned',
    llm,
    signals: [],
    adjustments: [],
    executionTrace: [],
    createdAt: new Date().toISOString(),
    createdAtMs: Date.now(),
  };
}

// 开场白 + 首个问题（LLM 优先，规则兜底）
export async function startInterview(session) {
  if (session.llm) {
    try {
      const systemPrompt = buildOpeningPrompt(session);
      const raw = await session.llm([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: '请开始面试，生成开场白和第一个问题。' },
      ]);
      const data = parseJsonFromText(raw);
      if (data && data.question) {
        const result = normalizeOpening(data);
        recordTurn(session, 'interviewer', result);
        session.phase = 'probing';
        session.state = 'running';
        return result;
      }
    } catch (err) {
      console.warn('[interviewer] llm opening failed, fallback to rules:', err.message);
    }
  }
  const result = openingByRules(session);
  recordTurn(session, 'interviewer', result);
  session.phase = 'probing';
  session.state = 'running';
  return result;
}

// 下一轮追问：消费 baseline → 注入实时信号 → 决策（继续/追问/换线/结束）。
export async function nextQuestion(session, candidateAnswer) {
  if (!session?.sessionId) throw new Error('session required');
  const lastQ = lastInterviewerTurn(session);
  const signals = ingestSignal(candidateAnswer, { question: lastQ?.content ?? '' });
  recordTurn(session, 'candidate', { question: candidateAnswer });
  session.depth++;
  const isLast = session.depth >= session.maxDepth;

  let result = null;
  let decision = null;

  if (session.mode === 'strategy') {
    // 规则先决策（保证调整不过激、可测试），LLM 可用时负责措辞。
    decision = nextQuestionByRules(session, signals);
    if (session.llm && !decision.done) {
      try {
        const systemPrompt = buildFollowupPrompt(session, candidateAnswer, signals, decision);
        const raw = await session.llm([
          { role: 'system', content: systemPrompt },
          { role: 'user', content: '请根据候选人回答和实时信号生成下一轮追问。' },
        ]);
        const data = parseJsonFromText(raw);
        if (data && data.question) {
          result = normalizeFollowup(data, session.depth);
          result.mainlineId = data.mainlineId ?? decision?.mainlineId ?? session.currentMainlineId;
          result.adjustment = data.adjustment ?? decision?.adjustment ?? null;
        }
      } catch (err) {
        console.warn('[interviewer] llm followup failed, fallback to rules:', err.message);
      }
    }
    if (!result) result = decision;
  } else {
    // 规则回退模式：保持旧的双路径（LLM 优先，规则兜底）。
    if (session.llm) {
      try {
        const systemPrompt = buildFollowupPrompt(session, candidateAnswer, signals);
        const raw = await session.llm([
          { role: 'system', content: systemPrompt },
          { role: 'user', content: '请根据候选人的回答生成下一轮追问。' },
        ]);
        const data = parseJsonFromText(raw);
        if (data && data.question) result = normalizeFollowup(data, session.depth);
      } catch (err) {
        console.warn('[interviewer] llm followup failed, fallback to rules:', err.message);
      }
    }
    if (!result) result = followupByRules(session, candidateAnswer);
  }

  // 记录信号与调整（状态机：调整时进入 ADJUSTING）
  session.signals.push({ turnNo: session.depth, question: lastQ?.content ?? '', signals });
  if (result.adjustment) {
    session.adjustments.push({
      turnNo: session.depth,
      type: result.adjustment,
      mainlineId: result.mainlineId ?? session.currentMainlineId,
    });
    session.state = 'adjusting';
  } else if (session.state !== 'closed') {
    session.state = 'running';
  }

  // executionTrace：记录上一题的实际耗时、信号、是否换线
  const answeredAt = Date.now();
  const askedAt = lastQ?.askedAt ?? session.createdAtMs ?? answeredAt;
  session.executionTrace.push({
    turnNo: session.depth,
    question: lastQ?.content ?? '',
    mainlineId: lastQ?.mainlineId ?? null,
    signals,
    adjustment: result.adjustment ?? null,
    elapsedMs: Math.max(0, answeredAt - askedAt),
  });

  recordTurn(session, 'interviewer', result, {
    mainlineId: result.mainlineId ?? session.currentMainlineId,
    adjustment: result.adjustment ?? null,
  });

  const shouldClose = isLast || result.done === true;
  if (shouldClose) session.phase = 'closing';
  return { ...result, shouldClose };
}

// 兼容旧调用名：askFollowup === nextQuestion。
export async function askFollowup(session, candidateAnswer) {
  return nextQuestion(session, candidateAnswer);
}

// 正式收尾（shouldClose=true 后可调用）
export async function closeInterview(session) {
  session.phase = 'closed';
  session.state = 'closed';
  const closing = closingByRules(session);
  recordTurn(session, 'interviewer', closing);
  return closing;
}

// 记录对话到历史（面试官发言带 askedAt 供 executionTrace 计算耗时）
function recordTurn(session, role, result, extra = {}) {
  let content = result.question ?? '';
  if (result.greeting) content = `${result.greeting} ${content}`.trim();
  else if (result.acknowledgment) content = `${result.acknowledgment} ${content}`.trim();
  session.turns.push({
    role,
    content,
    focusArea: result.focusArea ?? null,
    intent: result.intent ?? null,
    mainlineId: extra.mainlineId ?? result.mainlineId ?? null,
    adjustment: extra.adjustment ?? result.adjustment ?? null,
    turnNo: session.turns.length + 1,
    askedAt: role === 'interviewer' ? Date.now() : undefined,
    answeredAt: role === 'candidate' ? Date.now() : undefined,
  });
}

function lastInterviewerTurn(session) {
  for (let i = session.turns.length - 1; i >= 0; i--) {
    if (session.turns[i].role === 'interviewer') return session.turns[i];
  }
  return null;
}

function normalizeOpening(data) {
  return {
    greeting: data.greeting ?? '',
    question: data.question ?? '',
    focusArea: data.focusArea ?? '开场',
    intent: data.intent ?? '',
  };
}

function normalizeFollowup(data, depth) {
  return {
    acknowledgment: data.acknowledgment ?? '',
    question: data.question ?? '',
    focusArea: data.focusArea ?? `第${depth}轮追问`,
    intent: data.intent ?? '',
    depth,
  };
}

// 获取会话摘要（供复盘教练用；面试官失忆、教练全记忆）
export function getSessionSummary(session) {
  return {
    sessionId: session.sessionId,
    roundKey: session.roundKey,
    jobType: session.jobType,
    mode: session.mode,
    state: session.state,
    depth: session.depth,
    maxDepth: session.maxDepth,
    phase: session.phase,
    turnCount: session.turns.length,
    baselineCount: session.baselinePlan?.items?.length ?? 0,
    focusAreas: session.turns.filter((t) => t.focusArea).map((t) => t.focusArea),
    signalCount: session.signals.length,
    adjustmentCount: session.adjustments.length,
    executionTrace: session.executionTrace,
  };
}
