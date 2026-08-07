import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ArchiveStore } from '../src/archive/index.js';
import { chatJson } from '../src/llm/provider.js';
import { generatePlan } from '../src/preanalysis/engine.js';
import {
  PREANALYSIS_SCHEMA,
  validatePlan,
  countSubDimensions,
  normalizePlan,
  MIN_SUB_DIMENSIONS,
} from '../src/preanalysis/schema.js';
import { buildFallbackPlan } from '../src/preanalysis/fallback.js';
import { preanalysisCacheKey } from '../src/preanalysis/cache.js';

function tmpStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ip-preanalysis-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new ArchiveStore(dir);
}

function makeResumeVersion(overrides = {}) {
  return {
    versionId: 'ver_test_1',
    versionNo: 1,
    rawText: '张三，熟悉 Redis、Kafka，2020 年在字节跳动负责订单系统，QPS 从 500 提升到 2000。',
    profile: {
      basics: { name: '张三', title: '后端工程师' },
      companies: ['字节跳动'],
      skills: [
        { name: 'Redis', level: '熟练' },
        { name: 'Kafka', level: '熟悉' },
      ],
      experiences: [
        { id: 'exp_1', summary: '在字节跳动负责订单系统，QPS 从 500 提升到 2000', org: '字节跳动' },
      ],
    },
    ...overrides,
  };
}

function makeCompany(overrides = {}) {
  return { companyId: 'c_1', name: '星宸科技', archived: false, notes: '', ...overrides };
}

function makePosition(overrides = {}) {
  return {
    positionId: 'p_1',
    companyId: 'c_1',
    title: '高级后端工程师',
    jobType: 'tech',
    profile: {
      responsibilities: ['负责订单系统设计', '参与高并发改造'],
      requirements: ['熟悉 Java', '3 年以上经验'],
      keywords: ['订单', '高并发'],
    },
    ...overrides,
  };
}

function fakeLlm({ onCall, output } = {}) {
  let calls = 0;
  const chat = async () => {
    calls += 1;
    if (onCall) onCall(calls);
    return typeof output === 'function' ? output(calls) : output;
  };
  chat.calls = () => calls;
  return chat;
}

test('schema：七大层结构校验拒绝非法 plan', () => {
  const bad = validatePlan({ layers: { jdAnalysis: {} } });
  assert.equal(bad.valid, false);
  assert.ok(bad.errors.length > 0);
  assert.ok(bad.errors.some((e) => e.includes('candidateProfile')), '缺②候选人画像层');

  const notPlan = validatePlan(null);
  assert.equal(notPlan.valid, false);
});

test('schema：规则兜底 plan 合法且子维度数 ≥ 45', () => {
  const plan = buildFallbackPlan({
    resumeVersion: makeResumeVersion(),
    company: makeCompany(),
    position: makePosition(),
  });
  const check = validatePlan(plan);
  assert.equal(check.valid, true, check.errors.join('; '));
  assert.ok(check.subDimensions >= MIN_SUB_DIMENSIONS, `子维度 ${check.subDimensions} >= ${MIN_SUB_DIMENSIONS}`);
  assert.ok(countSubDimensions(plan) >= MIN_SUB_DIMENSIONS);
});

test('generatePlan：无 LLM 时走规则兜底，输出合法七大层', async () => {
  const result = await generatePlan({
    resumeVersion: makeResumeVersion(),
    company: makeCompany(),
    position: makePosition(),
    llm: null,
  });
  assert.equal(result.source, 'rules');
  assert.equal(result.cached, false);
  assert.equal(result.cacheKey, 'ver_test_1::c_1::p_1');
  const check = validatePlan(result.plan);
  assert.equal(check.valid, true, check.errors.join('; '));
});

test('generatePlan：LLM 返回合法 JSON 走 LLM 路径', async () => {
  const fallback = buildFallbackPlan({
    resumeVersion: makeResumeVersion(),
    company: makeCompany(),
    position: makePosition(),
  });
  const llm = fakeLlm({ output: JSON.stringify(fallback) });
  const result = await generatePlan({
    resumeVersion: makeResumeVersion(),
    company: makeCompany(),
    position: makePosition(),
    llm,
  });
  assert.equal(result.source, 'llm');
  assert.equal(llm.calls(), 1);
  const check = validatePlan(result.plan);
  assert.equal(check.valid, true, check.errors.join('; '));
});

test('generatePlan：LLM 返回垃圾自动落回规则', async () => {
  const llm = fakeLlm({ output: '这不是 JSON' });
  const result = await generatePlan({
    resumeVersion: makeResumeVersion(),
    company: makeCompany(),
    position: makePosition(),
    llm,
  });
  assert.equal(result.source, 'rules');
  assert.equal(llm.calls(), 2, 'chatJson 带 schema 重试一次后放弃');
  const check = validatePlan(result.plan);
  assert.equal(check.valid, true);
});

test('generatePlan：LLM 输出结构不合法（缺层/子维度不足）自动落回规则', async () => {
  const llm = fakeLlm({
    output: JSON.stringify({
      layers: {
        jdAnalysis: {},
        candidateProfile: {},
        interviewerPersona: {},
        roundStrategy: {},
        riskForecast: {},
        reviewFramework: {},
        rhythmDesign: {},
      },
    }),
  });
  const result = await generatePlan({
    resumeVersion: makeResumeVersion(),
    company: makeCompany(),
    position: makePosition(),
    llm,
  });
  assert.equal(result.source, 'rules');
});

test('缓存：同一 简历版本+公司+岗位 二次调用命中缓存，LLM 只调用 1 次', async (t) => {
  const store = tmpStore(t);
  const llm = fakeLlm({
    output: JSON.stringify(
      buildFallbackPlan({ resumeVersion: makeResumeVersion(), company: makeCompany(), position: makePosition() }),
    ),
  });
  const first = await generatePlan({
    resumeVersion: makeResumeVersion(),
    company: makeCompany(),
    position: makePosition(),
    llm,
    store,
  });
  assert.equal(first.source, 'llm');
  assert.equal(llm.calls(), 1);

  const second = await generatePlan({
    resumeVersion: makeResumeVersion(),
    company: makeCompany(),
    position: makePosition(),
    llm,
    store,
  });
  assert.equal(second.source, 'cache');
  assert.equal(second.cached, true);
  assert.equal(llm.calls(), 1, '缓存命中后不再调用 LLM');
  assert.deepEqual(second.plan, first.plan);
});

test('缓存：简历版本变化后自动失效重新生成', async (t) => {
  const store = tmpStore(t);
  let calls = 0;
  const llm = fakeLlm({
    onCall: () => calls++,
    output: () =>
      JSON.stringify(
        buildFallbackPlan({ resumeVersion: makeResumeVersion(), company: makeCompany(), position: makePosition() }),
      ),
  });
  const args = (versionId, versionNo) => ({
    resumeVersion: makeResumeVersion({ versionId, versionNo }),
    company: makeCompany(),
    position: makePosition(),
    llm,
    store,
  });

  const v1 = await generatePlan(args('ver_a', 1));
  assert.equal(v1.source, 'llm');
  const v1again = await generatePlan(args('ver_a', 1));
  assert.equal(v1again.source, 'cache');

  const v2 = await generatePlan(args('ver_b', 2));
  assert.equal(v2.source, 'llm', '换版本后缓存失效重新生成');
  assert.equal(calls, 2);
});

test('缓存：删除岗位后该岗位预分析缓存被释放', async (t) => {
  const store = tmpStore(t);
  const llm = fakeLlm({
    output: JSON.stringify(
      buildFallbackPlan({ resumeVersion: makeResumeVersion(), company: makeCompany(), position: makePosition() }),
    ),
  });
  await generatePlan({
    resumeVersion: makeResumeVersion(),
    company: makeCompany(),
    position: makePosition(),
    llm,
    store,
  });
  assert.ok(store.getPreanalysisCache('ver_test_1::c_1::p_1'));

  store.deletePosition('c_1', 'p_1');
  assert.equal(store.getPreanalysisCache('ver_test_1::c_1::p_1'), null, '岗位删除后缓存释放');
  assert.equal(store.getPosition('c_1', 'p_1'), null);
});

test('删除即释放：删除岗位时该岗位的复盘记录一并清理', async (t) => {
  const store = tmpStore(t);
  const { companyId } = store.createCompany({ name: '星辰科技' });
  const { positionId } = store.createPosition(companyId, { title: '后端', jobType: 'tech' });
  const { positionId: p2 } = store.createPosition(companyId, { title: '前端', jobType: 'tech' });
  // 给两个岗位各写一条复盘
  store.saveReview({
    reviewId: 'rv_a', companyId, positionId, roundKey: 'round1',
    scores: { logic: 3 }, improvementList: [], createdAt: '2026-08-01T00:00:00Z',
  });
  store.saveReview({
    reviewId: 'rv_b', companyId, positionId: p2, roundKey: 'round1',
    scores: { logic: 4 }, improvementList: [], createdAt: '2026-08-01T00:00:00Z',
  });
  assert.equal(store.listReviews({ companyId, positionId }).length, 1, '删除前 p1 有 1 条复盘');
  // 删除岗位 p1
  store.deletePosition(companyId, positionId);
  // p1 的复盘应被清理
  assert.equal(store.listReviews({ companyId, positionId }).length, 0, '删除岗位后 p1 复盘被清理');
  // p2 的复盘不受影响
  assert.equal(store.listReviews({ companyId, positionId: p2 }).length, 1, 'p2 复盘不受影响');
});

test('缓存：删除公司后该公司所有岗位的预分析缓存被释放', async (t) => {
  const store = tmpStore(t);
  const llm = fakeLlm({
    output: JSON.stringify(
      buildFallbackPlan({ resumeVersion: makeResumeVersion(), company: makeCompany(), position: makePosition() }),
    ),
  });
  await generatePlan({
    resumeVersion: makeResumeVersion(),
    company: makeCompany(),
    position: makePosition(),
    llm,
    store,
  });
  await generatePlan({
    resumeVersion: makeResumeVersion({ versionId: 'ver_b', versionNo: 2 }),
    company: makeCompany(),
    position: makePosition({ positionId: 'p_2' }),
    llm,
    store,
  });
  assert.ok(store.getPreanalysisCache('ver_test_1::c_1::p_1'));
  assert.ok(store.getPreanalysisCache('ver_b::c_1::p_2'));

  store.deleteCompany('c_1');
  assert.equal(store.getPreanalysisCache('ver_test_1::c_1::p_1'), null);
  assert.equal(store.getPreanalysisCache('ver_b::c_1::p_2'), null);
  assert.equal(store.listCompanyIds().includes('c_1'), false);
});

test('缓存键：格式与非法输入', () => {
  assert.equal(
    preanalysisCacheKey({ resumeVersion: 'ver_x', companyId: 'c_1', positionId: 'p_1' }),
    'ver_x::c_1::p_1',
  );
  assert.equal(
    preanalysisCacheKey({ resumeVersion: { versionId: 'ver_x' }, companyId: 'c_1', positionId: 'p_1' }),
    'ver_x::c_1::p_1',
  );
  assert.throws(() => preanalysisCacheKey({ resumeVersion: 'ver_x', companyId: '', positionId: 'p_1' }), /requires/);
});

test('chatJson：围栏 JSON 可解析，垃圾输出返回 null', async () => {
  const good = await chatJson(
    fakeLlm({ output: '```json\n{"ok":true}\n```' }),
    [{ role: 'user', content: 'hi' }],
    PREANALYSIS_SCHEMA,
  );
  assert.deepEqual(good, { ok: true });

  const bad = await chatJson(
    fakeLlm({ output: '这不是 JSON' }),
    [{ role: 'user', content: 'hi' }],
    PREANALYSIS_SCHEMA,
  );
  assert.equal(bad, null);
});

test('store：preanalysisCache 读写与更新时间', (t) => {
  const store = tmpStore(t);
  assert.equal(store.getPreanalysisCache('k'), null);
  store.setPreanalysisCache('k', { plan: 1 });
  assert.deepEqual(store.getPreanalysisCache('k'), { plan: 1 });
  assert.equal(store.deletePreanalysisCache('k'), true);
  assert.equal(store.getPreanalysisCache('k'), null);
  assert.equal(store.deletePreanalysisCache('k'), false);
});

test('normalizePlan：缺失版本号补 1', () => {
  const plan = buildFallbackPlan({
    resumeVersion: makeResumeVersion(),
    company: makeCompany(),
    position: makePosition(),
  });
  delete plan.version;
  assert.equal(normalizePlan(plan).version, 1);
});
