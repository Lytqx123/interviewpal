// 预分析自学习：把复盘偏差报告回写预分析缓存 feedback 数组，并在二次预分析时调整④层考察策略。
// 生命周期与缓存一致：feedback 存于 plan.feedback，删除公司/岗位时随缓存一起释放。
// 上限：最近 3 次，超出滚动淘汰（避免 feedback 累积导致 prompt 膨胀）。

import { preanalysisCacheKey } from '../preanalysis/cache.js';

export const MAX_FEEDBACK_ROUNDS = 3;

/** 追加一条偏差反馈到 plan.feedback（最多保留最近 3 次，滚动淘汰）。 */
export function appendFeedbackToPlan(plan, diffReport) {
  if (!plan || !diffReport) return plan;
  const feedback = Array.isArray(plan.feedback) ? plan.feedback : [];
  const entry = {
    at: new Date().toISOString(),
    roundKey: diffReport.roundKey ?? null,
    report: diffReport,
  };
  const next = [...feedback, entry];
  if (next.length > MAX_FEEDBACK_ROUNDS) next.splice(0, next.length - MAX_FEEDBACK_ROUNDS);
  return { ...plan, feedback: next };
}

/** 回写偏差报告到预分析缓存；无缓存/无 store 时静默返回 null（不阻断复盘主流程）。 */
export function updateStrategyCacheWithFeedback(store, cacheKeyOrParams, diffReport) {
  if (!store || !diffReport) return null;
  const key =
    typeof cacheKeyOrParams === 'string'
      ? cacheKeyOrParams
      : preanalysisCacheKey(cacheKeyOrParams);
  const cached = store.getPreanalysisCache(key);
  if (!cached) return null;
  const updated = appendFeedbackToPlan(cached, diffReport);
  store.setPreanalysisCache(key, updated);
  return updated.feedback;
}

/**
 * 把最近一次反馈应用到计划：上次未问的主线在④层考察策略中前置并标记权重提升。
 * 无 feedback / 无未问主线时原样返回（幂等，可安全用于 LLM 与规则两条路径）。
 */
export function applyFeedbackAdjustments(plan) {
  if (!plan?.layers?.roundStrategy) return plan;
  const feedback = Array.isArray(plan.feedback) ? plan.feedback : [];
  if (!feedback.length) return plan;
  const report = feedback[feedback.length - 1]?.report;
  const unasked = Array.isArray(report?.unaskedMainlines) ? report.unaskedMainlines : [];
  if (!unasked.length) return plan;
  const roundKey = report.roundKey ?? Object.keys(plan.layers.roundStrategy)[0];
  const strategy = plan.layers.roundStrategy[roundKey];
  const chains = Array.isArray(strategy?.followupChains) ? strategy.followupChains : [];
  if (!chains.length) return plan;

  const idSet = new Set(unasked.map((u) => u.mainlineId).filter(Boolean));
  if (!idSet.size) return plan;
  const boosted = chains.filter((c) => idSet.has(c.id)).map((c) => ({
    ...c,
    priorityBoost: true,
    boostReason: '上次未问，本轮优先',
  }));
  if (!boosted.length) return plan;
  const rest = chains.filter((c) => !idSet.has(c.id));
  return {
    ...plan,
    layers: {
      ...plan.layers,
      roundStrategy: {
        ...plan.layers.roundStrategy,
        [roundKey]: { ...strategy, followupChains: [...boosted, ...rest] },
      },
    },
  };
}
