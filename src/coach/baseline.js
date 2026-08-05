// P1：基线诊断与通关建议（阶段八可选）。
// 联网调研依据：三层复盘法第三层"行动层"——基于跨场次趋势给通关建议；
// 学习闭环 Iterate 环节——达标后才进入下一轮，避免带伤上场。
import { ROUND_KEYS, SCORE_DIMENSIONS } from '../archive/constants.js';
import { SCORE_RUBRIC } from './rules.js';

// 通关阈值：六维均分 >= 3.5 且无维度 < 3，视为该轮达标，建议进入下一轮。
const PASS_AVG = 3.5;
const PASS_MIN = 3;

// 基线诊断：汇总某公司某岗位各轮次状态 + 最近复盘，给出整体进度画像。
export function diagnoseBaseline({ store, companyId, positionId }) {
  const position = store.getPosition(companyId, positionId);
  if (!position) throw new Error(`position not found: ${companyId}/${positionId}`);
  const rounds = position.rounds;
  const diagnosis = ROUND_KEYS.map((key) => {
    const state = rounds[key];
    const reviews = store.listReviews({ companyId, positionId, roundKey: key });
    const latest = reviews[0] ?? null;
    return {
      roundKey: key,
      completedCount: state.completedCount,
      lastPracticedAt: state.lastPracticedAt,
      latestScores: latest?.scores ?? null,
      ready: latest ? isPassing(latest.scores) : false,
    };
  });
  const currentRound = nextRoundToPractice(diagnosis);
  return {
    positionTitle: position.title,
    jobType: position.jobType,
    rounds: diagnosis,
    currentRound, // 下一步该练的轮次
    overall: summarizeOverall(diagnosis),
  };
}

// 通关建议：某轮是否可以进入下一轮。
export function passRecommendation({ store, companyId, positionId, roundKey }) {
  const reviews = store.listReviews({ companyId, positionId, roundKey });
  const latest = reviews[0] ?? null;
  if (!latest) {
    return { roundKey, ready: false, reason: '该轮次尚未练习，建议先完成至少一场模拟', action: `开始${roundLabel(roundKey)}` };
  }
  const scores = latest.scores;
  const avg = avgScore(scores);
  const weakDims = weakDimensions(scores);
  const passing = isPassing(scores);
  const idx = ROUND_KEYS.indexOf(roundKey);
  const nextRound = ROUND_KEYS[idx + 1] ?? null;
  return {
    roundKey,
    ready: passing,
    avgScore: Math.round(avg * 10) / 10,
    weakDimensions: weakDims,
    reason: passing
      ? `六维均分 ${avg.toFixed(1)}，无短板维度，建议进入${nextRound ? roundLabel(nextRound) : '下一阶段'}`
      : `六维均分 ${avg.toFixed(1)}${weakDims.length ? `，短板维度：${weakDims.join('、')}` : ''}，建议针对短板继续练习`,
    action: passing ? (nextRound ? `开始${roundLabel(nextRound)}` : '准备终面通过') : `重练${roundLabel(roundKey)}`,
    nextRound,
  };
}

function isPassing(scores) {
  if (!scores) return false;
  const vals = SCORE_DIMENSIONS.map((d) => scores[d]).filter((v) => typeof v === 'number');
  if (!vals.length) return false;
  return avgScore(scores) >= PASS_AVG && vals.every((v) => v >= PASS_MIN);
}

function avgScore(scores) {
  const vals = SCORE_DIMENSIONS.map((d) => scores[d]).filter((v) => typeof v === 'number');
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
}

function weakDimensions(scores) {
  return SCORE_DIMENSIONS.filter((d) => typeof scores[d] === 'number' && scores[d] < PASS_MIN).map((d) => SCORE_RUBRIC[d].name);
}

function nextRoundToPractice(diagnosis) {
  // 第一个未达标或未练的轮次
  for (const r of diagnosis) {
    if (r.completedCount === 0) return { roundKey: r.roundKey, reason: '尚未练习', label: roundLabel(r.roundKey) };
    if (!r.ready) return { roundKey: r.roundKey, reason: '尚未达标', label: roundLabel(r.roundKey) };
  }
  return { roundKey: null, reason: '所有轮次已达标', label: '全部通过' };
}

function summarizeOverall(diagnosis) {
  const done = diagnosis.filter((r) => r.ready).length;
  const practiced = diagnosis.filter((r) => r.completedCount > 0).length;
  return `已练 ${practiced}/${diagnosis.length} 轮，达标 ${done}/${diagnosis.length} 轮`;
}

function roundLabel(key) {
  return { round1: '一面', round2: '二面', round3: '三面' }[key] ?? key;
}

export { roundLabel };
