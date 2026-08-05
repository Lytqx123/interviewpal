// P1：复盘导出（阶段八可选）。
// 把复盘记录导出为可分享的文本/Markdown 文档，便于存档或分享给导师求教。
import { formatReport } from './report.js';
import { SCORE_RUBRIC } from './rules.js';

// 导出复盘记录：text（飞书可读）/ markdown（文档存档）。
export function exportReview(record, { session, format = 'text' } = {}) {
  const header = buildHeader(record, format);
  if (format === 'markdown') {
    return `${header}\n\n${toMarkdown(record)}\n\n---\n\n${mdReport(record, session)}`;
  }
  const report = formatReport(toReviewResult(record), { session });
  return `${header}\n\n${report}`;
}

function buildHeader(record, format) {
  const title = `面试复盘 · ${record.companyId ?? ''} / ${record.positionId ?? ''} / ${record.roundKey ?? ''}`;
  const meta = `复盘时间：${record.createdAt ?? ''} | 复盘ID：${record.reviewId ?? ''}`;
  if (format === 'markdown') return `# ${title}\n\n> ${meta}`;
  return `============================\n${title}\n${meta}\n============================`;
}

// record → reviewResult（formatReport 期望的结构）
function toReviewResult(record) {
  return {
    scores: record.scores ?? {},
    scoreEvidence: record.scoreEvidence ?? {},
    directionDeviation: record.directionDeviation,
    difficultQuestions: record.difficultQuestions ?? [],
    perQuestionReview: record.perQuestionReview ?? [],
    improvementList: record.improvementList ?? [],
    comparedWithLast: record.comparedWithLast ?? null,
    nextFocus: record.nextFocus ?? [],
  };
}

// Markdown 结构化导出（含六维表格 + 改进清单 checkbox）
function toMarkdown(record) {
  const scores = record.scores ?? {};
  const lines = ['## 六维评分', '', '| 维度 | 分数 |', '|---|---|'];
  for (const [dim, rubric] of Object.entries(SCORE_RUBRIC)) {
    lines.push(`| ${rubric.name} | ${scores[dim] ?? '-'} / 5 |`);
  }
  lines.push('', '## 改进清单', '');
  for (const item of record.improvementList ?? []) {
    const box = item.checked ? '[x]' : '[ ]';
    const name = SCORE_RUBRIC[item.dimension]?.name ?? item.dimension;
    const tag = item.priorityRepractice ? ' 🔁优先重练' : '';
    lines.push(`- ${box} **${name}**（${item.priority}）${tag}：${item.suggestion}`);
  }
  if (record.difficultQuestions?.length) {
    lines.push('', '## 困难题', '');
    for (const q of record.difficultQuestions) {
      const stuck = q.alsoStuckLastTime ? ' ⚠️上次也卡壳' : '';
      lines.push(`- [${q.category}]${stuck} ${(q.question ?? '').slice(0, 50)}`);
    }
  }
  return lines.join('\n');
}

function mdReport(record, session) {
  return '## 详细报告\n\n```\n' + formatReport(toReviewResult(record), { session }) + '\n```';
}
