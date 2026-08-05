// 浏览器通话页逻辑：麦克风授权 → 16kHz 上行 → 24kHz 下行播放 → 打断处理。
import {
  buildAudioFrame,
  buildControlFrame,
  parseFrame,
  EV_CONNECTION_STARTED,
  EV_START_SESSION,
  EV_SESSION_STARTED,
  EV_SESSION_FINISHED,
  EV_STREAM_FINISHED,
  EV_FINISH_SESSION,
  EV_FINISH_CONNECTION,
  EV_INTERRUPT,
  EV_ASR,
  EV_LLM,
  SP_SERVER_ERROR,
} from './protocol.js';

const $ = (id) => document.getElementById(id);
const state = {
  status: null,
  ws: null,
  sessionId: null,
  ready: false,
  tearingDown: false,
  mic: null,
  playCtx: null,
  nextPlayTime: 0,
  activeSources: [],
  sentFrames: 0,
  recvFrames: 0,
  startedAt: 0,
  msgQueue: Promise.resolve(),
  durationTimer: null,
};

function setStatus(cls, msg) {
  const el = $('status');
  el.className = cls;
  el.textContent = msg;
}

function append(cls, text) {
  const div = document.createElement('div');
  div.className = cls;
  const now = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  div.textContent = `[${now}] ${text}`;
  const log = $('log');
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

function updateMetrics() {
  $('sentCount').textContent = String(state.sentFrames);
  $('recvCount').textContent = String(state.recvFrames);
  if (state.startedAt) {
    const sec = Math.floor((Date.now() - state.startedAt) / 1000);
    $('duration').textContent = `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
  }
}

function updateLevel(level) {
  $('level').value = level;
}

function float32ToInt16(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = float32[i] < -1 ? -1 : float32[i] > 1 ? 1 : float32[i];
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

function pcmLevel(float32) {
  let max = 0;
  for (let i = 0; i < float32.length; i++) {
    const v = float32[i] < 0 ? -float32[i] : float32[i];
    if (v > max) max = v;
  }
  return max;
}

function sendFrame(frame) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    try {
      state.ws.send(frame);
      state.sentFrames++;
      updateMetrics();
      return true;
    } catch (e) {
      append('sys', `发送失败: ${e.message}`);
    }
  }
  return false;
}

function sendControl(event, { sessionId = state.sessionId, payload = {} } = {}) {
  return sendFrame(buildControlFrame(event, { sessionId, payload }));
}

function buildStartSessionPayload() {
  const s = (state.status && state.status.session) || {};
  return {
    tts: {
      audio_config: { channel: 1, format: 'pcm_s16le', sample_rate: 24000 },
    },
    dialog: {
      bot_name: s.botName || '面试官',
      system_role: s.systemRole || '',
      speaking_style: s.speakingStyle || '',
      extra: { strict_audit: false, model: s.model || '1.2.1.1' },
    },
  };
}

async function handleFrame(frame) {
  state.recvFrames++;
  updateMetrics();

  if (frame.messageType === SP_SERVER_ERROR) {
    const msg =
      typeof frame.error === 'string'
        ? frame.error
        : (frame.error && (frame.error.message || JSON.stringify(frame.error))) || `code ${frame.code}`;
    if (!state.tearingDown) append('sys', `SERVER_ERROR ${frame.code}: ${msg}`);
    return;
  }

  if (frame.payloadBytes && frame.payloadBytes.length) {
    playPcm(frame.payloadBytes.buffer);
    return;
  }

  switch (frame.event) {
    case EV_CONNECTION_STARTED:
      append('sys', '连接已建立(50)，发送 StartSession(100)');
      sendControl(EV_START_SESSION, { payload: buildStartSessionPayload() });
      break;
    case EV_SESSION_STARTED:
      append('sys', '会话已建立(150)，开启麦克风');
      state.ready = true;
      setStatus('ready', '通话中 · 请说话');
      try {
        await startMic();
      } catch (e) {
        append('sys', `麦克风启动失败: ${e.message}（检查浏览器权限）`);
        setStatus('error', '麦克风不可用');
      }
      break;
    case EV_INTERRUPT:
      append('sys', '[打断] 停止播放，进入聆听');
      stopPlayback();
      break;
    case EV_ASR: {
      const results = frame.payloadJson && frame.payloadJson.results;
      const extra = (frame.payloadJson && frame.payloadJson.extra) || {};
      const text = Array.isArray(results)
        ? results.map((r) => r && r.text).filter(Boolean).join('')
        : '';
      if (text && (extra.endpoint === true || results.some((r) => r && r.is_interim === false))) {
        append('user', `[你] ${text}`);
      }
      break;
    }
    case EV_LLM: {
      const c = frame.payloadJson && frame.payloadJson.content;
      if (typeof c === 'string' && c) append('ai', c);
      break;
    }
    case EV_SESSION_FINISHED:
    case EV_STREAM_FINISHED:
      append('sys', `会话结束事件(${frame.event})`);
      state.ready = false;
      break;
    default:
      break;
  }
}

// ============ 播放（24kHz/int16 PCM → 无缝拼接） ============
function ensurePlayCtx() {
  if (!state.playCtx) {
    state.playCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  return state.playCtx;
}

function playPcm(arrayBuffer) {
  const ctx = ensurePlayCtx();
  if (ctx.state === 'suspended') ctx.resume();
  const pcm = new Int16Array(arrayBuffer);
  const float = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) float[i] = pcm[i] / 32768;
  const audioBuf = ctx.createBuffer(1, float.length, 24000);
  audioBuf.copyToChannel(float, 0);
  const src = ctx.createBufferSource();
  src.buffer = audioBuf;
  src.connect(ctx.destination);
  const startAt = Math.max(ctx.currentTime, state.nextPlayTime);
  src.start(startAt);
  state.nextPlayTime = startAt + audioBuf.duration;
  state.activeSources.push(src);
  src.onended = () => {
    state.activeSources = state.activeSources.filter((s) => s !== src);
  };
}

function stopPlayback() {
  for (const src of state.activeSources) {
    try {
      src.stop();
    } catch {}
  }
  state.activeSources = [];
  state.nextPlayTime = 0;
}

// ============ 麦克风（AudioWorklet 重采样到 16kHz） ============
async function startMic() {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    },
  });
  const ctx = new AudioContext();
  await ctx.audioWorklet.addModule('/voice/mic-worklet.js');
  const source = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'mic-resampler', {
    numberOfInputs: 1,
    numberOfOutputs: 0,
  });
  node.port.onmessage = (e) => {
    if (!state.ready) return;
    const pcm = float32ToInt16(e.data);
    updateLevel(pcmLevel(e.data));
    sendFrame(
      buildAudioFrame(state.sessionId, new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)),
    );
  };
  source.connect(node);
  state.mic = { stream, ctx, node };
  append('sys', '麦克风已开启：16kHz/int16 上行，20ms/包');
}

function stopMic() {
  if (!state.mic) return;
  const { stream, ctx, node } = state.mic;
  try {
    node.disconnect();
  } catch {}
  for (const track of stream.getTracks()) track.stop();
  try {
    ctx.close();
  } catch {}
  state.mic = null;
  updateLevel(0);
}

// ============ 连接 / 挂断 ============
function resetState() {
  state.tearingDown = false;
  state.ready = false;
  state.sessionId = null;
  state.sentFrames = 0;
  state.recvFrames = 0;
  state.startedAt = 0;
  state.msgQueue = Promise.resolve();
  updateMetrics();
}

async function connect() {
  if (state.ws && (state.ws.readyState === WebSocket.CONNECTING || state.ws.readyState === WebSocket.OPEN)) return;
  resetState();

  const q = new URLSearchParams();
  if (!state.status.mock && !state.status.envConfigured) {
    const appId = $('appId').value.trim();
    const accessKey = $('accessKey').value.trim();
    if (!appId || !accessKey) {
      setStatus('error', '请填写 App ID / Access Key（或让服务端配置 .env.voice.local）');
      return;
    }
    localStorage.setItem('voice_appId', appId);
    localStorage.setItem('voice_accessKey', accessKey);
    q.set('appId', appId);
    q.set('accessKey', accessKey);
  }

  state.sessionId = crypto.randomUUID();
  state.startedAt = Date.now();
  state.durationTimer = setInterval(updateMetrics, 1000);
  setStatus('connecting', '连接中…');
  append('sys', `连接本地代理 ws://${location.host}/voice/ws`);

  const ws = new WebSocket(`ws://${location.host}/voice/ws${q.toString() ? `?${q}` : ''}`);
  ws.binaryType = 'arraybuffer';
  state.ws = ws;

  const handshakeTimer = setTimeout(() => {
    if (!state.ready) hangup('握手超时（5 秒未就绪）');
  }, 5000);

  ws.onopen = () => {
    append('sys', '代理已连接，发送 StartConnection(1)');
    sendControl(EV_CONNECTION_STARTED, { sessionId: null, payload: {} });
  };
  ws.onmessage = (e) => {
    state.msgQueue = state.msgQueue
      .then(async () => {
        const frame = await parseFrame(e.data);
        if (frame) await handleFrame(frame);
      })
      .catch((err) => append('sys', `帧处理错误: ${err.message}`));
  };
  ws.onerror = () => {
    clearTimeout(handshakeTimer);
    setStatus('error', 'WebSocket 错误：多半是代理未启动或凭据错误，看代理控制台');
  };
  ws.onclose = (e) => {
    clearTimeout(handshakeTimer);
    if (state.durationTimer) clearInterval(state.durationTimer);
    append('sys', `连接关闭 code=${e.code}${e.reason ? ` ${e.reason}` : ''}`);
    state.ready = false;
    stopMic();
    stopPlayback();
    setStatus('idle', '已断开');
    $('connect').disabled = false;
    $('hangup').disabled = true;
  };

  $('connect').disabled = true;
  $('hangup').disabled = false;
}

function hangup(reason) {
  if (reason) append('sys', reason);
  state.tearingDown = true;
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    sendControl(EV_FINISH_SESSION, {});
    sendControl(EV_FINISH_CONNECTION, { sessionId: null });
  }
  stopMic();
  stopPlayback();
  state.ready = false;
  try {
    if (state.ws) state.ws.close();
  } catch {}
  setStatus('idle', '已挂断');
  $('connect').disabled = false;
  $('hangup').disabled = true;
}

// ============ 初始化 ============
async function init() {
  try {
    const res = await fetch('/voice/status');
    state.status = await res.json();
  } catch {
    state.status = { mock: false, envConfigured: false, requireEnv: false, session: {} };
  }
  const badge = $('modeBadge');
  if (state.status.mock) {
    badge.textContent = 'Mock 模式';
    badge.className = 'badge mock';
  } else if (state.status.envConfigured) {
    badge.textContent = '服务端凭据已配置';
    badge.className = 'badge env';
  } else {
    badge.textContent = '页面填写凭据';
    $('credsCard').hidden = false;
    const savedAppId = localStorage.getItem('voice_appId');
    const savedKey = localStorage.getItem('voice_accessKey');
    if (savedAppId) $('appId').value = savedAppId;
    if (savedKey) $('accessKey').value = savedKey;
  }
  $('connect').onclick = connect;
  $('hangup').onclick = () => hangup();
  window.addEventListener('beforeunload', hangup);
}

init();
