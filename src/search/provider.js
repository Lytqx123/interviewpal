// 联网检索的统一入口（联网补全与校验）：
//   search(query) -> [{ title, url, snippet, publishedAt, confidence }]
//
// 已从 SerpAPI 迁移到豆包 Responses API 内置 web_search 工具：
//   - 豆包 Ark LLM 原生支持联网搜索（Responses API + web_search）
//   - LLM 自动判断是否需要搜索，搜索+理解一步到位，质量优于 SerpAPI snippet
//   - 无 LLM 或 LLM 不支持联网时降级为 mock（可演示、可降级）
//
// 两条红线不变：
//   1. 只提交实体名（公司名/技术名），不提交个人信息；
//   2. 检索结果只用于提问与验证，不替经历背书。
import { parseJsonFromText } from '../llm/provider.js';
import { CACHE_TTL_MS } from '../archive/constants.js';

export function createSearchProvider({ llm = null } = {}) {
  if (llm) return createLlmSearchProvider(llm);
  return createMockSearchProvider();
}

/**
 * LLM 联网搜索 provider：调用豆包 Responses API + web_search 工具。
 * LLM 搜索后返回结构化 JSON 结果，对外接口与旧 SerpAPI provider 兼容。
 */
function createLlmSearchProvider(llm) {
  return {
    name: 'llm-web-search',
    async search(query) {
      const messages = [
        {
          role: 'system',
          content:
            '你是联网搜索助手。请使用联网搜索工具搜索用户给出的关键词，返回最相关的 3 条结果。' +
            '严格以 JSON 数组格式返回，不要输出任何解释或 markdown：' +
            '[{"title":"标题","url":"来源链接","snippet":"关键信息摘要（50-150字）"}]',
        },
        { role: 'user', content: `请搜索：${query}` },
      ];
      try {
        const raw = await llm(messages, { webSearch: true, temperature: 0.1, maxTokens: 2048 });
        const results = parseJsonFromText(raw);
        if (Array.isArray(results)) {
          return results.slice(0, 3).map((r) => ({
            title: r.title ?? '',
            url: r.url ?? '',
            snippet: r.snippet ?? '',
            publishedAt: r.publishedAt ?? null,
            confidence: 0.7,
          }));
        }
        // LLM 返回非 JSON 数组时，把原始文本作为单条结果返回（不丢信息）
        if (raw && raw.trim()) {
          return [
            {
              title: `搜索：${query}`,
              url: '',
              snippet: raw.trim().slice(0, 500),
              publishedAt: null,
              confidence: 0.6,
            },
          ];
        }
        return [];
      } catch (err) {
        console.warn('[search] llm web search failed:', err.message);
        return [];
      }
    },
  };
}

function createMockSearchProvider() {
  return {
    name: 'mock',
    async search(query) {
      return [
        {
          title: `${query}（mock 结果 1）`,
          url: `https://example.com/${encodeURIComponent(query)}`,
          snippet: `关于「${query}」的公开资料摘要（mock 数据，仅供本地联调）`,
          publishedAt: new Date().toISOString().slice(0, 10),
          confidence: 0.5,
        },
        {
          title: `${query}（mock 结果 2）`,
          url: `https://example.com/${encodeURIComponent(query)}-2`,
          snippet: `「${query}」相关的第二份参考资料（mock 数据）`,
          publishedAt: new Date().toISOString().slice(0, 10),
          confidence: 0.4,
        },
      ];
    },
  };
}

// 目前只有 enrich 模块用到，把默认 TTL 放这里方便统一调整
export const SEARCH_CACHE_TTL = {
  resume: CACHE_TTL_MS.stable,
  jd: CACHE_TTL_MS.volatile,
};
