import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';

import { ArchiveStore } from '../src/archive/index.js';
import { OpenClawGatewayClient, startGatewayBootstrap, createCommandRouter, createDualAgentOrchestrator, createOfflineOutbox } from '../src/gateway/index.js';
import { buildConnectParams, buildRequestFrame, parseFrame, subagentSessionKey } from '../src/gateway/protocol.js';

const silent = { info() {}, error() {}, warn() {} };

function tmpDir(t, prefix = 'ip-gateway-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function sendRes(ws, id, ok, payloadOrError) {
  ws.send(JSON.stringify({ type: 'res', id, ok, ...(ok ? { payload: payloadOrError } : { error: payloadOrError }) }));
}

/**
 * 本地 Mock Gateway：实现 connect 握手 / chat.send / agent / chat.history / sessions.list，
 * 用于无真实配对设备时验证客户端协议逻辑。
 */
async function createMockGatewayServer({ token = 'test-token', requirePairing = false, onRequest = null } = {}) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve, reject) => {
    wss.once('listening', resolve);
    wss.once('error', reject);
  });
  const requests = [];
  const connections = new Set();

  wss.on('connection', (ws) => {
    connections.add(ws);
    ws.on('close', () => connections.delete(ws));
    ws.on('error', () => connections.delete(ws));
    ws.send(
      JSON.stringify({
        type: 'event',
        event: 'connect.challenge',
        payload: { nonce: randomUUID(), ts: Date.now() },
      }),
    );
    ws.on('message', (data) => {
      let frame;
      try {
        frame = JSON.parse(String(data));
      } catch {
        return;
      }
      if (frame?.type !== 'req') return;
      requests.push(frame);
      onRequest?.(frame, ws);
      handleRequest(ws, frame);
    });
  });

  function handleRequest(ws, frame) {
    const { method, params = {}, id } = frame;
    if (method === 'connect') {
      if (requirePairing || params.auth?.token !== token) {
        sendRes(ws, id, false, {
          code: 'NOT_PAIRED',
          message: 'device identity required',
          details: { code: 'DEVICE_IDENTITY_REQUIRED', recommendedNextStep: 'pair_device' },
        });
        return;
      }
      sendRes(ws, id, true, {
        type: 'hello-ok',
        protocol: 4,
        server: { id: 'mock-openclaw', version: '2026.6.11' },
        features: {
          methods: ['connect', 'chat.send', 'agent', 'chat.history', 'sessions.list'],
          events: ['chat', 'agent', 'talk.event', 'presence'],
        },
        snapshot: { stateVersion: 1 },
        policy: { maxPayload: 26214400, maxBufferedBytes: 67108864, tickIntervalMs: 15000 },
        auth: { role: 'operator', scopes: ['operator.read', 'operator.write'] },
      });
      return;
    }
    if (method === 'chat.send') {
      if (!params.idempotencyKey) {
        sendRes(ws, id, false, { code: 'INVALID_REQUEST', message: 'idempotencyKey required' });
        return;
      }
      const runId = `run-${randomUUID()}`;
      sendRes(ws, id, true, { runId, acceptedAt: Date.now() });
      setTimeout(() => {
        ws.send(
          JSON.stringify({
            type: 'event',
            event: 'agent',
            payload: { runId, seq: 1, kind: 'assistant', content: `收到：${params.message}` },
            seq: 1,
          }),
        );
      }, 5);
      setTimeout(() => {
        ws.send(
          JSON.stringify({
            type: 'event',
            event: 'chat',
            payload: {
              runId,
              sessionKey: params.sessionKey,
              kind: 'final',
              message: `回复：${params.message}`,
            },
            seq: 2,
          }),
        );
      }, 10);
      return;
    }
    if (method === 'agent') {
      if (!params.idempotencyKey) {
        sendRes(ws, id, false, { code: 'INVALID_REQUEST', message: 'idempotencyKey required' });
        return;
      }
      sendRes(ws, id, true, { runId: `sub-${randomUUID()}`, acceptedAt: Date.now() });
      return;
    }
    if (method === 'chat.history') {
      sendRes(ws, id, true, { messages: [], hasMore: false });
      return;
    }
    if (method === 'sessions.list') {
      sendRes(ws, id, true, { sessions: [{ sessionKey: 'agent:main:main', agent: 'main' }] });
      return;
    }
    sendRes(ws, id, false, { code: 'UNSUPPORTED', message: `unsupported method: ${method}` });
  }

  return {
    port: wss.address().port,
    url: `ws://127.0.0.1:${wss.address().port}/ws`,
    requests,
    close: () =>
      new Promise((resolve) => {
        for (const ws of connections) ws.close();
        wss.close(() => resolve());
      }),
  };
}

async function waitFor(fn, { timeout = 3000, interval = 20 } = {}) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, interval));
  }
}

function seedStore(store) {
  store.createResumeVersion({
    rawText: '张三，熟悉 Redis、Kafka，负责订单系统，QPS 从 500 提升到 2000。',
    profile: {
      basics: { name: '张三', title: '后端工程师' },
      skills: [
        { name: 'Redis', level: '熟练' },
        { name: 'Kafka', level: '熟悉' },
      ],
      experiences: [{ id: 'exp_1', summary: '负责订单系统，QPS 提升 4 倍', org: '星辰科技' }],
    },
  });
}

test('gateway 协议：帧构造与解析、子代理会话键', () => {
  const req = buildRequestFrame('chat.send', { sessionKey: 'agent:main:main' }, 'req-1');
  assert.deepEqual(req, {
    type: 'req',
    id: 'req-1',
    method: 'chat.send',
    params: { sessionKey: 'agent:main:main' },
  });

  const frame = parseFrame(JSON.stringify({ type: 'res', id: 'req-1', ok: true, payload: { runId: 'r1' } }));
  assert.equal(frame.type, 'res');
  assert.equal(frame.ok, true);
  assert.equal(frame.payload.runId, 'r1');
  assert.equal(parseFrame('not-json'), null);

  const params = buildConnectParams({ token: 't', scopes: ['operator.read', 'operator.write'] });
  assert.equal(params.minProtocol, 4);
  assert.equal(params.maxProtocol, 4);
  assert.equal(params.role, 'operator');
  assert.equal(params.client.id, 'gateway-client');
  assert.equal(params.auth.token, 't');

  assert.match(subagentSessionKey('interviewer'), /^agent:interviewer:subagent:/);
});

test('gateway 客户端：challenge → connect 握手（协议 4），hello-ok 返回 features', async (t) => {
  const server = await createMockGatewayServer();
  t.after(() => server.close());

  const client = new OpenClawGatewayClient({ url: server.url, token: 'test-token', log: silent });
  t.after(() => client.close());

  const hello = await client.connect();
  assert.equal(hello.protocol, 4);
  assert.ok(hello.features.methods.includes('chat.send'));
  assert.equal(client.connected, true);

  const connectFrame = server.requests.find((r) => r.method === 'connect');
  assert.equal(connectFrame.params.minProtocol, 4);
  assert.equal(connectFrame.params.maxProtocol, 4);
  assert.equal(connectFrame.params.role, 'operator');
  assert.deepEqual(connectFrame.params.scopes, ['operator.read', 'operator.write']);
  assert.equal(connectFrame.params.client.id, 'gateway-client');
  assert.equal(connectFrame.params.auth.token, 'test-token');
});

test('gateway 客户端：chat.send 携带幂等键，agent/chat 事件流式推送', async (t) => {
  const server = await createMockGatewayServer();
  t.after(() => server.close());

  const client = new OpenClawGatewayClient({ url: server.url, token: 'test-token', log: silent });
  t.after(() => client.close());
  await client.connect();

  const events = [];
  client.on('agent', (payload) => events.push(['agent', payload]));
  client.on('chat', (payload) => events.push(['chat', payload]));

  const res = await client.chatSend({
    sessionKey: 'agent:main:agent_chat:interviewpal',
    message: '上传简历',
    idempotencyKey: 'chat-idem-1',
  });
  assert.ok(res.runId);
  assert.ok(res.acceptedAt);

  const sendFrame = server.requests.find((r) => r.method === 'chat.send');
  assert.equal(sendFrame.params.idempotencyKey, 'chat-idem-1');
  assert.equal(sendFrame.params.sessionKey, 'agent:main:agent_chat:interviewpal');

  await waitFor(() => events.some(([kind]) => kind === 'agent'));
  await waitFor(() => events.some(([kind, p]) => kind === 'chat' && p.kind === 'final'));
  const chatFinal = events.find(([kind, p]) => kind === 'chat' && p.kind === 'final');
  assert.match(chatFinal[1].message, /^回复：/);
  assert.equal(client.lastSeq, 2);
});

test('gateway 客户端：未配对返回结构化 GatewayError，可识别为配对类错误', async (t) => {
  const server = await createMockGatewayServer({ requirePairing: true });
  t.after(() => server.close());

  const client = new OpenClawGatewayClient({ url: server.url, token: 'wrong-token', log: silent });
  t.after(() => client.close());

  await assert.rejects(
    () => client.connect(),
    (err) => {
      assert.equal(err.name, 'GatewayError');
      assert.equal(err.code, 'NOT_PAIRED');
      assert.equal(err.details.code, 'DEVICE_IDENTITY_REQUIRED');
      assert.equal(err.retryable, false);
      return true;
    },
  );
});

test('gateway 子代理：agent RPC 返回 runId + childSessionKey（双 Agent 载体）', async (t) => {
  const server = await createMockGatewayServer();
  t.after(() => server.close());

  const client = new OpenClawGatewayClient({ url: server.url, token: 'test-token', log: silent });
  t.after(() => client.close());
  await client.connect();

  const orchestrator = createDualAgentOrchestrator({ client, mode: 'gateway' });
  const spawned = await orchestrator.spawnInterviewer({ task: '开始一面：请提问', model: 'deepseek-chat' });
  assert.equal(spawned.agent, 'interviewer');
  assert.equal(spawned.memory, 'amnesic');
  assert.ok(spawned.runId);
  assert.match(spawned.childSessionKey, /^agent:interviewer:subagent:/);

  const agentFrame = server.requests.find((r) => r.method === 'agent');
  assert.equal(agentFrame.params.sessionKey, spawned.childSessionKey);
  assert.equal(agentFrame.params.message, '开始一面：请提问');
  assert.ok(agentFrame.params.idempotencyKey);

  const local = createDualAgentOrchestrator({ store: new ArchiveStore(tmpDir(t)), mode: 'local' });
  const coach = await local.spawnCoach({ task: '复盘' });
  assert.equal(coach.agent, 'coach');
  assert.equal(coach.mode, 'local');
  assert.ok(coach.handle);
  assert.equal(coach.handle.name, 'coach');
});

test('命令路由：上传简历 → 粘贴 JD → 投递 → 开始一面 → 复盘报告', async (t) => {
  const dir = tmpDir(t);
  const store = new ArchiveStore(dir);
  const coordination = { start: async () => ({ sessionKey: 'voice-test', config: { botName: '面试官' } }) };
  const router = createCommandRouter({ store, coordination, log: silent });

  const help = await router.route('帮助');
  assert.equal(help.intent, 'help');
  assert.match(help.reply, /上传简历/);

  const resume = await router.route('上传简历\n张三，熟悉 Redis、Kafka，负责订单系统，QPS 提升 4 倍。');
  assert.equal(resume.ok, true);
  assert.equal(resume.intent, 'upload_resume');
  assert.match(resume.reply, /简历已存档/);
  assert.equal(resume.data.resumeVersionNo, 1);

  const jd = await router.route(
    '粘贴 JD\n公司：星辰科技\n岗位名称：高级后端工程师\n岗位职责：\n负责订单系统设计与高并发改造\n任职要求：\n熟悉 Java、Redis，3 年以上经验',
  );
  assert.equal(jd.ok, true);
  assert.equal(jd.intent, 'paste_jd');
  assert.match(jd.reply, /星辰科技/);
  assert.ok(jd.data.positionId);

  const apply = await router.route('投递到 星辰科技 高级后端工程师');
  assert.equal(apply.ok, true);
  assert.equal(apply.intent, 'apply');
  assert.match(apply.reply, /已投递/);
  assert.ok(apply.data.application);

  const round = await router.route('在 星辰科技 开始一面');
  assert.equal(round.ok, true);
  assert.equal(round.intent, 'start_round');
  assert.match(round.reply, /一面简历面/);
  assert.equal(round.data.sessionKey, 'voice-test');

  const review = await router.route('复盘报告');
  assert.equal(review.ok, true);
  assert.equal(review.intent, 'review');
  assert.match(review.reply, /还没有复盘记录/);

  const unknown = await router.route('随便说点什么');
  assert.equal(unknown.ok, true);
  assert.equal(unknown.intent, 'unknown');
});

test('离线发件箱：入队 → 真实网关补发 → 清空（§4.5 离线兜底）', async (t) => {
  const dir = tmpDir(t);
  const server = await createMockGatewayServer();
  t.after(() => server.close());

  const outbox = createOfflineOutbox({ dir, log: silent });
  outbox.enqueue({ sessionKey: 'agent:main:main', message: '离线消息一' });
  outbox.enqueue({ sessionKey: 'agent:main:main', message: '离线消息二' });
  assert.equal(outbox.stats().queued, 2);

  const boot = await startGatewayBootstrap({
    store: new ArchiveStore(dir),
    config: { url: server.url, token: 'test-token', dataDir: dir },
    outbox,
    log: silent,
  });
  t.after(() => boot.stop());
  assert.equal(boot.mode, 'gateway');

  const result = await boot.adapter.drainOutbox();
  assert.equal(result.sent.length, 2);
  assert.equal(result.remaining, 0);
  const sends = server.requests.filter((r) => r.method === 'chat.send' && String(r.params.message).startsWith('离线消息'));
  assert.equal(sends.length, 2);
  assert.ok(sends.every((r) => r.params.idempotencyKey.startsWith('offline-')));
});

test('bootstrap：无 token → mock 模式；token 错误/未配对 → 优雅降级 mock', async (t) => {
  const dir = tmpDir(t);

  const noToken = await startGatewayBootstrap({
    store: new ArchiveStore(dir),
    config: { token: '', dataDir: dir },
    log: silent,
  });
  assert.equal(noToken.mode, 'mock');
  assert.equal(noToken.client, null);
  await noToken.stop();

  const server = await createMockGatewayServer({ requirePairing: true });
  t.after(() => server.close());
  const degraded = await startGatewayBootstrap({
    store: new ArchiveStore(dir),
    config: { url: server.url, token: 'wrong', dataDir: dir },
    log: silent,
  });
  assert.equal(degraded.mode, 'mock');
  assert.equal(degraded.degradedFrom, 'gateway');
  assert.match(degraded.degradeReason, /device identity required/i);
  const inbound = await degraded.adapter.handleInboundMessage({ message: '帮助' });
  assert.equal(inbound.intent, 'help');
  await degraded.stop();
});

test('mock 适配器：本地端到端命令处理并写离线缓存', async (t) => {
  const dir = tmpDir(t);
  const boot = await startGatewayBootstrap({
    store: new ArchiveStore(dir),
    config: { mock: true, dataDir: dir },
    log: silent,
  });
  t.after(() => boot.stop());

  const result = await boot.adapter.handleInboundMessage({
    sessionKey: 'agent:main:agent_chat:interviewpal',
    message: '帮助',
  });
  assert.equal(result.ok, true);
  assert.equal(result.intent, 'help');
  const cached = boot.offlineCache.get('session:agent:main:agent_chat:interviewpal');
  assert.equal(cached.request, '帮助');
  assert.match(cached.reply, /上传简历/);

  const status = boot.status();
  assert.equal(status.mode, 'mock');
  assert.ok(status.outbox.queued >= 0);
  assert.deepEqual(status.agents, { mode: 'local', agents: ['interviewer', 'coach'] });
});
