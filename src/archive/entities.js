import { newId } from './ids.js';
import { ROUND_KEYS, SCORE_DIMENSIONS } from './constants.js';

// 轮次的初始状态：次数从 0 开始，弱项/强项等复盘教练写入。
export function emptyRoundState() {
  return {
    completedCount: 0,
    lastSessionId: null,
    lastReviewId: null,
    lastPracticedAt: null,
    weakPoints: [],
    strengths: [],
    ready: false, // 连续达标后置 true，建议进入下一轮
  };
}

export function emptyRounds() {
  return Object.fromEntries(ROUND_KEYS.map((key) => [key, emptyRoundState()]));
}

// 复盘六维评分，全部先置 null，教练评完再填
export function emptyScores() {
  return Object.fromEntries(SCORE_DIMENSIONS.map((dim) => [dim, null]));
}

// 复盘记录的最小骨架。saveReview 之前先拿它兜底，字段随教练模块扩展。
// 记忆闭环扩展：questions（跨场次重复题对比用）、perQuestionReview/scoreEvidence（复盘产物）。
export function newReviewRecord({ companyId, positionId, roundKey, sessionId, createdAt = new Date().toISOString() }) {
  return {
    reviewId: newId('rv'),
    sessionId,
    companyId,
    positionId,
    roundKey,
    scores: emptyScores(),
    scoreEvidence: {},
    directionDeviation: { expected: [], actual: [], notes: '' },
    difficultQuestions: [],
    perQuestionReview: [],
    questions: [], // 本场面试官问题（供下次复盘做重复题对比）
    improvementList: [],
    comparedWithLast: null,
    nextFocus: [],
    createdAt,
  };
}
