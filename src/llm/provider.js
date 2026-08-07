// 文本 LLM 的统一入口。
//
// 双协议支持：
//   - Chat Completions（/chat/completions）：DeepSeek / 豆包 Ark 均兼容，默认路径
//   - Responses API（/responses）：豆包 Ark 专属，启用 webSearch 时走此路径
//     → 内置 web_search 工具，LLM 自动联网搜索 + 理解，替代外部 SerpAPI
//
// 供应商自动识别：baseUrl 含 volces.com 判为豆包 Ark，支持 Responses API。
export function createLlm({ apiKey, baseUrl = 'https://api.deepseek.com', model = 'deepseek-v4-pro' } = {}) {
  if (!apiKey) {
    // 没有 key 的时候返回 null，上层解析器会自动走规则兜底，
    // 这样本地没有 key 也能把整条流水线跑通。
    return null;
  }

  const isArk = /volces\.com|ark\./i.test(baseUrl);

  // ---- Chat Completions 路径（DeepSeek / 豆包 Ark 通用）----
  async function chatOnce(messages, { temperature, maxTokens, timeoutMs = 120000 }, useJsonMode) {
    const body = {
      model,
      messages,
      temperature,
    };
    if (maxTokens) body.max_tokens = maxTokens;
    if (useJsonMode) {
      body.response_format = { type: 'json_object' };
    }
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
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

  // ---- Responses API 路径（豆包 Ark 专属，支持 web_search 内置工具）----
  async function responsesOnce(messages, { temperature, maxTokens, timeoutMs = 120000, webSearch }) {
    // Chat messages → Responses API 格式：system 消息提升为 instructions，其余进 input
    const systemMsgs = messages.filter((m) => m.role === 'system');
    const nonSystemMsgs = messages.filter((m) => m.role !== 'system');
    const instructions = systemMsgs.map((m) => m.content).join('\n') || undefined;

    const body = {
      model,
      input: nonSystemMsgs.map((m) => ({ role: m.role, content: m.content })),
      temperature,
    };
    if (instructions) body.instructions = instructions;
    if (maxTokens) body.max_tokens = maxTokens;
    if (webSearch) {
      // 内置联网搜索工具：LLM 自动判断是否需要搜索，无需手动触发
      body.tools = [{ type: 'web_search', max_keyword: 3 }];
    }
    const res = await fetch(`${baseUrl}/responses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const text = await res.text();
      const err = new Error(`llm responses api error ${res.status}: ${text}`);
      err.status = res.status;
      err.body = text;
      throw err;
    }
    const data = await res.json();
    return extractResponsesText(data);
  }

  /** 从 Responses API 响应中提取文本输出。 */
  function extractResponsesText(data) {
    // 标准格式：output[].content[].text
    const outputItems = data.output ?? [];
    for (const item of outputItems) {
      if (item.type === 'message' && Array.isArray(item.content)) {
        const text = item.content
          .filter((c) => c.type === 'output_text' && c.text)
          .map((c) => c.text)
          .join('\n');
        if (text) return text;
      }
    }
    // 兜底：直接取 output_text 字段（部分版本简化格式）
    if (typeof data.output_text === 'string') return data.output_text;
    return '';
  }

  async function chat(messages, { temperature = 0.2, maxTokens, timeoutMs = 120000, webSearch = false } = {}) {
    // webSearch 仅豆包 Ark 支持（Responses API + web_search 工具）
    if (webSearch && isArk) {
      try {
        return await responsesOnce(messages, { temperature, maxTokens, timeoutMs, webSearch: true });
      } catch (err) {
        // Responses API 失败时降级为 Chat API（不联网），上层可继续处理
      }
    }
    try {
      return await chatOnce(messages, { temperature, maxTokens, timeoutMs }, true);
    } catch (err) {
      if (err.status === 400 && /response_format|json_object/i.test(err.body || '')) {
        return chatOnce(messages, { temperature, maxTokens, timeoutMs }, false);
      }
      throw err;
    }
  }

  // 结构化输出助手：带 JSON Schema 提示 + 后置解析容错（双向纵深防御）。
  // 第一次直接请求（json_object 模式）；解析失败时把 schema 追加进 user 消息再试一次。
  chat.chatJson = async function chatJson(messages, schema, { temperature = 0.2, maxTokens = 4096, timeoutMs = 120000 } = {}) {
    return chatJson(chat, messages, schema, { temperature, maxTokens, timeoutMs });
  };

  return chat;
}

/**
 * 结构化输出助手：调用 chat 并保证拿到可解析的 JSON。
 *  - 解析成功：返回对象；
 *  - 首次失败：把 schema（JSON Schema 片段）追加到最后一条 user 消息重试一次；
 *  - 仍失败：返回 null，由调用方走规则兜底。
 */
export async function chatJson(chat, messages, schema, { temperature = 0.2, maxTokens = 4096, timeoutMs = 120000 } = {}) {
  if (typeof chat !== 'function') return null;
  try {
    const raw = await chat(messages, { temperature, maxTokens, timeoutMs });
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
    const raw = await chat(withSchema, { temperature, maxTokens, timeoutMs });
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
