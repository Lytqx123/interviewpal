// 记忆闭环编排层（阶段七：记忆闭环与困难题沉淀）。
// 把"教练复盘（阶段六）"和"档案库（阶段一）"、"飞书回传"串成闭环：
//   读同公司同轮次上次复盘 → 复盘评估 → 跨场次增强对比（重复题/改进项完成率/上次也卡壳）
//   → 可勾选改进清单 → 写入档案库 + 更新轮次状态 → 报告回传飞书。
//
// 设计原则：coach 模块本身不依赖档案库（保持阶段六自洽），记忆闭环依赖由本文件承担。
// 联网调研依据：Learning Loop（Reflect→Iterate）、三层复盘法第二层"跨多次练习趋势对比"。
import { reviewInterview, generateReport } from './engine.js';
import {
  extractSessionQuestions,
  compareRepeatedQuestions,
  improvementCompletionRate,
  markAlsoStuckLastTime,
  makeCheckable,
} from './rules.js';
import { newReviewRecord } from '../archive/entities.js';

// 记忆闭环主入口：一场面试结束后调用，自动读取上次复盘并写回档案库。
export async function reviewWithMemory(session, {
  store,
  companyId,
  positionId,
  roundKey,
  llm = null,
  reply = null,
} = {}) {
  if (!store) throw new Error('reviewWithMemory 需要 store（记忆闭环依赖档案库）');
  if (!companyId || !positionId || !roundKey) {
    throw new Error('reviewWithMemory 需要 companyId / positionId / roundKey');
  }

  // 1. 读上次复盘：同公司同岗位同轮次最近一场（listReviews 已按时间倒序，[0] 即上次）
  const lastReview = store.listReviews({ companyId, positionId, roundKey })[0] ?? null;

  // 2. 复盘评估（带 lastReview 做六维升降对比，阶段六已实现）
  const result = await reviewInterview(session, { lastReview, llm });

  // 3. 跨场次增强对比 + 困难题标注（仅当有上次复盘时）
  if (lastReview) {
    result.comparedWithLast = enrichComparison(result, session, lastReview);
    result.difficultQuestions = markAlsoStuckLastTime(
      result.difficultQuestions,
      lastReview.difficultQuestions ?? [],
    );
  }

  // 4. 可勾选改进清单（困难题相关维度标优先重练）
  result.improvementList = makeCheckable(result.improvementList, result.difficultQuestions);

  // 5. 构造复盘记录并写入档案库
  const record = buildReviewRecord(session, result, { companyId, positionId, roundKey });
  const saved = store.saveReview(record);

  // 6. 更新轮次状态：次数+1、记录本场 sessionId / reviewId（§5.4）
  store.recordRoundSession(companyId, positionId, roundKey, {
    sessionId: session.sessionId,
    reviewId: saved.reviewId,
  });

  // 7. 生成报告 + 回传飞书（飞书渠道由调用方通过 reply 注入）
  const report = generateReport(result, { session });
  if (reply) await reply(report);

  return { result, record: saved, report, lastReview };
}

// 跨场次对比增强：在阶段六维度升降基础上，叠加重复题对比 + 改进项完成率。
function enrichComparison(result, session, lastReview) {
  const base = result.comparedWithLast ?? { progress: {}, summary: '首次面试，无对比' };
  const currentQuestions = extractSessionQuestions(session);
  return {
    ...base,
    repeatedQuestions: compareRepeatedQuestions(currentQuestions, lastReview.questions ?? []),
    improvementCompletion: improvementCompletionRate(result.scores, lastReview.improvementList ?? []),
  };
}

// 构造写入档案库的复盘记录（含本场问题清单，供下次重复题对比）
function buildReviewRecord(session, result, { companyId, positionId, roundKey }) {
  return {
    ...newReviewRecord({ companyId, positionId, roundKey, sessionId: session.sessionId }),
    scores: result.scores,
    scoreEvidence: result.scoreEvidence,
    directionDeviation: result.directionDeviation,
    difficultQuestions: result.difficultQuestions,
    perQuestionReview: result.perQuestionReview,
    improvementList: result.improvementList,
    comparedWithLast: result.comparedWithLast,
    nextFocus: result.nextFocus,
    questions: extractSessionQuestions(session),
  };
}
