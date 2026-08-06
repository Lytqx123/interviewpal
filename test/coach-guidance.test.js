import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createSession, startInterview, askFollowup } from '../src/interviewer/index.js';
import { diagnoseBaseline, passRecommendation, analyzeRhythm, getQuestions, recommendByWeakness, exportReview, createInterviewerAgent, createCoachAgent } from '../src/coach/index.js';
import { ArchiveStore } from '../src/archive/index.js';

const RESUME = {
  basics: { name: '李四', title: '后端工程师' },
  companies: ['星宸科技'],
  skills: [{ name: 'Redis', level: '熟练' }],
  experiences: [{ id: 'exp_1', summary: '负责订单系统，QPS 提升 4 倍', org: '星宸科技' }],
  rawHash: 'x',
};
const JOB = { companyName: '星宸科技', title: '高级后端工程师', jobType: 'tech', responsibilities: ['负责订单系统设计', '保障高并发稳定'], requirements: ['熟悉 Java'], keywords: ['订单', '高并发'] };

function tmpStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ip-guidance-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new ArchiveStore(dir);
}
describe('复盘教练 · 基线诊断与通关建议（方案书 §5.4 方向校准）', () => {
  it('diagnoseBaseline：汇总各轮次状态 + 下一步建议', (t) => {
    const store = tmpStore(t);
    const company = store.createCompany({ name: 'X' });
    const pos = store.createPosition(company.companyId, { title: '后端', jobType: 'tech' });
    const diag = diagnoseBaseline({ store, companyId: company.companyId, positionId: pos.positionId });
    assert.equal(diag.rounds.length, 3, '三轮次');
    assert.equal(diag.currentRound.roundKey, 'round1', '未练时下一步是一面');
    assert.match(diag.overall, /已练 0\/3/);
  });

  it('passRecommendation：达标建议进入下一轮、未达标建议重练', (t) => {
    const store = tmpStore(t);
    const company = store.createCompany({ name: 'X' });
    const pos = store.createPosition(company.companyId, { title: '后端', jobType: 'tech' });
    // 未练
    const r0 = passRecommendation({ store, companyId: company.companyId, positionId: pos.positionId, roundKey: 'round1' });
    assert.equal(r0.ready, false);
    // 写入一场达标复盘（均分 >= 3.5 且无 <3）
    store.saveReview({ reviewId: 'rv1', companyId: company.companyId, positionId: pos.positionId, roundKey: 'round1', scores: { logic: 4, relevance: 4, depth: 4, fluency: 4, interaction: 4, confidence: 4 }, improvementList: [], difficultQuestions: [], createdAt: '2026-08-01T00:00:00Z' });
    const r1 = passRecommendation({ store, companyId: company.companyId, positionId: pos.positionId, roundKey: 'round1' });
    assert.equal(r1.ready, true, '均分4达标');
    assert.equal(r1.nextRound, 'round2', '建议进入二面');
    // 写入一场未达标（有 <3）
    store.saveReview({ reviewId: 'rv2', companyId: company.companyId, positionId: pos.positionId, roundKey: 'round2', scores: { logic: 2, relevance: 4, depth: 4, fluency: 4, interaction: 4, confidence: 4 }, improvementList: [], difficultQuestions: [], createdAt: '2026-08-02T00:00:00Z' });
    const r2 = passRecommendation({ store, companyId: company.companyId, positionId: pos.positionId, roundKey: 'round2' });
    assert.equal(r2.ready, false, 'logic=2 未达标');
    assert.ok(r2.weakDimensions.includes('逻辑结构'), '指出短板维度');
  });
});

describe('复盘教练 · 表达节奏分析（方案书 §4.1）', () => {
  it('analyzeRhythm：稳定节奏评 good、填充词多评 warning', () => {
    const turns = [
      { role: 'interviewer', content: 'Q1' }, { role: 'candidate', content: '首先我负责订单系统，其次用了缓存，最后性能提升。'.repeat(2) },
      { role: 'interviewer', content: 'Q2' }, { role: 'candidate', content: '因为用了 Redis，所以命中率提升，结果 QPS 翻倍。'.repeat(2) },
    ];
    const r = analyzeRhythm({ turns });
    assert.equal(r.answerCount, 2);
    assert.ok(r.avgLength > 0);
    assert.equal(r.pacing.level, 'good', '结构化长回答节奏稳定');

    const badTurns = [
      { role: 'interviewer', content: 'Q1' }, { role: 'candidate', content: '嗯，那个，就是，啊，嗯，就是那个啊。' },
    ];
    const r2 = analyzeRhythm({ turns: badTurns });
    assert.equal(r2.pacing.level, 'warning', '填充词多评 warning');
    assert.ok(r2.pacing.issues.length > 0, '有改进建议');
  });
});

describe('复盘教练 · 高频题库（方案书 §4.1）', () => {
  it('getQuestions：按岗位+轮次取题', () => {
    const qs = getQuestions('tech', 'round2');
    assert.ok(qs.length >= 1);
    assert.ok(qs.every((q) => q.dim), '每题有考察维度');
  });

  it('recommendByWeakness：按弱项维度筛选重练题', () => {
    const rec = recommendByWeakness('tech', 'round2', { logic: 2, relevance: 4, depth: 4, fluency: 4, interaction: 4, confidence: 4 });
    assert.ok(rec.weakDims.includes('逻辑结构'), '识别弱项');
    assert.ok(rec.recommended.every((q) => q.dim === 'logic'), '推荐题对应弱项');
  });
});

describe('复盘教练 · 复盘报告导出（方案书 §4.1）', () => {
  it('exportReview：text 格式含复盘报告', () => {
    const record = {
      reviewId: 'rv1', companyId: 'c1', positionId: 'p1', roundKey: 'round1',
      scores: { logic: 4, relevance: 3, depth: 4, fluency: 4, interaction: 3, confidence: 4 },
      scoreEvidence: {}, directionDeviation: { expected: [], actual: [], notes: '' },
      difficultQuestions: [], perQuestionReview: [], improvementList: [{ dimension: 'relevance', priority: 'medium', suggestion: '更切题' }],
      comparedWithLast: null, nextFocus: [], createdAt: '2026-08-01',
    };
    const text = exportReview(record, { format: 'text' });
    assert.ok(text.includes('面试复盘'), 'text 含报告');
  });

  it('exportReview：markdown 格式含表格与 checkbox', () => {
    const record = {
      reviewId: 'rv1', companyId: 'c1', positionId: 'p1', roundKey: 'round2',
      scores: { logic: 4, relevance: 3, depth: 4, fluency: 4, interaction: 3, confidence: 4 },
      scoreEvidence: {}, directionDeviation: { expected: [], actual: [], notes: '' },
      difficultQuestions: [{ question: 'Redis 原理', category: 'shallow', alsoStuckLastTime: true }], perQuestionReview: [],
      improvementList: [{ dimension: 'depth', priority: 'high', suggestion: '深挖', checked: false, priorityRepractice: true }],
      comparedWithLast: null, nextFocus: [], createdAt: '2026-08-01',
    };
    const md = exportReview(record, { format: 'markdown' });
    assert.ok(md.includes('# 面试复盘'), 'markdown 含标题');
    assert.ok(md.includes('| 维度 | 分数 |'), '含六维表格');
    assert.ok(md.includes('[ ]'), '含未勾选 checkbox');
    assert.ok(md.includes('🔁优先重练'), '含优先重练标记');
    assert.ok(md.includes('⚠️上次也卡壳'), '含上次也卡壳标注');
  });
});

describe('复盘教练 · 双 Agent 分工（方案书 §5.8）', () => {
  it('InterviewerAgent 失忆（无状态）、CoachAgent 全记忆（依赖 store）', async (t) => {
    const store = tmpStore(t);
    const company = store.createCompany({ name: 'X' });
    const pos = store.createPosition(company.companyId, { title: '后端', jobType: 'tech' });

    const iv = createInterviewerAgent({ llm: null });
    assert.equal(iv.memory, 'amnesic', '面试官失忆');
    const handle = iv.start({ resumeProfile: RESUME, jobProfile: JOB, roundKey: 'round1' });
    await handle.open();
    await handle.ask('回答'.repeat(20));
    assert.ok(handle.session.turns.length > 0, '面试官能开面试');

    const coach = createCoachAgent({ store, llm: null });
    assert.equal(coach.memory, 'full', '教练全记忆');
    await coach.review(handle.session, { companyId: company.companyId, positionId: pos.positionId, roundKey: 'round1' });
    assert.equal(store.listReviews({ companyId: company.companyId, positionId: pos.positionId }).length, 1, '教练写入档案库');
  });

  it('CoachAgent 缺 store 报错', () => {
    assert.throws(() => createCoachAgent({}), /store/);
  });
});

