// 复盘引擎：评估面试表现、对比历史、生成报告。
// 教练"全记忆"（方案书 §4.2）：读取历史复盘记录，对比上次表现。
// LLM 优先，规则兜底（与 parser/interviewer 一致的双路径模式）。
import { parseJsonFromText } from '../llm/provider.js';
import { buildReviewPrompt } from './prompts.js';
import {
  scoreByRules, improvementByRules, directionDeviationByRules,
  difficultQuestionsByRules, nextFocusByRules, perQuestionReviewByRules, SCORE_RUBRIC,
} from './rules.js';
import { formatReport } from './report.js';

// 复盘评估：基于面试 session 生成六维评分 + 改进清单 + 对比上次
export async function reviewInterview(session, { lastReview = null, llm = null } = {}) {
  let result;
  if (llm) {
    try {
      const systemPrompt = buildReviewPrompt(session, { lastReview });
      const raw = await llm([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: '请生成面试复盘报告。' },
      ]);
      const data = parseJsonFromText(raw);
      if (data && data.scores) {
        result = normalizeReviewResult(data);
      }
    } catch (err) {
      console.warn('[coach] llm review failed, fallback to rules:', err.message);
    }
  }
  if (!result) {
    result = reviewByRules(session);
  }
  // LLM 路径若未返回逐题点评，用规则补齐，保证两路径 schema 一致
  if (!result.perQuestionReview?.length) {
    result.perQuestionReview = perQuestionReviewByRules(session);
  }
  // 对比上次（纯数据比较，LLM 和规则路径都走这里，保证一致性）
  if (lastReview?.scores) {
    result.comparedWithLast = compareWithLast(result.scores, lastReview.scores);
  }
  return result;
}

// 规则兜底：完整复盘结果
function reviewByRules(session) {
  const { scores, scoreEvidence } = scoreByRules(session);
  return {
    scores,
    scoreEvidence,
    directionDeviation: directionDeviationByRules(session),
    difficultQuestions: difficultQuestionsByRules(session),
    perQuestionReview: perQuestionReviewByRules(session),
    improvementList: improvementByRules(scores),
    comparedWithLast: null,
    nextFocus: nextFocusByRules(scores),
  };
}

// 对比上次：逐维比较，生成进步/退步/持平（教练"全记忆"核心）
export function compareWithLast(currentScores, lastScores) {
  const progress = {};
  const dims = Object.keys(SCORE_RUBRIC);
  for (const dim of dims) {
    const cur = currentScores[dim] ?? 0;
    const last = lastScores[dim] ?? 0;
    progress[dim] = cur > last ? 'up' : cur < last ? 'down' : 'flat';
  }
  const ups = dims.filter((d) => progress[d] === 'up').map((d) => SCORE_RUBRIC[d].name);
  const downs = dims.filter((d) => progress[d] === 'down').map((d) => SCORE_RUBRIC[d].name);
  const flats = dims.filter((d) => progress[d] === 'flat').map((d) => SCORE_RUBRIC[d].name);
  const parts = [];
  if (ups.length) parts.push(`${ups.join('、')}进步`);
  if (downs.length) parts.push(`${downs.join('、')}退步`);
  if (flats.length) parts.push(`${flats.join('、')}持平`);
  return { progress, summary: parts.join('；') || '首次面试，无对比' };
}

function normalizeReviewResult(data) {
  const scores = {};
  for (const dim of Object.keys(SCORE_RUBRIC)) {
    const raw = data.scores[dim];
    scores[dim] = typeof raw === 'number' ? Math.max(1, Math.min(5, Math.round(raw))) : 3;
  }
  return {
    scores,
    scoreEvidence: data.scoreEvidence ?? {},
    directionDeviation: data.directionDeviation ?? { expected: [], actual: [], notes: '' },
    difficultQuestions: Array.isArray(data.difficultQuestions) ? data.difficultQuestions : [],
    perQuestionReview: Array.isArray(data.perQuestionReview) ? data.perQuestionReview : [],
    improvementList: Array.isArray(data.improvementList) ? data.improvementList : improvementByRules(scores),
    comparedWithLast: data.comparedWithLast ?? null,
    nextFocus: Array.isArray(data.nextFocus) ? data.nextFocus : nextFocusByRules(scores),
  };
}

// 生成文本报告（渠道可读）
export function generateReport(reviewResult, { session } = {}) {
  return formatReport(reviewResult, { session });
}
