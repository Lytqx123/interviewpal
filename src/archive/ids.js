// 简单的 ID 生成：前缀 + 时间戳 + 随机段。
// 不想为了一个 ID 引入 nanoid 依赖，这个够用了；后面要 UUID 再换。
export function newId(prefix) {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}
