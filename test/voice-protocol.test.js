import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';

import {
  buildAudioFrame,
  buildChatRagFrame,
  buildControlFrame,
  parseFrame,
  SP_COMPRESS_GZIP,
  SP_COMPRESS_NONE,
  SP_FLAG_EVENT,
  SP_FLAG_NEG_SEQ,
  SP_SERVER_ACK,
  SP_SERVER_ERROR,
  SP_SERIAL_JSON,
  SP_SERIAL_NONE,
  EV_AUDIO,
  EV_CHAT_RAG_TEXT,
  EV_START_CONNECTION,
  EV_START_SESSION,
} from '../src/voice/protocol.js';
import { buildServerFrame, makeBeepPcm } from '../src/voice/mock.js';

function u32(value) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, value, false);
  return b;
}

test('客户端控制帧：StartConnection 不带 sessionId，字节布局正确', () => {
  const frame = buildControlFrame(EV_START_CONNECTION, { sessionId: null, payload: {} });
  const u8 = new Uint8Array(frame);
  assert.equal(u8[0], 0x11); // v1 + header_size=1
  assert.equal(u8[1], 0x14); // full-client request + hasEvent
  assert.equal(u8[2], 0x10); // JSON + 无压缩
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  assert.equal(dv.getUint32(4, false), EV_START_CONNECTION);
  assert.equal(dv.getUint32(8, false), 2); // payload "{}"
});

test('客户端会话帧与音频帧：携带 sessionId，payload 长度正确', () => {
  const sid = 'sid-123';
  const control = new Uint8Array(
    buildControlFrame(EV_START_SESSION, { sessionId: sid, payload: { tts: {} } }),
  );
  const dv = new DataView(control.buffer, control.byteOffset, control.byteLength);
  assert.equal(dv.getUint32(4, false), EV_START_SESSION);
  assert.equal(dv.getUint32(8, false), sid.length);
  assert.equal(new TextDecoder().decode(control.subarray(12, 12 + sid.length)), sid);

  const pcm = new Uint8Array([1, 2, 3, 4, 5, 6]);
  const audio = new Uint8Array(buildAudioFrame(sid, pcm));
  const av = new DataView(audio.buffer, audio.byteOffset, audio.byteLength);
  assert.equal(audio[1], 0x24); // audio-only request + hasEvent
  assert.equal(audio[2], 0x00); // raw + 无压缩
  assert.equal(av.getUint32(4, false), EV_AUDIO);
  assert.equal(av.getUint32(8, false), sid.length);
  const plOff = 12 + sid.length;
  assert.equal(av.getUint32(plOff, false), pcm.length);
  assert.deepEqual([...audio.subarray(plOff + 4)], [...pcm]);
});

test('服务端 JSON 帧（gzip）：解析出 event 与 payloadJson', async () => {
  const frame = buildServerFrame({ event: 50, payloadJson: { ok: true } });
  const parsed = await parseFrame(frame);
  assert.equal(parsed.event, 50);
  assert.deepEqual(parsed.payloadJson, { ok: true });
  assert.equal(parsed.sessionId, '');
});

test('服务端帧：NEG_SEQ + EVENT + sessionId 顺序解析', async () => {
  const frame = buildServerFrame({
    flags: SP_FLAG_NEG_SEQ | SP_FLAG_EVENT,
    seq: 7,
    event: 150,
    sessionId: 's1',
    payloadJson: {},
  });
  const parsed = await parseFrame(frame);
  assert.equal(parsed.seq, 7);
  assert.equal(parsed.event, 150);
  assert.equal(parsed.sessionId, 's1');
});

test('服务端音频帧：payloadBytes 原样透传', async () => {
  const pcm = makeBeepPcm(0.05);
  const frame = buildServerFrame({
    messageType: SP_SERVER_ACK,
    flags: SP_FLAG_EVENT,
    event: EV_AUDIO,
    sessionId: 's2',
    serial: SP_SERIAL_NONE,
    compression: SP_COMPRESS_NONE,
    payloadBytes: pcm,
  });
  const parsed = await parseFrame(frame);
  assert.equal(parsed.messageType, SP_SERVER_ACK);
  assert.equal(parsed.event, EV_AUDIO);
  assert.ok(parsed.payloadBytes && parsed.payloadBytes.length > 0);
  assert.deepEqual([...parsed.payloadBytes], [...pcm]);
});

test('服务端错误帧：解析 code 与 error 文本', async () => {
  const payload = zlib.gzipSync(Buffer.from('{"error":"bad config"}'));
  const frame = new Uint8Array(4 + 4 + 4 + payload.length);
  frame.set([0x11, 0xf0, 0x11, 0x00], 0);
  frame.set(u32(12345), 4);
  frame.set(u32(payload.length), 8);
  frame.set(payload, 12);
  const parsed = await parseFrame(frame);
  assert.equal(parsed.messageType, SP_SERVER_ERROR);
  assert.equal(parsed.code, 12345);
  assert.deepEqual(parsed.error, { error: 'bad config' });
});

test('ChatRAGText 帧：event=502，payload 含 external_rag JSON 字符串', async () => {
  const sid = 'rag-sid-1';
  const ragItems = [
    { title: '面试官调整提示', content: '候选人偏题，请拉回主线。' },
  ];
  const frame = buildChatRagFrame(sid, ragItems);
  const parsed = await parseFrame(frame);
  assert.equal(parsed.event, EV_CHAT_RAG_TEXT);
  assert.equal(parsed.sessionId, sid);
  assert.ok(parsed.payloadJson, 'payload 解析为 JSON');
  assert.ok(typeof parsed.payloadJson.external_rag === 'string', 'external_rag 为字符串');
  const rag = JSON.parse(parsed.payloadJson.external_rag);
  assert.ok(Array.isArray(rag) && rag.length === 1, 'RAG 条目为数组');
  assert.equal(rag[0].title, '面试官调整提示');
  assert.equal(rag[0].content, '候选人偏题，请拉回主线。');
});
