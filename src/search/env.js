// 从环境变量创建检索层：有 LLM 时走豆包 Responses API 内置联网搜索，无 LLM 用 mock。
//
// 已移除 SerpAPI 依赖——联网搜索统一由豆包 LLM Responses API + web_search 工具完成，
// 不再需要外部搜索 API key。
//
// @param {object} env - 环境变量（process.env）
// @param {string|null} envFile - .env 文件路径（已弃用，保留兼容）
// @param {function|null} llm - 已创建的 LLM 调用函数（createLlmFromEnv 返回值）

import { loadEnvFile } from '../config/env.js';
import { createSearchProvider } from './provider.js';

export function createSearchProviderFromEnv(env = process.env, envFile = null, llm = null) {
  // 优先使用传入的 LLM（支持联网搜索）
  if (llm) return createSearchProvider({ llm });
  // 无 LLM 时降级为 mock（可演示、可降级）
  return createSearchProvider({ llm: null });
}
