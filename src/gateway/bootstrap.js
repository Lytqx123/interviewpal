// Gateway 启动入口：读取配置 → 尝试连接 OpenClaw Gateway → 无 token / 未配对时优雅降级。
//   - 真实模式：operator 后端接入，订阅 chat/agent 事件，命令脑回写 App 会话；
//   - mock 模式：本地命令路由 + 双 Agent 工厂 + 离线发件箱，无 key 可完整演示。

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadEnvFile } from '../voice/bridge.js';
import { ArchiveStore } from '../archive/store.js';
import { createVoiceCoordination } from '../voice/coordination.js';
import { OpenClawGatewayClient } from './client.js';
import { createCommandRouter } from './router.js';
import { createDualAgentOrchestrator } from './agents.js';
import { createOfflineCache, createOfflineOutbox } from './outbox.js';
import { isPairingError } from './protocol.js';

const DEFAULT_GATEWAY_URL = 'ws://127.0.0.1:18789/ws';

function truthy(v, fallback = false) {
  if (v == null || v === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
}

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** 读取 Gateway 配置：进程环境变量优先，其次 .env.local（与 voice 配置同构）。 */
export function readGatewayConfig(env = process.env, envFile = path.join(process.cwd(), '.env.local')) {
  const merged = { ...loadEnvFile(envFile), ...env };
  return {
    url: (merged.OPENCLAW_GATEWAY_URL || '').trim() || DEFAULT_GATEWAY_URL,
    token: (merged.OPENCLAW_GATEWAY_TOKEN || '').trim(),
    agentId: (merged.OPENCLAW_AGENT_ID || '').trim() || 'main',
    mock: truthy(merged.GATEWAY_MOCK),
    autoReconnect: truthy(merged.GATEWAY_AUTO_RECONNECT, true),
    connectTimeoutMs: num(merged.GATEWAY_CONNECT_TIMEOUT_MS, 8000),
    requestTimeoutMs: num(merged.GATEWAY_REQUEST_TIMEOUT_MS, 30000),
    reconnectDelayMs: num(merged.GATEWAY_RECONNECT_DELAY_MS, 2000),
    maxReconnectAttempts: num(merged.GATEWAY_MAX_RECONNECT_ATTEMPTS, 5),
    dataDir: (merged.GATEWAY_DATA_DIR || '').trim() || path.join(process.cwd(), 'data'),
  };
}

function makeLogger(log = console) {
  return {
    info: (...a) => (typeof log.info === 'function' ? log.info(...a) : log(...a)),
    error: (...a) => (typeof log.error === 'function' ? log.error(...a) : log(...a)),
  };
}

/**
 * 启动 Gateway 适配层。
 * @param {object} deps { store, llm, search, coordination?, config?, outbox?, offlineCache?, log? }
 * @returns {Promise<{mode, adapter, client, router, outbox, offlineCache, coordination, orchestrator, stop, status}>}
 */
export async function startGatewayBootstrap({
  store = null,
  llm = null,
  search = null,
  coordination = null,
  config = null,
  outbox = null,
  offlineCache = null,
  log = console,
} = {}) {
  const logger = makeLogger(log);
  const cfg = config ?? readGatewayConfig();
  const dataDir = cfg.dataDir;

  if (!store) store = new ArchiveStore(dataDir);
  if (!coordination) {
    coordination = createVoiceCoordination({ store, llm, search, log: logger });
  }
  if (!outbox) outbox = createOfflineOutbox({ dir: dataDir, log: logger });
  if (!offlineCache) offlineCache = createOfflineCache({ dir: dataDir, log: logger });

  const router = createCommandRouter({ store, llm, search, coordination, outbox, log: logger });

  // ---- mock 模式：本地适配器，无任何外部依赖 ----
  if (cfg.mock || !cfg.token) {
    const adapter = createMockAdapter({ store, router, outbox, offlineCache, coordination, log: logger });
    logger.info('[gateway] mock 模式已启用（未配置 OPENCLAW_GATEWAY_TOKEN 或 GATEWAY_MOCK=1）');
    return {
      mode: 'mock',
      adapter,
      client: null,
      router,
      outbox,
      offlineCache,
      coordination,
      orchestrator: createDualAgentOrchestrator({ store, llm, search, mode: 'local' }),
      stop: adapter.stop,
      status: () => adapter.status(),
    };
  }

  // ---- 真实模式：连接 OpenClaw Gateway ----
  const client = new OpenClawGatewayClient({
    url: cfg.url,
    token: cfg.token,
    agentId: cfg.agentId,
    connectTimeoutMs: cfg.connectTimeoutMs,
    requestTimeoutMs: cfg.requestTimeoutMs,
    reconnectDelayMs: cfg.reconnectDelayMs,
    maxReconnectAttempts: cfg.maxReconnectAttempts,
    autoReconnect: cfg.autoReconnect,
    log: logger,
  });

  try {
    await client.connect();
    const adapter = createGatewayAdapter({ client, router, outbox, offlineCache, log: logger });
    await adapter.start();
    logger.info(`[gateway] 已接入 OpenClaw Gateway: ${cfg.url}`);
    return {
      mode: 'gateway',
      adapter,
      client,
      router,
      outbox,
      offlineCache,
      coordination,
      orchestrator: createDualAgentOrchestrator({ client, store, llm, search, mode: 'gateway' }),
      stop: adapter.stop,
      status: () => adapter.status(),
    };
  } catch (err) {
    if (isPairingError(err)) {
      logger.error(`[gateway] 未配对/未授权（${err.code}），降级为 mock 模式：${err.message}`);
      await client.close().catch(() => {});
      const adapter = createMockAdapter({ store, router, outbox, offlineCache, coordination, log: logger });
      return {
        mode: 'mock',
        degradedFrom: 'gateway',
        degradeReason: err.message,
        adapter,
        client: null,
        router,
        outbox,
        offlineCache,
        coordination,
        orchestrator: createDualAgentOrchestrator({ store, llm, search, mode: 'local' }),
        stop: adapter.stop,
        status: () => ({ ...adapter.status(), degradedFrom: 'gateway', degradeReason: err.message }),
      };
    }
    await client.close().catch(() => {});
    throw err;
  }
}

/** 真实 Gateway 适配器：订阅事件 → 命令路由 → 回写会话 + 离线补发。 */
function createGatewayAdapter({ client, router, outbox, offlineCache, log }) {
  let started = false;
  const logger = makeLogger(log);

  async function handleInboundMessage({ sessionKey, message, messageId = null }) {
    if (typeof message !== 'string' || !message.trim()) return null;
    const result = await router.route(message);
    if (result?.reply) {
      await client.chatSend({
        sessionKey: sessionKey || chatKey(),
        message: result.reply,
        idempotencyKey: `reply-${messageId || Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      });
    }
    if (sessionKey) {
      offlineCache.save(`session:${sessionKey}`, {
        request: message,
        reply: result?.reply ?? null,
        intent: result?.intent ?? null,
        at: new Date().toISOString(),
      });
    }
    return result;
  }

  function chatKey() {
    return `agent:${client.agentId}:agent_chat:interviewpal`;
  }

  async function drainOutbox() {
    const pending = outbox.pending();
    if (!pending.length) return { sent: [], failed: [], remaining: 0 };
    return outbox.drain((entry) =>
      client.chatSend({
        sessionKey: entry.sessionKey,
        message: entry.message,
        attachments: entry.attachments ?? [],
        idempotencyKey: `offline-${entry.id}`,
      }),
    );
  }

  return {
    async start() {
      if (started) return;
      started = true;
      // 入站消息：chat 事件携带用户文本（delta/final 形态都接收，final 才路由）
      client.on('chat', (payload) => {
        const kind = payload?.kind ?? payload?.type;
        if (kind !== 'final' && kind !== 'user' && kind !== 'delta') return;
        const text = payload?.message ?? payload?.text ?? payload?.content;
        if (!text) return;
        handleInboundMessage({
          sessionKey: payload?.sessionKey ?? chatKey(),
          message: text,
          messageId: payload?.id ?? null,
        }).catch((err) => logger.error('[gateway] 入站命令处理失败:', err.message));
      });
      // 断线重连后：先补发离线队列
      client.on('reconnect', () => {
        drainOutbox().then((res) => {
          logger.info(`[gateway] 重连补发完成：${res.sent.length} 条成功，剩余 ${res.remaining}`);
        });
      });
      // 连接关闭/彻底失败时，未发送消息进离线发件箱由上层决定
      client.on('failed', (info) => logger.error('[gateway] 连接失败，后续消息将进入离线发件箱:', info?.reason));
      // 订阅初始会话（只读，探测可用方法面）
      try {
        const sessions = await client.sessionsList({ limit: 10 });
        logger.info(`[gateway] 可见会话 ${(sessions?.sessions ?? sessions ?? []).length ?? 0} 个`);
      } catch (err) {
        logger.info('[gateway] sessions.list 不可用（不影响命令路由）:', err.message);
      }
      return this;
    },

    handleInboundMessage,
    drainOutbox,
    chatKey,

    async stop() {
      started = false;
      await client.close();
    },

    status() {
      return {
        mode: 'gateway',
        connected: client.connected,
        url: client.url,
        protocol: client.hello?.protocol ?? null,
        features: client.hello?.features ?? null,
        agents: createDualAgentOrchestrator({ client, mode: 'gateway' }).status(),
        outbox: outbox.stats(),
        offlineCache: offlineCache.list({ limit: 5 }),
      };
    },
  };
}

/** mock 适配器：本地直接执行命令路由，等价于"无 Gateway 也可演示"。 */
function createMockAdapter({ store, router, outbox, offlineCache, log }) {
  const logger = makeLogger(log);
  return {
    async start() {
      return this;
    },

    async handleInboundMessage({ sessionKey = 'mock:main', message }) {
      const result = await router.route(message);
      offlineCache.save(`session:${sessionKey}`, {
        request: message,
        reply: result?.reply ?? null,
        intent: result?.intent ?? null,
        at: new Date().toISOString(),
      });
      return result;
    },

    async drainOutbox() {
      // mock 模式无外部网关：入队消息直接本地处理，等同补发
      const pending = outbox.pending();
      if (!pending.length) return { sent: [], failed: [], remaining: 0 };
      return outbox.drain((entry) => this.handleInboundMessage(entry));
    },

    chatKey() {
      return 'mock:main';
    },

    async stop() {},

    status() {
      return {
        mode: 'mock',
        connected: false,
        url: null,
        protocol: null,
        agents: createDualAgentOrchestrator({ store, mode: 'local' }).status(),
        outbox: outbox.stats(),
        offlineCache: offlineCache.list({ limit: 5 }),
      };
    },
  };
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  const cfg = readGatewayConfig();
  const boot = await startGatewayBootstrap({ config: cfg });
  console.log(`[gateway] 模式：${boot.mode}${boot.degradedFrom ? `（自 ${boot.degradedFrom} 降级）` : ''}`);
  console.log('[gateway] 状态：');
  console.log(JSON.stringify(boot.status(), null, 2));
  console.log('[gateway] 已就绪：Ctrl+C 退出；App 聊天消息可发送「帮助」查看指令。');
  const shutdown = async () => {
    await boot.stop().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
