// 复盘教练 LLM system prompt 构建。
// 核心思路（联网调研 BARS + 六维复盘）：把六维 BARS 评分标准、对话历史、
// 期望方向、上次评分全部塞进 system prompt，让模型生成有证据支撑的评分。
import { SCORE_RUBRIC } from './rules.js';

function rubricText() {
  return Object.entries(SCORE_RUBRIC)
    .map(
      ([key, val]) =>
        `${val.name}(${key})\n  1分: ${val.anchors[1]}\n  3分: ${val.anchors[3]}\n  5分: ${val.anchors[5]}`,
    )
    .join('\n');
}

export function buildReviewPrompt(session, { lastReview } = {}) {
  const dialogue = (session.turns ?? [])
    .map((t) => (t.role === 'interviewer' ? `面试官：${t.content}` : `候选人：${t.content}`))
    .join('\n');

  const lastScoresText = lastReview?.scores
    ? `上次评分：${JSON.stringify(lastReview.scores)}`
    : '无历史复盘记录（首次面试，comparedWithLast 留空）';

  const expectedDirections = (session.turns ?? [])
    .filter((t) => t.role === 'interviewer' && t.focusArea)
    .map((t) => t.focusArea);

  return `你是一位专业的面试复盘教练，正在为一位应聘"${session.jobProfile?.title ?? '该'}"岗位的候选人做面试复盘。

【六维 BARS 评分标准（1-5 分）】
${rubricText()}

【面试对话历史】
${dialogue}

【期望考察方向】
${expectedDirections.join('、') || '开场破冰、围绕岗位职责与简历经历追问'}

【历史表现】
${lastScoresText}

【你的任务】
基于对话历史，生成六维评分与改进建议。要求：
1. 每个维度给 1-5 分，并附行为证据（引用候选人具体回答片段）
2. 逐题点评：遍历每个面试官提问，给该题回答质量 1-5 分、失分标签(答非所问/无结构/表达问题/知识缺失/深挖崩盘)、是否被追问(followedUp)与点评
3. 识别方向偏差：期望方向 vs 实际回答方向
4. 识别困难题：未回答(noAnswer)/答偏(offTopic)/沉默(silence)/浅薄(shallow)
5. 生成改进清单：低分项高优先级(high)，中分项中优先级(medium)，高分项巩固(maintain)
6. 如果有上次评分，逐维对比进步(up)/退步(down)/持平(flat)
7. 给出下次面试的重点方向

请以 JSON 格式输出：
{"scores":{"logic":3,"relevance":4,"depth":2,"fluency":3,"interaction":2,"confidence":3},"scoreEvidence":{"logic":"证据","relevance":"证据","depth":"证据","fluency":"证据","interaction":"证据","confidence":"证据"},"perQuestionReview":[{"turnNo":1,"question":"问题","answer":"回答片段","score":4,"followedUp":true,"weaknessTags":["无结构"],"commentary":"点评"}],"directionDeviation":{"expected":["项目深挖"],"actual":["只讲了背景"],"notes":"说明"},"difficultQuestions":[{"question":"问题","category":"shallow","notes":"说明"}],"improvementList":[{"dimension":"depth","priority":"high","suggestion":"建议"}],"comparedWithLast":{"progress":{"logic":"up","relevance":"flat"},"summary":"对比总结"},"nextFocus":["重点1","重点2"]}`;
}
