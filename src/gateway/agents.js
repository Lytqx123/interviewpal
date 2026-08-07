// 双 Agent 编排：面试官失忆 / 教练全记忆。
// 真实 Gateway 模式下通过 OpenClaw 子代理（sessions_spawn 语义）承载两个 Agent；
// mock 模式下回退到本地面试官/教练 Agent 工厂，保证无配对设备也可演示。

import { createInterviewerAgent, createCoachAgent } from '../coach/agents.js';

/**
 * 创建双 Agent 编排器。
 * @param {object} opts
 *   client: OpenClawGatewayClient（真实模式；为空则本地 mock）
 *   store / llm / search：本地 Agent 工厂依赖（mock 模式）
 */
export function createDualAgentOrchestrator({ client = null, store = null, llm = null, search = null, mode = null } = {}) {
  const effectiveMode = mode || (client ? 'gateway' : 'local');

  return {
    mode: effectiveMode,

    /** 面试官子代理：隔离会话，无跨场记忆（失忆）。 */
    async spawnInterviewer({ task, model = null, runTimeoutSeconds = null } = {}) {
      if (client) {
        const res = await client.spawnSubagent({
          agentId: 'interviewer',
          task,
          model,
          runTimeoutSeconds,
        });
        return { agent: 'interviewer', memory: 'amnesic', mode: 'gateway', ...res };
      }
      const handle = createInterviewerAgent({ llm, search });
      return {
        agent: 'interviewer',
        memory: 'amnesic',
        mode: 'local',
        runId: `local-interviewer-${Date.now()}`,
        childSessionKey: `local:interviewer:${Date.now()}`,
        handle,
      };
    },

    /** 复盘教练子代理：隔离会话，全记忆（读写档案库）。 */
    async spawnCoach({ task, model = null, runTimeoutSeconds = null } = {}) {
      if (client) {
        const res = await client.spawnSubagent({
          agentId: 'coach',
          task,
          model,
          runTimeoutSeconds,
        });
        return { agent: 'coach', memory: 'full', mode: 'gateway', ...res };
      }
      const handle = createCoachAgent({ store, llm });
      return {
        agent: 'coach',
        memory: 'full',
        mode: 'local',
        runId: `local-coach-${Date.now()}`,
        childSessionKey: `local:coach:${Date.now()}`,
        handle,
      };
    },

    status() {
      return { mode: effectiveMode, agents: ['interviewer', 'coach'] };
    },
  };
}
