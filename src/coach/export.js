// P1：复盘报告导出（文本 / Markdown / HTML）。
// 把复盘记录导出为可分享的文档，便于存档或分享给导师求教。
// HTML 格式可浏览器直接打印为 PDF（Ctrl+P → 另存为 PDF），无需额外依赖。
import { formatReport } from './report.js';
import { SCORE_RUBRIC } from './rules.js';

// 导出复盘记录：text（渠道可读）/ markdown（文档存档）/ html（可打印为 PDF）。
export function exportReview(record, { session, format = 'text' } = {}) {
  const header = buildHeader(record, format);
  if (format === 'markdown') {
    return `${header}\n\n${toMarkdown(record)}\n\n---\n\n${mdReport(record, session)}`;
  }
  if (format === 'html') {
    return toHtml(record, session);
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

// HTML 导出：浏览器打开后 Ctrl+P 可另存为 PDF，无需额外依赖。
function toHtml(record, session) {
  const scores = record.scores ?? {};
  const title = `面试复盘 · ${record.companyId ?? ''} / ${record.positionId ?? ''} / ${record.roundKey ?? ''}`;
  const meta = `复盘时间：${record.createdAt ?? ''} | 复盘ID：${record.reviewId ?? ''}`;

  const scoreRows = Object.entries(SCORE_RUBRIC)
    .map(([dim, rubric]) => {
      const score = Number(scores[dim]) || 0;
      const bar = '█'.repeat(score) + '░'.repeat(5 - score);
      const progress = record.comparedWithLast?.progress?.[dim];
      const progLabel = progress === 'up' ? ' ↑进步' : progress === 'down' ? ' ↓退步' : '';
      return `<tr><td>${rubric.name}</td><td>${bar}</td><td>${score}/5${progLabel}</td></tr>`;
    })
    .join('\n');

  const improvementItems = (record.improvementList ?? [])
    .map((i) => {
      const box = i.checked ? '☑' : '☐';
      const name = SCORE_RUBRIC[i.dimension]?.name ?? i.dimension;
      const tag = i.priorityRepractice ? ' 🔁优先重练' : '';
      return `<li>${box} <strong>${name}</strong>（${i.priority}）${tag}：${escapeHtml(i.suggestion)}</li>`;
    })
    .join('\n');

  const diffItems = (record.difficultQuestions ?? [])
    .map((q) => {
      const stuck = q.alsoStuckLastTime ? ' ⚠️上次也卡壳' : '';
      return `<li><span class="tag">${q.category}</span>${stuck} ${escapeHtml((q.question ?? '').slice(0, 60))}</li>`;
    })
    .join('\n');

  const rhythmHtml = session?.rhythmAnalysis && session.rhythmAnalysis.answerCount > 0
    ? `<h2>表达节奏分析</h2>
       <p>回答 ${session.rhythmAnalysis.answerCount} 次，平均 ${session.rhythmAnalysis.avgLength} 字 | 填充词每百字 ${session.rhythmAnalysis.fillerRate} | ${session.rhythmAnalysis.pacing.assessment}</p>`
    : '';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; max-width: 800px; margin: 40px auto; padding: 20px; color: #333; line-height: 1.6; }
  h1 { font-size: 1.5em; border-bottom: 2px solid #4A90D9; padding-bottom: 8px; }
  h2 { font-size: 1.2em; color: #4A90D9; margin-top: 24px; }
  .meta { color: #888; font-size: 0.85em; margin-bottom: 20px; }
  table { width: 100%; border-collapse: collapse; margin: 12px 0; }
  th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid #eee; }
  th { background: #f5f7fa; font-weight: 600; }
  ul { padding-left: 20px; }
  li { margin: 4px 0; }
  .tag { display: inline-block; background: #fff3e0; color: #e65100; padding: 1px 6px; border-radius: 3px; font-size: 0.85em; margin-right: 4px; }
  pre { background: #f5f7fa; padding: 16px; border-radius: 6px; white-space: pre-wrap; font-size: 0.85em; overflow-x: auto; }
  @media print { body { margin: 0; max-width: none; } }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
<div class="meta">${escapeHtml(meta)}</div>

<h2>六维评分</h2>
<table>
<thead><tr><th>维度</th><th></th><th>评分</th></tr></thead>
<tbody>
${scoreRows}
</tbody>
</table>

${improvementItems ? `<h2>改进清单</h2><ul>${improvementItems}</ul>` : ''}
${diffItems ? `<h2>困难题</h2><ul>${diffItems}</ul>` : ''}
${rhythmHtml}

<h2>详细报告</h2>
<pre>${escapeHtml(formatReport(toReviewResult(record), { session }))}</pre>
</body>
</html>`;
}

function escapeHtml(text) {
  if (text == null) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
