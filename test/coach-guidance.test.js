import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createSession, startInterview } from '../src/interviewer/index.js';
import { analyzeRhythm, buildDifficultyReport, getQuestions, recommendByWeakness, exportReview, createInterviewerAgent, createCoachAgent } from '../src/coach/index.js';
import { extractSessionQuestions, compareRepeatedQuestions, detectMemorizedAnswers } from '../src/coach/rules.js';
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
describe('复盘教练 · 表达节奏分析', () => {
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

describe('复盘教练 · 高频题库', () => {
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

describe('复盘教练 · 复盘报告导出', () => {
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

  it('exportReview：html 格式可浏览器打印为 PDF（含 DOCTYPE/样式/表格）', () => {
    const record = {
      reviewId: 'rv1', companyId: 'c1', positionId: 'p1', roundKey: 'round1',
      scores: { logic: 4, relevance: 3, depth: 4, fluency: 4, interaction: 3, confidence: 4 },
      scoreEvidence: {}, directionDeviation: { expected: [], actual: [], notes: '' },
      difficultQuestions: [{ question: '卡壳题', category: 'noAnswer' }], perQuestionReview: [],
      improvementList: [{ dimension: 'relevance', priority: 'high', suggestion: '更切题', checked: false }],
      comparedWithLast: { progress: { logic: 'up' }, summary: '逻辑结构进步' }, nextFocus: [], createdAt: '2026-08-01',
    };
    const html = exportReview(record, { format: 'html' });
    assert.ok(html.includes('<!DOCTYPE html>'), 'html 含 DOCTYPE');
    assert.ok(html.includes('<html'), '含 html 标签');
    assert.ok(html.includes('@media print'), '含打印样式（Ctrl+P 另存为 PDF）');
    assert.ok(html.includes('六维评分'), '含六维评分表');
    assert.ok(html.includes('改进清单'), '含改进清单');
    assert.ok(html.includes('↑进步'), '含进步标注');
    // HTML 转义防 XSS
    assert.ok(!html.includes('<script>'), '不含未转义脚本标签');
  });
});

describe('复盘教练 · 困难点报告', () => {
  it('buildDifficultyReport：四分类统计 + 逐条困难题 + 沉默期', () => {
    const markers = [
      { questionIndex: 1, category: 'noAnswer', question: 'Redis 持久化原理', answerSummary: '不知道', notes: '明确表示不会' },
      { questionIndex: 2, category: 'offTopic', question: '消息队列选型', answerSummary: '聊了缓存', notes: '答偏跑题' },
      { questionIndex: 3, category: 'silence', question: '分布式事务', answerSummary: '沉默后才答', notes: '沉默 12s' },
      { questionIndex: 4, category: 'shallow', question: '高并发设计', answerSummary: '泛泛而谈', notes: '缺乏细节' },
    ];
    const silencePeriods = [
      { from: 1000, to: 13000, durationMs: 12000 },
    ];
    const report = buildDifficultyReport(markers, silencePeriods);
    assert.equal(report.total, 4);
    assert.equal(report.byCategory.noAnswer, 1);
    assert.equal(report.byCategory.offTopic, 1);
    assert.equal(report.byCategory.silence, 1);
    assert.equal(report.byCategory.shallow, 1);
    assert.equal(report.questions.length, 4);
    assert.equal(report.totalSilenceSec, 12);
    assert.equal(report.silencePeriods.length, 1);
    assert.match(report.summary, /本场共标记 4 个困难点/);
  });

  it('buildDifficultyReport：空标记返回无显著困难点', () => {
    const report = buildDifficultyReport([], []);
    assert.equal(report.total, 0);
    assert.equal(report.summary, '本场无显著困难点');
  });
});

describe('复盘教练 · 表达节奏分析（时间戳进阶）', () => {
  it('analyzeRhythm：有 voiceMeta 时补充语速/停顿/沉默维度', () => {
    const baseTime = Date.now() - 60000;
    const session = {
      turns: [
        { role: 'interviewer', content: 'Q1' },
        { role: 'candidate', content: '我负责订单系统，用了 Redis 做缓存，QPS 提升了 4 倍。' },
      ],
      voiceMeta: {
        asrEvents: [
          { text: '我负责', arrivedAt: baseTime, charCount: 3 },
          { text: '订单系统', arrivedAt: baseTime + 2000, charCount: 4 },
          { text: '用了 Redis', arrivedAt: baseTime + 4000, charCount: 6 },
        ],
        chatEvents: [{ content: 'Q1', arrivedAt: baseTime - 1000 }],
        silencePeriods: [{ from: baseTime - 1000, to: baseTime, durationMs: 1000 }],
        difficultyMarkers: [],
        lastChatAt: baseTime,
      },
    };
    const r = analyzeRhythm(session);
    assert.ok(r.answerCount > 0);
    assert.ok(r.timestampBased, '有时间戳维度分析');
    assert.ok(typeof r.timestampBased.speakingRate === 'number', '有语速（字/分钟）');
    assert.ok(typeof r.timestampBased.avgPauseSec === 'number', '有平均停顿');
  });

  it('analyzeRhythm：长沉默触发 warning 稳定性预警', () => {
    const baseTime = Date.now() - 120000;
    const session = {
      turns: [
        { role: 'interviewer', content: 'Q1' },
        { role: 'candidate', content: '嗯，那个，就是，回答得很浅。' },
      ],
      voiceMeta: {
        asrEvents: [{ text: '回答', arrivedAt: baseTime, charCount: 2 }],
        chatEvents: [{ content: 'Q1', arrivedAt: baseTime - 15000 }],
        silencePeriods: [{ from: baseTime - 15000, to: baseTime, durationMs: 15000 }],
        difficultyMarkers: [],
        lastChatAt: baseTime,
      },
    };
    const r = analyzeRhythm(session);
    assert.ok(r.timestampBased.silenceCount > 0, '检测到沉默超时');
    assert.equal(r.timestampBased.stability, 'warning', '长沉默触发 warning');
    assert.ok(r.timestampBased.issues.length > 0, '有预警建议');
  });
});

describe('复盘教练 · 双 Agent 分工', () => {
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

describe('复盘教练 · 防背答案式刷分', () => {
  it('extractSessionQuestions：提取问题同时提取候选人回答', () => {
    const session = {
      turns: [
        { role: 'interviewer', content: '说说 Redis 持久化', turnNo: 1 },
        { role: 'candidate', content: 'Redis 有 RDB 和 AOF 两种方式' },
        { role: 'interviewer', content: '消息队列怎么选型', turnNo: 2 },
        { role: 'candidate', content: '看吞吐量和可靠性需求' },
      ],
    };
    const qs = extractSessionQuestions(session);
    assert.equal(qs.length, 2);
    assert.equal(qs[0].content, '说说 Redis 持久化');
    assert.equal(qs[0].answer, 'Redis 有 RDB 和 AOF 两种方式');
    assert.equal(qs[1].answer, '看吞吐量和可靠性需求');
  });

  it('detectMemorizedAnswers：分数提升 + 回答高度雷同 → 疑似背答案', () => {
    const repeated = {
      repeated: [
        {
          current: '说说 Redis 持久化',
          last: '说说 Redis 持久化',
          similarity: 0.95,
          currentAnswer: 'Redis 有 RDB 和 AOF 两种方式，RDB 是快照，AOF 是追加日志',
          lastAnswer: 'Redis 有 RDB 和 AOF 两种方式，RDB 是快照，AOF 是追加日志',
        },
      ],
      repeatedCount: 1,
    };
    const progress = { depth: 'up', logic: 'flat' };
    const result = detectMemorizedAnswers(repeated, progress);
    assert.equal(result.suspected, true, '分数提升+回答雷同→疑似背答案');
    assert.ok(result.warnings.length > 0, '有预警信息');
    assert.ok(result.warnings[0].includes('背下来'), '预警含"背下来"提示');
    assert.ok(result.warnings[0].includes('变体题'), '预警建议换问法（变体题）');
  });

  it('detectMemorizedAnswers：分数未提升时不预警（即使回答雷同）', () => {
    const repeated = {
      repeated: [
        {
          current: '说说 Redis 持久化',
          last: '说说 Redis 持久化',
          similarity: 0.95,
          currentAnswer: 'Redis 有 RDB 和 AOF 两种方式',
          lastAnswer: 'Redis 有 RDB 和 AOF 两种方式',
        },
      ],
      repeatedCount: 1,
    };
    const progress = { depth: 'flat', logic: 'down' }; // 无提升
    const result = detectMemorizedAnswers(repeated, progress);
    assert.equal(result.suspected, false, '分数未提升时不预警');
    assert.equal(result.warnings.length, 0);
    // 但仍记录相似回答
    assert.equal(result.similarAnswers.length, 1);
  });

  it('detectMemorizedAnswers：回答不同时不预警', () => {
    const repeated = {
      repeated: [
        {
          current: '说说 Redis 持久化',
          last: '说说 Redis 持久化',
          similarity: 0.95,
          currentAnswer: 'RDB 是内存快照，AOF 是命令日志，各有利弊需要权衡',
          lastAnswer: 'Redis 有 RDB 和 AOF 两种方式',
        },
      ],
      repeatedCount: 1,
    };
    const progress = { depth: 'up' };
    const result = detectMemorizedAnswers(repeated, progress);
    assert.equal(result.suspected, false, '回答不同时不预警');
  });
});
