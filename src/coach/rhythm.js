// P1 §5.9：表达节奏分析（语速 / 停顿 / 口头禅 / 卡壳）+ 困难点报告。
// 联网调研依据：AI 复盘"ASR 数据告诉你不知道的自己"——语速曲线、停顿热力图、填充词触发；
// 通过回答长度分布、ASR 时间戳间隔与填充词频率推断表达节奏是否稳定。
//
// 数据源分层：
//  - 基础版（无时间戳）：回答长度分布 + 填充词频率 → 节奏评估
//  - 进阶版（有 voiceMeta 时间戳）：语速（字/分钟）+ 停顿分布 + 沉默检测 → 完整节奏画像
import { FILLER_WORDS } from './rules.js';

// 分析一场面试的表达节奏：回答长度分布 + 填充词频率 + 节奏评估 + 时间戳维度（如有）。
export function analyzeRhythm(session) {
  const answers = extractAnswers(session.turns);
  if (!answers.length) return emptyRhythm();

  const lengths = answers.map((a) => a.length);
  const totalLen = lengths.reduce((a, b) => a + b, 0);
  const avg = totalLen / answers.length;
  const variance = answers.length > 1 ? sampleVariance(lengths) : 0;
  const stdDev = Math.sqrt(variance);

  const fillerCounts = answers.map((a) => countFillers(a));
  const totalFillers = fillerCounts.reduce((a, b) => a + b, 0);
  const fillerRate = totalLen ? totalFillers / (totalLen / 100) : 0; // 每 100 字填充词数

  const shortAnswers = answers.filter((a) => a.length < 15).length;
  const longAnswers = answers.filter((a) => a.length > 200).length;

  const result = {
    answerCount: answers.length,
    avgLength: Math.round(avg),
    minLength: Math.min(...lengths),
    maxLength: Math.max(...lengths),
    stdDev: Math.round(stdDev),
    totalFillers,
    fillerRate: Math.round(fillerRate * 10) / 10,
    shortAnswerRatio: Math.round((shortAnswers / answers.length) * 100) / 100,
    longAnswerRatio: Math.round((longAnswers / answers.length) * 100) / 100,
    pacing: assessPacing(avg, stdDev, fillerRate, shortAnswers, answers.length),
  };

  // 进阶版：有 voiceMeta 时间戳时，补充语速/停顿/沉默分析
  const meta = session.voiceMeta;
  if (meta?.asrEvents?.length) {
    result.timestampBased = analyzeTimestamps(meta);
  }

  return result;
}

/**
 * 进阶版：基于 ASR/Chat 时间戳分析语速、停顿、沉默。
 * - 语速：chars/min（按 ASR 事件间隔推算）
 * - 停顿：面试官发言结束 → 候选人开始说话的间隔（思考时间）
 * - 沉默：>10s 的停顿（卡壳信号）
 */
function analyzeTimestamps(meta) {
  const asrEvents = meta.asrEvents ?? [];
  const chatEvents = meta.chatEvents ?? [];
  if (!asrEvents.length) return null;

  // 语速：总字数 / 总说话时长（按 ASR 事件跨度粗估）
  const totalChars = asrEvents.reduce((s, e) => s + e.charCount, 0);
  const spanMs = asrEvents[asrEvents.length - 1].arrivedAt - asrEvents[0].arrivedAt;
  const speakingRate = spanMs > 0 ? Math.round((totalChars / spanMs) * 60000) : 0; // 字/分钟

  // 停顿分布：每个面试官发言 → 下一个 ASR 的间隔
  const pauses = [];
  for (const chat of chatEvents) {
    const nextAsr = asrEvents.find((a) => a.arrivedAt > chat.arrivedAt);
    if (nextAsr) {
      pauses.push({
        gapMs: nextAsr.arrivedAt - chat.arrivedAt,
        gapSec: Math.round((nextAsr.arrivedAt - chat.arrivedAt) / 100) / 10,
      });
    }
  }
  const pauseGaps = pauses.map((p) => p.gapMs);
  const avgPauseMs = pauseGaps.length ? Math.round(pauseGaps.reduce((a, b) => a + b, 0) / pauseGaps.length) : 0;
  const maxPauseMs = pauseGaps.length ? Math.max(...pauseGaps) : 0;

  // 沉默期（>10s 的停顿）
  const silencePeriods = meta.silencePeriods ?? [];
  const totalSilenceMs = silencePeriods.reduce((s, p) => s + p.durationMs, 0);

  // 节奏稳定性评估
  let stability = 'stable';
  const issues = [];
  if (speakingRate > 0 && speakingRate < 80) {
    issues.push('语速偏慢（<80字/分），可能紧张或思考过久');
    stability = 'warning';
  }
  if (speakingRate > 300) {
    issues.push('语速偏快（>300字/分），可能紧张赶场，建议适当放慢');
    stability = 'warning';
  }
  if (avgPauseMs > 8000) {
    issues.push(`平均思考停顿较长（${Math.round(avgPauseMs / 1000)}s），可能有卡壳倾向`);
    stability = 'warning';
  }
  if (silencePeriods.length > 0) {
    issues.push(`出现 ${silencePeriods.length} 次沉默超时（>10s），卡壳风险高`);
    stability = 'warning';
  }

  return {
    speakingRate, // 字/分钟
    avgPauseSec: Math.round(avgPauseMs / 100) / 10,
    maxPauseSec: Math.round(maxPauseMs / 100) / 10,
    silenceCount: silencePeriods.length,
    totalSilenceSec: Math.round(totalSilenceMs / 1000),
    stability,
    issues,
  };
}

/**
 * P1 §5.9：构建困难点报告。
 * 输入：通话中当场标注的困难标记 + 沉默期记录。
 * 输出：结构化困难点报告（四分类统计 + 逐条困难题）。
 */
export function buildDifficultyReport(difficultyMarkers, silencePeriods = []) {
  const markers = Array.isArray(difficultyMarkers) ? difficultyMarkers : [];
  const byCategory = { noAnswer: 0, offTopic: 0, silence: 0, shallow: 0 };
  for (const m of markers) {
    if (byCategory[m.category] !== undefined) byCategory[m.category]++;
  }
  const totalSilenceSec = silencePeriods.reduce((s, p) => s + (p.durationMs ?? 0), 0) / 1000;
  return {
    total: markers.length,
    byCategory,
    silencePeriods: silencePeriods.map((p) => ({
      durationSec: Math.round((p.durationMs ?? 0) / 100) / 10,
      at: p.to,
    })),
    totalSilenceSec: Math.round(totalSilenceSec),
    questions: markers.map((m) => ({
      questionIndex: m.questionIndex,
      category: m.category,
      question: (m.question ?? '').slice(0, 100),
      answerSummary: (m.answerSummary ?? '').slice(0, 80),
      notes: m.notes ?? '',
    })),
    summary: markers.length
      ? `本场共标记 ${markers.length} 个困难点：未答 ${byCategory.noAnswer} / 答偏 ${byCategory.offTopic} / 沉默 ${byCategory.silence} / 浅薄 ${byCategory.shallow}`
      : '本场无显著困难点',
  };
}

function assessPacing(avg, stdDev, fillerRate, shortCount, total) {
  const issues = [];
  if (avg < 20) issues.push('回答偏短，可能表达不充分或紧张');
  if (avg > 250) issues.push('回答偏长，可能啰嗦或缺乏提炼，建议控制单次回答 1-2 分钟');
  if (stdDev > 80) issues.push('回答长度波动大，节奏不稳定');
  if (fillerRate > 2) issues.push(`填充词频率偏高（每百字 ${fillerRate} 个），建议用停顿替代口头填充`);
  if (shortCount / total > 0.5) issues.push('过半回答过短，可能存在卡壳或回避');
  if (!issues.length) return { level: 'good', assessment: '表达节奏稳定，长度适中、填充词少', issues: [] };
  return { level: 'warning', assessment: '表达节奏有改进空间', issues };
}

function extractAnswers(turns) {
  return (turns ?? []).filter((t) => t.role === 'candidate').map((t) => t.content);
}

function countFillers(text) {
  if (!text) return 0;
  let count = 0;
  for (const w of FILLER_WORDS) {
    let idx = text.indexOf(w);
    while (idx !== -1) { count++; idx = text.indexOf(w, idx + w.length); }
  }
  return count;
}

function sampleVariance(arr) {
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  return arr.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (arr.length - 1);
}

function emptyRhythm() {
  return { answerCount: 0, avgLength: 0, pacing: { level: 'unknown', assessment: '无回答数据', issues: [] } };
}
