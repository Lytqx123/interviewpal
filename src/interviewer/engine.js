// 面试引擎：管理面试会话状态机，驱动开场白生成与动态追问（方案书 §5.4/§5.5）。
// LLM 优先，规则兜底（与 parser 一致的双路径模式）。
// 面试官"失忆"（方案书 §5.7）：每次 createSession 独立，不跨会话记忆。
//
// 执行模型：读取预分析作战地图 → 从④层考察策略生成 baseline plan →
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

// 从预分析④层考察策略（roundStrategy[round].followupChains）生成有序 baseline 问题队列。
// 二面额外注入 roundContext（公司业务 / 岗位职责 / 前沿话题，来源 §5.3 联网补全）。
function pickBaselineQuestion(chain, roundKey, roundContext) {
  const base = chain.keyQuestions?.[0] ?? chain.chain?.[0]?.question ?? `${chain.dimension}：请展开讲讲。`;
  if (roundKey !== 'round2' || !roundContext) return base;
  const parts = [];
  const biz = roundContext.companyBusiness?.[0];
  const resp = roundContext.responsibilities?.[0];
  const frontier = roundContext.frontierTopics?.[0];
  const bizText = String(biz?.name || biz?.summary || '').slice(0, 40);
  if (bizText) parts.push(`结合我们公司业务「${bizText}」`);
  const respText = String(resp || '').slice(0, 30);
  if (respText) parts.push(`这个岗位职责是「${respText}」`);
  if (frontier) {
    const topic = String(frontier.topic || frontier.summary || '').slice(0, 40);
    if (topic) parts.push(`最近行业出现这样的动态：「${topic}」`);
  }
  return parts.length ? `${parts.join('，')}。${base}` : base;
}

/**
 * 生成 baseline plan（方案书 §5.4：计划是基线，不是脚本）。
 * 题目全部来自④层考察策略的追问链，每轮 ≥5 条。
 */
export function buildBaselinePlan(preanalysisPlan, roundKey = 'round1', roundContext = null) {
  const roundStrategy = preanalysisPlan?.layers?.roundStrategy?.[roundKey] ?? null;
  const chains = Array.isArray(roundStrategy?.followupChains) ? roundStrategy.followupChains : [];
  const meta = roundMetaFromPlan(preanalysisPlan, roundKey);
  if (!chains.length) {
    return { roundKey, items: [], source: 'none', positioning: meta };
  }
  const items = chains.map((c) => ({
    mainlineId: c.id,
    focus: c.dimension,
    intent: c.depthTarget,
    depthTarget: c.depthTarget,
    question: pickBaselineQuestion(c, roundKey, roundContext),
  }));
  return { roundKey, items, source: 'preanalysisPlan', positioning: meta };
}

// 创建面试会话（状态机：PLANNED → RUNNING → ADJUSTING → CLOSED）。
// 预分析缺失时显式回退到规则模式（mode='rules-fallback'），不静默降级。
export function createSession({
  resumeProfile,
  jobProfile,
  roundKey = 'round1',
  maxDepth = 3,
  llm = null,
  roundContext = null,
  preanalysisPlan = null,
} = {}) {
  if (!resumeProfile || !jobProfile) {
    throw new Error('resumeProfile and jobProfile required');
  }
  const hasPlan = Boolean(preanalysisPlan?.layers?.roundStrategy?.[roundKey]?.followupChains?.length);
  if (preanalysisPlan && !hasPlan) {
    console.warn('[interviewer] invalid preanalysisPlan, explicit fallback to rules mode');
  }
  const mode = hasPlan ? 'preanalysis' : 'rules-fallback';
  const baselinePlan = hasPlan
    ? buildBaselinePlan(preanalysisPlan, roundKey, roundContext)
    : { roundKey, items: [], source: 'none', positioning: null };
  return {
    sessionId: `iv_${crypto.randomBytes(6).toString('hex')}`,
    roundKey,
    jobType: jobProfile.jobType || 'tech',
    resumeProfile,
    jobProfile,
    roundContext,
    preanalysisPlan: hasPlan ? preanalysisPlan : null,
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

  if (session.mode === 'preanalysis') {
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
    // 规则回退模式：保持双路径（LLM 优先，规则兜底，方案书 §5.5）。
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
