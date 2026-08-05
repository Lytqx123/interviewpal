// 阶段八：多轮次上下文准备。
// 二面（业务面）核心要求：以"提交简历时填写的岗位职责 + 目标公司实际业务"为主要参考资料展开，
// 并适当联网搜索设计前沿探索类题目，考察应对突发情况的压力与思维拓展力。
//
// 本模块负责在二面开始前，从档案库取出岗位职责 + 公司业务缓存，并联网拉前沿话题，
// 组装成 roundContext 供面试官策略池引用。无 search/无缓存时优雅降级（规则兜底）。
import { enrichJd } from '../enrich/enrich.js';

// 准备二面（round2）上下文：岗位职责 + 公司业务 + 前沿探索题。
// 联网调研依据：二面深挖岗位匹配与业务场景、行业最新动态与前沿趋势、压力情景模拟。
export async function prepareRound2Context({ store, search, companyId, positionId }) {
  const position = store.getPosition(companyId, positionId);
  const responsibilities = position?.profile?.responsibilities ?? [];
  const title = position?.title ?? '该岗位';
  const jobType = position?.jobType ?? 'tech';

  // 公司实际业务：取 round2 检索缓存（enrichJd 默认 key 到 round2，§5.5）
  const cache = store.getCache(companyId, 'round2');
  const companyBusiness = (cache?.entries ?? []).slice(0, 5).map((e) => ({
    name: e.entityName,
    summary: e.summary,
    source: e.source,
  }));

  // 联网搜索前沿探索题：用岗位类型 + 岗位名 + 公司业务拼检索词，取最新趋势做压力题素材。
  // 两条红线（§5.3）：只提交岗位/行业词，不提交个人信息。
  const frontierTopics = await collectFrontierTopics({ search, jobType, title, companyBusiness, responsibilities });

  return { responsibilities, companyBusiness, frontierTopics, title, jobType };
}

// 联网拉前沿话题：失败/无 search 时降级为空数组（策略层会用模板兜底，不阻塞面试）。
async function collectFrontierTopics({ search, jobType, title, companyBusiness, responsibilities }) {
  if (!search) return [];
  const query = buildFrontierQuery({ jobType, title, responsibilities });
  try {
    const results = await search.search(query);
    // 取置信度较高的前 3 条作为前沿压力题素材
    return results.slice(0, 3).map((r) => ({
      topic: r.title ?? '',
      summary: r.snippet ?? '',
      source: r.url ?? '',
      publishedAt: r.publishedAt ?? null,
    }));
  } catch (err) {
    console.warn('[round2] frontier search failed, fallback to template:', err.message);
    return [];
  }
}

function buildFrontierQuery({ jobType, title, responsibilities }) {
  // 用职责关键词 + 岗位名拼"行业前沿趋势"检索词，命中最新动态
  const respKeyword = (responsibilities[0] ?? '').slice(0, 12);
  const base = respKeyword || title;
  return `${base} ${jobType} 行业 前沿 趋势 2026`;
}

// 触发二面联网补全进阶：补全时顺带把前沿话题写入 round2 缓存（§5.3 联网补全进阶）。
// 与 prepareRound2Context 分离：补全是写缓存（副作用），准备是读缓存（纯读）。
export async function enrichRound2Frontier({ store, search, jobProfile, companyId }) {
  return enrichJd({ store, search, jobProfile, companyId, roundKey: 'round2' });
}
