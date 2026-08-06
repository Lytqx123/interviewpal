import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ArchiveStore } from '../src/archive/index.js';
import { generatePlan } from '../src/preanalysis/engine.js';
import { buildFallbackPlan } from '../src/preanalysis/fallback.js';
import { buildPreAnalysisPrompt } from '../src/preanalysis/prompts.js';
import { buildBaselinePlan } from '../src/interviewer/engine.js';
import { diffPlanVsExecution, summarizeFeedbackForPrompt } from '../src/coach/feedback.js';
import {
  appendFeedbackToPlan,
  updateStrategyCacheWithFeedback,
  applyFeedbackAdjustments,
  MAX_FEEDBACK_ROUNDS,
} from '../src/coach/selfLearn.js';
import { reviewWithMemory } from '../src/coach/memory.js';
import { formatReport } from '../src/coach/report.js';

function tmpStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ip-coach-feedback-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new ArchiveStore(dir);
}

function seedStore(store) {
  const company = store.createCompany({ name: '星宸科技' });
  const position = store.createPosition(company.companyId, { title: '高级后端工程师', jobType: 'tech' });
  store.updatePosition(company.companyId, position.positionId, {
    profile: {
      responsibilities: ['负责订单系统设计', '参与高并发改造'],
      requirements: ['熟悉 Java', '3 年以上经验'],
      keywords: ['订单', '高并发'],
    },
  });
  store.createResumeVersion({
    rawText: '张三，熟悉 Redis、Kafka，负责订单系统，QPS 从 500 提升到 2000。',
    profile: {
      basics: { name: '张三', title: '后端工程师' },
      skills: [
        { name: 'Redis', level: '熟练' },
        { name: 'Kafka', level: '熟悉' },
      ],
      experiences: [{ id: 'exp_1', summary: '负责订单系统，QPS 提升 4 倍', org: '星宸科技' }],
    },
  });
  return {
    company: store.getCompany(company.companyId),
    position: store.getPosition(company.companyId, position.positionId),
    resumeVersion: store.getLatestResumeVersion(),
  };
}

function makeDiff(overrides = {}) {
  return {
    roundKey: 'round1',
    summary: '主线覆盖 4/5（未问 1）；换线 2 次；信号 5 次；评分锚点偏差 2 维；翻车点命中 1/3（33%）',
    totalMainlines: 5,
    unaskedMainlines: [{ mainlineId: 'r1c2', focus: '量化结果归因' }],
    unaskedCount: 1,
    switchCount: 2,
    signalDistribution: { highDifficulty: 2, offTopic: 1, shallow: 1, poorFluency: 1 },
    scoreAnchorDeviation: { logic: -1, depth: 0.5 },
    anchorDeviationCount: 2,
    hitRate: { total: 3, hit: 1, rate: 33 },
    hitStuck: [{ question: '「Redis」的底层原理', suggestion: '提前准备原理 + 边界 + 替代方案' }],
    ...overrides,
  };
}

// 手动构造一场 preanalysis 模式面试 session（基线 + 执行轨迹可控）
function preanalysisSession(plan) {
  const baselinePlan = buildBaselinePlan(plan, 'round1');
  return {
    sessionId: 'iv_p4_test',
    roundKey: 'round1',
    jobType: 'tech',
    resumeProfile: { basics: { name: '张三', title: '后端工程师' } },
    jobProfile: { title: '高级后端工程师', jobType: 'tech' },
    preanalysisPlan: plan,
    baselinePlan,
    turns: [
      { role: 'interviewer', content: '先做个自我介绍吧。', focusArea: '破冰', turnNo: 1 },
      { role: 'candidate', content: '我叫张三，负责订单系统 QPS 提升 4 倍。', turnNo: 2 },
      {
        role: 'interviewer',
        content: '简历里提到订单系统，能讲讲你的职责和技术方案吗？',
        focusArea: '关键经历深挖',
        mainlineId: 'r1c1',
        turnNo: 3,
      },
      { role: 'candidate', content: '主要用 Redis 做多级缓存，Kafka 异步削峰。', turnNo: 4 },
    ],
    depth: 1,
    maxDepth: 3,
    phase: 'closing',
    state: 'closed',
    executionTrace: [
      {
        turnNo: 1,
        question: '简历里提到订单系统，能讲讲你的职责和技术方案吗？',
        mainlineId: 'r1c1',
        signals: { difficulty: 'low', direction: 'on_topic', depth: 'deep', fluency: 'good' },
        adjustment: null,
        elapsedMs: 3200,
      },
    ],
    signals: [],
    adjustments: [],
  };
}

test('diffPlanVsExecution：偏差报告含未问主线/换线/信号分布/评分锚点/命中率', () => {
  const plan = buildFallbackPlan({
    resumeVersion: { profile: { skills: [{ name: 'Redis' }], experiences: [] } },
    company: { name: '星宸科技' },
    position: { title: '后端工程师', profile: { responsibilities: ['订单'], requirements: ['Java'] } },
  });
  const baselinePlan = buildBaselinePlan(plan, 'round1');
  const trace = [
    { turnNo: 1, mainlineId: 'r1c1', adjustment: null, signals: { difficulty: 'high', direction: 'on_topic', depth: 'shallow', fluency: 'poor' } },
    { turnNo: 2, mainlineId: 'r1c1', adjustment: 'switch-line', signals: { difficulty: 'medium', direction: 'off_topic', depth: 'medium', fluency: 'medium' } },
    { turnNo: 3, mainlineId: 'r1c3', adjustment: null, signals: { difficulty: 'low', direction: 'on_topic', depth: 'deep', fluency: 'good' } },
  ];
  const diff = diffPlanVsExecution({
    baselinePlan,
    plan,
    roundKey: 'round1',
    executionTrace: trace,
    difficultQuestions: [{ question: '「Redis」的底层原理', category: 'noAnswer', notes: '' }],
    scores: { logic: 2, depth: 3.5, relevance: 4, fluency: 4, interaction: 3, confidence: 3 },
  });

  assert.ok(diff, '有基线时产出偏差报告');
  assert.equal(diff.totalMainlines, 5);
  assert.equal(diff.unaskedCount, 3, 'r1c2/r1c4/r1c5 未问（共 3 条未问，r1c1/r1c3 已问）');
  assert.ok(diff.unaskedMainlines.some((u) => u.mainlineId === 'r1c2'));
  assert.equal(diff.switchCount, 1);
  assert.deepEqual(diff.signalDistribution, { highDifficulty: 1, offTopic: 1, shallow: 1, poorFluency: 1 });
  assert.equal(diff.scoreAnchorDeviation.logic, -1, 'logic 实际 2 分，计划期望 3 分');
  assert.equal(diff.scoreAnchorDeviation.depth, 0.5);
  assert.ok(diff.anchorDeviationCount >= 2);
  assert.equal(diff.hitRate.total, 3);
  assert.equal(diff.hitRate.hit, 1);
  assert.equal(diff.hitRate.rate, 33);
  assert.ok(diff.summary.includes('主线覆盖'), '摘要可读');
});

test('diffPlanVsExecution：无 baseline/轨迹时返回 null（规则模式不产出）', () => {
  assert.equal(
    diffPlanVsExecution({ baselinePlan: { items: [] }, executionTrace: [], plan: null }),
    null,
  );
});

test('updateStrategyCacheWithFeedback：回写 feedback，最多保留最近 3 次滚动淘汰', (t) => {
  const store = tmpStore(t);
  const plan = buildFallbackPlan({
    resumeVersion: { profile: {} },
    company: { name: '星宸科技' },
    position: { title: '后端工程师', profile: {} },
  });
  store.setPreanalysisCache('k1', plan);

  for (let i = 1; i <= 4; i++) {
    const feedback = updateStrategyCacheWithFeedback(store, 'k1', makeDiff({ roundKey: `r${i}`, unaskedMainlines: [{ mainlineId: `m${i}`, focus: `主线${i}` }] }));
    assert.ok(Array.isArray(feedback));
  }
  const cached = store.getPreanalysisCache('k1');
  assert.equal(cached.feedback.length, MAX_FEEDBACK_ROUNDS, '最多保留 3 次');
  assert.equal(cached.feedback[0].report.roundKey, 'r2', '最老的第 1 次被淘汰');
  assert.equal(cached.feedback[2].report.roundKey, 'r4', '最近一次在末尾');

  // 无缓存时静默返回 null，不抛错
  assert.equal(updateStrategyCacheWithFeedback(store, 'no_such_key', makeDiff()), null);
});

test('二次预分析：缓存命中时④层考察策略按 feedback 调整（未问主线前置+权重提升）', async (t) => {
  const store = tmpStore(t);
  const { company, position, resumeVersion } = seedStore(store);
  const plan = buildFallbackPlan({ resumeVersion, company, position });
  const first = await generatePlan({ resumeVersion, company, position, store });
  assert.equal(first.source, 'rules');

  // 回写一条偏差：r1c2（量化结果归因）上次未问
  updateStrategyCacheWithFeedback(store, first.cacheKey, makeDiff({
    unaskedMainlines: [{ mainlineId: 'r1c2', focus: '量化结果归因' }],
    unaskedCount: 1,
  }));

  // 二次预分析：缓存命中 + 未问主线前置
  const second = await generatePlan({ resumeVersion, company, position, store });
  assert.equal(second.source, 'cache');
  const chains = second.plan.layers.roundStrategy.round1.followupChains;
  assert.equal(chains[0].id, 'r1c2', '上次未问的主线本轮前置');
  assert.equal(chains[0].priorityBoost, true, '带权重提升标记');
  assert.equal(chains[0].boostReason, '上次未问，本轮优先');
  assert.equal(second.plan.feedback.length, 1, 'feedback 随缓存保留');

  // 无 feedback 时调整幂等（不改变结构）
  const plain = applyFeedbackAdjustments(plan);
  assert.equal(plain, plan, '无 feedback 原样返回');
});

test('buildPreAnalysisPrompt：有历史反馈时注入 <historical_feedback> 段与修正要求', () => {
  const resumeVersion = { versionId: 'v1', versionNo: 1, profile: {}, rawText: '' };
  const company = { companyId: 'c1', name: '星宸科技' };
  const position = { positionId: 'p1', title: '后端工程师', jobType: 'tech', profile: {} };
  const feedback = [{ at: '2026-08-07T00:00:00.000Z', report: makeDiff() }];

  const withFeedback = buildPreAnalysisPrompt({ resumeVersion, company, position, historicalFeedback: feedback });
  assert.ok(withFeedback[0].content.includes('历史偏差修正'), 'system 含修正要求');
  assert.ok(withFeedback[1].content.includes('<historical_feedback>'), 'user 含 XML 段');
  assert.ok(withFeedback[1].content.includes('量化结果归因'), '含未问主线摘要');

  const without = buildPreAnalysisPrompt({ resumeVersion, company, position });
  assert.ok(!without[1].content.includes('<historical_feedback>'), '无历史反馈时不注入');

  assert.ok(summarizeFeedbackForPrompt(makeDiff()).includes('预判翻车点命中率：33%'));
});

test('删除公司/岗位：feedback 随预分析缓存一起释放', (t) => {
  const store = tmpStore(t);
  const { company, position, resumeVersion } = seedStore(store);
  const key = `${resumeVersion.versionId}::${company.companyId}::${position.positionId}`;
  const plan = buildFallbackPlan({ resumeVersion, company, position });
  store.setPreanalysisCache(key, appendFeedbackToPlan(plan, makeDiff()));
  assert.equal(store.getPreanalysisCache(key).feedback.length, 1);

  store.deletePreanalysisCacheByPosition(company.companyId, position.positionId);
  assert.equal(store.getPreanalysisCache(key), null, '删除岗位后 feedback 一并释放');

  store.setPreanalysisCache(key, appendFeedbackToPlan(plan, makeDiff()));
  store.deletePreanalysisCacheByCompany(company.companyId);
  assert.equal(store.getPreanalysisCache(key), null, '删除公司后 feedback 一并释放');
});

test('formatReport：【预计 vs 实际】章节可读且带具体数字', () => {
  const diff = makeDiff();
  const result = {
    scores: { logic: 2, relevance: 3, depth: 3.5, fluency: 3, interaction: 3, confidence: 3 },
    improvementList: [],
    nextFocus: [],
    difficultQuestions: [],
    perQuestionReview: [],
    planVsExecution: diff,
  };
  const report = formatReport(result, { session: { jobProfile: { title: '后端工程师' }, roundKey: 'round1' } });
  assert.ok(report.includes('【预计 vs 实际】'));
  assert.ok(report.includes('未问主线：量化结果归因'));
  assert.ok(report.includes('换线 2 次'));
  assert.ok(report.includes('高难度 2 次'));
  assert.ok(report.includes('logic -1'));
  assert.ok(report.includes('预判翻车点命中率：1/3（33%）'));
});

test('reviewWithMemory：复盘末尾自动回写 feedback，失败不影响主流程', async (t) => {
  const store = tmpStore(t);
  const { company, position, resumeVersion } = seedStore(store);
  const { plan, cacheKey } = await generatePlan({ resumeVersion, company, position, store });
  const session = preanalysisSession(plan);

  const result = await reviewWithMemory(session, {
    store,
    companyId: company.companyId,
    positionId: position.positionId,
    roundKey: 'round1',
    resumeVersionId: resumeVersion.versionId,
  });
  assert.ok(result.result.planVsExecution, '复盘结果含预计 vs 实际偏差');
  const cached = store.getPreanalysisCache(cacheKey);
  assert.equal(cached.feedback.length, 1, '偏差报告已回写预分析缓存');
  assert.equal(cached.feedback[0].roundKey, 'round1');
  assert.ok(result.report.includes('【预计 vs 实际】'), '报告含偏差章节');

  // 无对应缓存时静默跳过，复盘主流程不受影响
  const result2 = await reviewWithMemory(session, {
    store,
    companyId: company.companyId,
    positionId: position.positionId,
    roundKey: 'round1',
    resumeVersionId: 'ver_not_cached',
  });
  assert.ok(result2.result.planVsExecution);
  assert.ok(result2.report.includes('复盘'));
});
