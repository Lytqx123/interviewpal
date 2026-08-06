// 薪资建议报告测试（§5.10）：触发条件（至少一场）、未练轮次中等填充、
// 规则兜底、LLM 路径、联网、当前薪资涨幅、格式化。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ArchiveStore } from '../src/archive/index.js';
import { checkSalaryTrigger, generateSalaryReport, formatSalaryReport } from '../src/coach/salary.js';

function tmpStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ip-salary-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new ArchiveStore(dir);
}

const SCORES = { logic: 4, relevance: 4, depth: 3.5, fluency: 3, interaction: 3.5, confidence: 3.5 };
const SCORES_LOW = { logic: 2, relevance: 2.5, depth: 2, fluency: 2, interaction: 2.5, confidence: 2 };

function seedRounds(store, companyId, positionId, { round1 = 1, round2 = 1, round3 = 1, scores = SCORES } = {}) {
  const rounds = { round1, round2, round3 };
  let i = 0;
  for (const [rk, n] of Object.entries(rounds)) {
    for (let k = 0; k < n; k++) {
      i += 1;
      store.saveReview({
        reviewId: `rv-${rk}-${k}`,
        companyId,
        positionId,
        roundKey: rk,
        scores: { ...scores },
        scoreEvidence: [],
        improvementList: [],
        difficultQuestions: k === 0 ? [{ question: 'Q', category: '未答' }] : [],
        perQuestionReview: [],
        createdAt: `2026-08-0${i}T10:00:00Z`,
      });
    }
  }
}

test('checkSalaryTrigger：一场都没有时未就绪', (t) => {
  const store = tmpStore(t);
  const { companyId } = store.createCompany({ name: '空公司' });
  const { positionId } = store.createPosition(companyId, { title: '后端', jobType: 'tech' });
  const r = checkSalaryTrigger({ store, companyId, positionId });
  assert.equal(r.ready, false);
  assert.deepEqual(r.missing, ['round1', 'round2', 'round3']);
});

test('checkSalaryTrigger：仅练一面时就绪，missing 含未练轮次', (t) => {
  const store = tmpStore(t);
  const { companyId } = store.createCompany({ name: 'A公司' });
  const { positionId } = store.createPosition(companyId, { title: '后端', jobType: 'tech' });
  store.saveReview({
    reviewId: 'rv1', companyId, positionId, roundKey: 'round1',
    scores: SCORES, createdAt: '2026-08-01T10:00:00Z',
  });
  const r = checkSalaryTrigger({ store, companyId, positionId });
  assert.equal(r.ready, true);
  assert.deepEqual(r.missing, ['round2', 'round3']);
  assert.equal(r.rounds.round1.count, 1);
  assert.equal(r.rounds.round2.count, 0);
  assert.equal(r.rounds.round3.count, 0);
});

test('checkSalaryTrigger：未练轮次用中等评价 3.0 填充', (t) => {
  const store = tmpStore(t);
  const { companyId } = store.createCompany({ name: 'B公司' });
  const { positionId } = store.createPosition(companyId, { title: '后端', jobType: 'tech' });
  store.saveReview({
    reviewId: 'rv1', companyId, positionId, roundKey: 'round1',
    scores: SCORES, createdAt: '2026-08-01T10:00:00Z',
  });
  const r = checkSalaryTrigger({ store, companyId, positionId });
  // 未练的二面三面应为中等评价
  assert.equal(r.rounds.round2.defaulted, true);
  assert.equal(r.rounds.round2.avgScores.logic, 3.0);
  assert.equal(r.rounds.round3.defaulted, true);
  assert.equal(r.rounds.round3.avgScores.fluency, 3.0);
  // 已练的一面不是 defaulted
  assert.equal(r.rounds.round1.defaulted, false);
});

test('generateSalaryReport：一场都没有时返回 blocked', async (t) => {
  const store = tmpStore(t);
  const { companyId } = store.createCompany({ name: 'G公司' });
  const { positionId } = store.createPosition(companyId, { title: '后端', jobType: 'tech' });
  const result = await generateSalaryReport({ store, companyId, positionId });
  assert.equal(result.ready, false);
  assert.equal(result.report, null);
  assert.equal(result.source, 'blocked');
});

test('generateSalaryReport：仅练一面也能生成报告（规则兜底）', async (t) => {
  const store = tmpStore(t);
  const { companyId } = store.createCompany({ name: '单面公司' });
  const { positionId } = store.createPosition(companyId, { title: '后端', jobType: 'tech' });
  store.saveReview({
    reviewId: 'rv1', companyId, positionId, roundKey: 'round1',
    scores: SCORES, createdAt: '2026-08-01T10:00:00Z',
  });
  const result = await generateSalaryReport({ store, companyId, positionId, llm: null });
  assert.equal(result.ready, true);
  assert.equal(result.source, 'rules');
  assert.ok(result.report.salaryRange.low > 0);
  assert.ok(result.missing.length, 2); // 二面三面未练
});

test('generateSalaryReport：规则兜底生成区间与建议（含报价策略）', async (t) => {
  const store = tmpStore(t);
  const { companyId } = store.createCompany({ name: 'C公司' });
  const { positionId } = store.createPosition(companyId, { title: '后端', jobType: 'tech' });
  seedRounds(store, companyId, positionId, { scores: SCORES });
  const result = await generateSalaryReport({ store, companyId, positionId, llm: null, search: null });
  assert.equal(result.ready, true);
  assert.equal(result.source, 'rules');
  assert.ok(result.report.salaryRange.low > 0);
  assert.ok(result.report.salaryRange.high >= result.report.salaryRange.low);
  assert.ok(result.report.strengths.length > 0);
  assert.ok(result.report.advice.length > 0);
  assert.ok(result.report.summary.includes('C公司'));
  assert.ok(result.report.offerStrategy, '规则兜底应有报价策略');
  assert.ok(result.report.offerStrategy.includes('总包'), '报价策略应提醒总包结构');
});

test('generateSalaryReport：低分（三轮全练）时 reportFocus 偏向期望调整', async (t) => {
  const store = tmpStore(t);
  const { companyId } = store.createCompany({ name: '低分公司' });
  const { positionId } = store.createPosition(companyId, { title: '后端', jobType: 'tech' });
  seedRounds(store, companyId, positionId, { scores: SCORES_LOW });
  const result = await generateSalaryReport({ store, companyId, positionId, llm: null });
  assert.equal(result.source, 'rules');
  assert.equal(result.report.reportFocus, '期望薪资调整建议');
  assert.ok(result.report.concerns.length > 0);
});

test('generateSalaryReport：同轮多场取平均', (t) => {
  const store = tmpStore(t);
  const { companyId } = store.createCompany({ name: 'D公司' });
  const { positionId } = store.createPosition(companyId, { title: '后端', jobType: 'tech' });
  seedRounds(store, companyId, positionId, { round1: 2, round2: 1, round3: 1, scores: SCORES });
  store.saveReview({
    reviewId: 'rv-round1-x', companyId, positionId, roundKey: 'round1',
    scores: SCORES_LOW, createdAt: '2026-08-09T10:00:00Z',
  });
  const r = checkSalaryTrigger({ store, companyId, positionId });
  assert.equal(r.rounds.round1.count, 3);
  assert.ok(r.rounds.round1.avgScores.logic < 4);
  assert.ok(r.rounds.round1.avgScores.logic > 2);
});

test('generateSalaryReport：LLM 路径生成报告（含报价策略）', async (t) => {
  const store = tmpStore(t);
  const { companyId } = store.createCompany({ name: 'E公司' });
  const { positionId } = store.createPosition(companyId, { title: '后端', jobType: 'tech' });
  seedRounds(store, companyId, positionId, { scores: SCORES });
  const fakeLlm = async () => JSON.stringify({
    salaryRange: { low: 30, high: 45, currency: 'CNY' },
    rangeBasis: 'JD + 行情 + 复盘',
    reportFocus: '谈薪技巧',
    strengths: ['项目经历扎实'],
    concerns: ['表达偏弱'],
    advice: ['用项目成果作筹码'],
    negotiationTips: ['先让对方出价'],
    companyPotential: null,
    offerStrategy: '建议报45万作为锚定值，关注总包结构',
    hikeRecommendation: null,
    summary: '建议 30-45 万',
  });
  const result = await generateSalaryReport({ store, companyId, positionId, llm: fakeLlm, search: null });
  assert.equal(result.source, 'llm');
  assert.equal(result.report.salaryRange.low, 30);
  assert.equal(result.report.salaryRange.high, 45);
  assert.equal(result.report.reportFocus, '谈薪技巧');
  assert.deepEqual(result.report.negotiationTips, ['先让对方出价']);
  assert.ok(result.report.offerStrategy, 'LLM 路径应有报价策略');
});

test('generateSalaryReport：LLM 返回无效 JSON 时降级规则兜底', async (t) => {
  const store = tmpStore(t);
  const { companyId } = store.createCompany({ name: '降级公司' });
  const { positionId } = store.createPosition(companyId, { title: '后端', jobType: 'tech' });
  seedRounds(store, companyId, positionId, { scores: SCORES });
  const badLlm = async () => '这不是JSON';
  const result = await generateSalaryReport({ store, companyId, positionId, llm: badLlm });
  assert.equal(result.source, 'rules');
  assert.ok(result.report.salaryRange.low > 0);
});

test('generateSalaryReport：联网搜索被调用（至少 3 次）', async (t) => {
  const store = tmpStore(t);
  const { companyId } = store.createCompany({ name: 'F公司' });
  const { positionId } = store.createPosition(companyId, { title: '后端', jobType: 'tech' });
  seedRounds(store, companyId, positionId, { scores: SCORES });
  let calls = 0;
  const fakeSearch = {
    name: 'fake',
    async search(q) {
      calls += 1;
      return [{ title: q, url: 'x', snippet: 's', publishedAt: null, confidence: 0.5 }];
    },
  };
  const result = await generateSalaryReport({ store, companyId, positionId, llm: null, search: fakeSearch });
  assert.ok(calls >= 3, `至少搜索 3 次，实际 ${calls}`);
  assert.equal(result.onlineSource, 'fake');
});

test('generateSalaryReport：提供 currentSalary 时规则兜底给涨幅建议', async (t) => {
  const store = tmpStore(t);
  const { companyId } = store.createCompany({ name: '涨幅公司' });
  const { positionId } = store.createPosition(companyId, { title: '后端', jobType: 'tech' });
  seedRounds(store, companyId, positionId, { scores: SCORES });
  const result = await generateSalaryReport({ store, companyId, positionId, llm: null, currentSalary: 20 });
  assert.equal(result.source, 'rules');
  assert.ok(result.report.hikeRecommendation, '提供 currentSalary 应有涨幅建议');
  assert.equal(result.report.hikeRecommendation.currentSalary, 20);
  // SCORES 三轮均分 ≈3.58（中等），hikePct 应为 20
  assert.equal(result.report.hikeRecommendation.hikePct, 20);
  assert.equal(result.report.hikeRecommendation.targetSalary, 24);
});

test('generateSalaryReport：未提供 currentSalary 时 hikeRecommendation 为 null', async (t) => {
  const store = tmpStore(t);
  const { companyId } = store.createCompany({ name: '无涨幅公司' });
  const { positionId } = store.createPosition(companyId, { title: '后端', jobType: 'tech' });
  seedRounds(store, companyId, positionId, { scores: SCORES });
  const result = await generateSalaryReport({ store, companyId, positionId, llm: null });
  assert.equal(result.report.hikeRecommendation, null);
});

test('generateSalaryReport：currentSalary 传给 LLM（LLM 返回涨幅）', async (t) => {
  const store = tmpStore(t);
  const { companyId } = store.createCompany({ name: 'LLM涨幅公司' });
  const { positionId } = store.createPosition(companyId, { title: '后端', jobType: 'tech' });
  seedRounds(store, companyId, positionId, { scores: SCORES });
  const fakeLlm = async () => JSON.stringify({
    salaryRange: { low: 30, high: 45, currency: 'CNY' },
    rangeBasis: '综合',
    reportFocus: '谈薪技巧',
    strengths: ['项目经历扎实'],
    concerns: [],
    advice: ['用筹码谈薪'],
    negotiationTips: [],
    companyPotential: null,
    offerStrategy: '报上沿',
    hikeRecommendation: { hikePct: 25, targetSalary: 25, basis: '复盘优秀' },
    summary: '建议涨25%',
  });
  const result = await generateSalaryReport({ store, companyId, positionId, llm: fakeLlm, currentSalary: 20 });
  assert.equal(result.source, 'llm');
  assert.ok(result.report.hikeRecommendation);
  assert.equal(result.report.hikeRecommendation.hikePct, 25);
});

test('formatSalaryReport：未就绪显示提示', () => {
  const text = formatSalaryReport({ ready: false, missing: ['至少完成一场模拟'] });
  assert.ok(text.includes('暂不可生成'));
  assert.ok(text.includes('至少完成一场'));
});

test('formatSalaryReport：就绪显示区间、报价策略与涨幅', () => {
  const result = {
    ready: true,
    source: 'llm',
    onlineSource: 'fake',
    rounds: { round1: { count: 1, label: '一面（简历面）' }, round2: { count: 0, label: '二面（业务面）' }, round3: { count: 0, label: '三面（总监/交叉面）' } },
    report: {
      salaryRange: { low: 30, high: 45, currency: 'CNY' },
      rangeBasis: '综合',
      reportFocus: '谈薪技巧',
      strengths: ['项目经历扎实'],
      concerns: ['表达偏弱'],
      advice: ['用项目成果作筹码'],
      negotiationTips: ['先让对方出价'],
      companyPotential: null,
      offerStrategy: '建议报45万作为锚定值，关注总包结构',
      hikeRecommendation: { currentSalary: 20, hikePct: 25, targetSalary: 25, basis: '复盘优秀' },
      summary: '建议 30-45 万',
    },
  };
  const text = formatSalaryReport(result);
  assert.ok(text.includes('30–45'));
  assert.ok(text.includes('加分项'));
  assert.ok(text.includes('谈薪技巧'));
  assert.ok(text.includes('报价策略'));
  assert.ok(text.includes('建议涨幅'));
  assert.ok(text.includes('20 万/年'));
  assert.ok(text.includes('未练'), '应标注未练轮次');
});
