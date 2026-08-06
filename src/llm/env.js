// 从环境变量创建文本 LLM（真实模式接线）：有 key 返回可调用 LLM，无 key 返回 null（规则兜底）。
// 变量约定（与 .env.local / README 一致）：
//   LLM_API_KEY / DEEPSEEK_API_KEY / ARK_API_KEY / DASHSCOPE_API_KEY
//   LLM_BASE_URL / LLM_MODEL（可选，缺省按 key 类型推断）

import { loadEnvFile } from '../config/env.js';
import { createLlm } from './provider.js';

const BASE_URL_BY_KEY = {
  DEEPSEEK_API_KEY: 'https://api.deepseek.com',
  ARK_API_KEY: 'https://ark.cn-beijing.volces.com/api/v3',
  DASHSCOPE_API_KEY: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  OPENAI_API_KEY: 'https://api.openai.com/v1',
};

const MODEL_BY_KEY = {
  DEEPSEEK_API_KEY: 'deepseek-chat',
  ARK_API_KEY: 'doubao-seed-1-6-flash',
  DASHSCOPE_API_KEY: 'qwen-plus',
  OPENAI_API_KEY: 'gpt-4o-mini',
};

export function createLlmFromEnv(env = process.env, envFile = null) {
  const merged = envFile ? { ...loadEnvFile(envFile), ...env } : { ...env };
  const explicitKey = (merged.LLM_API_KEY || '').trim();
  const explicitBaseUrl = (merged.LLM_BASE_URL || '').trim();
  const explicitModel = (merged.LLM_MODEL || '').trim();

  if (explicitKey) {
    return createLlm({
      apiKey: explicitKey,
      baseUrl: explicitBaseUrl || 'https://api.deepseek.com',
      model: explicitModel || 'deepseek-chat',
    });
  }

  // 兼容 DEEPSEEK / ARK / DASHSCOPE / OPENAI 同构 *_API_KEY
  for (const keyName of ['DEEPSEEK_API_KEY', 'ARK_API_KEY', 'DASHSCOPE_API_KEY', 'OPENAI_API_KEY']) {
    const key = (merged[keyName] || '').trim();
    if (!key) continue;
    return createLlm({
      apiKey: key,
      baseUrl: explicitBaseUrl || BASE_URL_BY_KEY[keyName],
      model: explicitModel || MODEL_BY_KEY[keyName],
    });
  }
  return null;
}
