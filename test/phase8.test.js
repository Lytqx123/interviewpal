import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createSession, startInterview, askFollowup, followupByRules, prepareRound2Context } from '../src/interviewer/index.js';
import { diagnoseBaseline, passRecommendation, analyzeRhythm, getQuestions, recommendByWeakness, exportReview, createInterviewerAgent, createCoachAgent } from '../src/coach/index.js';
import { ArchiveStore } from '../src/archive/index.js';
import { parseRoundCommand } from '../src/feishu/commands.js';
import { createMessageHandler } from '../src/feishu/handler.js';

const RESUME = {
  basics: { name: '李四', title: '后端工程师' },
  companies: ['星辰科技'],
  skills: [{ name: 'Redis', level: '熟练' }],
  experiences: [{ id: 'exp_1', summary: '负责订单系统，QPS 提升 4 倍', org: '星辰科技' }],
  rawHash: 'x',
};
const JOB = { companyName: '星辰科技', title: '高级后端工程师', jobType: 'tech', responsibilities: ['负责订单系统设计', '保障高并发稳定'], requirements: ['熟悉 Java'], keywords: ['订单', '高并发'] };

function tmpStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ip-p8-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new ArchiveStore(dir);
}

describe('阶段八 · 二面/三面差异化策略', () => {
  it('二面（round2）追问引用岗位职责与公司业务', async () => {
    const session = createSession({
      resumeProfile: RESUME, jobProfile: JOB, roundKey: 'round2', maxDepth: 3,
      roundContext: {
        responsibilities: ['负责订单系统设计'],
        companyBusiness: [{ name: '订单业务', summary: '日均订单百万级' }],
        frontierTopics: [],
      },
    });
    await startInterview(session);
    await askFollowup(session, '我叫李四，做了三年后端。');
    // 第 1 轮追问应是"业务理解"，引用岗位职责
    const last = session.turns[session.turns.length - 1];
    assert.ok(last.content.includes('订单系统设计'), `业务理解题引用职责：${last.content}`);
  });

  it('二面前沿探索题：有联网话题时引用前沿动态', async () => {
    const session = createSession({
      resumeProfile: RESUME, jobProfile: JOB, roundKey: 'round2', maxDepth: 3,
      roundContext: { responsibilities: ['负责订单系统'], companyBusiness: [], frontierTopics: [{ topic: 'AI 驱动的智能订单调度', summary: '新趋势' }] },
    });
    await startInterview(session);
    await askFollowup(session, '回答一'.repeat(10));
    await askFollowup(session, '回答二'.repeat(10));
    await askFollowup(session, '回答三'.repeat(10));
    // 第 3 轮追问是前沿探索，应含前沿话题
    const frontierQ = session.turns[session.turns.length - 1].content;
    assert.ok(frontierQ.includes('AI 驱动的智能订单调度') || frontierQ.includes('趋势'), `前沿题引用话题：${frontierQ}`);
  });

  it('二面无联网话题时用压力题模板兜底', async () => {
    const session = createSession({
      resumeProfile: RESUME, jobProfile: JOB, roundKey: 'round2', maxDepth: 3,
      roundContext: { responsibilities: [], companyBusiness: [], frontierTopics: [] },
    });
    await startInterview(session);
    await askFollowup(session, '回答一'.repeat(10));
    await askFollowup(session, '回答二'.repeat(10));
    await askFollowup(session, '回答三'.repeat(10));
    // 第 3 轮追问落到前沿探索兜底（无联网话题 → 岗位类型压力题模板）
    const frontierQ = session.turns[session.turns.length - 1].content;
    assert.ok(frontierQ.includes('压力') || frontierQ.includes('突发') || frontierQ.includes('假设'), `兜底压力题：${frontierQ}`);
    // 确认是前沿探索层而非案例深挖层（案例深挖也含"假设"，需靠 focusArea 区分）
    assert.equal(session.turns[session.turns.length - 1].focusArea, '前沿探索', `兜底题聚焦前沿探索：${frontierQ}`);
  });

  it('三面（round3）追问聚焦职业规划/价值观/抗压', async () => {
    const session = createSession({ resumeProfile: RESUME, jobProfile: JOB, roundKey: 'round3', maxDepth: 3 });
    await startInterview(session);
    await askFollowup(session, '回答一'.repeat(10));
    const q1 = session.turns[session.turns.length - 1].content;
    assert.ok(q1.includes('职业规划') || q1.includes('为什么选择'), `三面第1轮职业规划：${q1}`);
  });

  it('followupByRules：round2 与 round1 策略不同', () => {
    const s1 = createSession({ resumeProfile: RESUME, jobProfile: JOB, roundKey: 'round1' });
    s1.depth = 1;
    const r1 = followupByRules(s1, '回答');
    const s2 = createSession({ resumeProfile: RESUME, jobProfile: JOB, roundKey: 'round2', roundContext: { responsibilities: ['订单系统'], companyBusiness: [], frontierTopics: [] } });
    s2.depth = 1;
    const r2 = followupByRules(s2, '回答');
    assert.notEqual(r1.focusArea, r2.focusArea, '一面与二面首追问方向不同');
    assert.equal(r2.focusArea, '业务理解', '二面首追问是业务理解');
  });
});

describe('阶段八 · 二面上下文准备（联网前沿题）', () => {
  it('prepareRound2Context：取岗位职责 + 公司业务缓存 + 联网前沿话题', async (t) => {
    const store = tmpStore(t);
    const company = store.createCompany({ name: '星辰科技' });
    const pos = store.createPosition(company.companyId, { title: '高级后端工程师', jobType: 'tech' });
    store.updatePosition(company.companyId, pos.positionId, { profile: { responsibilities: ['负责订单系统设计'], requirements: [], keywords: [] } });
    // 写入公司业务缓存
    store.putCacheEntry(company.companyId, 'round2', { entityType: 'company', entityName: '订单业务', summary: '日均百万订单', source: 'mock' });

    const mockSearch = { async search(q) { return [{ title: `${q} 前沿趋势`, url: 'u', snippet: 'AI 调度', publishedAt: '2026-08-01', confidence: 0.7 }]; } };
    const ctx = await prepareRound2Context({ store, search: mockSearch, companyId: company.companyId, positionId: pos.positionId });
    assert.deepEqual(ctx.responsibilities, ['负责订单系统设计'], '取到岗位职责');
    assert.equal(ctx.companyBusiness.length, 1, '取到公司业务缓存');
    assert.equal(ctx.companyBusiness[0].name, '订单业务', '公司业务名');
    assert.ok(ctx.frontierTopics.length === 1, '联网前沿话题');
    assert.ok(ctx.frontierTopics[0].topic.includes('前沿趋势'), '前沿话题内容');
  });

  it('prepareRound2Context：无 search 时前沿话题降级为空（不阻塞）', async (t) => {
    const store = tmpStore(t);
    const company = store.createCompany({ name: 'X公司' });
    const pos = store.createPosition(company.companyId, { title: '后端', jobType: 'tech' });
    const ctx = await prepareRound2Context({ store, search: null, companyId: company.companyId, positionId: pos.positionId });
    assert.deepEqual(ctx.frontierTopics, [], '无 search 时前沿话题为空');
  });
});

describe('阶段八 · P1 基线诊断与通关建议', () => {
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

describe('阶段八 · P1 表达节奏分析', () => {
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

describe('阶段八 · P1 高频问题库', () => {
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

describe('阶段八 · P1 复盘导出', () => {
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

describe('阶段八 · P1 双 Agent 物理拆分', () => {
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

describe('阶段八 · 飞书轮次状态命令', () => {
  it('parseRoundCommand：解析轮次 + 公司 + 岗位', () => {
    const r = parseRoundCommand('练二面 星辰科技 后端工程师');
    assert.equal(r.roundKey, 'round2');
    assert.equal(r.companyName, '星辰科技');
    assert.equal(r.positionTitle, '后端工程师');
    assert.equal(parseRoundCommand('练三面 X公司').roundKey, 'round3');
    assert.equal(parseRoundCommand('你好'), null);
  });

  it('query_progress 命令返回进度', async (t) => {
    const store = tmpStore(t);
    const company = store.createCompany({ name: '星辰科技' });
    store.createPosition(company.companyId, { title: '后端', jobType: 'tech' });
    const handler = createMessageHandler({ store });
    const out = await handler({ text: '查进度 星辰科技' });
    assert.ok(out.text.includes('星辰科技 面试进度'), '返回进度');
    assert.ok(out.text.includes('一面'), '含轮次');
  });

  it('practice_round 二面命令返回业务面参考资料', async (t) => {
    const store = tmpStore(t);
    const company = store.createCompany({ name: '星辰科技' });
    const pos = store.createPosition(company.companyId, { title: '后端工程师', jobType: 'tech' });
    store.updatePosition(company.companyId, pos.positionId, { profile: { responsibilities: ['负责订单系统设计'], requirements: [], keywords: [] } });
    const handler = createMessageHandler({ store });
    const out = await handler({ text: '练二面 星辰科技 后端工程师' });
    assert.ok(out.text.includes('二面'), '二面命令');
    assert.ok(out.text.includes('岗位职责'), '含岗位职责');
    assert.ok(out.text.includes('前沿探索题'), '含前沿探索题说明');
  });

  it('两家公司信息隔离：A 公司进度不串到 B 公司', async (t) => {
    const store = tmpStore(t);
    const a = store.createCompany({ name: 'A公司' });
    const b = store.createCompany({ name: 'B公司' });
    const posA = store.createPosition(a.companyId, { title: '后端', jobType: 'tech' });
    const posB = store.createPosition(b.companyId, { title: '前端', jobType: 'tech' });
    store.saveReview({ reviewId: 'rvA', companyId: a.companyId, positionId: posA.positionId, roundKey: 'round1', scores: { logic: 4, relevance: 4, depth: 4, fluency: 4, interaction: 4, confidence: 4 }, improvementList: [], difficultQuestions: [], createdAt: '2026-08-01T00:00:00Z' });
    store.recordRoundSession(a.companyId, posA.positionId, 'round1', { sessionId: 'sA', reviewId: 'rvA' });
    const handler = createMessageHandler({ store });
    const outB = await handler({ text: '查进度 B公司' });
    assert.ok(!outB.text.includes('A公司'), 'B 公司进度不含 A 公司信息');
    assert.ok(outB.text.includes('B公司'), '只含 B 公司');
    // B 公司岗位轮次次数应为 0（不受 A 影响）
    assert.equal(store.getPosition(b.companyId, posB.positionId).rounds.round1.completedCount, 0, 'B 公司轮次不受 A 影响');
    // A 公司轮次次数仍为 1（不受 B 影响）
    assert.equal(store.getPosition(a.companyId, posA.positionId).rounds.round1.completedCount, 1, 'A 公司轮次保持 1');
  });
});
