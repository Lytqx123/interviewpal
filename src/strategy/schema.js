// 七层作战地图 JSON Schema（方案书 §5.4 / 重构计划 R1）。
// 层定义：
//   L1 候选人画像摘要   L2 岗位匹配度   L3 风险点清单
//   L4 必问主线         L5 追问树       L6 评分锚点   L7 轮次定位
import { ROUND_KEYS, SCORE_DIMENSIONS } from '../archive/constants.js';

export const STRATEGY_SCHEMA_VERSION = 1;

// 七层最小子维度要求：约 48，验收允许误差 ≤3，因此结构校验下限 = 42。
export const MIN_SUB_DIMENSIONS = 45;
export const SUB_DIMENSION_TOLERANCE = 3;
export const ACCEPTABLE_MIN_SUB_DIMENSIONS = MIN_SUB_DIMENSIONS - SUB_DIMENSION_TOLERANCE;

const SCORE_ANCHOR_SCHEMA = {
  type: 'object',
  required: ['expectedScore', 'lowAnchor', 'highAnchor'],
  properties: {
    expectedScore: { type: 'integer', minimum: 1, maximum: 5 },
    lowAnchor: { type: 'string' },
    highAnchor: { type: 'string' },
  },
};

const ROUND_SCHEMA = {
  type: 'object',
  required: ['focus', 'style', 'duration', 'keyDimensions'],
  properties: {
    focus: { type: 'string' },
    style: { type: 'string' },
    duration: { type: 'string' },
    keyDimensions: { type: 'array', items: { type: 'string' } },
  },
};

// 提供给 LLM 的输出约束；也是规则兜底/校验的目标结构。
export const STRATEGY_SCHEMA = {
  type: 'object',
  required: ['layers'],
  properties: {
    version: { type: 'integer' },
    layers: {
      type: 'object',
      required: [
        'candidateProfile',
        'positionFit',
        'riskPoints',
        'mustAskMainlines',
        'followupTree',
        'scoreAnchors',
        'roundPositioning',
      ],
      properties: {
        candidateProfile: {
          type: 'object',
          required: ['strengths', 'weaknesses', 'redFlags'],
          properties: {
            strengths: { type: 'array', items: { type: 'string' } },
            weaknesses: { type: 'array', items: { type: 'string' } },
            redFlags: { type: 'array', items: { type: 'string' } },
          },
        },
        positionFit: {
          type: 'object',
          required: ['hardSkills', 'softSkills', 'experienceFit'],
          properties: {
            hardSkills: { type: 'array', items: { type: 'string' } },
            softSkills: { type: 'array', items: { type: 'string' } },
            experienceFit: { type: 'string' },
          },
        },
        riskPoints: {
          type: 'array',
          items: {
            type: 'object',
            required: ['category', 'description', 'severity'],
            properties: {
              category: { type: 'string' },
              description: { type: 'string' },
              severity: { type: 'string', enum: ['low', 'medium', 'high'] },
            },
          },
        },
        mustAskMainlines: {
          type: 'array',
          items: {
            type: 'object',
            required: ['id', 'focus', 'intent', 'depthTarget', 'keyQuestions'],
            properties: {
              id: { type: 'string' },
              focus: { type: 'string' },
              intent: { type: 'string' },
              depthTarget: { type: 'string' },
              keyQuestions: { type: 'array', items: { type: 'string' } },
            },
          },
        },
        followupTree: {
          type: 'array',
          items: {
            type: 'object',
            required: ['mainlineId', 'level', 'question', 'intent'],
            properties: {
              mainlineId: { type: 'string' },
              level: { type: 'string', enum: ['shallow', 'medium', 'deep'] },
              question: { type: 'string' },
              intent: { type: 'string' },
            },
          },
        },
        scoreAnchors: {
          type: 'object',
          required: SCORE_DIMENSIONS,
          additionalProperties: false,
          properties: Object.fromEntries(SCORE_DIMENSIONS.map((d) => [d, SCORE_ANCHOR_SCHEMA])),
        },
        roundPositioning: {
          type: 'object',
          required: ROUND_KEYS,
          additionalProperties: false,
          properties: Object.fromEntries(ROUND_KEYS.map((k) => [k, ROUND_SCHEMA])),
        },
      },
    },
  },
};

function arrayLen(arr) {
  return Array.isArray(arr) ? arr.length : 0;
}

// 统计七层实际子维度数（含追问 keyQuestions 展开），用于验收"≥45 ±3"。
export function countSubDimensions(plan) {
  const layers = plan?.layers;
  if (!layers || typeof layers !== 'object') return 0;
  let count = 0;

  const cp = layers.candidateProfile ?? {};
  count += arrayLen(cp.strengths) + arrayLen(cp.weaknesses) + arrayLen(cp.redFlags);

  const pf = layers.positionFit ?? {};
  count += arrayLen(pf.hardSkills) + arrayLen(pf.softSkills);
  count += typeof pf.experienceFit === 'string' && pf.experienceFit ? 1 : 0;

  count += arrayLen(layers.riskPoints);

  const mainlines = Array.isArray(layers.mustAskMainlines) ? layers.mustAskMainlines : [];
  count += mainlines.length;
  count += mainlines.reduce((n, m) => n + arrayLen(m?.keyQuestions), 0);

  count += arrayLen(layers.followupTree);
  count += SCORE_DIMENSIONS.length; // scoreAnchors 固定六维

  const rp = layers.roundPositioning ?? {};
  for (const key of ROUND_KEYS) {
    const r = rp[key];
    if (!r || typeof r !== 'object') continue;
    count += (r.focus ? 1 : 0) + (r.style ? 1 : 0) + (r.duration ? 1 : 0);
    count += arrayLen(r.keyDimensions);
  }
  return count;
}

/**
 * 严格结构校验：七层齐全、各层最小数量达标、子维度数 ≥ 42（45-3）。
 * 返回 { valid, errors, subDimensions }。
 */
export function validatePlan(plan) {
  const errors = [];
  if (!plan || typeof plan !== 'object') {
    return { valid: false, errors: ['plan 不是对象'], subDimensions: 0 };
  }
  const layers = plan.layers;
  if (!layers || typeof layers !== 'object') {
    return { valid: false, errors: ['缺少 layers 七层结构'], subDimensions: 0 };
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

  const cp = layers.candidateProfile;
  if (!cp || typeof cp !== 'object') {
    errors.push('candidateProfile 缺失');
  } else {
    requireArrayMin('candidateProfile.strengths', cp.strengths, 1);
    requireArrayMin('candidateProfile.weaknesses', cp.weaknesses, 1);
    requireArrayMin('candidateProfile.redFlags', cp.redFlags, 1);
  }

  const pf = layers.positionFit;
  if (!pf || typeof pf !== 'object') {
    errors.push('positionFit 缺失');
  } else {
    requireArrayMin('positionFit.hardSkills', pf.hardSkills, 1);
    requireArrayMin('positionFit.softSkills', pf.softSkills, 1);
    requireNonEmptyString('positionFit.experienceFit', pf.experienceFit);
  }

  requireArrayMin('riskPoints', layers.riskPoints, 6);
  for (const [i, r] of (Array.isArray(layers.riskPoints) ? layers.riskPoints : []).entries()) {
    requireNonEmptyString(`riskPoints[${i}].category`, r?.category);
    requireNonEmptyString(`riskPoints[${i}].description`, r?.description);
    if (!['low', 'medium', 'high'].includes(r?.severity)) {
      errors.push(`riskPoints[${i}].severity 需为 low/medium/high`);
    }
  }

  requireArrayMin('mustAskMainlines', layers.mustAskMainlines, 8);
  for (const [i, m] of (Array.isArray(layers.mustAskMainlines) ? layers.mustAskMainlines : []).entries()) {
    requireNonEmptyString(`mustAskMainlines[${i}].id`, m?.id);
    requireNonEmptyString(`mustAskMainlines[${i}].focus`, m?.focus);
    requireNonEmptyString(`mustAskMainlines[${i}].intent`, m?.intent);
    requireNonEmptyString(`mustAskMainlines[${i}].depthTarget`, m?.depthTarget);
    requireArrayMin(`mustAskMainlines[${i}].keyQuestions`, m?.keyQuestions, 1);
  }

  requireArrayMin('followupTree', layers.followupTree, 12);
  for (const [i, f] of (Array.isArray(layers.followupTree) ? layers.followupTree : []).entries()) {
    requireNonEmptyString(`followupTree[${i}].mainlineId`, f?.mainlineId);
    requireNonEmptyString(`followupTree[${i}].question`, f?.question);
    requireNonEmptyString(`followupTree[${i}].intent`, f?.intent);
    if (!['shallow', 'medium', 'deep'].includes(f?.level)) {
      errors.push(`followupTree[${i}].level 需为 shallow/medium/deep`);
    }
  }

  const sa = layers.scoreAnchors;
  if (!sa || typeof sa !== 'object') {
    errors.push('scoreAnchors 缺失');
  } else {
    for (const dim of SCORE_DIMENSIONS) {
      const a = sa[dim];
      if (!a || typeof a !== 'object') {
        errors.push(`scoreAnchors.${dim} 缺失`);
        continue;
      }
      if (!Number.isInteger(a.expectedScore) || a.expectedScore < 1 || a.expectedScore > 5) {
        errors.push(`scoreAnchors.${dim}.expectedScore 需为 1-5 整数`);
      }
      requireNonEmptyString(`scoreAnchors.${dim}.lowAnchor`, a.lowAnchor);
      requireNonEmptyString(`scoreAnchors.${dim}.highAnchor`, a.highAnchor);
    }
  }

  const rp = layers.roundPositioning;
  if (!rp || typeof rp !== 'object') {
    errors.push('roundPositioning 缺失');
  } else {
    for (const key of ROUND_KEYS) {
      const r = rp[key];
      if (!r || typeof r !== 'object') {
        errors.push(`roundPositioning.${key} 缺失`);
        continue;
      }
      requireNonEmptyString(`roundPositioning.${key}.focus`, r.focus);
      requireNonEmptyString(`roundPositioning.${key}.style`, r.style);
      requireNonEmptyString(`roundPositioning.${key}.duration`, r.duration);
      requireArrayMin(`roundPositioning.${key}.keyDimensions`, r.keyDimensions, 1);
    }
  }

  const subDimensions = countSubDimensions(plan);
  if (subDimensions < ACCEPTABLE_MIN_SUB_DIMENSIONS) {
    errors.push(
      `子维度数 ${subDimensions} < 下限 ${ACCEPTABLE_MIN_SUB_DIMENSIONS}（目标 ${MIN_SUB_DIMENSIONS}，容忍 ±${SUB_DIMENSION_TOLERANCE}）`,
    );
  }

  return { valid: errors.length === 0, errors, subDimensions };
}

// 归一化：版本号缺失时补 1，其余字段保持原样（结构已在 validatePlan 校验过）。
export function normalizePlan(plan) {
  return {
    ...plan,
    version: plan.version ?? STRATEGY_SCHEMA_VERSION,
  };
}
