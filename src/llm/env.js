// 从环境变量创建文本 LLM（真实模式接线）：有 key 返回可调用 LLM，无 key 返回 null（规则兜底）。
// 供应商仅保留 豆包（火山方舟）+ DeepSeek，均为国产旗舰：
//   ARK_API_KEY      → doubao-seed-2-1-pro-260628（豆包 Seed 2.1 Pro 旗舰，主力，256k 上下文）
//   DEEPSEEK_API_KEY → deepseek-v4-pro（DeepSeek V4 旗舰，备选，1M 上下文）
// 通用透传：LLM_API_KEY + LLM_BASE_URL + LLM_MODEL（任意 OpenAI 兼容厂商，优先级最高）
//
// 注意：旧模型名 deepseek-chat / deepseek-reasoner 已于 2026-07-24 停用，
// doubao-seed-1-6-flash 为旧版轻量模型，均已升级为各自旗舰。

import { loadEnvFile } from '../config/env.js';
import { createLlm } from './provider.js';

const BASE_URL_BY_KEY = {
  ARK_API_KEY: 'https://ark.cn-beijing.volces.com/api/v3',
  DEEPSEEK_API_KEY: 'https://api.deepseek.com',
};

const MODEL_BY_KEY = {
  ARK_API_KEY: 'doubao-seed-2-1-pro-260628',
  DEEPSEEK_API_KEY: 'deepseek-v4-pro',
};

export function createLlmFromEnv(env = process.env, envFile = null) {
  const merged = envFile ? { ...loadEnvFile(envFile), ...env } : { ...env };
  const explicitKey = (merged.LLM_API_KEY || '').trim();
  const explicitBaseUrl = (merged.LLM_BASE_URL || '').trim();
  const explicitModel = (merged.LLM_MODEL || '').trim();

  if (explicitKey) {
    return createLlm({
      apiKey: explicitKey,
      baseUrl: explicitBaseUrl || 'https://ark.cn-beijing.volces.com/api/v3',
      model: explicitModel || 'doubao-seed-2-1-pro-260628',
    });
  }

  // 豆包（火山方舟）优先 → DeepSeek 备选
  for (const keyName of ['ARK_API_KEY', 'DEEPSEEK_API_KEY']) {
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
