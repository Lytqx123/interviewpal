import { JD_PARSE_PROMPT } from './prompts.js';
import { parseJdByRules } from './rules.js';
import { parseJsonFromText } from '../llm/provider.js';

// JD 解析入口，逻辑跟 parseResume 一样：LLM 优先，规则兜底。
export async function parseJd(text, { llm } = {}) {
  if (llm) {
    try {
      const raw = await llm([
        { role: 'system', content: JD_PARSE_PROMPT },
        { role: 'user', content: text },
      ]);
      const data = parseJsonFromText(raw);
      if (data && Array.isArray(data.responsibilities)) {
        return normalizeJd(data);
      }
    } catch (err) {
      console.warn('[jd] llm parse failed, fallback to rules:', err.message);
    }
  }
  return parseJdByRules(text);
}

function normalizeJd(data) {
  return {
    companyName: data.companyName ?? null,
    title: data.title ?? '未命名岗位',
    jobType: data.jobType ?? 'tech',
    responsibilities: Array.isArray(data.responsibilities) ? data.responsibilities : [],
    requirements: Array.isArray(data.requirements) ? data.requirements : [],
    keywords: Array.isArray(data.keywords) ? data.keywords : [],
  };
}
