// 预分析主入口：LLM 深度预分析生成七大层面试计划，作为面试官面试前读简历形成的判断与执行基线。
// 流程：缓存命中 → LLM 生成（chatJson + schema 校验）→ 规则兜底。
import { chatJson } from '../llm/provider.js';
import { PREANALYSIS_SCHEMA, validatePlan, normalizePlan } from './schema.js';
import { buildPreAnalysisPrompt } from './prompts.js';
import { buildFallbackPlan } from './fallback.js';
import { preanalysisCacheKey, readPreanalysisCache, writePreanalysisCache } from './cache.js';
import { applyFeedbackAdjustments } from '../coach/selfLearn.js';

// 读取历史 feedback（仅回写过偏差报告时存在；生命周期与缓存一致）
function readFeedback(store, cacheKey) {
  const cached = store ? readPreanalysisCache(store, cacheKey) : null;
  return Array.isArray(cached?.feedback) ? cached.feedback : [];
}

// 收尾统一：迁移历史 feedback + 应用④层策略调整 + 写缓存
function finalizePlan(plan, store, cacheKey) {
  const historicalFeedback = readFeedback(store, cacheKey);
  const merged = historicalFeedback.length ? { ...plan, feedback: historicalFeedback } : plan;
  const adjusted = applyFeedbackAdjustments(merged);
  writePreanalysisCache(store, cacheKey, adjusted);
  return adjusted;
}

/**
 * 生成七大层面试计划。
 * @param {object} opts
 * @param {object} opts.resumeVersion 简历版本对象（需含 versionId / versionNo / profile / rawText）
 * @param {object} opts.company       公司对象（需含 companyId / name）
 * @param {object} opts.position      岗位对象（需含 positionId / title / jobType / profile）
 * @param {Function|null} opts.llm    文本 LLM（createLlm 产物；null 走规则兜底）
 * @param {ArchiveStore|null} opts.store 档案库（可选；传入则读写预分析缓存）
 * @returns {Promise<{plan, source: 'cache'|'llm'|'rules', cacheKey, cached: boolean}>}
 */
export async function generatePlan({ resumeVersion, company, position, llm = null, store = null } = {}) {
  if (!resumeVersion?.versionId) {
    throw new Error('generatePlan requires resumeVersion (with versionId)');
  }
  if (!company?.companyId) {
    throw new Error('generatePlan requires company (with companyId)');
  }
  if (!position?.positionId) {
    throw new Error('generatePlan requires position (with positionId)');
  }

  const cacheKey = preanalysisCacheKey({
    resumeVersion,
    companyId: company.companyId,
    positionId: position.positionId,
  });

  // 1. 缓存命中：同一 简历版本+公司+岗位 直接复用
  if (store) {
    const cached = readPreanalysisCache(store, cacheKey);
    if (cached) {
      return {
        plan: applyFeedbackAdjustments(normalizePlan(cached)),
        source: 'cache',
        cacheKey,
        cached: true,
      };
    }
  }

  // 2. LLM 优先：chatJson 保证可解析 JSON，validatePlan 保证七层结构合法
  if (llm) {
    try {
      const messages = buildPreAnalysisPrompt({
        resumeVersion,
        company,
        position,
        historicalFeedback: readFeedback(store, cacheKey),
      });
      const data = await chatJson(llm, messages, PREANALYSIS_SCHEMA);
      const check = data ? validatePlan(data) : null;
      if (check?.valid) {
        const plan = finalizePlan(normalizePlan(data), store, cacheKey);
        return { plan, source: 'llm', cacheKey, cached: false };
      }
      if (data && !check?.valid) {
        console.warn('[preanalysis] llm plan invalid, fallback to rules:', check.errors.join('; '));
      }
    } catch (err) {
      console.warn('[preanalysis] llm pre-analysis failed, fallback to rules:', err.message);
    }
  }

  // 3. 规则兜底：无 key / LLM 失败 / 结构不合法时保证输出
  const plan = buildFallbackPlan({ resumeVersion, company, position });
  const check = validatePlan(plan);
  if (!check.valid) {
    // 规则兜底本身必须合法；若非法说明代码 bug，直接抛错暴露
    throw new Error(`preanalysis rules fallback invalid: ${check.errors.join('; ')}`);
  }
  const finalized = finalizePlan(normalizePlan(plan), store, cacheKey);
  return { plan: finalized, source: 'rules', cacheKey, cached: false };
}
