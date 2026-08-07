import { SEARCH_CACHE_TTL } from '../search/provider.js';

// 联网补全（§5.3）：基础版 + P1 进阶版。
//
// 基础版：首次上传时把简历里的公司/技术、JD 里的公司/职责拿去检索，
//   结果带"检索时间 + 来源 + 置信度"写入检索缓存。
// P1 进阶版（§5.3）：补全目标公司真实 JD、岗位职责、业务方向；
//   面试前一天刷新时效性信息（检测缓存是否过期，过期则重新检索）。
//
// 两条红线：
//  1. 只提交实体名（公司名/技术名），不提交个人信息；
//  2. 检索结果只用于提问与验证，不替经历背书。

export function collectResumeEntities(resumeProfile) {
  const entities = [];
  for (const company of resumeProfile?.companies ?? []) {
    entities.push({ kind: 'company', name: company });
  }
  for (const skill of resumeProfile?.skills ?? []) {
    entities.push({ kind: 'tech', name: skill.name });
  }
  return entities;
}

export function collectJdEntities(jobProfile) {
  const entities = [];
  if (jobProfile?.companyName) {
    entities.push({ kind: 'company', name: jobProfile.companyName });
  }
  // 职责里往往藏着业务/产品线信息，二面业务面要用
  for (const resp of jobProfile?.responsibilities ?? []) {
    entities.push({ kind: 'job', name: resp.slice(0, 30) });
  }
  return entities;
}

export async function enrichResume({ store, search, resumeProfile, companyId, roundKey = 'round1' }) {
  const entities = collectResumeEntities(resumeProfile);
  return runEnrich({ store, search, entities, companyId, roundKey, ttl: SEARCH_CACHE_TTL.resume });
}

export async function enrichJd({ store, search, jobProfile, companyId, roundKey = 'round2' }) {
  const entities = collectJdEntities(jobProfile);
  return runEnrich({ store, search, entities, companyId, roundKey, ttl: SEARCH_CACHE_TTL.jd });
}

/**
 * P1 §5.3 进阶：补全目标公司真实业务方向。
 * 搜索公司业务方向、主营业务、最新动态——供二面业务面提问与点评引用。
 * 与基础版 enrichJd 互补：基础版搜职责实体，进阶版搜公司业务全貌。
 */
export async function enrichCompanyBusiness({ store, search, companyName, companyId, roundKey = 'round2' }) {
  if (!companyName || !search || !companyId) {
    return { skipped: true, cachedCount: 0 };
  }
  const businessEntities = [
    { kind: 'business', name: `${companyName} 主营业务` },
    { kind: 'business', name: `${companyName} 业务方向 产品线` },
    { kind: 'news', name: `${companyName} 最新动态 2026` },
  ];
  return runEnrich({ store, search, entities: businessEntities, companyId, roundKey, ttl: SEARCH_CACHE_TTL.jd });
}

/**
 * P1 §5.3 进阶：时效性刷新。
 * 检测缓存是否过期（expiresAt 已过），过期则重新检索并原地更新——面试前一天刷新时效性信息。
 * @param {object} store 档案库
 * @param {object} search 检索 provider
 * @param {string} companyId
 * @param {string} roundKey
 * @returns {{refreshed: number, skipped: number, total: number}}
 */
export async function refreshEnrich({ store, search, companyId, roundKey = 'round2' }) {
  if (!companyId || !search) return { refreshed: 0, skipped: 0, total: 0 };
  const cache = store.getCache?.(companyId, roundKey);
  const entries = cache?.entries ?? [];
  if (!entries.length) return { refreshed: 0, skipped: 0, total: 0 };
  const now = Date.now();
  let refreshed = 0;
  let skipped = 0;
  for (const entry of entries) {
    // store 条目存的是 expiresAt（ISO 字符串），用它判断是否过期
    const expiresAtMs = entry.expiresAt ? new Date(entry.expiresAt).getTime() : 0;
    if (now < expiresAtMs) {
      skipped++;
      continue;
    }
    // 缓存已过期，重新检索并原地更新（不产生重复条目）
    try {
      const results = await search.search(`${entry.entityName}`);
      if (results.length > 0 && store.updateCacheEntry) {
        store.updateCacheEntry(companyId, roundKey, entry.id, {
          source: results[0].url,
          summary: results[0].snippet,
          confidence: results[0].confidence ?? 0.5,
          verified: false,
        });
        refreshed++;
      } else {
        skipped++;
      }
    } catch (err) {
      console.warn('[enrich] refresh failed for', entry.entityName, err.message);
      skipped++;
    }
  }
  return { refreshed, skipped, total: entries.length };
}

async function runEnrich({ store, search, entities, companyId, roundKey, ttl }) {
  if (!companyId || !search) {
    // 没有公司或没配检索 provider 时跳过补全，不影响主流程
    return { entityCount: entities.length, cachedCount: 0, skipped: true };
  }
  let cachedCount = 0;
  for (const entity of entities.slice(0, 5)) {
    // 实体名就是检索词，不带个人信息；数量也限一下，避免一次传太多请求
    const query = buildQuery(entity);
    let results = [];
    try {
      results = await search.search(query);
    } catch (err) {
      console.warn('[enrich] search failed for', query, err.message);
      continue;
    }
    for (const r of results.slice(0, 3)) {
      store.putCacheEntry(companyId, roundKey, {
        entityType: entity.kind,
        entityName: entity.name,
        source: r.url,
        summary: r.snippet,
        confidence: r.confidence ?? 0.5,
        ttl,
        verified: false,
      });
      cachedCount += 1;
    }
  }
  return { entityCount: entities.length, cachedCount };
}

function buildQuery(entity) {
  if (entity.kind === 'company') return `${entity.name} 公司 简介`;
  if (entity.kind === 'tech') return `${entity.name} 技术 文档`;
  if (entity.kind === 'business') return entity.name;
  if (entity.kind === 'news') return entity.name;
  return entity.name;
}

