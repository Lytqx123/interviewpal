// OpenClaw Gateway WebSocket 协议（v4）帧与常量。
// 与 src/voice/protocol.js 同理：浏览器/Node 共用纯函数，不依赖 Node 内置模块。
//
// 帧形态（官方 Gateway protocol，v2026.6.11 容器实测协议版本 4）：
//   Request  { type:"req", id, method, params, traceparent? }
//   Response { type:"res", id, ok, payload|error }
//   Event    { type:"event", event, payload, seq?, stateVersion? }
// 首个请求必须是 connect：等待服务端 connect.challenge 后用其 nonce/ts 完成握手。

export const GATEWAY_PROTOCOL_VERSION = 4;

// 与容器实测一致的最小协商版本（协议 4 之前不再接受 operator 客户端）
export const MIN_GATEWAY_PROTOCOL_VERSION = 4;

// 后端客户端允许的 client.id（官方连接示意与实测校验一致）
export const GATEWAY_CLIENT_IDS = ['cli', 'gateway-client', 'openclaw-control-ui'];

// 本适配层所需的最小操作面（聊天发送 + 只读会话/事件）
export const GATEWAY_SCOPES = ['operator.read', 'operator.write'];

// 副作用方法必须携带幂等键（chat.send / agent / send 等）
export const SIDE_EFFECT_METHODS = new Set(['chat.send', 'agent', 'send', 'poll']);

// 断连/未配对等可重试或可降级的错误码
export const GATEWAY_RETRYABLE_CODES = new Set([
  'UNAVAILABLE',
  'RATE_LIMITED',
  'TIMEOUT',
  'INTERNAL',
]);

// 未配对/需人工设备配对的错误码：触发优雅降级到本地 mock
export const GATEWAY_PAIRING_CODES = new Set([
  'NOT_PAIRED',
  'PAIRING_REQUIRED',
  'DEVICE_IDENTITY_REQUIRED',
  'AUTH_TOKEN_MISMATCH',
  'CONTROL_UI_DEVICE_IDENTITY_REQUIRED',
]);

/** 解析服务端文本帧；非 JSON 返回 null（协议要求全部文本帧为 JSON）。 */
export function parseFrame(text) {
  if (typeof text !== 'string' && !(text instanceof String)) return null;
  try {
    const frame = JSON.parse(String(text));
    if (!frame || typeof frame !== 'object') return null;
    return frame;
  } catch {
    return null;
  }
}

/** 构造请求帧（id 由调用方生成，保证 req/res 一一对应）。 */
export function buildRequestFrame(method, params = {}, id) {
  if (!method) throw new Error('gateway method required');
  return {
    type: 'req',
    id: id || newRequestId(),
    method,
    params: params ?? {},
  };
}

/**
 * 构造 connect 握手参数。
 * 后端客户端（client.id: gateway-client，mode: backend）在本机回环 + 共享 token
 * 场景可省略 device 身份；其余场景需要 device 签名（由配对流程提供）。
 */
export function buildConnectParams({
  clientId = 'gateway-client',
  clientVersion = '0.1.0',
  platform = 'desktop',
  mode = 'backend',
  role = 'operator',
  scopes = GATEWAY_SCOPES,
  token = '',
  device = null,
  caps = [],
  locale = 'zh-CN',
  userAgent = 'interviewpal/0.1.0',
  minProtocol = MIN_GATEWAY_PROTOCOL_VERSION,
  maxProtocol = GATEWAY_PROTOCOL_VERSION,
} = {}) {
  const client = { id: clientId, version: clientVersion, platform, mode };
  const params = {
    minProtocol,
    maxProtocol,
    client,
    role,
    scopes: [...scopes],
    locale,
    userAgent,
  };
  if (caps?.length) params.caps = caps;
  if (device) params.device = device;
  if (token) params.auth = { token };
  return params;
}

/** 生成唯一请求 id（req/res 关联用）。 */
export function newRequestId(prefix = 'req') {
  return `${prefix}-${randomId()}`;
}

/** 生成副作用方法的幂等键（去重兜底，防止断线重发产生重复运行）。 */
export function newIdempotencyKey(prefix = 'ip') {
  return `${prefix}-${randomId()}`;
}

/** 生成子代理会话键：agent:<agentId>:subagent:<id>（与 OpenClaw 会话键格式一致）。 */
export function subagentSessionKey(agentId, id = null) {
  return `agent:${agentId}:subagent:${id || randomId()}`;
}

/** 生成聊天会话键：agent:<agentId>:agent_chat:<id>（官方 WebChat 会话键格式）。 */
export function chatSessionKey(agentId, id = null) {
  return `agent:${agentId}:agent_chat:${id || randomId()}`;
}

/** 规范化错误对象：保留 code/message/details/retryable/retryAfterMs。 */
export function normalizeGatewayError(error) {
  if (!error || typeof error !== 'object') {
    return { code: 'UNKNOWN', message: String(error ?? 'unknown gateway error') };
  }
  return {
    code: error.code || 'UNKNOWN',
    message: error.message || String(error.code || 'unknown gateway error'),
    details: error.details ?? null,
    retryable: Boolean(error.retryable || GATEWAY_RETRYABLE_CODES.has(error.code)),
    retryAfterMs: error.retryAfterMs ?? null,
  };
}

/** 判断错误是否属于「未配对/需人工操作」类，便于上层优雅降级。 */
export function isPairingError(error) {
  const code = error?.code || error?.error?.code;
  if (GATEWAY_PAIRING_CODES.has(code)) return true;
  const details = error?.details ?? error?.error?.details;
  return Boolean(details?.code && GATEWAY_PAIRING_CODES.has(details.code));
}

/** 判断错误是否可重试（服务端显式标记或已知瞬时错误码）。 */
export function isRetryableError(error) {
  const normalized = normalizeGatewayError(error);
  return normalized.retryable;
}

function randomId() {
  // 浏览器/Node 通用：优先 crypto.randomUUID，缺失时降级时间戳+随机数
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
