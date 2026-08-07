// 浏览器通话页逻辑：麦克风授权 → 16kHz 上行 → 24kHz 下行播放 → 打断处理。
import {
  buildAudioFrame,
  buildControlFrame,
  parseFrame,
  EV_START_CONNECTION,
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
  sessionKey: null,
  sessionConfig: null,
  panelTimer: null,
  roundKey: 'round1',
  companyId: '',
  positionId: '',
  selected: null, // 选中的 ready item { companyId, positionId }
  readyList: [], // /voice/ready 返回的 items
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
  const c = state.sessionConfig || ((state.status && state.status.session) || {});
  const mockAsrText = $('mockAsrText').value.trim();
  const dialog = {
    bot_name: c.botName || '面试官',
    system_role: c.systemRole || '',
    speaking_style: c.speakingStyle || '',
    extra: { strict_audit: false, model: c.model || '1.2.1.1' },
  };
  if (mockAsrText) dialog.mock_asr_text = mockAsrText;
  return {
    tts: {
      audio_config: { channel: 1, format: 'pcm_s16le', sample_rate: 24000 },
    },
    dialog,
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
      updatePanel();
      startPanelPolling();
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
      updatePanel();
      stopPanelPolling();
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
  state.sessionKey = null;
  state.sessionConfig = null;
  stopPanelPolling();
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

  if (state.status.coordination) {
    if (!state.selected) {
      setStatus('error', '请先选择一场面试');
      return;
    }
    const { companyId, positionId } = state.selected;
    const roundKey = $('roundKey').value;
    append('sys', '创建语音面试会话（预分析 + 面试官 session）…');
    const startRes = await fetch('/voice/start-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ companyId, positionId, roundKey }),
    });
    const startData = await startRes.json();
    if (!startRes.ok) {
      setStatus('error', '创建会话失败：' + (startData.error || startRes.status));
      return;
    }
    state.sessionKey = startData.sessionKey;
    state.sessionConfig = startData.config;
    state.roundKey = roundKey;
    state.companyId = companyId;
    state.positionId = positionId;
  } else {
    state.sessionKey = null;
    state.sessionConfig = null;
  }
  state.sessionId = state.sessionKey || crypto.randomUUID();
  state.startedAt = Date.now();
  state.durationTimer = setInterval(updateMetrics, 1000);
  setStatus('connecting', '连接中…');
  // 根据页面协议动态选择 ws/wss（路径 A：Tailscale Serve 走 wss://）
  const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  append('sys', `连接语音中继 ${wsProto}//${location.host}/voice/ws`);

  const ws = new WebSocket(`${wsProto}//${location.host}/voice/ws${q.toString() ? `?${q}` : ''}`);
  ws.binaryType = 'arraybuffer';
  state.ws = ws;

  const handshakeTimer = setTimeout(() => {
    if (!state.ready) hangup('握手超时（5 秒未就绪）');
  }, 5000);

  ws.onopen = () => {
    append('sys', '代理已连接，发送 StartConnection(1)');
    sendControl(EV_START_CONNECTION, { sessionId: null, payload: {} });
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
    stopPanelPolling();
    fetchReview();
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


// ============ 会话状态面板 / 复盘拉取（配合语音会话编排层） ============
function updatePanel() {
  if (!state.sessionKey) return;
  fetch(`/voice/session/${encodeURIComponent(state.sessionKey)}`)
    .then((r) => (r.ok ? r.json() : null))
    .then((info) => {
      if (!info) return;
      const s = info.summary || {};
      $('panelRound').textContent = { round1: '一面', round2: '二面', round3: '三面' }[info.roundKey] || info.roundKey;
      $('panelAsked').textContent = String(s.depth || 0);
      $('panelLeft').textContent = String(Math.max(0, (s.maxDepth || 0) - (s.depth || 0)));
      const last = s.signals && s.signals.length ? s.signals[s.signals.length - 1] : null;
      const sig = last ? last.signals : null;
      const el = $('panelSignal');
      el.textContent = sig ? `${sig.difficulty}/${sig.direction}/${sig.fluency}` : '-';
      el.className = 'badge' + (sig && sig.direction === 'off_topic' ? ' signal-bad' : sig && sig.fluency === 'poor' ? ' signal-warn' : '');
    })
    .catch(() => {});
}

function startPanelPolling() {
  stopPanelPolling();
  state.panelTimer = setInterval(updatePanel, 1500);
}

function stopPanelPolling() {
  if (state.panelTimer) {
    clearInterval(state.panelTimer);
    state.panelTimer = null;
  }
}

function fetchReview() {
  if (!state.sessionKey) return;
  fetch(`/voice/review/${encodeURIComponent(state.sessionKey)}`)
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      if (!data || !data.review || !data.review.report) return;
      const card = $('reviewCard');
      card.hidden = false;
      $('review').textContent = data.review.report;
    })
    .catch(() => {});
}

// ============ 准备好的面试卡片（一键开始，无需手填 ID） ============
async function loadReady() {
  if (!state.status?.coordination) {
    $('readyList').innerHTML = '<div class="empty">未启用档案库联动（coordination 未就绪），可在 mock 模式下直接开始。</div>';
    return;
  }
  try {
    const res = await fetch('/voice/ready');
    const data = await res.json();
    state.readyList = data.items || [];
    renderReady();
  } catch (e) {
    $('readyList').innerHTML = `<div class="empty">加载失败：${e.message}</div>`;
  }
}

function renderReady() {
  const list = $('readyList');
  if (!state.readyList.length) {
    list.innerHTML = '<div class="empty">还没有准备好的面试。请在手机 APP 里：上传简历 → 粘贴 JD → 投递岗位。</div>';
    return;
  }
  list.innerHTML = '';
  for (const item of state.readyList) {
    const div = document.createElement('div');
    div.className = 'ready-item';
    const roundChips = item.rounds
      .map((r) => {
        const cls = r.practicedCount > 0 ? 'round-chip practiced' : 'round-chip';
        return `<span class="${cls}">${r.label} ×${r.practicedCount}</span>`;
      })
      .join('');
    div.innerHTML = `
      <div class="title">${item.companyName} · ${item.positionTitle}</div>
      <div class="sub">${item.appliedAt ? `已投递 · 简历 v${item.resumeVersionNo ?? '?'}` : '未投递（用最新简历练）'}</div>
      <div class="rounds">${roundChips}</div>
    `;
    div.onclick = () => selectReady(item, div);
    list.appendChild(div);
  }
}

function selectReady(item, el) {
  document.querySelectorAll('.ready-item').forEach((n) => n.classList.remove('selected'));
  el.classList.add('selected');
  state.selected = { companyId: item.companyId, positionId: item.positionId };
  $('sessionCard').hidden = false;
  $('sessionTitle').textContent = `${item.companyName} · ${item.positionTitle}`;
  $('sessionSub').textContent = item.appliedAt
    ? `已投递 · 简历 v${item.resumeVersionNo ?? '?'} · ${new Date(item.appliedAt).toLocaleString('zh-CN')}`
    : '未投递（将用最新简历版本练）';
  // 推荐轮次：第一个未练的，否则最近练的
  const recommend = item.rounds.find((r) => r.practicedCount === 0) ?? item.rounds[item.rounds.length - 1];
  $('roundKey').value = recommend.roundKey;
  $('connect').disabled = false;
  append('sys', `已选择：${item.companyName} · ${item.positionTitle}，推荐${recommend.label}`);
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
  loadReady();
}

init();
