// 六维报告格式化：生成渠道可读的文本报告。
import { SCORE_RUBRIC } from './rules.js';

const PROGRESS_LABEL = { up: '↑ 进步', down: '↓ 退步', flat: '→ 持平' };
const CATEGORY_LABEL = { noAnswer: '未回答', offTopic: '答偏跑题', silence: '沉默超时', shallow: '回答浅薄' };
const PRIORITY_LABEL = { high: '🔴 高优先级', medium: '🟡 中优先级', maintain: '🟢 巩固优势' };

export function formatReport(reviewResult, { session } = {}) {
  const { scores, scoreEvidence, improvementList, comparedWithLast, nextFocus, difficultQuestions, perQuestionReview } = reviewResult;
  const lines = [];

  const title = session
    ? `面试复盘报告 · ${session.jobProfile?.title ?? ''} · ${session.roundKey}`
    : '面试复盘报告';
  lines.push(`【${title}】`);
  lines.push('');

  // 六维评分
  lines.push('【六维评分】');
  for (const [dim, val] of Object.entries(SCORE_RUBRIC)) {
    const score = Math.max(0, Math.min(5, Number(scores[dim]) || 0));
    const bar = '█'.repeat(score) + '░'.repeat(5 - score);
    const progress = comparedWithLast?.progress?.[dim];
    const progressLabel = progress ? ` ${PROGRESS_LABEL[progress]}` : '';
    lines.push(`${val.name}  ${bar} ${score}/5${progressLabel}`);
    const evidence = scoreEvidence?.[dim];
    if (evidence) lines.push(`  证据：${evidence}`);
  }
  lines.push('');

  // 逐题点评
  if (perQuestionReview?.length) {
    lines.push('【逐题点评】');
    perQuestionReview.forEach((q, idx) => {
      const score = Math.max(1, Math.min(5, Number(q.score) || 0));
      const followTag = q.followedUp ? '（被追问）' : '';
      lines.push(`  ${idx + 1}. ${followTag}Q: ${(q.question ?? '').slice(0, 50)} [${score}/5]`);
      const tags = q.weaknessTags?.length ? ` 失分：${q.weaknessTags.join('、')}` : '';
      if (tags) lines.push(`     ${tags.trim()}`);
      if (q.commentary) lines.push(`     点评：${q.commentary}`);
    });
    lines.push('');
  }

  // 改进清单（可勾选：☐ 未完成；困难题相关维度标 🔁 优先重练）
  if (improvementList?.length) {
    lines.push('【改进清单】（☐ 待完成 / ☑ 已完成）');
    for (const priority of ['high', 'medium', 'maintain']) {
      const items = improvementList.filter((i) => i.priority === priority);
      if (!items.length) continue;
      lines.push(PRIORITY_LABEL[priority]);
      items.forEach((i, idx) => {
        const name = SCORE_RUBRIC[i.dimension]?.name ?? i.dimension;
        const box = i.checked ? '☑' : '☐';
        const repractice = i.priorityRepractice ? ' 🔁 优先重练' : '';
        lines.push(`  ${box} ${idx + 1}. [${name}]${repractice} ${i.suggestion}`);
      });
    }
    lines.push('');
  }

  // 困难题（标注是否上次也卡壳）
  if (difficultQuestions?.length) {
    lines.push('【困难题】');
    difficultQuestions.forEach((q, idx) => {
      const label = CATEGORY_LABEL[q.category] ?? q.category;
      const stuckTag = q.alsoStuckLastTime ? ' ⚠️ 上次也卡壳' : '';
      lines.push(`  ${idx + 1}. [${label}]${stuckTag} ${(q.question ?? '').slice(0, 50)}`);
      if (q.notes) lines.push(`     ${q.notes}`);
    });
    lines.push('');
  }

  // 与上次对比（维度升降 + 重复题 + 改进项完成率）
  if (comparedWithLast?.summary) {
    lines.push('【与上次对比】');
    lines.push(`  ${comparedWithLast.summary}`);
    const rq = comparedWithLast.repeatedQuestions;
    if (rq) {
      lines.push(`  重复题：本场 ${rq.total} 题，其中 ${rq.repeatedCount} 题上次也问过，${rq.newCount} 题为新题`);
    }
    const ic = comparedWithLast.improvementCompletion;
    if (ic && ic.total > 0) {
      lines.push(`  改进项完成率：上次改进项 ${ic.total} 项，本次完成 ${ic.completed} 项（${Math.round(ic.rate * 100)}%）`);
    }
    lines.push('');
  }

  // 下次重点
  if (nextFocus?.length) {
    lines.push('【下次重点】');
    nextFocus.forEach((f, idx) => lines.push(`  ${idx + 1}. ${f}`));
  }

  return lines.join('\n');
}
