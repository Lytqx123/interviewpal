// 文本 LLM 的统一入口。
//
// 先按 OpenAI 兼容的 chat completions 协议实现（DeepSeek / 通义 /
// 豆包 Ark 都兼容这个协议，只是 baseUrl 和 model 不同），后面要换 provider
// 只改这里的工厂函数。
export function createLlm({ apiKey, baseUrl = 'https://api.deepseek.com', model = 'deepseek-chat' } = {}) {
  if (!apiKey) {
    // 没有 key 的时候返回 null，上层解析器会自动走规则兜底，
    // 这样本地没有 key 也能把整条流水线跑通。
    return null;
  }

  async function chatOnce(messages, { temperature, maxTokens }, useJsonMode) {
    const body = {
      model,
      messages,
      temperature,
    };
    // 官方 JSON 模式文档强调要合理设置 max_tokens，防止长 JSON 被截断
    if (maxTokens) body.max_tokens = maxTokens;
    if (useJsonMode) {
      // 让模型尽量输出纯 JSON；个别 provider 要求提示词里必须出现 json 字样，
      // 或干脆不支持这个字段（会 400），此时由 chat() 摘掉该字段重试。
      body.response_format = { type: 'json_object' };
    }
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      const err = new Error(`llm api error ${res.status}: ${text}`);
      err.status = res.status;
      err.body = text;
      throw err;
    }
    const data = await res.json();
    return data.choices?.[0]?.message?.content ?? '';
  }

  async function chat(messages, { temperature = 0.2, maxTokens } = {}) {
    try {
      return await chatOnce(messages, { temperature, maxTokens }, true);
    } catch (err) {
      // response_format 不是所有 OpenAI 兼容端点都支持（部分会 400），
      // 摘掉该字段重试一次；JSON 解析由上层 parseJsonFromText/chatJson 兜底。
      if (err.status === 400 && /response_format|json_object/i.test(err.body || '')) {
        return chatOnce(messages, { temperature, maxTokens }, false);
      }
      throw err;
    }
  }

  // 结构化输出助手：带 JSON Schema 提示 + 后置解析容错（§5.4 双向纵深防御）。
  // 第一次直接请求（json_object 模式）；解析失败时把 schema 追加进 user 消息再试一次。
  chat.chatJson = async function chatJson(messages, schema, { temperature = 0.2, maxTokens = 4096 } = {}) {
    return chatJson(chat, messages, schema, { temperature, maxTokens });
  };

  return chat;
}

/**
 * 结构化输出助手：调用 chat 并保证拿到可解析的 JSON。
 *  - 解析成功：返回对象；
 *  - 首次失败：把 schema（JSON Schema 片段）追加到最后一条 user 消息重试一次；
 *  - 仍失败：返回 null，由调用方走规则兜底。
 */
export async function chatJson(chat, messages, schema, { temperature = 0.2, maxTokens = 4096 } = {}) {
  if (typeof chat !== 'function') return null;
  try {
    const raw = await chat(messages, { temperature, maxTokens });
    const data = parseJsonFromText(raw);
    if (data && typeof data === 'object') return data;
  } catch (err) {
    // 第一次请求失败（网络/400 等），带 schema 重试一次
  }

  const schemaText = schema ? JSON.stringify(schema, null, 2) : null;
  if (!schemaText) return null;
  const withSchema = [...messages];
  const last = withSchema[withSchema.length - 1];
  const schemaNote = `\n\n【输出格式要求】请严格按以下 JSON Schema 输出，不要输出任何解释或 markdown：\n${schemaText}`;
  if (last && last.role === 'user') {
    withSchema[withSchema.length - 1] = { ...last, content: `${last.content}${schemaNote}` };
  } else {
    withSchema.push({ role: 'user', content: schemaNote });
  }
  try {
    const raw = await chat(withSchema, { temperature, maxTokens });
    const data = parseJsonFromText(raw);
    return data && typeof data === 'object' ? data : null;
  } catch (err) {
    return null;
  }
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
