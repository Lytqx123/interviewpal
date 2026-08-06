// 通用环境文件读取：解析简单 KEY=VALUE（不做插值、不做引号转义）。
// 供 voice / llm / search / gateway 共用，避免模块间循环依赖。

import fs from 'node:fs';

export function loadEnvFile(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const out = {};
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      let value = m[2];
      if (value.startsWith('#') || value === '') continue;
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      out[m[1]] = value;
    }
    return out;
  } catch {
    return {};
  }
}
