// 面试引擎：管理面试会话状态机，驱动开场白生成与动态追问。
// LLM 优先，规则兜底（与 parser 一致的双路径模式）。
// 面试官"失忆"（方案书 §4.2）：每次 createSession 独立，不跨会话记忆。
// 追问深度可配置（默认 3 轮），方向由岗位类型驱动。
import crypto from 'node:crypto';
import { parseJsonFromText } from '../llm/provider.js';
import { buildOpeningPrompt, buildFollowupPrompt } from './prompts.js';
import { openingByRules, followupByRules, closingByRules } from './rules.js';

// 创建面试会话（状态机）
// 阶段八：roundContext 承载二面业务面上下文（岗位职责 + 公司业务 + 联网前沿话题）。
export function createSession({ resumeProfile, jobProfile, roundKey = 'round1', maxDepth = 3, llm = null, roundContext = null } = {}) {
  if (!resumeProfile || !jobProfile) {
    throw new Error('resumeProfile and jobProfile required');
  }
  return {
    sessionId: `iv_${crypto.randomBytes(6).toString('hex')}`,
    roundKey,
    jobType: jobProfile.jobType || 'tech',
    resumeProfile,
    jobProfile,
    roundContext, // 二面业务面参考资料（岗位职责/公司业务/前沿话题），其它轮次为 null
    turns: [], // { role, content, turnNo, focusArea, intent }
    depth: 0, // 已完成的追问轮数
    maxDepth,
    phase: 'opening', // opening → probing → closing → closed
    llm,
    createdAt: new Date().toISOString(),
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
        return result;
      }
    } catch (err) {
      console.warn('[interviewer] llm opening failed, fallback to rules:', err.message);
    }
  }
  const result = openingByRules(session);
  recordTurn(session, 'interviewer', result);
  session.phase = 'probing';
  return result;
}

// 动态追问：接收候选人回答，返回下一个追问。
// depth 达到 maxDepth 时返回 shouldClose=true（最后一轮追问）。
export async function askFollowup(session, candidateAnswer) {
  // 记录候选人回答
  session.turns.push({
    role: 'candidate',
    content: candidateAnswer,
    turnNo: session.turns.length + 1,
  });
  session.depth++;
  const isLast = session.depth >= session.maxDepth;

  let result;
  // LLM 优先
  if (session.llm) {
    try {
      const systemPrompt = buildFollowupPrompt(session, candidateAnswer);
      const raw = await session.llm([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: '请根据候选人的回答生成下一个追问。' },
      ]);
      const data = parseJsonFromText(raw);
      if (data && data.question) {
        result = normalizeFollowup(data, session.depth);
      }
    } catch (err) {
      console.warn('[interviewer] llm followup failed, fallback to rules:', err.message);
    }
  }
  // 规则兜底
  if (!result) {
    result = followupByRules(session, candidateAnswer);
  }
  recordTurn(session, 'interviewer', result);

  if (isLast) session.phase = 'closing';
  return { ...result, shouldClose: isLast };
}

// 正式收尾（shouldClose=true 后可选调用）
export async function closeInterview(session) {
  session.phase = 'closed';
  const closing = closingByRules(session);
  recordTurn(session, 'interviewer', closing);
  return closing;
}

// 记录面试官发言到对话历史
function recordTurn(session, role, result) {
  let content = result.question ?? '';
  if (result.greeting) content = `${result.greeting} ${content}`.trim();
  else if (result.acknowledgment) content = `${result.acknowledgment} ${content}`.trim();
  session.turns.push({
    role,
    content,
    focusArea: result.focusArea ?? null,
    intent: result.intent ?? null,
    turnNo: session.turns.length + 1,
  });
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

// 获取会话摘要（供复盘教练用，方案书 §4.2 面试官失忆、教练全记忆）
export function getSessionSummary(session) {
  return {
    sessionId: session.sessionId,
    roundKey: session.roundKey,
    jobType: session.jobType,
    depth: session.depth,
    maxDepth: session.maxDepth,
    phase: session.phase,
    turnCount: session.turns.length,
    focusAreas: session.turns.filter((t) => t.focusArea).map((t) => t.focusArea),
  };
}
