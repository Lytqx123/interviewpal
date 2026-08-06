// 预分析七大层 JSON Schema：面试官面试前读简历形成的判断与执行基线。
// 层定义：
//   ① jdAnalysis          JD 深度解析
//   ② candidateProfile    候选人画像深度分析
//   ③ interviewerPersona  每轮面试官深度人设（round1/round2/round3）
//   ④ roundStrategy       每轮考察策略（维度 / 追问链 / 开场 / 压力测试 / 情景题 / 时间分配 / 跨轮去重）
//   ⑤ riskForecast        风险预判
//   ⑥ reviewFramework     复盘评分框架（BARS + 覆盖度 + 方向偏差 + 命中率回检）
//   ⑦ rhythmDesign        面试节奏与体验设计（每轮独立）
import { ROUND_KEYS, SCORE_DIMENSIONS } from '../archive/constants.js';

export const PREANALYSIS_SCHEMA_VERSION = 1;

// 子维度下限：统计所有数组元素与固定评分项，验收允许 ±3 容差。
export const MIN_SUB_DIMENSIONS = 45;
export const SUB_DIMENSION_TOLERANCE = 3;
export const ACCEPTABLE_MIN_SUB_DIMENSIONS = MIN_SUB_DIMENSIONS - SUB_DIMENSION_TOLERANCE;

const RADAR_KEYS = ['technicalDepth', 'technicalBreadth', 'businessSense', 'communication', 'leadership', 'learning'];

const STRING = { type: 'string' };
const STRING_LIST = { type: 'array', items: STRING };

const JD_ANALYSIS_SCHEMA = {
  type: 'object',
  required: ['roleNature', 'level', 'coreResponsibilities', 'hiddenRequirements', 'redLines', 'industryContext', 'companyStage', 'hiringPain'],
  properties: {
    roleNature: STRING,
    level: STRING,
    coreResponsibilities: STRING_LIST,
    hiddenRequirements: STRING_LIST,
    redLines: STRING_LIST,
    industryContext: STRING,
    companyStage: STRING,
    hiringPain: STRING,
  },
};

const CANDIDATE_PROFILE_SCHEMA = {
  type: 'object',
  required: ['radar', 'credibility', 'highlights', 'weaknesses', 'exaggerationWarnings', 'skillDepth', 'fitAnalysis', 'careerTrajectory', 'likelyStuck'],
  properties: {
    radar: {
      type: 'object',
      required: RADAR_KEYS,
      additionalProperties: false,
      properties: Object.fromEntries(RADAR_KEYS.map((k) => [k, { type: 'integer', minimum: 1, maximum: 5 }])),
    },
    credibility: {
      type: 'array',
      items: {
        type: 'object',
        required: ['summary', 'level', 'verifyFocus'],
        properties: { summary: STRING, level: { type: 'string', enum: ['high', 'medium', 'low'] }, verifyFocus: STRING },
      },
    },
    highlights: {
      type: 'array',
      items: {
        type: 'object',
        required: ['experience', 'depthDirection', 'expectedDepth'],
        properties: { experience: STRING, depthDirection: STRING, expectedDepth: STRING },
      },
    },
    weaknesses: {
      type: 'array',
      items: {
        type: 'object',
        required: ['point', 'probeApproach'],
        properties: { point: STRING, probeApproach: STRING },
      },
    },
    exaggerationWarnings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['statement', 'howToVerify'],
        properties: { statement: STRING, howToVerify: STRING },
      },
    },
    skillDepth: {
      type: 'array',
      items: {
        type: 'object',
        required: ['skill', 'depth'],
        properties: { skill: STRING, depth: { type: 'string', enum: ['了解', '能干', '精通', '能讲清底层原理'] } },
      },
    },
    fitAnalysis: {
      type: 'object',
      required: ['strongMatches', 'weakMatches', 'missingItems'],
      properties: { strongMatches: STRING_LIST, weakMatches: STRING_LIST, missingItems: STRING_LIST },
    },
    careerTrajectory: STRING,
    likelyStuck: STRING_LIST,
  },
};

const PERSONA_SCHEMA = {
  type: 'object',
  required: ['identity', 'background', 'style', 'focus', 'bias', 'killerQuestions', 'questionPattern'],
  properties: {
    identity: STRING,
    background: STRING,
    style: STRING,
    focus: STRING,
    bias: STRING,
    killerQuestions: STRING_LIST,
    questionPattern: STRING,
  },
};

const FOLLOWUP_CHAIN_SCHEMA = {
  type: 'object',
  required: ['id', 'dimension', 'depthTarget', 'keyQuestions', 'chain'],
  properties: {
    id: STRING,
    dimension: STRING,
    depthTarget: STRING,
    keyQuestions: STRING_LIST,
    chain: {
      type: 'array',
      items: {
        type: 'object',
        required: ['level', 'question', 'intent', 'qualityAnchor'],
        properties: {
          level: { type: 'string', enum: ['shallow', 'medium', 'deep'] },
          question: STRING,
          intent: STRING,
          qualityAnchor: STRING,
        },
      },
    },
  },
};

const ROUND_STRATEGY_SCHEMA = {
  type: 'object',
  required: ['dimensions', 'followupChains', 'opening', 'stressTest', 'scenarioDesign', 'timeAllocation', 'dedupList'],
  properties: {
    dimensions: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'excellent', 'failing'],
        properties: { name: STRING, excellent: STRING, failing: STRING },
      },
    },
    followupChains: { type: 'array', items: FOLLOWUP_CHAIN_SCHEMA },
    opening: {
      type: 'object',
      required: ['style', 'firstQuestion'],
      properties: { style: STRING, firstQuestion: STRING },
    },
    stressTest: {
      type: 'object',
      required: ['point', 'method', 'recovery'],
      properties: { point: STRING, method: STRING, recovery: STRING },
    },
    scenarioDesign: {
      type: 'object',
      required: ['scenario', 'question'],
      properties: { scenario: STRING, question: STRING },
    },
    timeAllocation: STRING,
    dedupList: STRING_LIST,
  },
};

const RISK_FORECAST_SCHEMA = {
  type: 'object',
  required: ['likelyStuck', 'exaggerationPoints', 'trapQuestions', 'crossRoundRisks', 'candidateQuestions', 'extremePlans'],
  properties: {
    likelyStuck: {
      type: 'array',
      items: {
        type: 'object',
        required: ['question', 'suggestion', 'rescue'],
        properties: { question: STRING, suggestion: STRING, rescue: STRING },
      },
    },
    exaggerationPoints: {
      type: 'array',
      items: {
        type: 'object',
        required: ['claim', 'verifyApproach', 'depthNeeded'],
        properties: { claim: STRING, verifyApproach: STRING, depthNeeded: STRING },
      },
    },
    trapQuestions: {
      type: 'array',
      items: {
        type: 'object',
        required: ['question', 'intent', 'expectedDirection'],
        properties: { question: STRING, intent: STRING, expectedDirection: STRING },
      },
    },
    crossRoundRisks: {
      type: 'array',
      items: {
        type: 'object',
        required: ['fromRound', 'risk', 'followupRound'],
        properties: { fromRound: STRING, risk: STRING, followupRound: STRING },
      },
    },
    candidateQuestions: {
      type: 'array',
      items: {
        type: 'object',
        required: ['question', 'interviewerAnswer'],
        properties: { question: STRING, interviewerAnswer: STRING },
      },
    },
    extremePlans: {
      type: 'array',
      items: {
        type: 'object',
        required: ['situation', 'response'],
        properties: { situation: STRING, response: STRING },
      },
    },
  },
};

const REVIEW_FRAMEWORK_SCHEMA = {
  type: 'object',
  required: ['dimensions', 'bars', 'coverageChecklist', 'deviationDimensions', 'progressComparison', 'hitRateCheck'],
  properties: {
    dimensions: STRING_LIST,
    bars: {
      type: 'object',
      required: SCORE_DIMENSIONS,
      additionalProperties: false,
      properties: Object.fromEntries(
        SCORE_DIMENSIONS.map((d) => [
          d,
          {
            type: 'object',
            required: ['expectedScore', 'lowAnchor', 'highAnchor'],
            properties: {
              expectedScore: { type: 'integer', minimum: 1, maximum: 5 },
              lowAnchor: STRING,
              highAnchor: STRING,
            },
          },
        ]),
      ),
    },
    coverageChecklist: STRING_LIST,
    deviationDimensions: STRING_LIST,
    progressComparison: STRING_LIST,
    hitRateCheck: STRING_LIST,
  },
};

const RHYTHM_SCHEMA = {
  type: 'object',
  required: ['curve', 'pressureGradient', 'positiveFeedback', 'durationAndCount'],
  properties: {
    curve: STRING,
    pressureGradient: STRING,
    positiveFeedback: STRING,
    durationAndCount: STRING,
  },
};

// 提供给 LLM 的输出约束；也是规则兜底 / 校验的目标结构。
export const PREANALYSIS_SCHEMA = {
  type: 'object',
  required: ['layers'],
  properties: {
    version: { type: 'integer' },
    layers: {
      type: 'object',
      required: ['jdAnalysis', 'candidateProfile', 'interviewerPersona', 'roundStrategy', 'riskForecast', 'reviewFramework', 'rhythmDesign'],
      properties: {
        jdAnalysis: JD_ANALYSIS_SCHEMA,
        candidateProfile: CANDIDATE_PROFILE_SCHEMA,
        interviewerPersona: {
          type: 'object',
          required: ROUND_KEYS,
          additionalProperties: false,
          properties: Object.fromEntries(ROUND_KEYS.map((k) => [k, PERSONA_SCHEMA])),
        },
        roundStrategy: {
          type: 'object',
          required: ROUND_KEYS,
          additionalProperties: false,
          properties: Object.fromEntries(ROUND_KEYS.map((k) => [k, ROUND_STRATEGY_SCHEMA])),
        },
        riskForecast: RISK_FORECAST_SCHEMA,
        reviewFramework: REVIEW_FRAMEWORK_SCHEMA,
        rhythmDesign: {
          type: 'object',
          required: ROUND_KEYS,
          additionalProperties: false,
          properties: Object.fromEntries(ROUND_KEYS.map((k) => [k, RHYTHM_SCHEMA])),
        },
      },
    },
  },
};

function arrayLen(arr) {
  return Array.isArray(arr) ? arr.length : 0;
}

// 统计七大层实际子维度数（数组元素 + 固定评分项），用于验收“≥45 ±3”。
export function countSubDimensions(plan) {
  const layers = plan?.layers;
  if (!layers || typeof layers !== 'object') return 0;
  let count = 0;

  const jd = layers.jdAnalysis ?? {};
  count += arrayLen(jd.coreResponsibilities) + arrayLen(jd.hiddenRequirements) + arrayLen(jd.redLines);

  const cp = layers.candidateProfile ?? {};
  count += RADAR_KEYS.length;
  count += arrayLen(cp.credibility) + arrayLen(cp.highlights) + arrayLen(cp.weaknesses) + arrayLen(cp.exaggerationWarnings) + arrayLen(cp.skillDepth) + arrayLen(cp.likelyStuck);
  count += arrayLen(cp.fitAnalysis?.strongMatches) + arrayLen(cp.fitAnalysis?.weakMatches) + arrayLen(cp.fitAnalysis?.missingItems);

  const persona = layers.interviewerPersona ?? {};
  for (const key of ROUND_KEYS) count += arrayLen(persona[key]?.killerQuestions);

  const rs = layers.roundStrategy ?? {};
  for (const key of ROUND_KEYS) {
    const r = rs[key];
    if (!r || typeof r !== 'object') continue;
    count += arrayLen(r.dimensions) + arrayLen(r.dedupList);
    for (const c of Array.isArray(r.followupChains) ? r.followupChains : []) {
      count += 1 + arrayLen(c.keyQuestions) + arrayLen(c.chain);
    }
  }

  const rf = layers.riskForecast ?? {};
  count += arrayLen(rf.likelyStuck) + arrayLen(rf.exaggerationPoints) + arrayLen(rf.trapQuestions)
    + arrayLen(rf.crossRoundRisks) + arrayLen(rf.candidateQuestions) + arrayLen(rf.extremePlans);

  const rv = layers.reviewFramework ?? {};
  count += arrayLen(rv.dimensions) + arrayLen(rv.coverageChecklist) + arrayLen(rv.deviationDimensions)
    + arrayLen(rv.progressComparison) + arrayLen(rv.hitRateCheck) + SCORE_DIMENSIONS.length;

  const rd = layers.rhythmDesign ?? {};
  for (const key of ROUND_KEYS) {
    const r = rd[key];
    if (r && typeof r === 'object') count += 4;
  }
  return count;
}

/**
 * 严格结构校验：七大层齐全、各层最小数量达标、子维度数 ≥42（45-3）。
 * 返回 { valid, errors, subDimensions }。
 */
export function validatePlan(plan) {
  const errors = [];
  if (!plan || typeof plan !== 'object') {
    return { valid: false, errors: ['plan 不是对象'], subDimensions: 0 };
  }
  const layers = plan.layers;
  if (!layers || typeof layers !== 'object') {
    return { valid: false, errors: ['缺少 layers 七大层结构'], subDimensions: 0 };
  }

  const requireArrayMin = (path, arr, min) => {
    if (!Array.isArray(arr) || arr.length < min) {
      errors.push(`${path} 至少需要 ${min} 项，当前 ${arrayLen(arr)}`);
    }
  };
  const requireNonEmptyString = (path, value) => {
    if (typeof value !== 'string' || !value.trim()) {
      errors.push(`${path} 需要非空字符串`);
    }
  };

  // ① JD 深度解析
  const jd = layers.jdAnalysis;
  if (!jd || typeof jd !== 'object') {
    errors.push('jdAnalysis 缺失');
  } else {
    requireNonEmptyString('jdAnalysis.roleNature', jd.roleNature);
    requireNonEmptyString('jdAnalysis.level', jd.level);
    requireArrayMin('jdAnalysis.coreResponsibilities', jd.coreResponsibilities, 2);
    requireArrayMin('jdAnalysis.hiddenRequirements', jd.hiddenRequirements, 1);
    requireArrayMin('jdAnalysis.redLines', jd.redLines, 1);
  }

  // ② 候选人画像
  const cp = layers.candidateProfile;
  if (!cp || typeof cp !== 'object') {
    errors.push('candidateProfile 缺失');
  } else {
    requireArrayMin('candidateProfile.credibility', cp.credibility, 2);
    requireArrayMin('candidateProfile.highlights', cp.highlights, 2);
    requireArrayMin('candidateProfile.weaknesses', cp.weaknesses, 2);
    requireArrayMin('candidateProfile.exaggerationWarnings', cp.exaggerationWarnings, 1);
    requireArrayMin('candidateProfile.skillDepth', cp.skillDepth, 2);
    requireArrayMin('candidateProfile.likelyStuck', cp.likelyStuck, 1);
    requireArrayMin('candidateProfile.fitAnalysis.strongMatches', cp.fitAnalysis?.strongMatches, 1);
    requireArrayMin('candidateProfile.fitAnalysis.weakMatches', cp.fitAnalysis?.weakMatches, 1);
    requireArrayMin('candidateProfile.fitAnalysis.missingItems', cp.fitAnalysis?.missingItems, 1);
    if (!cp.radar || typeof cp.radar !== 'object') {
      errors.push('candidateProfile.radar 缺失');
    } else {
      for (const k of RADAR_KEYS) {
        if (!Number.isInteger(cp.radar[k]) || cp.radar[k] < 1 || cp.radar[k] > 5) {
          errors.push(`candidateProfile.radar.${k} 需要 1-5 整数`);
        }
      }
    }
  }

  // ③ 每轮面试官人设
  const persona = layers.interviewerPersona;
  if (!persona || typeof persona !== 'object') {
    errors.push('interviewerPersona 缺失');
  } else {
    for (const key of ROUND_KEYS) {
      const p = persona[key];
      if (!p || typeof p !== 'object') {
        errors.push(`interviewerPersona.${key} 缺失`);
        continue;
      }
      requireNonEmptyString(`interviewerPersona.${key}.identity`, p.identity);
      requireArrayMin(`interviewerPersona.${key}.killerQuestions`, p.killerQuestions, 1);
    }
  }

  // ④ 每轮考察策略
  const rs = layers.roundStrategy;
  if (!rs || typeof rs !== 'object') {
    errors.push('roundStrategy 缺失');
  } else {
    for (const key of ROUND_KEYS) {
      const r = rs[key];
      if (!r || typeof r !== 'object') {
        errors.push(`roundStrategy.${key} 缺失`);
        continue;
      }
      requireArrayMin(`roundStrategy.${key}.dimensions`, r.dimensions, 3);
      requireArrayMin(`roundStrategy.${key}.followupChains`, r.followupChains, 5);
      requireNonEmptyString(`roundStrategy.${key}.timeAllocation`, r.timeAllocation);
      for (const [i, c] of (Array.isArray(r.followupChains) ? r.followupChains : []).entries()) {
        requireNonEmptyString(`roundStrategy.${key}.followupChains[${i}].id`, c?.id);
        requireArrayMin(`roundStrategy.${key}.followupChains[${i}].keyQuestions`, c?.keyQuestions, 1);
        requireArrayMin(`roundStrategy.${key}.followupChains[${i}].chain`, c?.chain, 3);
        for (const [j, f] of (Array.isArray(c?.chain) ? c.chain : []).entries()) {
          requireNonEmptyString(`roundStrategy.${key}.followupChains[${i}].chain[${j}].question`, f?.question);
          if (!['shallow', 'medium', 'deep'].includes(f?.level)) {
            errors.push(`roundStrategy.${key}.followupChains[${i}].chain[${j}].level 需为 shallow/medium/deep`);
          }
        }
      }
    }
  }

  // ⑤ 风险预判
  const rf = layers.riskForecast;
  if (!rf || typeof rf !== 'object') {
    errors.push('riskForecast 缺失');
  } else {
    requireArrayMin('riskForecast.likelyStuck', rf.likelyStuck, 3);
    requireArrayMin('riskForecast.exaggerationPoints', rf.exaggerationPoints, 2);
    requireArrayMin('riskForecast.trapQuestions', rf.trapQuestions, 1);
    requireArrayMin('riskForecast.crossRoundRisks', rf.crossRoundRisks, 1);
    requireArrayMin('riskForecast.candidateQuestions', rf.candidateQuestions, 1);
    requireArrayMin('riskForecast.extremePlans', rf.extremePlans, 1);
  }

  // ⑥ 复盘评分框架
  const rv = layers.reviewFramework;
  if (!rv || typeof rv !== 'object') {
    errors.push('reviewFramework 缺失');
  } else {
    requireArrayMin('reviewFramework.dimensions', rv.dimensions, 6);
    for (const dim of SCORE_DIMENSIONS) {
      const a = rv.bars?.[dim];
      if (!a || typeof a !== 'object') {
        errors.push(`reviewFramework.bars.${dim} 缺失`);
        continue;
      }
      if (!Number.isInteger(a.expectedScore) || a.expectedScore < 1 || a.expectedScore > 5) {
        errors.push(`reviewFramework.bars.${dim}.expectedScore 需要 1-5 整数`);
      }
    }
  }

  // ⑦ 面试节奏与体验
  const rd = layers.rhythmDesign;
  if (!rd || typeof rd !== 'object') {
    errors.push('rhythmDesign 缺失');
  } else {
    for (const key of ROUND_KEYS) {
      const r = rd[key];
      if (!r || typeof r !== 'object') {
        errors.push(`rhythmDesign.${key} 缺失`);
        continue;
      }
      requireNonEmptyString(`rhythmDesign.${key}.curve`, r.curve);
      requireNonEmptyString(`rhythmDesign.${key}.pressureGradient`, r.pressureGradient);
    }
  }

  const subDimensions = countSubDimensions(plan);
  if (subDimensions < ACCEPTABLE_MIN_SUB_DIMENSIONS) {
    errors.push(
      `子维度数 ${subDimensions} < 下限 ${ACCEPTABLE_MIN_SUB_DIMENSIONS}（目标 ${MIN_SUB_DIMENSIONS}，容差 ±${SUB_DIMENSION_TOLERANCE}）`,
    );
  }

  return { valid: errors.length === 0, errors, subDimensions };
}

// 归一化：版本号缺失时补 1，其余字段保持原样（结构已在 validatePlan 校验过）。
export function normalizePlan(plan) {
  return {
    ...plan,
    version: plan.version ?? PREANALYSIS_SCHEMA_VERSION,
  };
}
