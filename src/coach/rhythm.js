// P1：表达节奏分析（阶段八可选）。
// 联网调研依据：AI 复盘"ASR 数据告诉你不知道的自己"——语速曲线、停顿热力图、填充词触发；
// 通过回答长度分布与填充词频率推断表达节奏是否稳定。
import { FILLER_WORDS } from './rules.js';

// 分析一场面试的表达节奏：回答长度分布 + 填充词频率 + 节奏评估。
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

  return {
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
