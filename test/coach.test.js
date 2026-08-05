import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  reviewInterview, compareWithLast, generateReport,
  scoreByRules, improvementByRules, difficultQuestionsByRules, nextFocusByRules, perQuestionReviewByRules,
  SCORE_RUBRIC, formatReport,
} from '../src/coach/index.js';

// 构造有对话历史的面试 session（不依赖 interviewer 模块，独立测试 coach）
function mockSession(answers) {
  const turns = [
    { role: 'interviewer', content: '先做个自我介绍吧。', focusArea: '破冰', turnNo: 1 },
    { role: 'candidate', content: answers[0] ?? '', turnNo: 2 },
    { role: 'interviewer', content: '你提到订单系统，能讲讲你的技术方案吗？', focusArea: '项目深挖', turnNo: 3 },
    { role: 'candidate', content: answers[1] ?? '', turnNo: 4 },
    { role: 'interviewer', content: 'Redis 的底层原理是什么？高并发场景有什么瓶颈？', focusArea: '技术原理', turnNo: 5 },
    { role: 'candidate', content: answers[2] ?? '', turnNo: 6 },
  ];
  return {
    sessionId: 'iv_test', roundKey: 'round1', jobType: 'tech',
    resumeProfile: { basics: { name: '张三' } },
    jobProfile: { title: '后端工程师', jobType: 'tech' },
    turns, depth: 3, maxDepth: 3, phase: 'closing',
  };
}

// 高质量回答：结构词+量化+无犹豫+有反问
const GOOD_ANSWERS = [
  '我叫张三，在字节跳动做了三年后端，主要负责订单系统的设计和优化。',
  '首先，订单系统用 Redis 做了多级缓存。因为热点 key 导致 QPS 从 500 提升到 2000，所以响应时间降低了 60%。其次，我用 Kafka 做了异步削峰，结果数据库压力下降 70%。最后我想问一下，你们的订单量级大概多少？',
  'Redis 底层是单线程模型，用 IO 多路复用实现高并发。瓶颈在于大 key 和热 key，因此需要做分片和本地缓存。综上，合理设计缓存策略是关键。',
];

// 低质量回答：短+犹豫+填充词+无结构
const BAD_ANSWERS = [
  '嗯，那个大概做了个系统吧。',
  '可能用了缓存什么的。好像不太清楚具体细节。',
  '不确定，应该就是普通的缓存吧。',
];

describe('复盘教练 · 规则兜底', () => {
  it('SCORE_RUBRIC：六维 BARS 标准完整', () => {
    const dims = Object.keys(SCORE_RUBRIC);
    assert.equal(dims.length, 6);
    for (const dim of dims) {
      assert.ok(SCORE_RUBRIC[dim].name, `${dim} 有名称`);
      assert.ok(SCORE_RUBRIC[dim].anchors[1], `${dim} 有 1 分锚点`);
      assert.ok(SCORE_RUBRIC[dim].anchors[3], `${dim} 有 3 分锚点`);
      assert.ok(SCORE_RUBRIC[dim].anchors[5], `${dim} 有 5 分锚点`);
    }
  });

  it('scoreByRules：高质量回答评分高于低质量回答', () => {
    const goodSession = mockSession(GOOD_ANSWERS);
    const badSession = mockSession(BAD_ANSWERS);
    const good = scoreByRules(goodSession);
    const bad = scoreByRules(badSession);
    const goodAvg = Object.values(good.scores).reduce((a, b) => a + b, 0) / 6;
    const badAvg = Object.values(bad.scores).reduce((a, b) => a + b, 0) / 6;
    assert.ok(goodAvg > badAvg, `高质量回答均分 ${goodAvg} 应高于低质量 ${badAvg}`);
  });

  it('scoreByRules：六维都有 1-5 分', () => {
    const { scores, scoreEvidence } = scoreByRules(mockSession(GOOD_ANSWERS));
    for (const dim of Object.keys(SCORE_RUBRIC)) {
      assert.ok(scores[dim] >= 1 && scores[dim] <= 5, `${dim} 分数在 1-5`);
      assert.ok(scoreEvidence[dim], `${dim} 有证据`);
    }
  });

  it('improvementByRules：低分 high 优先级、高分 maintain', () => {
    const scores = { logic: 2, relevance: 4, depth: 3, fluency: 4, interaction: 2, confidence: 3 };
    const list = improvementByRules(scores);
    const high = list.filter((i) => i.priority === 'high');
    const medium = list.filter((i) => i.priority === 'medium');
    const maintain = list.filter((i) => i.priority === 'maintain');
    assert.equal(high.length, 2, '2 个低分项 high');
    assert.equal(medium.length, 2, '2 个中分项 medium');
    assert.equal(maintain.length, 2, '2 个高分项 maintain');
    assert.ok(high.every((i) => i.suggestion), 'high 项有建议');
  });

  it('compareWithLast：进步/退步/持平', () => {
    const current = { logic: 4, relevance: 3, depth: 2, fluency: 4, interaction: 3, confidence: 4 };
    const last = { logic: 3, relevance: 3, depth: 4, fluency: 3, interaction: 2, confidence: 4 };
    const cmp = compareWithLast(current, last);
    assert.equal(cmp.progress.logic, 'up', 'logic 进步');
    assert.equal(cmp.progress.relevance, 'flat', 'relevance 持平');
    assert.equal(cmp.progress.depth, 'down', 'depth 退步');
    assert.ok(cmp.summary.includes('进步'), '总结含进步');
    assert.ok(cmp.summary.includes('退步'), '总结含退步');
  });

  it('difficultQuestionsByRules：短回答标记 noAnswer', () => {
    const session = mockSession(['嗯', '', '正常回答'.repeat(20)]);
    const dq = difficultQuestionsByRules(session);
    assert.ok(dq.length >= 1, '有困难题');
    assert.ok(dq.some((q) => q.category === 'noAnswer'), '有 noAnswer 类别');
  });

  it('nextFocusByRules：低分项出现在重点里', () => {
    const scores = { logic: 2, relevance: 4, depth: 3, fluency: 4, interaction: 2, confidence: 4 };
    const focus = nextFocusByRules(scores);
    assert.ok(focus.some((f) => f.includes('逻辑结构')), '低分项逻辑结构在重点');
    assert.ok(focus.some((f) => f.includes('互动质量')), '低分项互动质量在重点');
  });

  it('perQuestionReviewByRules：每题有点评、高质量题分高于低质量题', () => {
    const good = perQuestionReviewByRules(mockSession(GOOD_ANSWERS));
    assert.equal(good.length, 3, '3 个面试官问题 → 3 条逐题点评');
    for (const r of good) {
      assert.ok(r.question, '有问题');
      assert.ok(r.score >= 1 && r.score <= 5, '分数在 1-5');
      assert.ok(r.commentary, '有点评');
      assert.ok(Array.isArray(r.weaknessTags), '有失分标签数组');
    }
    // 高质量回答的逐题均分应高于低质量
    const bad = perQuestionReviewByRules(mockSession(BAD_ANSWERS));
    const goodAvg = good.reduce((s, r) => s + r.score, 0) / good.length;
    const badAvg = bad.reduce((s, r) => s + r.score, 0) / bad.length;
    assert.ok(goodAvg > badAvg, `高质量逐题均分 ${goodAvg} 应高于低质量 ${badAvg}`);
    // 低质量回答应命中失分标签
    assert.ok(bad.some((r) => r.weaknessTags.length > 0), '低质量回答有失分标签');
  });

  it('perQuestionReviewByRules：短回答标"答非所问"', () => {
    const r = perQuestionReviewByRules(mockSession(['嗯', '', '正常回答'.repeat(20)]));
    assert.ok(r.some((q) => q.weaknessTags.includes('答非所问')), '短回答标答非所问');
  });
});

describe('复盘教练 · 引擎（规则路径）', () => {
  it('reviewInterview：规则路径生成完整复盘结果', async () => {
    const session = mockSession(GOOD_ANSWERS);
    const result = await reviewInterview(session);
    assert.ok(result.scores, '有六维评分');
    assert.ok(result.scoreEvidence, '有评分证据');
    assert.ok(result.improvementList, '有改进清单');
    assert.ok(result.nextFocus, '有下次重点');
    assert.ok(result.directionDeviation, '有方向偏差');
    assert.ok(result.perQuestionReview?.length, '有逐题点评');
    assert.equal(result.comparedWithLast, null, '无 lastReview 时 comparedWithLast 为 null');
  });

  it('reviewInterview + lastReview：生成与上次对比', async () => {
    const session = mockSession(GOOD_ANSWERS);
    const lastReview = {
      scores: { logic: 2, relevance: 3, depth: 2, fluency: 3, interaction: 2, confidence: 3 },
    };
    const result = await reviewInterview(session, { lastReview });
    assert.ok(result.comparedWithLast, '有与上次对比');
    assert.ok(result.comparedWithLast.progress, '有逐维 progress');
    assert.ok(result.comparedWithLast.summary, '有对比总结');
  });
});

describe('复盘教练 · LLM 路径', () => {
  function fakeLlm() {
    return async () =>
      JSON.stringify({
        scores: { logic: 4, relevance: 5, depth: 3, fluency: 4, interaction: 3, confidence: 4 },
        scoreEvidence: { logic: '用了首先其次最后', relevance: '精准切题', depth: '有量化数据', fluency: '表达流畅', interaction: '有反问', confidence: '语气坚定' },
        perQuestionReview: [{ turnNo: 3, question: '技术方案', answer: '多级缓存', score: 4, followedUp: true, weaknessTags: [], commentary: '结构完整' }],
        directionDeviation: { expected: ['项目深挖', '技术原理'], actual: ['项目深挖', '技术原理'], notes: '方向一致' },
        difficultQuestions: [{ question: 'Redis 底层原理', category: 'shallow', notes: '回答不够深入' }],
        improvementList: [{ dimension: 'depth', priority: 'medium', suggestion: '加强底层原理' }],
        comparedWithLast: null,
        nextFocus: ['强化专业深度'],
      });
  }

  it('reviewInterview：LLM 路径解析评分', async () => {
    const session = mockSession(GOOD_ANSWERS);
    const result = await reviewInterview(session, { llm: fakeLlm() });
    assert.equal(result.scores.logic, 4);
    assert.equal(result.scores.relevance, 5);
    assert.ok(result.scoreEvidence.logic, 'LLM 证据保留');
    assert.equal(result.difficultQuestions[0].category, 'shallow');
    assert.equal(result.perQuestionReview[0].score, 4, 'LLM 逐题点评保留');
  });

  it('reviewInterview：LLM 失败落回规则', async () => {
    const badLlm = async () => { throw new Error('network'); };
    const session = mockSession(GOOD_ANSWERS);
    const result = await reviewInterview(session, { llm: badLlm });
    assert.ok(result.scores, 'LLM 挂了仍有评分');
    assert.ok(result.improvementList, '规则兜底有改进清单');
  });

  it('reviewInterview：LLM 返回垃圾落回规则', async () => {
    const garbageLlm = async () => '这不是JSON';
    const session = mockSession(GOOD_ANSWERS);
    const result = await reviewInterview(session, { llm: garbageLlm });
    assert.ok(result.scores, '垃圾输出仍有规则兜底');
  });

  it('LLM 评分越界被钳制到 1-5', async () => {
    const overflowLlm = async () =>
      JSON.stringify({ scores: { logic: 99, relevance: -1, depth: 3, fluency: 3, interaction: 3, confidence: 3 } });
    const session = mockSession(GOOD_ANSWERS);
    const result = await reviewInterview(session, { llm: overflowLlm });
    assert.equal(result.scores.logic, 5, '99 钳制到 5');
    assert.equal(result.scores.relevance, 1, '-1 钳制到 1');
  });
});

describe('复盘教练 · 六维报告', () => {
  it('formatReport：报告含六维评分条 + 改进清单 + 下次重点', async () => {
    const session = mockSession(GOOD_ANSWERS);
    const result = await reviewInterview(session, {
      lastReview: { scores: { logic: 2, relevance: 3, depth: 2, fluency: 3, interaction: 2, confidence: 3 } },
    });
    const report = formatReport(result, { session });
    assert.ok(report.includes('六维评分'), '含六维评分');
    assert.ok(report.includes('█'), '含评分条');
    assert.ok(report.includes('逐题点评'), '含逐题点评');
    assert.ok(report.includes('改进清单'), '含改进清单');
    assert.ok(report.includes('与上次对比'), '含与上次对比');
    assert.ok(report.includes('下次重点'), '含下次重点');
  });

  it('formatReport：报告含进步/退步标记', async () => {
    const session = mockSession(GOOD_ANSWERS);
    const result = await reviewInterview(session, {
      lastReview: { scores: { logic: 2, relevance: 2, depth: 2, fluency: 2, interaction: 2, confidence: 2 } },
    });
    const report = formatReport(result, { session });
    assert.ok(report.includes('↑'), '含进步标记');
  });

  it('generateReport：与 formatReport 一致', async () => {
    const session = mockSession(GOOD_ANSWERS);
    const result = await reviewInterview(session);
    const report = generateReport(result, { session });
    assert.ok(report.includes('面试复盘报告'));
  });
});
