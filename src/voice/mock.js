// 本地 Mock 上游：模拟豆包实时语音服务端，用于无凭据的 localhost 联调。
// 行为：握手 → StartConnection(50) → StartSession(150)；收到用户音频后返回
// ASR 文本(451) + LLM 文本(550) + 一段提示音(200)，验证双向链路。

import zlib from 'node:zlib';
import { WebSocketServer } from 'ws';
import {
  SP_FLAG_EVENT,
  SP_SERVER_ACK,
  SP_SERVER_FULL,
  SP_SERIAL_JSON,
  SP_SERIAL_NONE,
  SP_COMPRESS_GZIP,
  SP_COMPRESS_NONE,
  EV_CONNECTION_STARTED,
  EV_SESSION_STARTED,
  EV_SESSION_FINISHED,
  EV_FINISH_CONNECTION,
  EV_START_CONNECTION,
  EV_START_SESSION,
  EV_FINISH_SESSION,
  EV_AUDIO,
  EV_ASR,
  EV_LLM,
  EV_INTERRUPT,
  EV_CHAT_RAG_TEXT,
  buildFrame,
  parseFrame,
} from './protocol.js';

/** 组装服务端帧（Node 侧专用，JSON payload 默认 gzip）。 */
export function buildServerFrame({
  messageType = SP_SERVER_FULL,
  flags = SP_FLAG_EVENT,
  seq = null,
  event = null,
  sessionId = '',
  payloadJson = null,
  payloadBytes = null,
  serial = SP_SERIAL_JSON,
  compression = SP_COMPRESS_GZIP,
}) {
  let body;
  if (payloadBytes !== null) {
    body = payloadBytes instanceof Uint8Array ? payloadBytes : new Uint8Array(payloadBytes);
  } else {
    body = new TextEncoder().encode(JSON.stringify(payloadJson ?? {}));
    if (compression === SP_COMPRESS_GZIP) body = zlib.gzipSync(body);
  }
  return buildFrame({
    messageType,
    flags,
    serial,
    compression,
    seq,
    event,
    sessionId,
    payloadBytes: body,
  });
}

/** 生成一段 24kHz/int16 提示音（正弦 + 淡入淡出），用于验证播放链路。 */
export function makeBeepPcm(seconds = 0.4, freq = 440) {
  const n = Math.floor(24000 * seconds);
  const out = new Int16Array(n);
  const fade = Math.min(400, Math.floor(n / 2));
  for (let i = 0; i < n; i++) {
    const env = Math.min(1, i / fade, (n - i) / fade);
    out[i] = Math.round(Math.sin((2 * Math.PI * freq * i) / 24000) * 0.28 * 32767 * env);
  }
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}

/**
 * 启动一个本地 Mock 服务端。
 * onConnection({ ws, headers }) 可用于测试时断言上游收到的鉴权 header。
 */
export async function createMockDoubaoServer({ onConnection, onStartSession, onChatRagText } = {}) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve, reject) => {
    wss.once('listening', resolve);
    wss.once('error', reject);
  });
  const connections = new Set();
  const replied = new Set();
  const receivedRagTexts = [];

  wss.on('connection', (ws, req) => {
    connections.add(ws);
    if (onConnection) onConnection({ ws, headers: req.headers });
    ws.on('close', () => connections.delete(ws));
    ws.on('error', () => connections.delete(ws));
    ws.on('message', async (data) => {
      const frame = await parseFrame(data);
      if (!frame) return;
      const sid = frame.sessionId ?? '';
      if (frame.event === EV_START_CONNECTION) {
        ws.send(buildServerFrame({ event: EV_CONNECTION_STARTED, payloadJson: {} }));
      } else if (frame.event === EV_START_SESSION) {
        const dialog = frame.payloadJson?.dialog ?? {};
        const echo = {
          botName: dialog.bot_name ?? '',
          systemRole: dialog.system_role ?? '',
          speakingStyle: dialog.speaking_style ?? '',
        };
        if (onStartSession) onStartSession({ sessionId: sid, payloadJson: frame.payloadJson, echo });
        ws.send(
          buildServerFrame({
            event: EV_SESSION_STARTED,
            sessionId: sid,
            payloadJson: { echo },
          }),
        );
      } else if (frame.event === EV_FINISH_SESSION) {
        ws.send(buildServerFrame({ event: EV_SESSION_FINISHED, sessionId: sid, payloadJson: {} }));
      } else if (frame.event === EV_FINISH_CONNECTION) {
        ws.send(buildServerFrame({ event: EV_CONNECTION_STARTED, payloadJson: {} }));
        ws.close();
      } else if (frame.event === EV_CHAT_RAG_TEXT) {
        // 动态调整注入：Mock 收到 ChatRAGText(502) 后，回放一段"已采纳调整指引"的 LLM 文本，
        // 验证注入闭环（ASR → 本地决策 → ChatRAGText 注入 → 上游响应）。
        receivedRagTexts.push({ sessionId: sid, payload: frame.payloadJson });
        if (onChatRagText) onChatRagText({ sessionId: sid, payload: frame.payloadJson });
        ws.send(
          buildServerFrame({
            event: EV_LLM,
            sessionId: sid,
            payloadJson: {
              content: '（Mock·已采纳调整指引）我们换个角度来聊，先回到刚才的问题。',
            },
          }),
        );
      } else if (frame.event === EV_AUDIO && !replied.has(sid)) {
        replied.add(sid);
        // 先发打断事件（验证浏览器停止播放），再回文本与音频。
        ws.send(buildServerFrame({ event: EV_INTERRUPT, sessionId: sid, payloadJson: {} }));
        ws.send(
          buildServerFrame({
            event: EV_ASR,
            sessionId: sid,
            payloadJson: {
              results: [{ text: frame.payloadJson?.dialog?.mock_asr_text || '（Mock）我听到你说话了', is_interim: false }],
              extra: { endpoint: true },
            },
          }),
        );
        ws.send(
          buildServerFrame({
            event: EV_LLM,
            sessionId: sid,
            payloadJson: {
              content: frame.payloadJson?.dialog?.mock_llm_text || 'Mock 模式：这是一段模拟面试官回复，用来验证双向音频链路。',
            },
          }),
        );
        ws.send(
          buildServerFrame({
            messageType: SP_SERVER_ACK,
            flags: SP_FLAG_EVENT,
            event: EV_AUDIO,
            sessionId: sid,
            serial: SP_SERIAL_NONE,
            compression: SP_COMPRESS_NONE,
            payloadBytes: makeBeepPcm(),
          }),
        );
      }
    });
  });

  return {
    wss,
    get port() {
      return wss.address().port;
    },
    connections,
    receivedRagTexts,
    close: () =>
      new Promise((resolve) => {
        for (const ws of [...connections]) {
          try {
            ws.terminate();
          } catch {}
        }
        wss.close(() => resolve());
      }),
  };
}
