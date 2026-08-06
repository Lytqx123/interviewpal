// P1：高频问题库（方案书 §4.1）。
// 联网调研依据：Interview Question Bank——按岗位类型 + 轮次组织高频考点，
// 配合弱项定向重练（闭环 Iterate）。供候选人自主练习与教练推荐重练用。
import { SCORE_RUBRIC } from './rules.js';

// 高频问题库：按 jobType × round 组织。每题标注考察维度，便于按弱项筛选。
const QUESTION_BANK = {
  tech: {
    round1: [
      { q: '讲讲你简历里最有挑战的一个项目，技术方案和难点是什么？', dim: 'depth' },
      { q: '你熟悉的一个中间件，讲讲它的底层原理和适用场景。', dim: 'depth' },
      { q: '如何设计一个高并发系统？关键的技术选型有哪些？', dim: 'logic' },
    ],
    round2: [
      { q: '结合我们岗位的职责，你会怎么理解这个岗位的核心价值？', dim: 'relevance' },
      { q: '假设线上出现大规模超时，你会怎么排查和止损？', dim: 'logic' },
      { q: '最近关注到什么技术前沿趋势？对我们业务可能有什么影响？', dim: 'depth' },
    ],
    round3: [
      { q: '你的职业规划是什么？为什么选择我们？', dim: 'interaction' },
      { q: '讲一次你在高压下做关键决策的经历。', dim: 'confidence' },
    ],
  },
  product: {
    round1: [
      { q: '讲一个你从 0 到 1 拆解需求的产品案例。', dim: 'depth' },
      { q: '资源只够做一个功能，你怎么排优先级？', dim: 'logic' },
    ],
    round2: [
      { q: '结合我们公司业务，你会怎么定义这个产品的核心场景？', dim: 'relevance' },
      { q: '竞品突然上线颠覆性功能，你怎么应对？', dim: 'logic' },
    ],
    round3: [
      { q: '你希望在公司实现怎样的成长？', dim: 'interaction' },
      { q: '讲一次你在压力下做产品取舍的经历。', dim: 'confidence' },
    ],
  },
  operation: {
    round1: [
      { q: '讲一个你最有成就感的运营案例，核心指标和效果如何？', dim: 'depth' },
      { q: '目标提升 30%，你怎么拆解？', dim: 'logic' },
    ],
    round2: [
      { q: '结合我们业务，你会怎么设计一个提升核心指标的活动？', dim: 'relevance' },
      { q: '活动出现负面舆情，你怎么应急？', dim: 'logic' },
    ],
    round3: [
      { q: '你的职业规划是什么？', dim: 'interaction' },
      { q: '讲一次你在资源不足下达成目标的经历。', dim: 'confidence' },
    ],
  },
};

const DEFAULT_BANK = [
  { q: '先做个自我介绍吧。', dim: 'interaction' },
  { q: '讲一个你需要综合判断做决策的经历。', dim: 'logic' },
  { q: '你最大的优点和需要改进的地方是什么？', dim: 'confidence' },
];

// 按岗位 + 轮次取高频题
export function getQuestions(jobType, roundKey) {
  const bank = QUESTION_BANK[jobType]?.[roundKey];
  return bank ? bank.map((x) => ({ ...x })) : DEFAULT_BANK.map((x) => ({ ...x }));
}

// 按弱项维度筛选重练题：从题库挑出对应弱项维度的题，定向补强。
export function recommendByWeakness(jobType, roundKey, scores) {
  const all = getQuestions(jobType, roundKey);
  const weakDims = Object.entries(scores ?? {})
    .filter(([, s]) => typeof s === 'number' && s < 3)
    .map(([d]) => d);
  if (!weakDims.length) return { weakDims: [], recommended: [], note: '无短板，建议挑战更高难度题' };
  const recommended = all.filter((x) => weakDims.includes(x.dim)).map((x) => ({
    ...x,
    dimName: SCORE_RUBRIC[x.dim]?.name ?? x.dim,
    reason: `针对短板维度定向重练`,
  }));
  return { weakDims: weakDims.map((d) => SCORE_RUBRIC[d]?.name ?? d), recommended, note: `针对 ${weakDims.length} 个短板维度推荐` };
}
