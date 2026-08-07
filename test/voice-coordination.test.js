import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';

import { ArchiveStore } from '../src/archive/index.js';
import { readVoiceConfig, startVoiceServer } from '../src/voice/bridge.js';
import {
  createVoiceCoordination,
  createVoiceInterviewSession,
  buildInterviewerSystemPrompt,
  handleAsrText,
  collectChatResponse,
  finishVoiceSession,
} from '../src/voice/coordination.js';
import { buildFallbackPlan } from '../src/preanalysis/fallback.js';
import {
  buildAudioFrame,
  buildControlFrame,
  parseFrame,
  EV_CONNECTION_STARTED,
  EV_SESSION_STARTED,
  EV_START_CONNECTION,
  EV_START_SESSION,
  EV_FINISH_SESSION,
  EV_ASR,
  EV_LLM,
} from '../src/voice/protocol.js';

const silent = { info() {}, error() {} };

function tmpStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ip-voice-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new ArchiveStore(dir);
}

function seedStore(store) {
  const company = store.createCompany({ name: '星宸科技' });
  const position = store.createPosition(company.companyId, { title: '高级后端工程师', jobType: 'tech' });
  store.updatePosition(company.companyId, position.positionId, {
    profile: {
      responsibilities: ['负责订单系统设计'],
      requirements: ['熟悉 Java'],
      keywords: ['订单'],
    },
  });
  store.createResumeVersion({
    rawText: '张三，后端工程师，熟悉 Redis，负责订单系统 QPS 提升',
    profile: {
      basics: { name: '张三', title: '后端工程师' },
      skills: [{ name: 'Redis', level: '熟练' }],
      experiences: [{ id: 'exp_1', summary: '负责订单系统，QPS 提升 4 倍', org: '星宸科技' }],
    },
  });
  return { company, position };
}

function onceOpen(ws) {
  return new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
}

async function waitFor(fn, { timeout = 4000, interval = 20 } = {}) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, interval));
  }
}

function jobProfileLike(position, companyName = '') {
  return {
    companyName,
    title: position.title,
    jobType: position.jobType,
    responsibilities: position.profile?.responsibilities ?? [],
  };
}

test('System Prompt：包含人设/画像/策略/节奏，长度 ≤2000，轮次间不同', (t) => {
  const store = tmpStore(t);
  const { company, position } = seedStore(store);
  const resumeVersion = store.getLatestResumeVersion();
  const plan = buildFallbackPlan({ resumeVersion, company, position });

  const p1 = buildInterviewerSystemPrompt({
    preanalysisPlan: plan,
    roundKey: 'round1',
    resumeProfile: resumeVersion.profile,
    jobProfile: jobProfileLike(position),
  });
  assert.ok(p1.length > 0 && p1.length <= 2000, `长度 ${p1.length} ≤ 2000`);
  assert.ok(p1.includes('一面简历面'));
  assert.ok(p1.includes('候选人画像'));
  assert.ok(p1.includes('本场考察策略'));
  assert.ok(p1.includes('节奏与体验'));

  const p2 = buildInterviewerSystemPrompt({
    preanalysisPlan: plan,
    roundKey: 'round2',
    resumeProfile: resumeVersion.profile,
    jobProfile: jobProfileLike(position),
  });
  assert.notEqual(p1, p2, '轮次不同 System Prompt 不同');
  assert.ok(p2.includes('二面业务面'));
  // ④层跨轮去重清单 + ⑤层跨轮风险传递（轮次提示词含跨轮去重与跨轮风险传递）
  assert.ok(p2.includes('跨轮去重'), '二面 System Prompt 含跨轮去重清单');
  assert.ok(p2.includes('跨轮风险跟进'), '二面 System Prompt 含跨轮风险传递');
  // 动态调整指令（计划是基线不是脚本）
  assert.ok(p2.includes('动态调整'), 'System Prompt 含动态调整指令');

  const positionB = { ...position, title: '产品经理', jobType: 'product' };
  const planB = buildFallbackPlan({ resumeVersion, company, position: positionB });
  const p3 = buildInterviewerSystemPrompt({
    preanalysisPlan: planB,
    roundKey: 'round1',
    resumeProfile: resumeVersion.profile,
    jobProfile: jobProfileLike(positionB),
  });
  assert.notEqual(p1, p3, '岗位不同 System Prompt 不同');

  const companyC = store.createCompany({ name: '云帆科技' });
  const positionC = store.createPosition(companyC.companyId, { title: '高级后端工程师', jobType: 'tech' });
  store.updatePosition(companyC.companyId, positionC.positionId, {
    profile: {
      responsibilities: ['负责订单系统设计'],
      requirements: ['熟悉 Java'],
      keywords: ['订单'],
    },
  });
  const planC = buildFallbackPlan({ resumeVersion, company: companyC, position: positionC });
  const p4 = buildInterviewerSystemPrompt({
    preanalysisPlan: planC,
    roundKey: 'round3',
    resumeProfile: resumeVersion.profile,
    jobProfile: jobProfileLike(positionC, '云帆科技'),
  });
  const p5 = buildInterviewerSystemPrompt({
    preanalysisPlan: plan,
    roundKey: 'round3',
    resumeProfile: resumeVersion.profile,
    jobProfile: jobProfileLike(position, '星宸科技'),
  });
  assert.notEqual(p4, p5, '公司不同 System Prompt 不同（含 round3）');
  assert.ok(p4.includes('云帆科技'), 'System Prompt 含目标公司名');
});

test('ASR 文本回写：executionTrace 出现信号/耗时记录，并返回下一问题', async (t) => {
  const store = tmpStore(t);
  const { company, position } = seedStore(store);
  const created = await createVoiceInterviewSession({
    store,
    llm: null,
    companyId: company.companyId,
    positionId: position.positionId,
    roundKey: 'round1',
  });

  const next = await handleAsrText(created.session, '我负责订单系统的核心模块');
  assert.ok(next && next.question, '返回下一问题');
  assert.equal(created.session.signals.length, 1);
  assert.ok(created.session.executionTrace.length >= 1);
  const entry = created.session.executionTrace[0];
  assert.ok(entry.signals?.difficulty, '有信号');
  assert.ok(Number.isFinite(entry.elapsedMs), '有实际耗时');
  assert.ok('adjustment' in entry, '有调整标记');
});

test('动态调整闭环：正常回答不注入，显著卡壳触发 switch-line 注入指引', async (t) => {
  const store = tmpStore(t);
  const { company, position } = seedStore(store);
  const created = await createVoiceInterviewSession({
    store,
    llm: null,
    companyId: company.companyId,
    positionId: position.positionId,
    roundKey: 'round1',
  });

  // 第一轮正常回答：currentId=null → nextBaseline 设置 currentMainlineId，无调整 → 无注入
  const r1 = await handleAsrText(created.session, '我负责订单系统的核心模块，QPS 提升 4 倍，用了 Redis 做缓存');
  assert.ok(r1 && r1.question, '第一轮返回下一问题');
  assert.ok(!r1.injection, '正常回答不触发注入');

  // 第二轮严重卡壳（嗯嗯呃呃 → high+poor+shallow → collapsed → switch-line）→ 注入调整指引
  const r2 = await handleAsrText(created.session, '嗯嗯呃呃');
  assert.ok(r2, '第二轮返回结果');
  assert.ok(r2.injection, '严重卡壳触发动态调整注入');
  assert.ok(Array.isArray(r2.injection) && r2.injection.length > 0, '注入为 RAG 条目数组');
  assert.ok(r2.injection[0].title && r2.injection[0].content, 'RAG 条目含 title/content');
  assert.ok(
    r2.adjustment === 'switch-line' || r2.adjustment === 'level-down',
    `显著调整类型=${r2.adjustment}`,
  );
});

test('ChatResponse 文本采集：面试官发言进入 session，且不重复采集', async (t) => {
  const store = tmpStore(t);
  const { company, position } = seedStore(store);
  const created = await createVoiceInterviewSession({
    store,
    llm: null,
    companyId: company.companyId,
    positionId: position.positionId,
    roundKey: 'round1',
  });
  const before = created.session.turns.length;
  const text = 'Mock 面试官：请继续讲讲你的方案。';
  collectChatResponse(created.session, text);
  assert.equal(created.session.turns.length, before + 1);
  assert.equal(created.session.turns[created.session.turns.length - 1].role, 'interviewer');
  collectChatResponse(created.session, text);
  assert.equal(created.session.turns.length, before + 1, '重复发言不重复采集');
});

test('通话结束触发复盘：报告与记录引用本场会话与 executionTrace', async (t) => {
  const store = tmpStore(t);
  const { company, position } = seedStore(store);
  const created = await createVoiceInterviewSession({
    store,
    llm: null,
    companyId: company.companyId,
    positionId: position.positionId,
    roundKey: 'round1',
  });
  await handleAsrText(created.session, '我负责订单系统的核心模块，QPS 提升 4 倍');
  await handleAsrText(created.session, '用了 Redis 做缓存，还做了降级方案');
  collectChatResponse(created.session, '好的，思路清晰。');

  const result = await finishVoiceSession({
    store,
    llm: null,
    session: created.session,
    companyId: company.companyId,
    positionId: position.positionId,
    roundKey: 'round1',
  });
  assert.equal(result.summary.state, 'closed');
  assert.ok(result.summary.executionTrace.length >= 1, '摘要含 executionTrace');
  assert.ok(result.review.record.reviewId, '复盘记录已写入');
  assert.ok(result.review.report.includes('复盘'), '生成复盘报告');
  assert.equal(result.review.record.sessionId, created.session.sessionId, '记录关联本场会话');
  assert.ok(store.listReviews({ companyId: company.companyId, positionId: position.positionId, roundKey: 'round1' }).length >= 1);
});

test('并发结束只触发一次复盘：不重复收尾、不重复写记录，摘要暴露信号', async (t) => {
  const store = tmpStore(t);
  const { company, position } = seedStore(store);
  const coordination = createVoiceCoordination({ store, llm: null, log: silent });
  const { sessionKey } = await coordination.start({
    companyId: company.companyId,
    positionId: position.positionId,
    roundKey: 'round1',
  });
  await coordination.handleAsr(sessionKey, '我负责订单系统的核心模块，QPS 提升 4 倍');
  const [r1, r2] = await Promise.all([
    coordination.finish(sessionKey),
    coordination.finish(sessionKey),
  ]);
  assert.equal(r1, r2, '并发 finish 复用同一结果');
  const records = store.listReviews({ companyId: company.companyId, positionId: position.positionId, roundKey: 'round1' });
  assert.equal(records.length, 1, '只写一份复盘记录');
  const info = coordination.getSessionInfo(sessionKey);
  assert.equal(info.summary.state, 'closed');
  const closings = info.summary.focusAreas.filter((f) => f === '收尾');
  assert.equal(closings.length, 1, '只收尾一次');
  assert.ok(Array.isArray(info.summary.signals), '摘要暴露 signals 供状态面板读取');
  assert.ok(info.summary.signals.length >= 1);
});

test('端到端：mock 模式 StartSession 注入 System Prompt，ASR/Chat 回写，结束生成复盘', async (t) => {
  const store = tmpStore(t);
  const { company, position } = seedStore(store);
  const coordination = createVoiceCoordination({ store, llm: null });
  const base = readVoiceConfig({ VOICE_MOCK: '1' });
  const bridge = await startVoiceServer({
    port: 0,
    config: { ...base, mock: true, requireEnv: false },
    coordination,
    log: silent,
  });
  t.after(async () => {
    await bridge.stop();
  });

  const startRes = await fetch(`${bridge.url}/voice/start-session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      companyId: company.companyId,
      positionId: position.positionId,
      roundKey: 'round1',
    }),
  });
  const startData = await startRes.json();
  assert.ok(startData.sessionKey, '返回 sessionKey');
  assert.ok(startData.config.systemRole.includes('一面简历面'), 'System Prompt 含轮次定位');

  const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}/voice/ws`);
  const frames = [];
  ws.on('message', (data) => {
    parseFrame(data).then((f) => frames.push(f));
  });
  await onceOpen(ws);
  ws.send(buildControlFrame(EV_START_CONNECTION, { sessionId: null }));
  await waitFor(() => frames.some((f) => f.event === EV_CONNECTION_STARTED));

  ws.send(
    buildControlFrame(EV_START_SESSION, {
      sessionId: startData.sessionKey,
      payload: {
        tts: {},
        dialog: {
          mock_asr_text: '我负责订单系统的核心模块',
          mock_llm_text: 'Mock 面试官：请继续讲讲你的方案。',
        },
      },
    }),
  );
  await waitFor(() => frames.some((f) => f.event === EV_SESSION_STARTED));
  const started = frames.find((f) => f.event === EV_SESSION_STARTED);
  assert.equal(started.payloadJson.echo.botName, startData.config.botName, '注入 botName');
  assert.equal(started.payloadJson.echo.systemRole, startData.config.systemRole, '注入 systemRole');
  assert.equal(started.payloadJson.echo.speakingStyle, startData.config.speakingStyle, '注入 speakingStyle');

  ws.send(buildAudioFrame(startData.sessionKey, new Uint8Array(640)));
  await waitFor(() => frames.some((f) => f.event === EV_ASR));
  await waitFor(() => frames.some((f) => f.event === EV_LLM));
  await waitFor(() => coordination.getSessionInfo(startData.sessionKey).summary.depth >= 1);
  await waitFor(() => coordination.getSessionInfo(startData.sessionKey).summary.turnCount >= 3);

  ws.send(buildControlFrame(EV_FINISH_SESSION, { sessionId: startData.sessionKey }));
  await waitFor(() => coordination.getReport(startData.sessionKey) !== null);

  const reviewRes = await fetch(`${bridge.url}/voice/review/${startData.sessionKey}`);
  const reviewData = await reviewRes.json();
  assert.ok(reviewData.review.record.reviewId, '复盘记录可拉取');
  const info = coordination.getSessionInfo(startData.sessionKey);
  assert.ok(info.summary.executionTrace.length >= 1);
  assert.ok(info.summary.executionTrace[0].signals, 'trace 含信号');
});
