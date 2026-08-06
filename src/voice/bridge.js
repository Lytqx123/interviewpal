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
import { ArchiveStore } from '../archive/store.js';
import { createVoiceCoordination } from './coordination.js';
import { createLlmFromEnv } from '../llm/env.js';
import { createSearchProviderFromEnv } from '../search/env.js';
import { loadEnvFile } from '../config/env.js';
import {
  buildControlFrame,
  parseFrame,
  EV_START_SESSION,
  EV_FINISH_SESSION,
  EV_ASR,
  EV_LLM,
  EV_SESSION_FINISHED,
} from './protocol.js';

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

export { loadEnvFile };

/** 汇总配置：进程环境变量优先，其次 .env.voice.local。 */
export function readVoiceConfig(env = process.env, envFile = DEFAULT_ENV_FILE) {
  const merged = { ...loadEnvFile(envFile), ...env };
  const truthy = (v) => v != null && /^(1|true|yes|on)$/i.test(String(v).trim());
  return {
    appId: (merged.DOUBAO_APP_ID || '').trim(),
    accessKey: (merged.DOUBAO_ACCESS_KEY || merged.DOUBAO_API_KEY || '').trim(),
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

async function handleRequest(req, res, cfg, coordination) {
  const url = new URL(req.url, 'http://localhost');
  const sendJson = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
  };

  if (req.method === 'POST' && url.pathname === '/voice/start-session') {
    if (!coordination) {
      sendJson(501, { error: 'coordination not enabled' });
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    let input = {};
    try {
      input = JSON.parse(body || '{}');
    } catch {
      sendJson(400, { error: 'invalid json body' });
      return;
    }
    try {
      const result = await coordination.start({
        companyId: input.companyId,
        positionId: input.positionId,
        roundKey: input.roundKey ?? 'round1',
      });
      sendJson(200, result);
    } catch (err) {
      sendJson(400, { error: err.message });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname.startsWith('/voice/session/')) {
    if (!coordination) {
      sendJson(501, { error: 'coordination not enabled' });
      return;
    }
    const sessionKey = decodeURIComponent(url.pathname.slice('/voice/session/'.length));
    const info = coordination.getSessionInfo(sessionKey);
    if (!info) {
      sendJson(404, { error: 'session not found' });
      return;
    }
    sendJson(200, info);
    return;
  }

  if (req.method === 'GET' && url.pathname.startsWith('/voice/review/')) {
    if (!coordination) {
      sendJson(501, { error: 'coordination not enabled' });
      return;
    }
    const sessionKey = decodeURIComponent(url.pathname.slice('/voice/review/'.length));
    const report = coordination.getReport(sessionKey);
    if (!report) {
      sendJson(404, { error: 'review not ready' });
      return;
    }
    sendJson(200, report);
    return;
  }

  serveStatic(req, res, cfg, coordination);
}

function serveStatic(req, res, cfg, coordination) {
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
        coordination: Boolean(coordination),
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
      if (ctx.coordination && data.length) {
        parseFrame(data)
          .then((frame) => {
            if (!frame?.sessionId) return;
            if (frame.event === EV_ASR) {
              const results = frame.payloadJson?.results ?? [];
              const text = Array.isArray(results)
                ? results.map((r) => (r && r.text) || '').join('')
                : '';
              if (text) {
                Promise.resolve(ctx.coordination.handleAsr(frame.sessionId, text)).catch((e) =>
                  log.error('[voice] asr handling failed:', e.message),
                );
              }
            } else if (frame.event === EV_LLM) {
              const content = frame.payloadJson?.content;
              if (typeof content === 'string' && content) {
                ctx.coordination.collectChat(frame.sessionId, content);
              }
            } else if (frame.event === EV_SESSION_FINISHED) {
              ctx.coordination
                .finish(frame.sessionId)
                .catch((e) => log.error('[voice] review failed:', e.message));
            }
          })
          .catch((e) => log.error('[voice] upstream frame parse failed:', e.message));
      }
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

    clientWs.on('message', async (data) => {
      clientFrames++;
      let out = data;
      let finishKey = null;
      if (ctx.coordination && data.length) {
        try {
          const frame = await parseFrame(data);
          if (frame?.event === EV_START_SESSION && frame.payloadJson) {
            const config = ctx.coordination.getConfig(frame.sessionId);
            if (config) {
              const payload = { ...frame.payloadJson };
              payload.dialog = {
                ...(payload.dialog ?? {}),
                bot_name: config.botName,
                system_role: config.systemRole,
                speaking_style: config.speakingStyle,
                extra: {
                  ...(payload.dialog?.extra ?? {}),
                  model: config.model,
                },
              };
              out = buildControlFrame(frame.event, { sessionId: frame.sessionId, payload });
            }
          } else if (frame?.event === EV_FINISH_SESSION && frame.sessionId) {
            finishKey = frame.sessionId;
          }
        } catch (e) {
          log.error('[voice] client frame parse failed:', e.message);
        }
      }
      if (upstreamOpen && upstream.readyState === WebSocket.OPEN) {
        upstream.send(out);
      } else {
        pending.push(out);
      }
      if (finishKey && ctx.coordination) {
        ctx.coordination
          .finish(finishKey)
          .catch((e) => log.error('[voice] review failed:', e.message));
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
  coordination = null,
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

  const server = http.createServer((req, res) => handleRequest(req, res, cfg, coordination));
  const wss = new WebSocketServer({ noServer: true });
  const upstreams = new Set();
  server.on('upgrade', (req, socket, head) =>
    handleUpgrade(req, socket, head, cfg, wss, {
      getMockTarget,
      coordination,
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
  // 真实使用接线：本地档案库 + 文本 LLM（有 key 真实、无 key 兜底）+ 检索层
  const store = new ArchiveStore(path.join(process.cwd(), 'data', 'voice'));
  const llm = createLlmFromEnv(process.env, path.join(process.cwd(), '.env.local'));
  const search = createSearchProviderFromEnv(process.env);
  const coordination = createVoiceCoordination({ store, llm, search });
  const { url } = await startVoiceServer({ port, config: cfg, coordination });
  const mode = cfg.mock ? 'Mock（本地模拟，无需真实凭据）' : cfg.appId ? '真实服务（服务端凭据）' : '真实服务（等待页面填写凭据）';
  console.log(`[voice] 已启动: ${url}/voice/call.html  [${mode}]`);
  console.log(`[voice] 文本 LLM：${llm ? '已接线（真实模型）' : '未配置，走规则兜底'}；检索层：${search.name}`);
  console.log('[voice] 浏览器打开上面的地址，点击“开始通话”即可联调。');
}
