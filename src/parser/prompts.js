import { JOB_TYPES } from '../archive/constants.js';

// 简历解析提示词。要求只输出 JSON，结构跟规则兜底的输出保持一致，
// 这样上层 normalize 之后两条路径的产物是同一个 schema。
export const RESUME_PARSE_PROMPT = `你是一名求职面试陪练系统里的简历解析器。用户会发来一份简历文本，请提取结构化信息。

只输出 JSON，不要输出任何解释或 markdown。JSON 结构：
{
  "basics": { "name": "姓名，没有就填 null", "title": "求职方向或目标岗位，没有就填 null" },
  "companies": ["简历里出现过的公司/单位名称，去重"],
  "skills": [ { "name": "技能名", "level": "熟练/熟悉/了解，或 null" } ],
  "experiences": [ { "summary": "一段经历/项目概括，尽量保留关键细节和量化结果", "org": "所属公司，没有就 null" } ]
}

要求：不要编造原文里没有的信息；技能按原文出现顺序去重；经历按时间或重要程度排序。`;

export const JD_PARSE_PROMPT = `你是一名求职面试陪练系统里的 JD 解析器。用户会发来目标岗位的 JD 文本，请提取结构化信息。

只输出 JSON，不要输出任何解释或 markdown。JSON 结构：
{
  "companyName": "公司名称，没有就填 null",
  "title": "岗位名称",
  "jobType": "${JOB_TYPES.join('|')} 之一，根据职责内容判断岗位类型",
  "responsibilities": ["岗位职责，逐条列出"],
  "requirements": ["任职要求，逐条列出"],
  "keywords": ["JD 中出现的关键词（技术栈/工具/能力），去重"]
}

jobType 说明：tech=技术岗(研发/算法/测试)，product=产品岗，operation=运营/增长，sales=市场/销售/BD，function=职能岗(行政/财务/HR)，civil=公考/考编。`;
