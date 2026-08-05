// 文本 LLM 的统一入口。
//
// 阶段二先按 OpenAI 兼容的 chat completions 协议实现（DeepSeek / 通义 /
// 豆包 Ark 都兼容这个协议，只是 baseUrl 和 model 不同），后面要换 provider
// 只改这里的工厂函数。
export function createLlm({ apiKey, baseUrl = 'https://api.deepseek.com', model = 'deepseek-chat' } = {}) {
  if (!apiKey) {
    // 没有 key 的时候返回 null，上层解析器会自动走规则兜底，
    // 这样本地没有 key 也能把整条流水线跑通。
    return null;
  }

  return async function chat(messages, { temperature = 0.2 } = {}) {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature,
        // 让模型尽量输出纯 JSON；个别 provider 不支持这个字段会 400，
        // 到时候把这个字段摘掉再试一次就行。
        response_format: { type: 'json_object' },
      }),
    });
    if (!res.ok) {
      throw new Error(`llm api error ${res.status}: ${await res.text()}`);
    }
    const data = await res.json();
    return data.choices?.[0]?.message?.content ?? '';
  };
}

// 从模型回复里稳健地抠出 JSON：先剥 markdown 围栏，再整段解析，
// 还不行就找第一个 { 到最后一个 } 的区间。
export function parseJsonFromText(text) {
  if (!text) return null;
  let cleaned = String(text).trim();
  cleaned = cleaned.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // 继续往下走容错分支
  }
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  return null;
}
