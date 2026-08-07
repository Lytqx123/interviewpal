// OpenClaw Gateway 适配层出口
export { OpenClawGatewayClient, GatewayError } from './client.js';
export { startGatewayBootstrap, readGatewayConfig } from './bootstrap.js';
export { createCommandRouter, detectIntent } from './router.js';
export { createDualAgentOrchestrator } from './agents.js';
export { createOfflineOutbox, createOfflineCache } from './outbox.js';
export {
  GATEWAY_PROTOCOL_VERSION,
  GATEWAY_SCOPES,
  buildConnectParams,
  buildRequestFrame,
  parseFrame,
  newIdempotencyKey,
  newRequestId,
  subagentSessionKey,
  chatSessionKey,
  isPairingError,
  isRetryableError,
  normalizeGatewayError,
} from './protocol.js';
