// 实时信号提取（方案书 §5.4 动态执行）。
// 从候选人回答中提取四类信号：difficulty（难度）/ direction（方向）/ depth（深度）/ fluency（流畅度）。
// 依据：关键词、长度、停顿标记、2-gram 重复度。

const FILLER_PATTERNS = [
  '嗯嗯', '呃呃', '额额', '那个那个', '然后然后', '就是就是', '怎么说呢',
  'emmm', 'emm', '嗯...', '呃...', '额...', '……', '。。', '，，',
];

const DIFFICULTY_HIGH_MARKERS = [
  '不清楚', '不太清楚', '不太会', '没做过', '不熟悉', '不太了解', '不了解', '忘了', '不会', '没接触过',
];

const OFF_TOPIC_MARKERS = [
  '跑题', '换个话题', '说点别的', '跳过这个', '不想回答', '跟这个没关系', '别的问题',
];

const DEPTH_DEEP_MARKERS = [
  '因为', '所以', '方案', '原理', '对比', '边界', '设计', '架构', '数据',
  'qps', '性能', '权衡', '原因', '复盘', '迭代', '指标', '场景',
];

function toText(value) {
  return String(value ?? '').replace(/\s+/g, '');
}

function countOccurrences(text, patterns) {
  const lower = text.toLowerCase();
  return patterns.reduce((n, p) => n + (lower.split(p.toLowerCase()).length - 1), 0);
}

// 2-gram 重复度：字符二元组中重复出现的比例，用于识别"这个这个/就是就是"式卡顿。
function bigramRepeatRate(text) {
  if (text.length < 4) return 0;
  const grams = [];
  for (let i = 0; i < text.length - 1; i++) grams.push(text.slice(i, i + 2));
  return 1 - new Set(grams).size / grams.length;
}

// 中文词面相似度代理：统计回答与问题共享的 2-gram 数量。
function termOverlap(a, b) {
  const gramsA = new Set();
  for (let i = 0; i < a.length - 1; i++) gramsA.add(a.slice(i, i + 2));
  let hit = 0;
  for (let i = 0; i < b.length - 1; i++) {
    if (gramsA.has(b.slice(i, i + 2))) hit++;
  }
  return hit;
}

/**
 * 提取实时信号。
 * @param {string} answerText 候选人回答
 * @param {object} [opts]
 * @param {string} [opts.question] 上一轮面试官问题（用于偏题判定）
 * @returns {{difficulty: 'high'|'medium'|'low', direction: 'on_topic'|'off_topic',
 *            depth: 'shallow'|'medium'|'deep', fluency: 'good'|'medium'|'poor',
 *            metrics: {length, fillerCount, repeatRate}}}
 */
export function ingestSignal(answerText, { question = '' } = {}) {
  const text = toText(answerText);
  const len = text.length;
  const fillerCount = countOccurrences(text, FILLER_PATTERNS);
  const repeatRate = bigramRepeatRate(text);
  const highMarkers = countOccurrences(text, DIFFICULTY_HIGH_MARKERS);
  const deepMarkers = countOccurrences(text, DEPTH_DEEP_MARKERS);
  const offMarkers = countOccurrences(text, OFF_TOPIC_MARKERS);

  let difficulty = 'medium';
  if (highMarkers > 0 || len < 8) difficulty = 'high';
  else if (len > 80) difficulty = 'low';

  let direction = 'on_topic';
  if (offMarkers > 0) direction = 'off_topic';
  else if (question && len >= 8 && termOverlap(text, toText(question)) === 0) direction = 'off_topic';

  let depth = 'medium';
  if (len < 15 || repeatRate > 0.3) depth = 'shallow';
  else if (deepMarkers >= 2 || len > 120) depth = 'deep';

  let fluency = 'good';
  if (fillerCount >= 2 || repeatRate > 0.35 || /…|。{2,}|，{2,}|\.{3,}/.test(text)) fluency = 'poor';
  else if (fillerCount === 1 || len < 6) fluency = 'medium';

  return {
    difficulty,
    direction,
    depth,
    fluency,
    metrics: { length: len, fillerCount, repeatRate },
  };
}
