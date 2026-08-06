// 预分析 LLM Prompt（方案书 §5.4 / 重构计划 R1）。
// 四要素：公司 + 岗位 + 简历 + 岗位要求；XML 标签分片；JSON Schema 输出约束。
import { STRATEGY_SCHEMA, MIN_SUB_DIMENSIONS } from './schema.js';

export function buildPreAnalysisPrompt({ resumeVersion, company, position }) {
  const resumeProfile = resumeVersion?.profile ?? {};
  const jobProfile = position?.profile ?? {};
  const schemaText = JSON.stringify(STRATEGY_SCHEMA, null, 2);

  const system = `你是一名资深求职面试陪练系统的预分析引擎。
面试开始前，你需要根据"简历版本 + 目标公司 + 目标岗位"生成一份七层作战地图，作为面试官的面试前判断与执行基线。

七层结构（必须全部输出）：
L1 candidateProfile：候选人画像摘要（强项 / 弱项 / 红旗信号）
L2 positionFit：岗位匹配度（硬技能 / 软技能 / 经验匹配结论）
L3 riskPoints：风险点清单（简历瑕疵 / 经历断层 / 技术深挖风险，至少 6 条）
L4 mustAskMainlines：必问主线（项目深挖 / 技术原理或业务理解 / 行为面试 / 岗位匹配，至少 8 条，每条带 2 个以上关键问题）
L5 followupTree：追问树（对核心主线按 浅(shallow) / 中(medium) / 深(deep) 三档设计，至少 12 条）
L6 scoreAnchors：六维 BARS 评分锚点（logic/relevance/depth/fluency/interaction/confidence，每维给期望分位与高低锚点）
L7 roundPositioning：一面/二面/三面差异化定位（focus/style/duration/keyDimensions）

要求：
1. 全部基于输入材料推断，不编造简历里没有的事实；简历缺失的信息标注为风险点
2. 子维度总量不少于 ${MIN_SUB_DIMENSIONS} 个（含每条主线的 keyQuestions）
3. 面试官在面试中"失忆"：本计划只含简历推导信息，不引用历次练习记录
4. 只输出 JSON，不要输出任何解释或 markdown`;

  const user = `<company>
公司名：${company.name ?? '未命名公司'}
公司状态：${company.archived ? '已归档' : '活跃'}${company.notes ? `\n备注：${company.notes}` : ''}
</company>

<position>
岗位：${position.title ?? '未命名岗位'}
岗位类型：${position.jobType ?? 'tech'}
职责：${JSON.stringify(jobProfile.responsibilities ?? [])}
要求：${JSON.stringify(jobProfile.requirements ?? [])}
关键词：${JSON.stringify(jobProfile.keywords ?? [])}
</position>

<resume>
版本号：v${resumeVersion.versionNo ?? '?'}（版本ID：${resumeVersion.versionId}）
${JSON.stringify(resumeProfile, null, 2)}
</resume>

请严格按以下 JSON Schema 输出：\n${schemaText}`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}
