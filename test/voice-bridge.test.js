import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocket } from 'ws';

import { readVoiceConfig, startVoiceServer } from '../src/voice/bridge.js';
import { createMockDoubaoServer } from '../src/voice/mock.js';
import {
  buildAudioFrame,
  buildControlFrame,
  parseFrame,
  EV_CONNECTION_STARTED,
  EV_SESSION_STARTED,
  EV_START_CONNECTION,
  EV_START_SESSION,
  EV_AUDIO,
} from '../src/voice/protocol.js';

const silent = { info() {}, error() {} };

function onceOpen(ws) {
  return new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
}

async function waitFor(fn, { timeout = 3000, interval = 20 } = {}) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, interval));
  }
}

function upgradeStatus(url, { origin } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(url.replace(/^ws:/, 'http:')), {
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': 13,
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        ...(origin ? { Origin: origin } : {}),
      },
    });
    req.on('response', (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('upgrade', (_res, socket) => {
      socket.destroy();
      resolve(101);
    });
    req.on('error', reject);
    req.end();
  });
}

async function makeBridge({ env = {}, mock = false } = {}) {
  const config = readVoiceConfig(env);
  return startVoiceServer({ port: 0, config: { ...config, mock, requireEnv: false }, log: silent });
}

test('桥接：服务端凭据注入上游 header，StartConnection/StartSession/音频双向转发', async (t) => {
  let capturedHeaders = null;
  const mock = await createMockDoubaoServer({
    onConnection: ({ headers }) => {
      capturedHeaders = headers;
    },
  });
  const bridge = await makeBridge({
    env: {
      DOUBAO_APP_ID: 'test-app',
      DOUBAO_ACCESS_KEY: 'test-access-key',
      DOUBAO_WS_URL: `ws://127.0.0.1:${mock.port}`,
    },
  });
  t.after(async () => {
    await bridge.stop();
    await mock.close();
  });

  const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}/voice/ws`);
  const frames = [];
  ws.on('message', (data) => {
    parseFrame(data).then((f) => frames.push(f));
  });
  await onceOpen(ws);

  ws.send(buildControlFrame(EV_START_CONNECTION, { sessionId: null }));
  await waitFor(() => frames.some((f) => f.event === EV_CONNECTION_STARTED));
  assert.equal(capturedHeaders['x-api-app-id'], 'test-app');
  assert.equal(capturedHeaders['x-api-access-key'], 'test-access-key');
  assert.equal(capturedHeaders['x-api-resource-id'], 'volc.speech.dialog');
  assert.ok(capturedHeaders['x-api-connect-id']);
  assert.ok(capturedHeaders['x-api-app-key']);

  ws.send(buildControlFrame(EV_START_SESSION, { sessionId: 'sess-1', payload: { tts: {} } }));
  await waitFor(() => frames.some((f) => f.event === EV_SESSION_STARTED));

  ws.send(buildAudioFrame('sess-1', new Uint8Array(640)));
  await waitFor(() => frames.some((f) => f.event === EV_AUDIO && f.payloadBytes));
  const audio = frames.find((f) => f.event === EV_AUDIO && f.payloadBytes);
  assert.ok(audio.payloadBytes.length > 0);
});

test('桥接：服务端未配置凭据时允许页面 query 凭据（本地手测路径）', async (t) => {
  let capturedHeaders = null;
  const mock = await createMockDoubaoServer({
    onConnection: ({ headers }) => {
      capturedHeaders = headers;
    },
  });
  const bridge = await makeBridge({
    env: { DOUBAO_WS_URL: `ws://127.0.0.1:${mock.port}` },
  });
  t.after(async () => {
    await bridge.stop();
    await mock.close();
  });

  const ws = new WebSocket(
    `ws://127.0.0.1:${bridge.port}/voice/ws?appId=page-app&accessKey=page-key`,
  );
  const frames = [];
  ws.on('message', (data) => {
    parseFrame(data).then((f) => frames.push(f));
  });
  await onceOpen(ws);
  ws.send(buildControlFrame(EV_START_CONNECTION, { sessionId: null }));
  await waitFor(() => frames.some((f) => f.event === EV_CONNECTION_STARTED));
  assert.equal(capturedHeaders['x-api-app-id'], 'page-app');
  assert.equal(capturedHeaders['x-api-access-key'], 'page-key');
});

test('桥接：无任何凭据时拒绝握手（401），非本地 Origin 拒绝（403）', async (t) => {
  const mock = await createMockDoubaoServer();
  const bridge = await makeBridge({ env: { DOUBAO_WS_URL: `ws://127.0.0.1:${mock.port}` } });
  t.after(async () => {
    await bridge.stop();
    await mock.close();
  });

  const noCreds = await upgradeStatus(`ws://127.0.0.1:${bridge.port}/voice/ws`);
  assert.equal(noCreds, 401);

  const evilOrigin = await upgradeStatus(
    `ws://127.0.0.1:${bridge.port}/voice/ws?appId=a&accessKey=b`,
    { origin: 'http://evil.example' },
  );
  assert.equal(evilOrigin, 403);
});

test('桥接：/voice/status 返回模式与会话默认配置', async (t) => {
  const mock = await createMockDoubaoServer();
  const bridge = await makeBridge({
    env: {
      DOUBAO_APP_ID: 'app',
      DOUBAO_ACCESS_KEY: 'key',
      DOUBAO_WS_URL: `ws://127.0.0.1:${mock.port}`,
      DOUBAO_BOT_NAME: '一面面试官',
    },
  });
  t.after(async () => {
    await bridge.stop();
    await mock.close();
  });

  const res = await fetch(`${bridge.url}/voice/status`);
  const body = await res.json();
  assert.equal(body.envConfigured, true);
  assert.equal(body.mock, false);
  assert.equal(body.session.botName, '一面面试官');
  assert.ok(body.session.model);
});
