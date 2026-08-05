// 面试官模块入口（阶段五：面试官与动态追问链）
export { createSession, startInterview, askFollowup, closeInterview, getSessionSummary } from './engine.js';
export { openingByRules, followupByRules, closingByRules } from './rules.js';
export { buildOpeningPrompt, buildFollowupPrompt } from './prompts.js';
