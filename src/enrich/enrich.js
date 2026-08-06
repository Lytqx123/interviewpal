import { SEARCH_CACHE_TTL } from '../search/provider.js';

// 联网补全基础版：首次上传时把简历里的公司/技术、JD 里的公司/职责
// 拿去检索，结果带"检索时间 + 来源 + 置信度"写入检索缓存。
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
  return entity.name;
}
