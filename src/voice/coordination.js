// 语音会话编排层：把实时语音链路与面试官/复盘教练串成闭环。
//   - 预分析七大层 → 浓缩 System Prompt（≤2K 字符，注入豆包 StartSession）
//   - ASR 文本 → 喂给面试官 session（信号提取 + 动态追问）
//   - ChatResponse 文本 → 回写 session（面试官发言采集）
//   - 通话结束 → 触发复盘教练（全记忆），报告引用 executionTrace
import crypto from 'node:crypto';
import { generatePlan } from '../preanalysis/engine.js';
import { createSession, startInterview, nextQuestion, closeInterview, getSessionSummary } from '../interviewer/index.js';
import { prepareRound2Context } from '../interviewer/rounds.js';
import { reviewWithMemory } from '../coach/memory.js';

const MAX_SYSTEM_PROMPT_CHARS = 2000;

function roundLabel(roundKey) {
  return roundKey === 'round1' ? '一面简历面' : roundKey === 'round2' ? '二面业务面' : '三面总监交叉面';
}

function compactJson(value, max = 400) {
  const text = JSON.stringify(value ?? {});
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * 从预分析七大层生成浓缩 System Prompt（≤2K 字符）：
 * ③本轮人设 + ②候选人画像 + ①JD 要点 + ④本轮考察策略 + ⑤风险预判 + ⑦节奏体验。
 */
export function buildInterviewerSystemPrompt({ preanalysisPlan, roundKey, resumeProfile, jobProfile }) {
  const layers = preanalysisPlan?.layers;
  if (!layers) return null;
  const persona = layers.interviewerPersona?.[roundKey] ?? null;
  const strategy = layers.roundStrategy?.[roundKey] ?? null;
  const rhythm = layers.rhythmDesign?.[roundKey] ?? null;
  const cp = layers.candidateProfile ?? null;
  const jd = layers.jdAnalysis ?? null;
  const rf = layers.riskForecast ?? null;

  const chains = Array.isArray(strategy?.followupChains)
    ? strategy.followupChains.slice(0, 3).map((c) => ({
        dimension: c.dimension,
        keyQuestions: (c.keyQuestions ?? []).slice(0, 2),
      }))
    : [];

  const parts = [
    `你是${persona?.identity ?? '面试官'}，正在进行${roundLabel(roundKey)}。`,
    jobProfile?.companyName ? `目标公司：${jobProfile.companyName}` : '',
    persona?.background ? `背景：${persona.background}` : '',
    persona?.style ? `风格：${persona.style}` : '',
    persona?.focus ? `关注核心：${persona.focus}` : '',
    persona?.bias ? `偏好预判：${persona.bias}` : '',
    persona?.killerQuestions?.length ? `杀手锏问题：${persona.killerQuestions.slice(0, 2).join('；')}` : '',
    cp ? `候选人画像：${compactJson({ highlights: cp.highlights, weaknesses: cp.weaknesses, skillDepth: cp.skillDepth, likelyStuck: cp.likelyStuck })}` : '',
    jd ? `JD 要点：${compactJson({ roleNature: jd.roleNature, level: jd.level, coreResponsibilities: jd.coreResponsibilities, redLines: jd.redLines })}` : '',
    chains.length ? `本场考察策略：${compactJson({ dimensions: strategy.dimensions, followupChains: chains })}` : '',
    rf ? `风险预判：${compactJson({ likelyStuck: rf.likelyStuck?.slice(0, 2), exaggerationPoints: rf.exaggerationPoints?.slice(0, 1) })}` : '',
    rhythm ? `节奏与体验：${rhythm.curve}；时长与问题数：${rhythm.durationAndCount}` : '',
    '要求：一次只问一个问题；先简短回应候选人再追问；回答卡壳时降一档难度，偏题时先拉回；口语自然，不书面化、不列要点。',
  ].filter(Boolean);

  let prompt = parts.join('\n');
  if (prompt.length > MAX_SYSTEM_PROMPT_CHARS) {
    prompt = prompt.slice(0, MAX_SYSTEM_PROMPT_CHARS);
  }
  return prompt;
}

function makeJobProfile(position, company) {
  return {
    companyName: company?.name ?? position.companyName ?? '',
    title: position.title ?? '目标岗位',
    jobType: position.jobType ?? 'tech',
    responsibilities: position.profile?.responsibilities ?? [],
    requirements: position.profile?.requirements ?? [],
    keywords: position.profile?.keywords ?? [],
  };
}

/**
 * 创建一场语音面试会话：
 * 读取档案库（公司/岗位/最新简历版本）→ 生成预分析（缓存命中或 LLM/规则兜底）→
 * 组装 roundContext（二面）→ 创建面试官 session 并开场。
 */
export async function createVoiceInterviewSession({
  store,
  llm = null,
  search = null,
  companyId,
  positionId,
  roundKey = 'round1',
  maxDepth = 3,
}) {
  const company = store?.getCompany(companyId);
  const position = store?.getPosition(companyId, positionId);
  const resumeVersion = store?.getLatestResumeVersion();
  if (!company || !position || !resumeVersion) {
    throw new Error('缺少公司/岗位/简历版本，无法开始语音面试');
  }

  const { plan } = await generatePlan({ resumeVersion, company, position, llm, store });
  let roundContext = null;
  if (roundKey === 'round2') {
    roundContext = await prepareRound2Context({ store, search, companyId, positionId });
  }

  const session = createSession({
    resumeProfile: resumeVersion.profile ?? {},
    jobProfile: makeJobProfile(position, company),
    roundKey,
    maxDepth,
    llm: null, // 语音链路中面试官本体走实时语音模型；文本路径仅做记录与决策兜底
    roundContext,
    preanalysisPlan: plan,
  });
  await startInterview(session);

  const systemPrompt = buildInterviewerSystemPrompt({
    preanalysisPlan: plan,
    roundKey,
    resumeProfile: resumeVersion.profile ?? {},
    jobProfile: makeJobProfile(position, company),
  });
  const persona = plan.layers.interviewerPersona?.[roundKey] ?? {};
  const rhythm = plan.layers.rhythmDesign?.[roundKey] ?? {};
  const config = {
    botName: (persona.identity ?? `${roundLabel(roundKey)}面试官`).slice(0, 20),
    systemRole: systemPrompt,
    speakingStyle: rhythm.pressureGradient
      ? `口语自然，节奏${rhythm.curve}；一次只问一个问题，像真人面试官一样说话。`
      : '口语自然，像真人面试官一样说话；一次只问一个问题，不书面化。',
    model: '1.2.1.1',
  };

  return {
    sessionKey: crypto.randomUUID(),
    session,
    preanalysisPlan: plan,
    config,
    company,
    position,
    resumeVersion,
  };
}

/** ASR 文本回写：作为候选人回答喂给面试官 session（信号提取 + 动态决策），返回下一问题。 */
export function handleAsrText(session, text) {
  if (!session || session.state === 'closed' || typeof text !== 'string' || !text.trim()) return null;
  return nextQuestion(session, text);
}

/** ChatResponse 文本采集：把面试官（实时语音模型）发言记录到 session，供复盘引用。 */
export function collectChatResponse(session, text) {
  if (!session || typeof text !== 'string' || !text.trim()) return null;
  const last = session.turns[session.turns.length - 1];
  if (last?.role === 'interviewer' && last.content === text) return null;
  session.turns.push({
    role: 'interviewer',
    content: text,
    focusArea: null,
    intent: null,
    mainlineId: session.currentMainlineId ?? null,
    adjustment: null,
    turnNo: session.turns.length + 1,
    askedAt: Date.now(),
  });
  return text;
}

/** 通话结束：正式收尾并触发复盘教练（全记忆），返回复盘结果与会话摘要。 */
export async function finishVoiceSession({
  store,
  llm = null,
  session,
  companyId,
  positionId,
  roundKey,
  reply = null,
  resumeVersionId = null,
}) {
  await closeInterview(session);
  const review = await reviewWithMemory(session, {
    store,
    companyId,
    positionId,
    roundKey,
    llm,
    reply,
    resumeVersionId,
  });
  return { review, summary: getSessionSummary(session) };
}

/**
 * 创建语音会话编排器（供 bridge 挂载）：
 *   start({ companyId, positionId, roundKey }) → { sessionKey, config }
 *   handleAsr(sessionKey, text) / collectChat(sessionKey, text)
 *   finish(sessionKey) / getReport(sessionKey) / getSessionInfo(sessionKey) / getConfig(sessionKey)
 */
export function createVoiceCoordination({ store, llm = null, search = null, log = console } = {}) {
  const sessions = new Map(); // sessionKey -> { session, companyId, positionId, roundKey, config }
  const reports = new Map(); // sessionKey -> review result
  const finishing = new Map(); // sessionKey -> in-flight finish promise（防并发重复收尾/复盘）

  return {
    async start({ companyId, positionId, roundKey = 'round1' }) {
      const created = await createVoiceInterviewSession({ store, llm, search, companyId, positionId, roundKey });
      sessions.set(created.sessionKey, {
        session: created.session,
        companyId,
        positionId,
        roundKey,
        config: created.config,
        resumeVersionId: created.resumeVersion?.versionId ?? null,
      });
      log.info?.(`[voice] 语音会话已创建 ${created.sessionKey}（${companyId}/${positionId}/${roundKey}）`);
      return { sessionKey: created.sessionKey, config: created.config };
    },

    getConfig(sessionKey) {
      return sessions.get(sessionKey)?.config ?? null;
    },

    handleAsr(sessionKey, text) {
      const entry = sessions.get(sessionKey);
      if (!entry) return null;
      return handleAsrText(entry.session, text);
    },

    collectChat(sessionKey, text) {
      const entry = sessions.get(sessionKey);
      if (!entry) return null;
      return collectChatResponse(entry.session, text);
    },

    async finish(sessionKey) {
      const entry = sessions.get(sessionKey);
      if (!entry) return null;
      if (reports.has(sessionKey)) return reports.get(sessionKey);
      if (finishing.has(sessionKey)) return finishing.get(sessionKey);
      const promise = finishVoiceSession({
        store,
        llm,
        session: entry.session,
        companyId: entry.companyId,
        positionId: entry.positionId,
        roundKey: entry.roundKey,
        resumeVersionId: entry.resumeVersionId,
      })
        .then((result) => {
          reports.set(sessionKey, result);
          log.info?.(`[voice] 语音会话复盘完成 ${sessionKey}`);
          return result;
        })
        .finally(() => {
          finishing.delete(sessionKey);
        });
      finishing.set(sessionKey, promise);
      return promise;
    },

    getReport(sessionKey) {
      return reports.get(sessionKey) ?? null;
    },

    getSessionInfo(sessionKey) {
      const entry = sessions.get(sessionKey);
      if (!entry) return null;
      return {
        roundKey: entry.roundKey,
        companyId: entry.companyId,
        positionId: entry.positionId,
        summary: getSessionSummary(entry.session),
      };
    },
  };
}
