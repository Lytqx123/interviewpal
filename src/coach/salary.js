// 薪资建议报告（§5.10）：综合简历 + 岗位职责（联网刷新）+ 多维复盘报告，
// LLM 生成定制化薪资区间参考与差异化建议。落在复盘教练侧（全记忆），不引入新 agent、
// 不破坏面试官失忆（§5.7）。LLM 不可用时降级为规则兜底。
//
// 触发条件：至少完成一场模拟即可；未练轮次用中等评价（六维 3.0）填充，不过度高估。
// 可选输入：当前薪资（currentSalary，万元/年），提供则额外给出建议涨幅。
import { parseJsonFromText } from '../llm/provider.js';
import { SCORE_RUBRIC } from './rules.js';

const ROUND_KEYS = ['round1', 'round2', 'round3'];
const ROUND_LABELS = {
  round1: '一面（简历面）',
  round2: '二面（业务面）',
  round3: '三面（总监/交叉面）',
};
const SCORE_DIMENSIONS = Object.keys(SCORE_RUBRIC);
const DEFAULT_SCORE = 3.0; // 未练轮次的中等评价（BARS 1/3/5 中位）

/** 聚合同轮多场评分：取平均值。未练轮次用中等评价填充（count=0, defaulted=true）。 */
function aggregateRound(reviews, roundKey) {
  const rs = reviews.filter((r) => r.roundKey === roundKey);
  if (!rs.length) {
    const avgScores = {};
    for (const d of SCORE_DIMENSIONS) avgScores[d] = DEFAULT_SCORE;
    return {
      roundKey,
      label: ROUND_LABELS[roundKey],
      count: 0,
      avgScores,
      difficultCount: 0,
      createdAt: null,
      defaulted: true,
    };
  }
  const avgScores = {};
  for (const d of SCORE_DIMENSIONS) {
    const vals = rs.map((r) => r.scores?.[d]).filter((v) => typeof v === 'number');
    avgScores[d] = vals.length ? +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2) : null;
  }
  const difficultCount = rs.reduce((n, r) => n + (r.difficultQuestions?.length ?? 0), 0);
  return {
    roundKey,
    label: ROUND_LABELS[roundKey],
    count: rs.length,
    avgScores,
    difficultCount,
    createdAt: rs[0]?.createdAt ?? null,
    defaulted: false,
  };
}

/**
 * 检查触发条件：至少完成一场模拟即可。
 * 未练轮次仍会填充中等评价进入 rounds（defaulted=true），missing 记录未练轮次供上层标注。
 */
export function checkSalaryTrigger({ store, companyId, positionId }) {
  const reviews = store.listReviews({ companyId, positionId });
  const rounds = {};
  const missing = [];
  let hasAny = false;
  for (const rk of ROUND_KEYS) {
    const agg = aggregateRound(reviews, rk);
    rounds[rk] = agg;
    if (agg.count === 0) missing.push(rk);
    else hasAny = true;
  }
  return { ready: hasAny, missing, rounds, reviews };
}

/** 跨轮总体均分（含默认填充轮次，未练轮次 3.0 会拉平真实表现，避免过度高估）。 */
function overallAvg(rounds) {
  const vals = SCORE_DIMENSIONS.map((d) => {
    const perRound = Object.values(rounds).map((r) => r.avgScores[d]).filter((v) => v != null);
    return perRound.length ? perRound.reduce((a, b) => a + b, 0) / perRound.length : null;
  }).filter((v) => v != null);
  return vals.length ? +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2) : null;
}

/** 联网刷新：公司 + 岗位 + 薪资行情。此时才搜，保证时效。 */
async function refreshOnline({ search, company, position }) {
  if (!search) return { results: [], source: 'none' };
  const name = company?.name ?? '';
  const title = position?.title ?? '';
  const queries = [
    `${name} ${title} 薪资 待遇`,
    `${name} ${title} 招聘 岗位职责`,
    `${name} 发展前景 业务`,
  ];
  const all = [];
  try {
    for (const q of queries) {
      const items = await search.search(q);
      all.push(...(items ?? []).slice(0, 3));
    }
  } catch (err) {
    return { results: [], source: 'error', error: err.message };
  }
  return { results: all, source: search.name ?? 'unknown' };
}

function buildPrompt({ resumeVersion, position, company, rounds, online, currentSalary }) {
  const resume = resumeVersion?.profile ?? {};
  const skills = (resume.skills ?? []).map((s) => s.name).join('、') || '未提取';
  const exps = (resume.experiences ?? []).map((e) => e.summary).filter(Boolean).join('；') || '未提取';
  const basics = resume.basics ?? {};
  const jobProfile = position?.profile ?? {};
  const responsibilities = (jobProfile.responsibilities ?? []).join('；') || '未提供';
  const requirements = (jobProfile.requirements ?? []).join('；') || '未提供';

  const roundsText = Object.values(rounds)
    .map((r) => {
      const scores = SCORE_DIMENSIONS.map((d) => `${SCORE_RUBRIC[d].name}${r.avgScores[d] ?? '—'}`).join('、');
      const tag = r.count === 0 ? '（未练，按中等评价 3.0 填充）' : `（${r.count}场）`;
      return `${r.label}${tag}：${scores}；困难题 ${r.difficultCount} 个`;
    })
    .join('\n');

  const onlineText = online.results.length
    ? online.results.map((r) => `· ${r.title}：${r.snippet}`).join('\n')
    : '（联网无结果，基于已知信息判断）';

  const salaryText =
    currentSalary != null
      ? `${currentSalary} 万/年`
      : '未提供（按市场公允价值评估，不给涨幅建议）';

  const user = `你是一位资深社招薪资顾问。请基于以下信息，生成一份定制化薪资建议报告。

【候选人简历画像】
姓名：${basics.name ?? '未知'}
当前/目标职位：${basics.title ?? position?.title ?? '未知'}
技能：${skills}
经历：${exps}

【候选人当前薪资】
${salaryText}

【目标岗位】
公司：${company?.name ?? '未知'}
岗位：${position?.title ?? '未知'}
岗位职责：${responsibilities}
任职要求：${requirements}

【多维复盘报告聚合（同轮多场取平均，未练轮次按中等评价 3.0 填充）】
${roundsText}
跨轮总体均分：${overallAvg(rounds) ?? '—'}

【联网最新资料】
${onlineText}

【你的任务】
1. 给出薪资区间参考（low/high，单位：万元/年），综合岗位信息与联网行情；
2. 区间受复盘表现调节，但由你自主判断哪些维度影响、如何影响，不要机械套用公式；
3. reportFocus 由候选人画像自主决定——可能侧重谈薪技巧（negotiationTips），可能侧重公司发展潜力（companyPotential），可能侧重期望薪资调整（advice），不预设场景；
4. strengths/concerns/advice 要具体、可执行，结合候选人真实表现与简历背景；
5. offerStrategy 给出报价策略：提醒此区间为内部参考，向HR报价时建议报锚定值（区间上沿）而非直接报区间（HR易锚定下限），并提醒关注总包结构（base+bonus+equity+福利），不要只看单一数字；
6. 如提供了当前薪资，额外给出 hikeRecommendation（建议涨幅% + targetSalary + basis），涨幅参考社招常规（平跳约30%、表现优异可冲上限、表现弱保守）；未提供则该字段为 null。

【输出 JSON Schema】
{
  "salaryRange": { "low": number, "high": number, "currency": "CNY" },
  "rangeBasis": "区间依据：综合了哪些数据源与复盘表现",
  "reportFocus": "本报告主目的",
  "strengths": ["加分项"],
  "concerns": ["减分项或风险"],
  "advice": ["定制化建议"],
  "negotiationTips": ["谈薪技巧（可选，无则空数组）"],
  "companyPotential": "公司/岗位发展潜力分析（可选，无则 null）",
  "offerStrategy": "报价策略：如何使用此区间向HR报价",
  "hikeRecommendation": { "hikePct": number, "targetSalary": number, "basis": "依据" },
  "summary": "总结"
}
请严格输出 JSON，不要输出解释或 markdown。`;

  return [
    { role: 'system', content: '你是社招薪资顾问，擅长结合面试表现、简历背景、市场行情给出定制化薪资建议。' },
    { role: 'user', content: user },
  ];
}

/** 规则兜底：无 LLM 时基于六维均分 + JD band 给出基础区间与建议。 */
function buildFallbackReport({ resumeVersion, position, company, rounds, currentSalary }) {
  const avg = overallAvg(rounds);
  const name = company?.name ?? '该公司';
  const title = position?.title ?? '该岗位';
  const band = position?.profile?.salaryBand ?? position?.salaryBand ?? null;

  let low;
  let high;
  if (band && typeof band.low === 'number' && typeof band.high === 'number') {
    low = band.low;
    high = band.high;
  } else {
    // 无公开 band：按岗位类型粗分保守区间，提示用户自行核实
    const jobType = position?.profile?.jobType ?? position?.jobType ?? 'tech';
    if (jobType === 'tech') {
      low = 25;
      high = 50;
    } else {
      low = 15;
      high = 30;
    }
  }

  // 复盘表现调节：均分 ≥4 偏上沿，≤2.5 偏下沿
  let tendency = '中位';
  if (avg != null) {
    if (avg >= 4) {
      tendency = '上沿';
      high = Math.round(high * 1.05 * 10) / 10;
    } else if (avg <= 2.5) {
      tendency = '下沿';
      low = Math.round(low * 0.95 * 10) / 10;
    }
  }

  const strengths = [];
  const concerns = [];
  const advice = [];
  if (avg != null) {
    for (const d of SCORE_DIMENSIONS) {
      const perRound = Object.values(rounds).map((r) => r.avgScores[d]).filter((v) => v != null);
      const dimAvg = perRound.length ? perRound.reduce((a, b) => a + b, 0) / perRound.length : null;
      if (dimAvg != null) {
        if (dimAvg >= 4) strengths.push(`${SCORE_RUBRIC[d].name}（均分 ${dimAvg.toFixed(1)}）表现突出`);
        if (dimAvg <= 2.5) concerns.push(`${SCORE_RUBRIC[d].name}（均分 ${dimAvg.toFixed(1)}）偏弱，可能影响定薪`);
      }
    }
  }
  if (!strengths.length) strengths.push('综合表现稳定');
  if (!concerns.length) concerns.push('无明显短板，但也缺少突出亮点');

  advice.push(`参考区间 ${low}–${high} 万/年，建议争取区间${tendency}。`);
  if (!band) advice.push('该岗位无公开薪资 band，上述区间为保守估算，建议结合招聘平台与 offer 网核实。');
  if (avg != null && avg <= 2.5) advice.push('复盘表现偏弱，建议短期补强后再谈薪，或期望薪资报保守。');
  if (avg != null && avg >= 4) advice.push('复盘表现优秀，可用具体项目成果作为谈薪筹码。');

  // 建议涨幅（如提供当前薪资）：均分≥4 涨30%，≤2.5 涨10%，中等涨20%
  let hikeRecommendation = null;
  if (currentSalary != null && currentSalary > 0) {
    let hikePct;
    if (avg != null && avg >= 4) hikePct = 30;
    else if (avg != null && avg <= 2.5) hikePct = 10;
    else hikePct = 20;
    hikeRecommendation = {
      currentSalary,
      hikePct,
      targetSalary: Math.round(currentSalary * (1 + hikePct / 100) * 10) / 10,
      basis: `复盘均分 ${avg ?? '—'} 对应建议涨幅约 ${hikePct}%（社招常规：平跳约30%、表现优异可冲上限、表现弱保守）`,
    };
  }

  return {
    salaryRange: { low, high, currency: 'CNY' },
    rangeBasis: band
      ? `JD band + 复盘均分 ${avg ?? '—'}（规则兜底）`
      : `保守估算 + 复盘均分 ${avg ?? '—'}（规则兜底，无公开 band）`,
    reportFocus: avg != null && avg <= 2.5 ? '期望薪资调整建议' : '薪资区间参考',
    strengths,
    concerns,
    advice,
    negotiationTips: [],
    companyPotential: null,
    offerStrategy: `此区间为系统内部参考，向HR报价时建议报 ${high} 万左右（区间上沿）作为锚定值，不要直接报区间（HR易锚定下限）；同时关注总包结构（base+bonus+equity+福利），不要只看单一数字。`,
    hikeRecommendation,
    summary: `综合 ${Object.keys(rounds).length} 轮复盘表现（总体均分 ${avg ?? '—'}），${name} ${title} 的参考薪资区间约 ${low}–${high} 万/年（${tendency}）。`,
    _fallback: true,
  };
}

/**
 * 生成薪资建议报告。
 * @param {object} opts { store, companyId, positionId, llm, search, currentSalary, log }
 * @returns {Promise<{ ready, report, source, missing?, rounds?, overallAvg? }>}
 */
export async function generateSalaryReport({
  store,
  companyId,
  positionId,
  llm = null,
  search = null,
  currentSalary = null,
  log = console,
} = {}) {
  // 1. 触发条件：至少完成一场模拟
  const trigger = checkSalaryTrigger({ store, companyId, positionId });
  if (!trigger.ready) {
    return {
      ready: false,
      missing: ['至少完成一场模拟'],
      report: null,
      source: 'blocked',
    };
  }

  // 2. 读取公司 / 岗位 / 投递绑定的简历版本
  const company = store.getCompany(companyId);
  const position = store.getPosition(companyId, positionId);
  const app = store.getApplicationByCompany(companyId);
  let resumeVersion = null;
  if (app?.resumeVersionId) resumeVersion = store.getResumeVersion(app.resumeVersionId);

  // 3. 联网刷新（此时才搜）
  const online = await refreshOnline({ search, company, position });

  // 4. LLM 综合 / 规则兜底
  let report = null;
  let source = 'rules';
  if (llm) {
    try {
      const messages = buildPrompt({
        resumeVersion,
        position,
        company,
        rounds: trigger.rounds,
        online,
        currentSalary,
      });
      const raw = await llm(messages, { temperature: 0.3, maxTokens: 4096 });
      const data = parseJsonFromText(raw);
      if (data && data.salaryRange && data.salaryRange.low != null) {
        report = data;
        source = 'llm';
      }
    } catch (err) {
      log.info?.(`[salary] llm failed, fallback to rules: ${err.message}`);
    }
  }
  if (!report) {
    report = buildFallbackReport({ resumeVersion, position, company, rounds: trigger.rounds, currentSalary });
    source = 'rules';
  }

  return {
    ready: true,
    report,
    source,
    onlineSource: online.source,
    rounds: trigger.rounds,
    missing: trigger.missing,
    overallAvg: overallAvg(trigger.rounds),
  };
}

/** 格式化薪资报告为可读文本。 */
export function formatSalaryReport(result) {
  if (!result?.ready) {
    return `【薪资建议】暂不可生成：${result?.missing?.join('、') ?? '请先完成至少一场模拟面试'}。`;
  }
  const r = result.report;
  const lines = [];
  lines.push('【薪资建议报告】');
  lines.push(
    `  来源：${result.source === 'llm' ? 'LLM 综合分析' : '规则兜底'}${
      result.onlineSource && result.onlineSource !== 'none' ? ` · 联网(${result.onlineSource})` : ''
    }`,
  );
  // 标注未练轮次
  const defaultedRounds = Object.values(result.rounds ?? {})
    .filter((rd) => rd.count === 0)
    .map((rd) => rd.label);
  if (defaultedRounds.length) {
    lines.push(`  注：${defaultedRounds.join('、')}未练，按中等评价（3.0）填充。`);
  }
  lines.push('');
  lines.push(`  ■ 参考薪资区间：${r.salaryRange.low}–${r.salaryRange.high} 万/年`);
  if (r.rangeBasis) lines.push(`    依据：${r.rangeBasis}`);
  lines.push(`  ■ 报告侧重：${r.reportFocus ?? '综合参考'}`);
  lines.push('');
  if (r.hikeRecommendation) {
    lines.push('  【建议涨幅】');
    lines.push(
      `    当前 ${r.hikeRecommendation.currentSalary} 万/年 → 建议涨幅 ${r.hikeRecommendation.hikePct}% → 目标 ${r.hikeRecommendation.targetSalary} 万/年`,
    );
    lines.push(`    依据：${r.hikeRecommendation.basis}`);
  }
  if (r.strengths?.length) {
    lines.push('  【加分项】');
    r.strengths.forEach((s) => lines.push(`    · ${s}`));
  }
  if (r.concerns?.length) {
    lines.push('  【风险/减分项】');
    r.concerns.forEach((s) => lines.push(`    · ${s}`));
  }
  if (r.advice?.length) {
    lines.push('  【定制化建议】');
    r.advice.forEach((s) => lines.push(`    · ${s}`));
  }
  if (r.negotiationTips?.length) {
    lines.push('  【谈薪技巧】');
    r.negotiationTips.forEach((s) => lines.push(`    · ${s}`));
  }
  if (r.companyPotential) {
    lines.push('  【公司/岗位发展潜力】');
    lines.push(`    ${r.companyPotential}`);
  }
  if (r.offerStrategy) {
    lines.push('  【报价策略】');
    lines.push(`    ${r.offerStrategy}`);
  }
  if (r.summary) {
    lines.push('');
    lines.push(`  【总结】${r.summary}`);
  }
  return lines.join('\n');
}
