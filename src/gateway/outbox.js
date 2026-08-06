// 离线发件箱 + 本地缓存（§4.5 离线兜底）。
//   - 断网时用户消息进入发件箱排队，重连后按顺序补发（最多 50 条，48 小时内有效）；
//   - 最近会话与复盘报告写入本地缓存，断网仍可浏览。
// 实现：JSON 文件持久化（与档案库同一数据目录，隐私默认留在本机）。

import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_MAX_ENTRIES = 50;
const DEFAULT_TTL_MS = 48 * 60 * 60 * 1000;

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function saveJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function nowIso() {
  return new Date().toISOString();
}

function notExpired(entry, ttlMs, now) {
  return !entry.expiresAt || Date.parse(entry.expiresAt) > now;
}

/**
 * 离线发件箱：断网排队、重连补发。
 * sendFn 返回成功（不抛错）即视为送达并从队列移除；失败保留，等待下次 drain。
 */
export function createOfflineOutbox({
  dir = path.join(process.cwd(), 'data'),
  file = 'gateway-outbox.json',
  maxEntries = DEFAULT_MAX_ENTRIES,
  ttlMs = DEFAULT_TTL_MS,
  log = console,
} = {}) {
  const filePath = path.join(dir, file);
  let entries = readJson(filePath, []);

  const persist = () => saveJson(filePath, entries);
  const now = () => Date.now();

  const prune = () => {
    const before = entries.length;
    entries = entries.filter((e) => notExpired(e, ttlMs, now()));
    if (entries.length !== before) persist();
  };

  return {
    file: filePath,

    enqueue({ sessionKey, message, attachments = [], intent = null, id = null }) {
      prune();
      const entry = {
        id: id || `offline-${now()}-${Math.random().toString(36).slice(2, 8)}`,
        sessionKey,
        message,
        attachments,
        intent,
        createdAt: nowIso(),
        expiresAt: new Date(now() + ttlMs).toISOString(),
      };
      entries.push(entry);
      // 超限时丢弃最旧（离线兜底有界，避免本机磁盘无限增长）
      if (entries.length > maxEntries) {
        entries = entries.slice(entries.length - maxEntries);
      }
      persist();
      log.info?.(`[gateway] 离线消息已入队（${entries.length}/${maxEntries}）: ${entry.id}`);
      return entry;
    },

    pending() {
      prune();
      return [...entries];
    },

    /** 顺序补发；sendFn 抛错则该条保留并继续下一条。 */
    async drain(sendFn) {
      prune();
      const sent = [];
      const failed = [];
      const snapshot = [...entries];
      for (const entry of snapshot) {
        try {
          await sendFn(entry);
          entries = entries.filter((e) => e.id !== entry.id);
          sent.push(entry);
        } catch (err) {
          failed.push({ entry, error: err.message });
          log.error?.('[gateway] 离线补发失败:', err.message);
        }
      }
      if (sent.length) persist();
      return { sent, failed, remaining: entries.length };
    },

    remove(id) {
      const before = entries.length;
      entries = entries.filter((e) => e.id !== id);
      if (entries.length !== before) persist();
      return entries.length !== before;
    },

    clear() {
      entries = [];
      persist();
    },

    stats() {
      prune();
      return { queued: entries.length, max: maxEntries, ttlMs, file: filePath };
    },
  };
}

/**
 * 本地缓存：最近会话与复盘报告（断网可浏览）。
 * key 建议用 `session:<id>` / `review:<id>`；按 updatedAt 倒序，超过 maxEntries 淘汰最旧。
 */
export function createOfflineCache({
  dir = path.join(process.cwd(), 'data'),
  file = 'gateway-cache.json',
  maxEntries = 100,
  log = console,
} = {}) {
  const filePath = path.join(dir, file);
  let entries = readJson(filePath, []);

  return {
    file: filePath,

    save(key, data) {
      const list = entries.filter((e) => e.key !== key);
      list.push({
        key,
        data,
        updatedAt: nowIso(),
      });
      list.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
      const trimmed = list.length > maxEntries ? list.slice(0, maxEntries) : list;
      entries = trimmed;
      saveJson(filePath, trimmed);
      log.info?.(`[gateway] 本地缓存已更新: ${key}（${trimmed.length}/${maxEntries}）`);
      return data;
    },

    get(key) {
      return entries.find((e) => e.key === key)?.data ?? null;
    },

    list({ limit = 20 } = {}) {
      return [...entries].slice(0, limit).map((e) => ({ key: e.key, updatedAt: e.updatedAt }));
    },
  };
}
