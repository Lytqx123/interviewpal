// 豆包端到端实时语音：二进制帧协议（协议 v1）。
// 浏览器与 Node 共用，不依赖任何 Node 内置模块。

export const SP_CLIENT_FULL = 0b0001;
export const SP_CLIENT_AUDIO = 0b0010;
export const SP_SERVER_FULL = 0b1001;
export const SP_SERVER_ACK = 0b1011;
export const SP_SERVER_ERROR = 0b1111;

export const SP_FLAG_NEG_SEQ = 0b0010;
export const SP_FLAG_EVENT = 0b0100;

export const SP_SERIAL_NONE = 0b0000;
export const SP_SERIAL_JSON = 0b0001;

export const SP_COMPRESS_NONE = 0b0000;
export const SP_COMPRESS_GZIP = 0b0001;

// 连接类事件（不带 sessionId）
export const EV_START_CONNECTION = 1;
export const EV_FINISH_CONNECTION = 2;
export const EV_CONNECTION_STARTED = 50;

// 会话类事件（带 sessionId）
export const EV_START_SESSION = 100;
export const EV_FINISH_SESSION = 102;
export const EV_SESSION_STARTED = 150;
export const EV_SESSION_FINISHED = 152;
export const EV_STREAM_FINISHED = 153;

// 音频与过程事件
export const EV_AUDIO = 200;
export const EV_SAY_HELLO = 300; // 客户端提交打招呼文本（开场注入）
export const EV_INTERRUPT = 450; // 客户端打断服务端响应（push_to_talk 模式）
export const EV_ASR = 451;
export const EV_LLM = 550;

// 文本注入类事件（豆包端到端实时语音 API：动态调整闭环用）
export const EV_CHAT_TTS_TEXT = 500; // 指定文本合成音频（替代模型闲聊结果）
export const EV_CHAT_TEXT_QUERY = 501; // 用户文本 query（替代音频输入）
export const EV_CHAT_RAG_TEXT = 502; // 注入外部 RAG 知识，模型总结后口语化播报

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function u32(value) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value >>> 0, false);
  return bytes;
}

function concatBytes(parts) {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const part of parts) {
    out.set(part, pos);
    pos += part.length;
  }
  return out;
}

/**
 * 组装一帧二进制消息。
 * - seq/event/sessionId 由调用方按需传入，字段出现顺序与协议表一致。
 * - payloadBytes 为 null 时 payload 为空。
 */
export function buildFrame({
  messageType,
  flags = 0,
  serial = SP_SERIAL_NONE,
  compression = SP_COMPRESS_NONE,
  seq = null,
  event = null,
  sessionId = null,
  payloadBytes = null,
}) {
  const header = new Uint8Array([
    (0b0001 << 4) | 0b0001, // protocol v1 + header_size=1（4 字节）
    ((messageType & 0x0f) << 4) | (flags & 0x0f),
    ((serial & 0x0f) << 4) | (compression & 0x0f),
    0x00,
  ]);
  const parts = [header];
  if (seq !== null) parts.push(u32(seq));
  if (event !== null) parts.push(u32(event));
  if (sessionId !== null) {
    const sid = encoder.encode(String(sessionId));
    parts.push(u32(sid.length), sid);
  }
  const body = payloadBytes === null ? new Uint8Array(0) : new Uint8Array(payloadBytes);
  parts.push(u32(body.length), body);
  return concatBytes(parts);
}

/** 客户端文本事件帧：如 StartConnection(1) / StartSession(100) / FinishSession(102)。 */
export function buildControlFrame(event, { sessionId = null, payload = {} } = {}) {
  return buildFrame({
    messageType: SP_CLIENT_FULL,
    flags: SP_FLAG_EVENT,
    serial: SP_SERIAL_JSON,
    compression: SP_COMPRESS_NONE,
    event,
    sessionId,
    payloadBytes: encoder.encode(JSON.stringify(payload ?? {})),
  });
}

/** 客户端音频帧：TaskRequest(200)，payload 为 16kHz/int16/单声道 PCM。 */
export function buildAudioFrame(sessionId, pcmBytes) {
  return buildFrame({
    messageType: SP_CLIENT_AUDIO,
    flags: SP_FLAG_EVENT,
    serial: SP_SERIAL_NONE,
    compression: SP_COMPRESS_NONE,
    event: EV_AUDIO,
    sessionId,
    payloadBytes: pcmBytes,
  });
}

/**
 * 客户端 ChatRAGText(502) 帧：向端到端实时语音模型注入外部 RAG 知识。
 * 模型会对 external_rag 内容做总结与口语化改写后播报。
 * 用途：动态调整闭环——当本地协调层判定需要显著调整（拉回/降档/换线/卡壳救援）时，
 *   把调整指引作为 RAG 注入上游，引导面试官下一轮回应方向。
 * @param {string} sessionId 会话 ID
 * @param {Array<{title:string,content:string}>} ragItems RAG 条目（整体 ≤4K 字符）
 */
export function buildChatRagFrame(sessionId, ragItems) {
  const externalRag = JSON.stringify(
    Array.isArray(ragItems) ? ragItems : [ragItems],
  );
  return buildFrame({
    messageType: SP_CLIENT_FULL,
    flags: SP_FLAG_EVENT,
    serial: SP_SERIAL_JSON,
    compression: SP_COMPRESS_NONE,
    event: EV_CHAT_RAG_TEXT,
    sessionId,
    payloadBytes: encoder.encode(JSON.stringify({ external_rag: externalRag })),
  });
}

/** gzip 解压（现代浏览器与 Node 18+ 均有 DecompressionStream）。 */
export async function gunzip(u8) {
  const ds = new DecompressionStream('gzip');
  const writer = ds.writable.getWriter();
  writer.write(u8);
  writer.close();
  const reader = ds.readable.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let pos = 0;
  for (const chunk of chunks) {
    out.set(chunk, pos);
    pos += chunk.length;
  }
  return out;
}

/**
 * 解析服务端帧（Full/ACK/Error）。
 * 返回统一结构；JSON payload 解析到 payloadJson，二进制 payload 保留在 payloadBytes。
 */
export async function parseFrame(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (u8.length < 4) return null;
  const headerSize = u8[0] & 0x0f;
  if (headerSize < 1 || u8.length < headerSize * 4) return null;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const messageType = u8[1] >> 4;
  const msgFlags = u8[1] & 0x0f;
  const serial = u8[2] >> 4;
  const compress = u8[2] & 0x0f;
  const result = {
    messageType,
    msgFlags,
    serial,
    compress,
    seq: null,
    event: null,
    sessionId: null,
    payloadSize: 0,
    payloadBytes: null,
    payloadJson: null,
    payloadRaw: null,
    code: null,
    error: null,
  };
  let off = headerSize * 4;

  if (messageType === SP_SERVER_ERROR) {
    if (u8.length >= off + 4) result.code = dv.getUint32(off, false);
    off += 4;
    const plLen = u8.length >= off + 4 ? dv.getUint32(off, false) : 0;
    off += 4;
    let body = u8.slice(off, off + plLen);
    result.payloadSize = plLen;
    if (compress === SP_COMPRESS_GZIP && body.length) body = await gunzip(body);
    const text = decoder.decode(body);
    try {
      result.error = JSON.parse(text);
    } catch {
      result.error = text;
    }
    result.payloadRaw = text;
    return result;
  }

  if (
    messageType === SP_SERVER_FULL ||
    messageType === SP_SERVER_ACK ||
    messageType === SP_CLIENT_FULL ||
    messageType === SP_CLIENT_AUDIO
  ) {
    if (msgFlags & SP_FLAG_NEG_SEQ) {
      if (u8.length < off + 4) return result;
      result.seq = dv.getUint32(off, false);
      off += 4;
    }
    if (msgFlags & SP_FLAG_EVENT) {
      if (u8.length < off + 4) return result;
      result.event = dv.getUint32(off, false);
      off += 4;
    }
    if (u8.length < off + 4) return result;
    const sidLen = dv.getUint32(off, false);
    off += 4;
    if (u8.length < off + sidLen) return result;
    result.sessionId = decoder.decode(u8.subarray(off, off + sidLen));
    off += sidLen;
    if (u8.length < off + 4) return result;
    const plLen = dv.getUint32(off, false);
    off += 4;
    result.payloadSize = plLen;
    let body = u8.slice(off, off + plLen);
    if (compress === SP_COMPRESS_GZIP && body.length) body = await gunzip(body);
    if (serial === SP_SERIAL_JSON) {
      const text = decoder.decode(body);
      try {
        result.payloadJson = JSON.parse(text);
      } catch {
        result.payloadRaw = text;
      }
    } else {
      result.payloadBytes = body;
    }
  }
  return result;
}
