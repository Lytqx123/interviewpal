import crypto from 'node:crypto';
import { RESUME_PARSE_PROMPT } from './prompts.js';
import { parseResumeByRules } from './rules.js';
import { parseJsonFromText } from '../llm/provider.js';

// 简历解析入口：有 LLM 走 LLM，没有/失败走规则兜底。
// 两条路径最终都归一成同一个 resumeProfile schema。
export async function parseResume(text, { llm } = {}) {
  if (llm) {
    try {
      const raw = await llm([
        { role: 'system', content: RESUME_PARSE_PROMPT },
        { role: 'user', content: text },
      ]);
      const data = parseJsonFromText(raw);
      if (data && Array.isArray(data.experiences)) {
        return normalizeResume(data, text);
      }
    } catch (err) {
      // LLM 挂了不阻塞上传，落回规则解析（§5.1 规则兜底）
      console.warn('[resume] llm parse failed, fallback to rules:', err.message);
    }
  }
  return parseResumeByRules(text);
}

function normalizeResume(data, rawText) {
  return {
    basics: data.basics ?? {},
    companies: Array.isArray(data.companies)
      ? data.companies.map((c) => (typeof c === 'string' ? c : c?.name)).filter(Boolean)
      : [],
    skills: Array.isArray(data.skills)
      ? data.skills
          .map((s) => (typeof s === 'string' ? { name: s, level: null } : { name: s?.name ?? '', level: s?.level ?? null }))
          .filter((s) => s.name)
      : [],
    experiences: Array.isArray(data.experiences)
      ? data.experiences.map((e, i) =>
          typeof e === 'string'
            ? { id: `exp_${i + 1}`, summary: e, org: null }
            : { id: e?.id ?? `exp_${i + 1}`, summary: e?.summary ?? '', org: e?.org ?? null },
        )
      : [],
    rawHash: simpleHash(rawText),
  };
}

function simpleHash(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, 16);
}
