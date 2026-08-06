// 面试官模块入口（方案书 §5.4/§5.5：动态追问链 + 轮次差异化）
export { createSession, startInterview, nextQuestion, buildBaselinePlan, closeInterview, getSessionSummary, ingestSignal } from './engine.js';
export { openingByRules, followupByRules, closingByRules, nextQuestionByRules } from './rules.js';
export { buildOpeningPrompt, buildFollowupPrompt } from './prompts.js';
export { prepareRound2Context, enrichRound2Frontier, roundMetaFromPlan } from './rounds.js';
