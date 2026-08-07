// 端到端演示剧本（P6）：mock 模式一键跑通全链路。
// 上传简历 → 粘贴 JD → 投递 → 预分析 → 一面（baseline + 执行轨迹）→ 复盘
// → 二面（差异化）→ 复盘 → 困难题沉淀 → 缓存命中 → 删除公司释放缓存。
// 用法：npm run demo

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { seedDemoData, loadManifest } from './seed.mjs';
import { generatePlan } from '../src/preanalysis/engine.js';
import { preanalysisCacheKey } from '../src/preanalysis/cache.js';
import {
  createSession,
  startInterview,
  nextQuestion,
  closeInterview,
  getSessionSummary,
} from '../src/interviewer/index.js';
import { prepareRound2Context } from '../src/interviewer/rounds.js';
import { reviewWithMemory } from '../src/coach/memory.js';
import { formatReport } from '../src/coach/report.js';
import { getQuestions } from '../src/coach/questionBank.js';
import { createLlmFromEnv } from '../src/llm/env.js';

const MOCK_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data/mock');

function makeJobProfile(position, company) {
  return {
    companyName: company?.name ?? '',
    title: position?.title ?? '目标岗位',
    jobType: position?.jobType ?? 'tech',
    responsibilities: position?.profile?.responsibilities ?? [],
    requirements: position?.profile?.requirements ?? [],
    keywords: position?.profile?.keywords ?? [],
  };
}

function planSummary(plan) {
  const L = plan?.layers ?? {};
  return [
    `① JD 深度解析：${L.jdAnalysis?.roleNature ?? ''}`,
    `② 候选人画像：高光 ${L.candidateProfile?.highlights?.length ?? 0} 处 / 短板 ${L.candidateProfile?.weaknesses?.length ?? 0} 处 / 技能 ${L.candidateProfile?.skillDepth?.length ?? 0} 项`,
    `③ 面试官人设：${Object.entries(L.interviewerPersona ?? {})
      .map(([k, v]) => `${k}=${v?.identity ?? ''}`)
      .join(' / ')}`,
    `④ 考察策略：${Object.entries(L.roundStrategy ?? {})
      .map(([k, v]) => `${k}=${v?.followupChains?.length ?? 0} 条追问链`)
      .join(' / ')}`,
    `⑤ 风险预判：${L.riskForecast?.likelyStuck?.length ?? 0} 个易卡点`,
    `⑥ 复盘评分框架：${L.reviewFramework?.dimensions?.length ?? 0} 维（${(L.reviewFramework?.dimensions ?? []).join('、')}）`,
    `⑦ 节奏体验：${Object.entries(L.rhythmDesign ?? {})
      .map(([k, v]) => `${k}=${v?.curve ?? ''}`)
      .join(' / ')}`,
  ].join('\n');
}

async function runInterview({ store, plan, llm, resumeProfile, jobProfile, companyId, positionId, roundKey, answers, search = null }) {
  const roundContext = roundKey === 'round2'
    ? await prepareRound2Context({ store, search, companyId, positionId })
    : null;
  const session = createSession({
    resumeProfile,
    jobProfile,
    roundKey,
    maxDepth: 3,
    llm,
    roundContext,
    preanalysisPlan: plan,
  });
  const opening = await startInterview(session);
  const log = [];
  log.push(`开场：${opening.question ?? opening.greeting ?? ''}`);
  for (const answer of answers) {
    if (session.state === 'closed') break;
    const next = await nextQuestion(session, answer);
    if (!next || session.state === 'closed') break;
    log.push(`候选人：${answer.slice(0, 60)}${answer.length > 60 ? '…' : ''}`);
    log.push(`面试官：${next.question}`);
  }
  const closing = await closeInterview(session);
  log.push(`收尾：${closing.question ?? ''}`);
  return { session, roundContext, log };
}

/**
 * 跑完整端到端演示。
 * @param {object} opts { dir, storeDir, reset, log }
 */
export async function runDemo({ dir = MOCK_DIR, storeDir = null, reset = true, log = console } = {}) {
  const out = [];
  const sink = typeof log === 'function' ? log : (log?.info ?? (() => {}));
  const p = (s = '') => {
    out.push(String(s));
    sink(String(s));
  };

  const seeded = await seedDemoData({ dir, storeDir, reset, log: { info: () => {} } });
  const { store, manifest, summary } = seeded;
  const llm = createLlmFromEnv(process.env, path.join(process.cwd(), '.env.local'));
  const llmMode = llm ? '真实 LLM' : '规则兜底';
  const demo = manifest.demo;

  p('════════════════════════════════════════════');
  p('InterviewPal · 端到端演示剧本（mock 模式，无 key）');
  p(`推理模式：${llmMode}${llm ? '（已读取 LLM_API_KEY，走真实模型）' : '（未配置文本 LLM key，走规则兜底）'}`);
  p('════════════════════════════════════════════');
  p();

  // ---------- 1. 简历解析结果 ----------
  p('【1. 简历解析结果】');
  for (const r of summary.resumes) {
    const version = store.getResumeVersion(r.versionId);
    const profile = version?.profile ?? {};
    const skills = (profile.skills ?? []).map((s) => s.name).join('、') || '（规则兜底未提取）';
    const exps = (profile.experiences ?? []).length;
    p(`  • ${r.title}（v${r.versionNo}）：${version?.charCount ?? 0} 字，技能「${skills}」，经历 ${exps} 段`);
  }
  p();

  // ---------- 2. JD 解析结果 ----------
  p('【2. JD 解析结果】');
  for (const pos of summary.positions) {
    const position = store.getPosition(pos.companyId, pos.positionId);
    const profile = position?.profile ?? {};
    p(
      `  • ${pos.company} · ${pos.title}：职责 ${(profile.responsibilities ?? []).length} 条，要求 ${(profile.requirements ?? []).length} 条，关键词 ${(profile.keywords ?? []).length} 个`,
    );
  }
  p();

  // ---------- 3. 投递快照 ----------
  p('【3. 投递快照】（投递即冻结）');
  for (const app of summary.applications) {
    p(`  • ${app.company} · ${app.position}：简历 v${app.resumeVersionNo}，快照 ${app.snapshotHash}，${app.submittedAt}`);
  }
  p();

  // ---------- 4. 预分析七大层（摘要） ----------
  const resumeEntry = summary.resumes.find((r) => r.id === demo.resumeId);
  const companyEntry = summary.companies.find((c) => c.name === demo.company);
  const positionEntry = companyEntry?.positions.find((pos) => pos.title === demo.position);
  if (!resumeEntry || !companyEntry || !positionEntry) {
    throw new Error(`demo 配置引用了不存在的组合: ${demo.company}/${demo.position}/${demo.resumeId}`);
  }
  const resumeVersion = store.getResumeVersion(resumeEntry.versionId);
  const company = store.getCompany(companyEntry.companyId);
  const position = store.getPosition(companyEntry.companyId, positionEntry.positionId);

  const first = await generatePlan({ resumeVersion, company, position, llm, store });
  const plan = first.plan;
  p(`【4. 预分析七大层（${first.source}，${first.cached ? '缓存命中' : '重新生成'}）】`);
  p(planSummary(plan));
  p();

  // ---------- 5. 一面 baseline + executionTrace ----------
  const jobProfile = makeJobProfile(position, company);
  p('【5. 一面（简历面）baseline + executionTrace】');
  p(`  baseline 主线 ${plan.layers.roundStrategy.round1.followupChains.length} 条，前 3 条：`);
  plan.layers.roundStrategy.round1.followupChains.slice(0, 3).forEach((c, i) => {
    p(`    ${i + 1}. [${c.dimension}] ${c.keyQuestions?.[0] ?? ''}`);
  });

  const round1 = await runInterview({
    store,
    plan,
    llm,
    resumeProfile: resumeVersion.profile ?? {},
    jobProfile,
    companyId: company.companyId,
    positionId: position.positionId,
    roundKey: 'round1',
    answers: demo.answersRound1,
  });
  for (const line of round1.log) p(`  ${line}`);
  const summary1 = getSessionSummary(round1.session);
  p(
    `  信号：${
      summary1.signals
        .map((s) => `t${s.turnNo} ${s.signals?.difficulty}/${s.signals?.direction}/${s.signals?.depth}/${s.signals?.fluency}`)
        .join(' / ') || '无'
    }`,
  );
  p('  executionTrace：');
  p('  ' + JSON.stringify(summary1.executionTrace, null, 2).split('\n').map((l) => `  ${l}`).join('\n'));
  p();

  // ---------- 6. 一面复盘报告 ----------
  p('【6. 一面复盘报告（六维 + 逐题点评 + 方向偏差）】');
  const review1 = await reviewWithMemory(round1.session, {
    store,
    llm,
    companyId: company.companyId,
    positionId: position.positionId,
    roundKey: 'round1',
    resumeVersionId: resumeVersion.versionId,
  });
  p(review1.report);
  const dev1 = review1.result.directionDeviation ?? {};
  const toArr = (v) => (Array.isArray(v) ? v : v ? [v] : []);
  p('【方向偏差】');
  p(`  预期：${toArr(dev1.expected).join('、') || '无'}`);
  p(`  实际：${toArr(dev1.actual).join('、') || '无'}`);
  p(`  说明：${dev1.notes ?? ''}`);
  p();

  // ---------- 7. 二面 baseline（差异化）+ 二面复盘 ----------
  p('【7. 二面（业务面）baseline 差异化】');
  const round2 = await runInterview({
    store,
    plan,
    llm,
    resumeProfile: resumeVersion.profile ?? {},
    jobProfile,
    companyId: company.companyId,
    positionId: position.positionId,
    roundKey: 'round2',
    answers: demo.answersRound2,
  });
  p(`  二面前 3 条 baseline：`);
  plan.layers.roundStrategy.round2.followupChains.slice(0, 3).forEach((c, i) => {
    p(`    ${i + 1}. [${c.dimension}] ${c.keyQuestions?.[0] ?? ''}`);
  });
  p('  实际追问（前 3 轮）：');
  round2.log.slice(0, 6).forEach((l) => p(`    ${l}`));
  p('  与一面对比：一面围绕简历真实性，二面围绕岗位匹配与业务场景（追问链维度不同）');

  p('【二面复盘】');
  const review2 = await reviewWithMemory(round2.session, {
    store,
    llm,
    companyId: company.companyId,
    positionId: position.positionId,
    roundKey: 'round2',
    resumeVersionId: resumeVersion.versionId,
  });
  p(review2.report);
  p();

  // ---------- 8. 困难题沉淀清单 ----------
  p('【8. 困难题沉淀清单】');
  const difficult = review1.result.difficultQuestions ?? [];
  if (difficult.length) {
    difficult.forEach((q, i) => p(`  ${i + 1}. ${q.question}（${q.category ?? q.tag ?? '未答'}）${q.notes ? `：${q.notes}` : ''}`));
  } else {
    p('  （本场未沉淀困难题）');
  }
  p('  高频题（一面）：');
  getQuestions(jobProfile.jobType, 'round1').forEach((q, i) => p(`    ${i + 1}. ${q.q}`));
  p();

  // ---------- 9. 预分析缓存命中 ----------
  p('【9. 预分析缓存命中场景（同公司同岗位二次生成）】');
  const again = await generatePlan({ resumeVersion, company, position, llm, store });
  p(`  第一次：${first.source}；第二次：${again.source}${again.cached ? '（缓存命中，秒出）' : ''}`);
  p(`  缓存键：${again.cacheKey}`);
  p();

  // ---------- 10. 删除公司 → 缓存释放 ----------
  p('【10. 删除公司场景演示（缓存联动释放）】');
  const cacheKey = preanalysisCacheKey({ resumeVersion, companyId: company.companyId, positionId: position.positionId });
  const before = Boolean(store.getPreanalysisCache(cacheKey));
  store.deleteCompany(company.companyId);
  const after = store.getPreanalysisCache(cacheKey);
  p(`  删除前缓存存在：${before}`);
  p(`  删除公司「${company.name}」后缓存存在：${Boolean(after)}（已联动释放）`);
  p();

  p('════════════════════════════════════════════');
  p('端到端演示完成 ✅（全程规则兜底 + 本地档案，无外部依赖）');
  return { out: out.join('\n'), summary, store };
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  await runDemo();
}
