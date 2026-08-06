import { parseResume } from '../parser/resume.js';
import { parseJd } from '../parser/jd.js';
import { enrichResume, enrichJd } from '../enrich/enrich.js';

// onboarding：首次上传/粘贴的完整流水线。
// 解析 → 建画像 → 存档 → 联网补全入缓存，一条龙。
export { handleApply, parseApplyCommand } from './apply.js';

export async function handleResumeUpload({ store, llm, search, companyName = null, fileName = null, content }) {
  const resumeProfile = await parseResume(content, { llm });

  // 每次上传都生成一个不可变简历版本（v1/v2...），投递时绑定的是版本不是"当前文件"。
  const version = store.createResumeVersion({
    rawText: content,
    profile: resumeProfile,
    source: fileName ? 'file' : 'text',
  });

  // 简历画像是全局的（一份简历投多家公司），先存档
  store.saveResumeProfile({ ...resumeProfile, activeVersionId: version.versionId });

  // 用户带了公司名就顺便补全（简历面检索重点：公司/技术）
  let companyId = null;
  let enrichment = null;
  if (companyName) {
    const company = ensureCompany(store, companyName);
    companyId = company.companyId;
    enrichment = await enrichResume({ store, search, resumeProfile, companyId, roundKey: 'round1' });
  }

  return { resumeProfile, version, companyId, enrichment, fileName };
}

export async function handleJdPaste({ store, llm, search, companyName = null, jdText }) {
  const jobProfile = await parseJd(jdText, { llm });
  const company = ensureCompany(store, companyName || jobProfile.companyName || '未命名公司');

  // 岗位画像：职责/要求/关键词直接写进 position.profile（双画像之一）
  const position = store.createPosition(company.companyId, {
    title: jobProfile.title,
    jdText,
    jobType: jobProfile.jobType,
  });
  store.updatePosition(company.companyId, position.positionId, {
    profile: {
      responsibilities: jobProfile.responsibilities,
      requirements: jobProfile.requirements,
      keywords: jobProfile.keywords,
    },
  });

  // JD 补全重点属于二面业务面（真实 JD 职责/业务方向）
  const enrichment = await enrichJd({
    store,
    search,
    jobProfile,
    companyId: company.companyId,
    roundKey: 'round2',
  });

  return { jobProfile, company, position, enrichment };
}

function ensureCompany(store, name) {
  return store.findCompanyByName(name) ?? store.createCompany({ name });
}
