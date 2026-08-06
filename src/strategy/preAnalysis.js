// 预分析主入口（方案书 §5.4 / 重构计划 R1）。
// 流程：缓存命中 → LLM 生成（chatJson + schema 校验）→ 规则兜底。
import { chatJson } from '../llm/provider.js';
import { STRATEGY_SCHEMA, validatePlan, normalizePlan } from './schema.js';
import { buildPreAnalysisPrompt } from './prompts.js';
import { buildRulesPlan } from './rules.js';
import { strategyCacheKey, readStrategyCache, writeStrategyCache } from './cache.js';

/**
 * 生成七层作战地图。
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

  const cacheKey = strategyCacheKey({
    resumeVersion,
    companyId: company.companyId,
    positionId: position.positionId,
  });

  // 1. 缓存命中：同一 简历版本+公司+岗位 直接复用
  if (store) {
    const cached = readStrategyCache(store, cacheKey);
    if (cached) {
      return { plan: normalizePlan(cached), source: 'cache', cacheKey, cached: true };
    }
  }

  // 2. LLM 优先：chatJson 保证可解析 JSON，validatePlan 保证七层结构合法
  if (llm) {
    try {
      const messages = buildPreAnalysisPrompt({ resumeVersion, company, position });
      const data = await chatJson(llm, messages, STRATEGY_SCHEMA);
      const check = data ? validatePlan(data) : null;
      if (check?.valid) {
        const plan = normalizePlan(data);
        writeStrategyCache(store, cacheKey, plan);
        return { plan, source: 'llm', cacheKey, cached: false };
      }
      if (data && !check?.valid) {
        console.warn('[strategy] llm plan invalid, fallback to rules:', check.errors.join('; '));
      }
    } catch (err) {
      console.warn('[strategy] llm pre-analysis failed, fallback to rules:', err.message);
    }
  }

  // 3. 规则兜底：无 key / LLM 失败 / 结构不合法时保证输出
  const plan = buildRulesPlan({ resumeVersion, company, position });
  const check = validatePlan(plan);
  if (!check.valid) {
    // 规则兜底本身必须合法；若非法说明代码 bug，直接抛错暴露
    throw new Error(`strategy rules fallback invalid: ${check.errors.join('; ')}`);
  }
  writeStrategyCache(store, cacheKey, plan);
  return { plan: normalizePlan(plan), source: 'rules', cacheKey, cached: false };
}
