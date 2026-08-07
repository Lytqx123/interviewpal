// 一键播种 mock 数据：3 份简历 × 3 家公司 × 3 个岗位。
// 走真实流水线：简历/JD 解析（规则兜底）→ 建画像存档 → 投递即冻结。
// 用法：npm run seed   （默认目标 data/demo，可传 --store-dir=xxx 覆盖）

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ArchiveStore } from '../src/archive/index.js';
import { handleResumeUpload, handleJdPaste, handleApply } from '../src/onboarding/index.js';
import { createLlmFromEnv } from '../src/llm/env.js';

const MOCK_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data/mock');

export function loadManifest(dir = MOCK_DIR) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
}

function readText(dir, file) {
  return fs.readFileSync(path.join(dir, file), 'utf8');
}

/**
 * 播种 mock 数据（可被 demo 与测试复用）。
 * @param {object} opts { dir, storeDir, reset, log }
 * @returns {Promise<{store, manifest, summary}>}
 */
export async function seedDemoData({ dir = MOCK_DIR, storeDir = null, reset = true, log = console } = {}) {
  const manifest = loadManifest(dir);
  const target = storeDir ?? path.resolve(process.cwd(), manifest.storeDir);

  if (reset && fs.existsSync(target)) {
    fs.rmSync(target, { recursive: true, force: true });
  }
  const store = new ArchiveStore(target);
  const llm = createLlmFromEnv(process.env, path.join(process.cwd(), '.env.local'));
  const llmMode = llm ? '真实 LLM' : '规则兜底';
  const summary = { resumes: [], companies: [], positions: [], applications: [] };
  const logger = {
    info: (...a) => (typeof log.info === 'function' ? log.info(...a) : log(...a)),
  };

  // 1. 上传 3 份简历（每次上传 = 一个不可变版本 v1/v2/v3）
  for (const item of manifest.resumes) {
    const content = readText(dir, item.file);
    const result = await handleResumeUpload({ store, llm, search: null, content });
    summary.resumes.push({
      id: item.id,
      title: item.title,
      versionId: result.version.versionId,
      versionNo: result.version.versionNo,
      charCount: result.version.charCount,
      source: result.version.source,
    });
    logger.info(`[seed] 简历已上传：${item.title} → v${result.version.versionNo}（${llmMode}）`);
  }

  // 2. 粘贴 9 份 JD（3 公司 × 3 岗位），建公司/岗位双画像
  for (const company of manifest.companies) {
    const entry = { name: company.name, companyId: null, positions: [] };
    for (const pos of company.positions) {
      const jdText = readText(dir, pos.file);
      const result = await handleJdPaste({ store, llm, search: null, jdText });
      entry.companyId = result.company.companyId;
      entry.positions.push({ title: pos.title, positionId: result.position.positionId });
      summary.positions.push({
        company: company.name,
        companyId: result.company.companyId,
        title: pos.title,
        positionId: result.position.positionId,
        jobType: result.jobProfile.jobType,
      });
      logger.info(`[seed] JD 已粘贴：${company.name} · ${pos.title}（${llmMode}）`);
    }
    summary.companies.push(entry);
  }

  // 3. 投递 3 份（一家公司绑定一份简历版本，投递即冻结）
  for (const app of manifest.applications) {
    const resume = summary.resumes.find((r) => r.id === app.resumeId);
    if (!resume) throw new Error(`manifest applications 引用了未知简历: ${app.resumeId}`);
    // 显式指定版本：投递即冻结，防止默认落到"最新版本"
    const result = await handleApply({
      store,
      text: `投递 v${resume.versionNo} 到 ${app.company} ${app.position}`,
    });
    summary.applications.push({
      company: app.company,
      position: app.position,
      resumeId: app.resumeId,
      resumeVersionNo: resume.versionNo,
      applicationId: result.application.applicationId,
      snapshotHash: result.application.resumeSnapshot.hash,
      submittedAt: result.application.submittedAt,
    });
    logger.info(`[seed] 已投递：${app.company} · ${app.position}（简历 v${resume.versionNo}）`);
  }

  return { store, manifest, summary, storeDir: target };
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  const arg = process.argv.find((a) => a.startsWith('--store-dir='));
  const storeDir = arg ? arg.slice('--store-dir='.length) : null;
  const { summary, storeDir: target } = await seedDemoData({ storeDir });
  console.log(`\n✅ 播种完成（${target}）`);
  console.log(`  简历版本：${summary.resumes.map((r) => `${r.title} v${r.versionNo}`).join('、')}`);
  console.log(`  公司×岗位：${summary.companies.length} 家 × ${summary.companies[0]?.positions.length ?? 0} 岗`);
  console.log(`  岗位类型：${[...new Set(summary.positions.map((p) => p.title))].join('、')}`);
  console.log(`  投递快照：${summary.applications.length} 份`);
}
