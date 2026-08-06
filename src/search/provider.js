import { CACHE_TTL_MS } from '../archive/constants.js';

// 联网检索的统一入口（方案书 §5.3）：
//   search(query) -> [{ title, url, snippet, publishedAt, confidence }]
// 默认 mock，方便本地没有搜索 API key 时联调整条流水线。
export function createSearchProvider({ provider = 'mock', apiKey } = {}) {
  if (provider === 'mock') return createMockSearchProvider();
  if (provider === 'serpapi') return createSerpApiProvider(apiKey);
  throw new Error(`unknown search provider: ${provider}`);
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

function createSerpApiProvider(apiKey) {
  if (!apiKey) {
    // 没有 key 的时候直接抛错，让上层知道要去配置，而不是假装能搜
    throw new Error('serpapi provider requires apiKey (SERPAPI_API_KEY)');
  }
  return {
    name: 'serpapi',
    async search(query) {
      const url = new URL('https://serpapi.com/search.json');
      url.searchParams.set('q', query);
      url.searchParams.set('engine', 'google');
      url.searchParams.set('api_key', apiKey);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`search api error ${res.status}`);
      const data = await res.json();
      return (data.organic_results ?? []).map((r) => ({
        title: r.title ?? '',
        url: r.link ?? '',
        snippet: r.snippet ?? '',
        publishedAt: r.date ?? null,
        confidence: 0.6, // 搜索结果默认中等置信度，等人工确认再提高
      }));
    },
  };
}

// 目前只有 enrich 模块用到，把默认 TTL 放这里方便统一调整
export const SEARCH_CACHE_TTL = {
  resume: CACHE_TTL_MS.stable,
  jd: CACHE_TTL_MS.volatile,
};
