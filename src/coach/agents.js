// P1：双 Agent 物理拆分（阶段八可选）。
// 方案书 §4.2：面试官"失忆"（每场独立、不跨会话记忆）/ 教练"全记忆"（读历史复盘）。
// 物理拆分意义：两个 Agent 职责正交、可独立部署/独立扩缩容，避免状态互相污染。
//   - InterviewerAgent：负责生成面试问题，无状态、不读档案库历史
//   - CoachAgent：负责复盘评估，有记忆、读写档案库
import { createSession, startInterview, askFollowup, closeInterview } from '../interviewer/index.js';
import { reviewWithMemory } from './memory.js';
import { diagnoseBaseline, passRecommendation } from './baseline.js';
import { analyzeRhythm } from './rhythm.js';

// 面试官 Agent：无状态工厂。每场 createSession 独立，不读历史（失忆）。
export function createInterviewerAgent({ llm = null, search = null } = {}) {
  return {
    name: 'interviewer',
    memory: 'amnesic', // 失忆：不跨会话记忆
    // 开一场新面试（round2 需传 roundContext）
    start({ resumeProfile, jobProfile, roundKey = 'round1', maxDepth = 3, roundContext = null }) {
      const session = createSession({ resumeProfile, jobProfile, roundKey, maxDepth, llm, roundContext });
      return {
        session,
        async open() {
          return startInterview(session);
        },
        async ask(answer) {
          return askFollowup(session, answer);
        },
        async close() {
          return closeInterview(session);
        },
      };
    },
  };
}

// 教练 Agent：有记忆工厂。读写档案库，跨会话对比（全记忆）。
export function createCoachAgent({ store, llm = null, reply = null } = {}) {
  if (!store) throw new Error('CoachAgent 需要 store（全记忆依赖档案库）');
  return {
    name: 'coach',
    memory: 'full', // 全记忆：读写档案库历史
    store,
    // 复盘一场面试并写入档案库 + 回传渠道
    async review(session, { companyId, positionId, roundKey }) {
      return reviewWithMemory(session, { store, companyId, positionId, roundKey, llm, reply });
    },
    // 基线诊断
    diagnose({ companyId, positionId }) {
      return diagnoseBaseline({ store, companyId, positionId });
    },
    // 通关建议
    passAdvise({ companyId, positionId, roundKey }) {
      return passRecommendation({ store, companyId, positionId, roundKey });
    },
    // 表达节奏分析
    rhythm(session) {
      return analyzeRhythm(session);
    },
  };
}
