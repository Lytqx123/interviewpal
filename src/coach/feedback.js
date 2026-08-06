// 复盘反馈闭环：比较「预分析 baseline plan vs 实际执行轨迹」，生成偏差报告。
// 五个维度：未问主线 / 换线次数 / 信号触发分布 / 评分锚点偏差 / 预判翻车点命中率。
// 偏差报告由 memory 编排层回写预分析缓存（selfLearn.js），形成跨场次自学习闭环。

const ADJUSTMENT_SWITCH = 'switch-line';

function normalizeText(value) {
  return String(value ?? '').replace(/\s+/g, '').toLowerCase();
}

// 轻量相似度：包含关系或 2-gram 重叠 ≥35% 视为同一预判点。
function similarText(a, b) {
  const ta = normalizeText(a);
  const tb = normalizeText(b);
  if (!ta || !tb) return false;
  if (ta.includes(tb) || tb.includes(ta)) return true;
  const grams = (s) => {
    const set = new Set();
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    return set;
  };
  const ga = grams(ta);
  const gb = grams(tb);
  if (!ga.size || !gb.size) return false;
  let hit = 0;
  for (const g of gb) if (ga.has(g)) hit++;
  return hit / gb.size >= 0.35;
}

/**
 * 生成「预计 vs 实际」偏差报告。
 * @param {object} opts
 * @param {object} [opts.baselinePlan] 面试官 baseline plan（含 items[].mainlineId）
 * @param {object} [opts.plan] 预分析七大层 plan（含 riskForecast / reviewFramework）
 * @param {string} [opts.roundKey] 轮次
 * @param {Array} [opts.executionTrace] 实际执行轨迹（来自 interviewer session）
 * @param {Array} [opts.difficultQuestions] 复盘困难题清单
 * @param {object} [opts.scores] 复盘六维得分
 * @returns {object|null} 无 baseline/轨迹时返回 null（规则模式不产出偏差报告）
 */
export function diffPlanVsExecution({
  baselinePlan,
  plan,
  roundKey,
  executionTrace = [],
  difficultQuestions = [],
  scores = {},
} = {}) {
  const items = Array.isArray(baselinePlan?.items) ? baselinePlan.items : [];
  const trace = Array.isArray(executionTrace) ? executionTrace : [];
  if (!items.length && !trace.length) return null;

  // 1. 未问主线：baseline 有、执行轨迹从未出现的主线
  const asked = new Set(trace.map((e) => e.mainlineId).filter(Boolean));
  const unaskedMainlines = items
    .filter((it) => it.mainlineId && !asked.has(it.mainlineId))
    .map((it) => ({ mainlineId: it.mainlineId, focus: it.focus ?? it.dimension ?? '' }));

  // 2. 换线次数
  const switchCount = trace.filter((e) => e.adjustment === ADJUSTMENT_SWITCH).length;

  // 3. 信号触发分布（四类信号各自出现次数）
  const signalDistribution = { highDifficulty: 0, offTopic: 0, shallow: 0, poorFluency: 0 };
  for (const e of trace) {
    const s = e.signals ?? {};
    if (s.difficulty === 'high') signalDistribution.highDifficulty++;
    if (s.direction === 'off_topic') signalDistribution.offTopic++;
    if (s.depth === 'shallow') signalDistribution.shallow++;
    if (s.fluency === 'poor') signalDistribution.poorFluency++;
  }

  // 4. 评分锚点偏差：实际六维得分 vs 计划⑥层期望分位
  const bars = plan?.layers?.reviewFramework?.bars ?? {};
  const scoreAnchorDeviation = {};
  for (const [dim, cfg] of Object.entries(bars)) {
    if (typeof scores[dim] !== 'number' || typeof cfg?.expectedScore !== 'number') continue;
    const delta = Math.round((scores[dim] - cfg.expectedScore) * 10) / 10;
    if (delta !== 0) scoreAnchorDeviation[dim] = delta;
  }
  const anchorDeviationCount = Object.keys(scoreAnchorDeviation).length;

  // 5. 预判翻车点命中率：困难题 vs 计划⑤层 likelyStuck
  const likelyStuck = Array.isArray(plan?.layers?.riskForecast?.likelyStuck)
    ? plan.layers.riskForecast.likelyStuck
    : [];
  const hitStuck = likelyStuck.filter((p) =>
    (difficultQuestions ?? []).some((d) => similarText(d.question, p.question)),
  );
  const total = likelyStuck.length;
  const hit = hitStuck.length;
  const hitRate = total ? { total, hit, rate: Math.round((hit / total) * 100) } : { total: 0, hit: 0, rate: 0 };

  const unaskedCount = unaskedMainlines.length;
  const summaryParts = [
    `主线覆盖 ${items.length - unaskedCount}/${items.length}（未问 ${unaskedCount}）`,
    `换线 ${switchCount} 次`,
    `信号 ${Object.values(signalDistribution).reduce((a, b) => a + b, 0)} 次`,
  ];
  if (anchorDeviationCount) summaryParts.push(`评分锚点偏差 ${anchorDeviationCount} 维`);
  summaryParts.push(`翻车点命中 ${hit}/${total}（${hitRate.rate}%）`);

  return {
    roundKey: roundKey ?? null,
    summary: summaryParts.join('；'),
    totalMainlines: items.length,
    unaskedMainlines,
    unaskedCount,
    switchCount,
    signalDistribution,
    scoreAnchorDeviation,
    anchorDeviationCount,
    hitRate,
    hitStuck: hitStuck.map((p) => ({ question: p.question, suggestion: p.suggestion })),
  };
}

/** 供 LLM prompt 注入的可读摘要（截断字段，避免 feedback 膨胀）。 */
export function summarizeFeedbackForPrompt(diffReport) {
  if (!diffReport) return '';
  const unasked = (diffReport.unaskedMainlines ?? []).map((u) => u.focus || u.mainlineId).join('、') || '无';
  const sig = diffReport.signalDistribution ?? {};
  const dev = Object.entries(diffReport.scoreAnchorDeviation ?? {})
    .map(([d, v]) => `${d} ${v > 0 ? '+' : ''}${v}`)
    .join('、') || '无';
  const hr = diffReport.hitRate ?? {};
  return [
    `主线覆盖：已问 ${(diffReport.totalMainlines ?? 0) - (diffReport.unaskedCount ?? 0)}/${diffReport.totalMainlines ?? 0}`,
    `未问主线：${unasked}`,
    `换线次数：${diffReport.switchCount ?? 0}`,
    `信号分布：高难度 ${sig.highDifficulty ?? 0} / 偏题 ${sig.offTopic ?? 0} / 浅薄 ${sig.shallow ?? 0} / 流畅差 ${sig.poorFluency ?? 0}`,
    `评分锚点偏差：${dev}`,
    `预判翻车点命中率：${hr.rate ?? 0}%（命中 ${hr.hit ?? 0}/${hr.total ?? 0}）`,
  ].join('；');
}
