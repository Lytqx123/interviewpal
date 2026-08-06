// 预分析 LLM Prompt（方案书 §5.4）。
// 四要素：公司 + 岗位 + 简历 + 岗位要求；XML 标签分片；JSON Schema 输出约束。
import { PREANALYSIS_SCHEMA, MIN_SUB_DIMENSIONS } from './schema.js';

export function buildPreAnalysisPrompt({ resumeVersion, company, position }) {
  const resumeProfile = resumeVersion?.profile ?? {};
  const jobProfile = position?.profile ?? {};
  const schemaText = JSON.stringify(PREANALYSIS_SCHEMA, null, 2);

  const system = `你是一名资深求职面试陪练系统的预分析引擎。
面试开始前，你需要根据「简历版本 + 目标公司 + 目标岗位」生成一份覆盖七大深度层的定制化面试计划（方案书 §5.4）——它是面试官面试前读简历形成的判断与执行基线，不是通用题库。
七大层（必须全部输出）：
① jdAnalysis：JD 深度解析（岗位本质 / 级别判定 / 核心职责拆解 / 隐性要求 / 红线项 / 行业上下文 / 公司阶段 / 岗位痛点推断）
② candidateProfile：候选人画像深度分析（能力雷达六维 1-5 / 经历真实性预判 / 简历亮点 / 简历弱点 / 水分预警 / 技能深度分级 / 匹配度分析 / 职业轨迹 / 潜在翻车点）
③ interviewerPersona：每轮面试官深度人设（round1 直属上级 / round2 业务负责人 / round3 总监交叉面；每轮含身份 / 背景 / 风格 / 关注核心 / 偏见偏好 / 杀手锏问题 / 提问模式）
④ roundStrategy：每轮考察策略（每轮 3-5 个考察维度及优秀/不及格行为描述；5 条以上追问链，每条含关键问题与 浅shallow / 中medium / 深deep 三层追问及质量锚定；开场策略 / 压力测试点 / 情景题具体设计 / 时间分配 / 跨轮去重清单）
⑤ riskForecast：风险预判（最可能卡壳的 3 个问题附救援策略 / 最可能吹牛的 2 个点附验证话术 / 陷阱题 / 跨轮风险传递 / 候选人反问预判 / 极端情况预案）
⑥ reviewFramework：复盘评分框架（六维 BARS：logic/relevance/depth/fluency/interaction/confidence，每维期望分位与高低锚点；覆盖度检查清单 / 方向偏差检测维度 / 跨轮进步对比 / 命中率回检）
⑦ rhythmDesign：面试节奏与体验设计（每轮节奏曲线 / 压力梯度 / 正向反馈节点 / 时长与问题数建议）
要求：
1. 全部基于输入材料推断，不编造简历里没有的事实；简历缺失的信息标注进风险预判
2. 子维度总量不少于 ${MIN_SUB_DIMENSIONS} 个（含追问链与关键问题）
3. 面试官在面试中"失忆"：本计划只含简历推导信息，不引用历次练习记录（方案书 §5.7）
4. 动态执行：计划是基线不是脚本，面试中按实时信号调整（卡壳降档 / 偏题拉回 / 意外深度延伸追问）
5. 只输出 JSON，不要输出任何解释或 markdown`;

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
