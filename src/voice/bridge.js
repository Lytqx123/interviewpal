// 实时语音通话链路：Node 本地中继，Gateway 侧适配豆包实时语音协议。
//
// 豆包实时语音端点只用 X-Api-* HTTP header 鉴权（APP ID + Access Token），
// 浏览器原生 WebSocket 无法携带自定义 header，因此由本服务：
//   1. 从环境变量 / .env.voice.local 读取凭据（等价于“后端持有并签发鉴权信息”）；
//   2. 浏览器只连本地 ws，中继代填 header 转发到火山；
//   3. 兼作静态服务，直接打开 http://localhost:8780/voice/call.html。
//
// 凭据默认不暴露给浏览器；仅当服务端未配置凭据时，才允许页面表单把
// appId/accessKey 通过 query 传入（方便本地手测，受 VOICE_REQUIRE_ENV 开关控制）。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { createMockDoubaoServer } from './mock.js';

const DEFAULT_TARGET = 'wss://openspeech.bytedance.com/api/v3/realtime/dialogue';
const DEFAULT_APP_KEY = 'PlgvMymc7f3tQnJ6'; // 官方固定值
const VOICE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ENV_FILE = path.join(process.cwd(), '.env.voice.local');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const DEFAULT_SESSION = {
  botName: '面试官',
  systemRole:
    '你是一名专业、温和的模拟面试官，正在和求职者进行模拟面试。请用自然口语交流，一次只问一个问题，认真倾听对方的回答，并基于回答适当追问。',
  speakingStyle:
    '口语自然，像真人面试官一样说话；语速适中，语气沉稳温和；不列要点，不书面化，不念稿。',
  model: '1.2.1.1', // O2.0 版本
};

/** 解析简单 KEY=VALUE 环境文件（不做插值、不做引号转义）。 */
export function loadEnvFile(file = DEFAULT_ENV_FILE) {
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

/** 汇总配置：进程环境变量优先，其次 .env.voice.local。 */
export function readVoiceConfig(env = process.env, envFile = DEFAULT_ENV_FILE) {
  const merged = { ...loadEnvFile(envFile), ...env };
  const truthy = (v) => v != null && /^(1|true|yes|on)$/i.test(String(v).trim());
  return {
    appId: (merged.DOUBAO_APP_ID || '').trim(),
    accessKey: (merged.DOUBAO_ACCESS_KEY || '').trim(),
    appKey: (merged.DOUBAO_APP_KEY || '').trim() || DEFAULT_APP_KEY,
    resourceId: (merged.DOUBAO_RESOURCE_ID || '').trim() || 'volc.speech.dialog',
    target: (merged.DOUBAO_WS_URL || '').trim() || DEFAULT_TARGET,
    mock: truthy(merged.VOICE_MOCK),
    requireEnv: truthy(merged.VOICE_REQUIRE_ENV),
    botName: (merged.DOUBAO_BOT_NAME || '').trim() || DEFAULT_SESSION.botName,
    systemRole: (merged.DOUBAO_SYSTEM_ROLE || '').trim() || DEFAULT_SESSION.systemRole,
    speakingStyle: (merged.DOUBAO_SPEAKING_STYLE || '').trim() || DEFAULT_SESSION.speakingStyle,
    model: (merged.DOUBAO_MODEL || '').trim() || DEFAULT_SESSION.model,
  };
}

function isLocalOrigin(origin) {
  if (!origin) return true;
  try {
    const u = new URL(origin);
    return u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '::1';
  } catch {
    return false;
  }
}

function rejectUpgrade(socket, code, message) {
  socket.write(`HTTP/1.1 ${code} ${code === 401 ? 'Unauthorized' : 'Forbidden'}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`);
  socket.destroy();
}

function resolveAuth(cfg, url) {
  if (cfg.appId && cfg.accessKey) {
    return { appId: cfg.appId, accessKey: cfg.accessKey, appKey: cfg.appKey, source: 'env' };
  }
  if (!cfg.requireEnv) {
    const appId = (url.searchParams.get('appId') || '').trim();
    const accessKey = (url.searchParams.get('accessKey') || '').trim();
    if (appId && accessKey) {
      return {
        appId,
        accessKey,
        appKey: (url.searchParams.get('appKey') || '').trim() || cfg.appKey,
        source: 'page',
      };
    }
  }
  return null;
}

function buildAuthHeaders(cfg, auth) {
  const headers = {
    'X-Api-App-ID': auth.appId,
    'X-Api-Access-Key': auth.accessKey,
    'X-Api-Resource-Id': cfg.resourceId,
    'X-Api-Connect-Id': crypto.randomUUID(),
  };
  if (auth.appKey) headers['X-Api-App-Key'] = auth.appKey;
  return headers;
}

function serveStatic(req, res, cfg) {
  if (!isLocalOrigin(req.headers.origin)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('forbidden');
    return;
  }
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/voice/status') {
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(
      JSON.stringify({
        mock: cfg.mock,
        envConfigured: Boolean(cfg.appId && cfg.accessKey),
        requireEnv: cfg.requireEnv,
        target: cfg.mock ? 'mock' : cfg.target,
        session: {
          botName: cfg.botName,
          systemRole: cfg.systemRole,
          speakingStyle: cfg.speakingStyle,
          model: cfg.model,
        },
      }),
    );
    return;
  }
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/voice/call.html';
  if (!p.startsWith('/voice/')) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
    return;
  }
  const rel = p.slice('/voice/'.length);
  if (!rel || rel.includes('..') || rel.includes('\\') || rel.includes('/')) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('forbidden');
    return;
  }
  const filePath = path.join(VOICE_DIR, rel);
  if (filePath !== VOICE_DIR && !filePath.startsWith(VOICE_DIR + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`not found: ${p}`);
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
}

function handleUpgrade(req, socket, head, cfg, wss, ctx) {
  const log = ctx.log;
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/voice/ws') {
    rejectUpgrade(socket, 403, 'not a websocket path');
    return;
  }
  if (!isLocalOrigin(req.headers.origin)) {
    rejectUpgrade(socket, 403, 'origin not allowed');
    return;
  }

  let auth = null;
  let target = cfg.target;
  let upstreamHeaders = null;
  if (cfg.mock) {
    target = ctx.getMockTarget();
    upstreamHeaders = { 'X-Mock-Upstream': '1' };
  } else {
    auth = resolveAuth(cfg, url);
    if (!auth) {
      rejectUpgrade(
        socket,
        401,
        '缺少凭据：请在 .env.voice.local 配置 DOUBAO_APP_ID / DOUBAO_ACCESS_KEY，或在页面填写 App ID / Access Key',
      );
      return;
    }
    upstreamHeaders = buildAuthHeaders(cfg, auth);
  }

  let upstream;
  try {
    upstream = new WebSocket(target, { headers: upstreamHeaders, handshakeTimeout: 15000 });
  } catch (e) {
    rejectUpgrade(socket, 502, `upstream init failed: ${e.message}`);
    return;
  }
  ctx.trackUpstream?.(upstream);

  wss.handleUpgrade(req, socket, head, (clientWs) => {
    let cleaned = false;
    let upstreamOpen = false;
    let clientFrames = 0;
    let upstreamFrames = 0;
    const pending = [];
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      try {
        upstream.close();
      } catch {}
      try {
        clientWs.close();
      } catch {}
    };

    upstream.on('open', () => {
      upstreamOpen = true;
      log.info('[voice] 上游已连接，flush 缓存帧');
      while (pending.length && upstream.readyState === WebSocket.OPEN) {
        upstream.send(pending.shift());
      }
    });
    upstream.on('message', (data) => {
      upstreamFrames++;
      if (clientWs.readyState === WebSocket.OPEN) clientWs.send(data);
    });
    upstream.on('close', () => {
      try {
        clientWs.close();
      } catch {}
      cleanup();
    });
    upstream.on('error', (e) => {
      log.error('[voice] 上游错误:', e.message);
      try {
        clientWs.close(1011, 'upstream error');
      } catch {}
      cleanup();
    });

    clientWs.on('message', (data) => {
      clientFrames++;
      if (upstreamOpen && upstream.readyState === WebSocket.OPEN) {
        upstream.send(data);
      } else {
        pending.push(data);
      }
    });
    clientWs.on('close', cleanup);
    clientWs.on('error', cleanup);
    clientWs.on('close', () => {
      log.info(`[voice] 会话结束: client->upstream ${clientFrames} 帧, upstream->client ${upstreamFrames} 帧`);
    });
  });
}

/**
 * 启动语音中继服务。
 * 返回 { server, wss, port, url, config, stop }。
 */
export async function startVoiceServer({
  port = 8780,
  host = '127.0.0.1',
  config,
  log = console,
} = {}) {
  const cfg = config ?? readVoiceConfig();
  const logger = {
    info: (...a) => (typeof log.info === 'function' ? log.info(...a) : log(...a)),
    error: (...a) => (typeof log.error === 'function' ? log.error(...a) : log(...a)),
  };
  let mockUpstream = null;
  if (cfg.mock) {
    mockUpstream = await createMockDoubaoServer();
    logger.info(`[voice] Mock 上游已启动: ws://127.0.0.1:${mockUpstream.port}`);
  }
  const getMockTarget = () => `ws://127.0.0.1:${mockUpstream.port}`;

  const server = http.createServer((req, res) => serveStatic(req, res, cfg));
  const wss = new WebSocketServer({ noServer: true });
  const upstreams = new Set();
  server.on('upgrade', (req, socket, head) =>
    handleUpgrade(req, socket, head, cfg, wss, {
      getMockTarget,
      log: logger,
      trackUpstream: (ws) => {
        upstreams.add(ws);
        ws.once('close', () => upstreams.delete(ws));
      },
    }),
  );

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  const stop = async () => {
    for (const ws of wss.clients) {
      try {
        ws.close();
      } catch {}
    }
    wss.close();
    for (const upstream of upstreams) {
      try {
        upstream.close();
      } catch {}
    }
    upstreams.clear();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(() => resolve()));
    if (mockUpstream) await mockUpstream.close();
  };

  return {
    server,
    wss,
    port: address.port,
    url: `http://${host}:${address.port}`,
    config: cfg,
    stop,
  };
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  const cfg = readVoiceConfig();
  const port = Number(process.env.VOICE_PORT) || 8780;
  const { url } = await startVoiceServer({ port, config: cfg });
  const mode = cfg.mock ? 'Mock（本地模拟，无需真实凭据）' : cfg.appId ? '真实服务（服务端凭据）' : '真实服务（等待页面填写凭据）';
  console.log(`[voice] 已启动: ${url}/voice/call.html  [${mode}]`);
  console.log('[voice] 浏览器打开上面的地址，点击“开始通话”即可联调。');
}
