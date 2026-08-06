// 从环境变量创建检索层：有 SERPAPI_API_KEY 用真实检索，无 key 用 mock（可演示、可降级）。

import { loadEnvFile } from '../config/env.js';
import { createSearchProvider } from './provider.js';

export function createSearchProviderFromEnv(env = process.env, envFile = null) {
  const merged = envFile ? { ...loadEnvFile(envFile), ...env } : { ...env };
  const apiKey = (merged.SERPAPI_API_KEY || '').trim();
  return createSearchProvider({ provider: apiKey ? 'serpapi' : 'mock', apiKey });
}
