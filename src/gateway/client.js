// OpenClaw Gateway WebSocket 客户端封装。
// 职责：connect 握手（challenge → connect → hello-ok）、req/res 关联、事件订阅、
// 幂等键、断线重连与状态恢复。只依赖 ws 库，不依赖官方 npm 包（保持零额外依赖）。

import { WebSocket } from 'ws';
import {
  GATEWAY_PROTOCOL_VERSION,
  MIN_GATEWAY_PROTOCOL_VERSION,
  GATEWAY_SCOPES,
  buildConnectParams,
  buildRequestFrame,
  newIdempotencyKey,
  newRequestId,
  normalizeGatewayError,
  parseFrame,
  subagentSessionKey,
} from './protocol.js';

const DEFAULT_URL = 'ws://127.0.0.1:18789/ws';
const DEFAULT_CONNECT_TIMEOUT_MS = 8000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
const DEFAULT_RECONNECT_DELAY_MS = 2000;

/** 网关错误：带 code/details/retryable 的结构化错误（与协议响应错误形状一致）。 */
export class GatewayError extends Error {
  constructor(error) {
    const normalized = normalizeGatewayError(error);
    super(normalized.message);
    this.name = 'GatewayError';
    this.code = normalized.code;
    this.details = normalized.details;
    this.retryable = normalized.retryable;
    this.retryAfterMs = normalized.retryAfterMs;
  }
}

function noop() {}

export class OpenClawGatewayClient {
  constructor({
    url = DEFAULT_URL,
    token = '',
    agentId = 'main',
    clientId = 'gateway-client',
    clientVersion = '0.1.0',
    platform = 'desktop',
    scopes = GATEWAY_SCOPES,
    minProtocol = MIN_GATEWAY_PROTOCOL_VERSION,
    maxProtocol = GATEWAY_PROTOCOL_VERSION,
    connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    reconnectDelayMs = DEFAULT_RECONNECT_DELAY_MS,
    maxReconnectAttempts = 5,
    autoReconnect = true,
    log = console,
  } = {}) {
    this.url = url;
    this.token = token;
    this.agentId = agentId;
    this.clientId = clientId;
    this.clientVersion = clientVersion;
    this.platform = platform;
    this.scopes = [...scopes];
    this.minProtocol = minProtocol;
    this.maxProtocol = maxProtocol;
    this.connectTimeoutMs = connectTimeoutMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.reconnectDelayMs = reconnectDelayMs;
    this.maxReconnectAttempts = maxReconnectAttempts;
    this.autoReconnect = autoReconnect;
    this.log = typeof log?.info === 'function' ? log : { info: log || noop, error: noop };

    this.ws = null;
    this.hello = null;
    this.connected = false;
    this.manualClose = false;
    this.reconnectAttempts = 0;
    this.lastSeq = null;
    this.connectSent = false;

    this.pending = new Map(); // id -> { resolve, reject, timer, method, params, idempotent, retryOnReconnect }
    this.requeue = []; // 断线时带幂等键的未完成请求，重连成功后补发
    this.eventHandlers = new Map(); // event -> Set<fn>
    this.buffer = []; // connect 前的预接收帧
  }

  /** 建立连接并完成握手；返回 hello-ok 的 payload（features/methods/events/policy/auth）。 */
  async connect() {
    if (this.connected && this.ws?.readyState === WebSocket.OPEN) return this.hello;
    this.manualClose = false;
    await this.openSocket();
    const hello = await this.waitForHello();
    this.connected = true;
    this.reconnectAttempts = 0;
    this.hello = hello;
    this.log.info(`[gateway] 已连接 ${this.url}（协议 ${hello.protocol ?? this.maxProtocol}）`);
    return hello;
  }

  openSocket() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      this.buffer = [];
      this.lastSeq = null;
      this.connectSent = false;

      const timeout = setTimeout(() => {
        cleanup();
        reject(new GatewayError({ code: 'CONNECT_TIMEOUT', message: `gateway connect timeout: ${this.url}` }));
      }, this.connectTimeoutMs);

      const cleanup = () => clearTimeout(timeout);
      ws.once('open', () => {
        cleanup();
        resolve();
      });
      ws.once('error', (err) => {
        cleanup();
        reject(new GatewayError({ code: 'CONNECT_FAILED', message: err.message, retryable: true }));
      });

      ws.on('message', (data) => this.handleMessage(data));
      ws.on('close', (code, reason) => this.handleClose(code, reason));
      ws.on('error', (err) => this.log.error('[gateway] ws error:', err.message));
    });
  }

  waitForHello() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new GatewayError({ code: 'HELLO_TIMEOUT', message: 'gateway hello-ok timeout' }));
      }, this.connectTimeoutMs);
      const step = () => {
        // 一次性消费 buffer：challenge 只发一次 connect，响应到达即结束握手
        let challenge = null;
        let response = null;
        const keep = [];
        for (const frame of this.buffer) {
          if (!challenge && frame?.type === 'event' && frame.event === 'connect.challenge') {
            challenge = frame;
          } else if (!response && frame?.type === 'res' && String(frame.id ?? '').startsWith('connect-')) {
            response = frame;
          } else {
            keep.push(frame);
          }
        }
        this.buffer = keep;
        if (challenge && !this.connectSent) {
          this.sendConnect(challenge.payload ?? {});
        }
        if (response) {
          clearTimeout(timer);
          if (response.ok) {
            resolve(response.payload);
          } else {
            reject(new GatewayError(response.error));
          }
          return;
        }
        setTimeout(step, 20);
      };
      step();
    });
  }

  sendConnect(challenge) {
    if (this.connectSent || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.connectSent = true;
    const params = buildConnectParams({
      clientId: this.clientId,
      clientVersion: this.clientVersion,
      platform: this.platform,
      role: 'operator',
      scopes: this.scopes,
      token: this.token,
      minProtocol: this.minProtocol,
      maxProtocol: this.maxProtocol,
    });
    // 设备签名为空时仍发 device.signedAt 占位会触发签名校验失败，
    // 因此只有拿到真实 device 才注入；后端回环场景只依赖共享 token。
    this.ws.send(JSON.stringify(buildRequestFrame('connect', params, 'connect-1')));
  }

  handleMessage(data) {
    const frame = parseFrame(String(data));
    if (!frame) return;

    if (frame.seq != null) {
      if (this.lastSeq != null && frame.seq > this.lastSeq + 1) {
        this.emit('gap', { from: this.lastSeq, to: frame.seq });
      }
      this.lastSeq = frame.seq;
    }

    if (frame.type === 'res') {
      const pending = this.pending.get(frame.id);
      if (pending) {
        this.pending.delete(frame.id);
        clearTimeout(pending.timer);
        if (frame.ok) {
          pending.resolve(frame.payload ?? {});
        } else {
          pending.reject(new GatewayError(frame.error));
        }
        return;
      }
      // 握手阶段的 connect 响应没有对应 pending，交给 waitForHello 消费
      this.buffer.push(frame);
      return;
    }

    if (frame.type === 'event') {
      if (this.hello) {
        this.emit(frame.event, frame.payload ?? {}, frame);
      } else {
        this.buffer.push(frame);
      }
      return;
    }

    // connect 之前的响应帧也进 buffer，由 waitForHello 消费
    this.buffer.push(frame);
  }

  handleClose(code, reason) {
    const wasConnected = this.connected;
    this.connected = false;
    const message = `gateway closed (${code})${reason ? `: ${reason}` : ''}`;
    this.log.info(`[gateway] ${message}`);

    // 未完成的请求：幂等方法标记可重试（交由 outbox/调用方补发），其余直接失败
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      if (pending.retryOnReconnect && pending.idempotent) {
        this.requeue.push(pending);
      } else {
        pending.reject(new GatewayError({ code: 'CONNECTION_LOST', message, retryable: pending.idempotent }));
      }
    }

    this.emit('close', { code, reason: String(reason || '') });

    if (this.manualClose) return;
    if (!this.autoReconnect) {
      this.emit('failed', { reason: 'autoReconnect disabled' });
      return;
    }
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.emit('failed', { reason: `max reconnect attempts (${this.maxReconnectAttempts})` });
      return;
    }
    this.reconnectAttempts += 1;
    const delay = this.reconnectDelayMs * this.reconnectAttempts;
    this.log.info(`[gateway] ${delay}ms 后重连（第 ${this.reconnectAttempts} 次）`);
    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.connect();
        this.emit('reconnect', { hello: this.hello, attempts: this.reconnectAttempts });
        // 重连成功后重放已排队且带幂等键的请求
        const requeue = this.requeue.splice(0);
        for (const pending of requeue) {
          this.dispatchPending(pending);
        }
      } catch (err) {
        this.log.error('[gateway] 重连失败:', err.message);
      }
    }, delay);
  }

  /**
   * 发送 RPC 请求。
   * - 幂等方法（chat.send/agent 等）由调用方传 idempotencyKey，重连后自动补发；
   * - 超时/断线错误保留结构化 code，便于上层判断重试或降级。
   */
  request(method, params = {}, { timeoutMs = this.requestTimeoutMs, idempotencyKey = null, retryOnReconnect = true } = {}) {
    if (!this.connected || this.ws?.readyState !== WebSocket.OPEN) {
      return Promise.reject(new GatewayError({ code: 'NOT_CONNECTED', message: 'gateway not connected', retryable: true }));
    }
    const id = newRequestId();
    const idempotent = Boolean(idempotencyKey);
    const pending = {
      id,
      method,
      params,
      idempotent,
      retryOnReconnect: idempotent && retryOnReconnect,
      resolve: null,
      reject: null,
      timer: null,
    };
    const promise = new Promise((resolve, reject) => {
      pending.resolve = resolve;
      pending.reject = reject;
    });
    this.pending.set(id, pending);
    this.dispatchPending(pending);
    return promise;
  }

  dispatchPending(pending) {
    pending.timer = setTimeout(() => {
      this.pending.delete(pending.id);
      pending.reject(new GatewayError({ code: 'REQUEST_TIMEOUT', message: `gateway request timeout: ${pending.method}`, retryable: true }));
    }, this.requestTimeoutMs);
    try {
      this.ws?.send(JSON.stringify(buildRequestFrame(pending.method, pending.params, pending.id)));
    } catch (err) {
      clearTimeout(pending.timer);
      this.pending.delete(pending.id);
      pending.reject(new GatewayError({ code: 'SEND_FAILED', message: err.message, retryable: true }));
    }
  }

  /** 发送聊天消息（副作用方法，必须带幂等键；返回 { runId, acceptedAt }）。 */
  chatSend({ sessionKey, message, attachments = [], idempotencyKey = null, timeoutMs }) {
    if (!sessionKey || !message) {
      return Promise.reject(new GatewayError({ code: 'INVALID_PARAMS', message: 'chat.send 需要 sessionKey + message' }));
    }
    const key = idempotencyKey || newIdempotencyKey('chat');
    const params = { sessionKey, message, idempotencyKey: key };
    if (Array.isArray(attachments) && attachments.length) params.attachments = attachments;
    return this.request('chat.send', params, { timeoutMs, idempotencyKey: key });
  }

  /** 直接启动一轮 agent 运行（副作用方法，返回 { runId, acceptedAt }）。 */
  agentRun({ sessionKey, message, model = null, thinkingLevel = null, idempotencyKey = null, timeoutMs }) {
    if (!sessionKey || !message) {
      return Promise.reject(new GatewayError({ code: 'INVALID_PARAMS', message: 'agent 需要 sessionKey + message' }));
    }
    const key = idempotencyKey || newIdempotencyKey('agent');
    const params = { sessionKey, message, idempotencyKey: key };
    if (model) params.model = model;
    if (thinkingLevel != null) params.thinkingLevel = thinkingLevel;
    return this.request('agent', params, { timeoutMs, idempotencyKey: key });
  }

  /**
   * 子代理承载双 Agent（§5.8）：以隔离子会话键承载面试官/复盘教练。
   * 与 OpenClaw sessions_spawn 语义一致——非阻塞、返回 runId + childSessionKey。
   */
  async spawnSubagent({ agentId = this.agentId, task, model = null, runTimeoutSeconds = null, idempotencyKey = null }) {
    if (!task) {
      throw new GatewayError({ code: 'INVALID_PARAMS', message: 'spawnSubagent 需要 task' });
    }
    const childSessionKey = subagentSessionKey(agentId);
    const params = {
      sessionKey: childSessionKey,
      message: task,
      idempotencyKey: idempotencyKey || newIdempotencyKey('sub'),
    };
    if (model) params.model = model;
    if (runTimeoutSeconds != null) params.runTimeoutSeconds = runTimeoutSeconds;
    const payload = await this.request('agent', params, { idempotencyKey: params.idempotencyKey });
    return { runId: payload?.runId, childSessionKey, acceptedAt: payload?.acceptedAt };
  }

  /** 读取会话历史（重连恢复 / 离线补发前核对用）。 */
  chatHistory({ sessionKey, limit = 20, timeoutMs }) {
    return this.request('chat.history', { sessionKey, limit }, { timeoutMs });
  }

  /** 列出可见会话（只读，带 kind 过滤可选）。 */
  sessionsList({ kind = null, limit = 50 } = {}) {
    const params = { limit };
    if (kind) params.kind = kind;
    return this.request('sessions.list', params, { retryOnReconnect: false });
  }

  /** 订阅 Gateway 事件（agent/chat/talk.event/gap/reconnect/close/failed 等）。 */
  on(event, handler) {
    if (!this.eventHandlers.has(event)) this.eventHandlers.set(event, new Set());
    this.eventHandlers.get(event).add(handler);
    return () => this.off(event, handler);
  }

  once(event, handler) {
    const wrapper = (payload, frame) => {
      this.off(event, wrapper);
      handler(payload, frame);
    };
    return this.on(event, wrapper);
  }

  off(event, handler) {
    const handlers = this.eventHandlers.get(event);
    if (handlers) handlers.delete(handler);
  }

  emit(event, payload, frame) {
    const handlers = this.eventHandlers.get(event);
    if (!handlers || !handlers.size) return;
    for (const handler of [...handlers]) {
      try {
        handler(payload, frame);
      } catch (err) {
        this.log.error(`[gateway] event handler error (${event}):`, err.message);
      }
    }
  }

  /** 手动断开（不再自动重连）。 */
  async close() {
    this.manualClose = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(new GatewayError({ code: 'CLOSED', message: 'gateway client closed' }));
    }
    if (this.ws?.readyState === WebSocket.OPEN || this.ws?.readyState === WebSocket.CONNECTING) {
      this.ws.close();
    }
    this.connected = false;
  }
}
