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
import { analyzeRhythm, buildDifficultyReport } from '../coach/rhythm.js';
import { ROUND_KEYS } from '../archive/constants.js';

const MAX_SYSTEM_PROMPT_CHARS = 2000;
const SILENCE_THRESHOLD_MS = 10000; // 困难点标注：沉默超时阈值 ≥10s

function roundLabel(roundKey) {
  return roundKey === 'round1' ? '一面简历面' : roundKey === 'round2' ? '二面业务面' : '三面总监交叉面';
}

/**
 * 构造一条"准备好的面试"：公司+岗位+各轮次练习情况，供浏览器一键开始。
 */
function buildReadyItem({ store, company, position, appliedAt = null, resumeVersionNo = null }) {
  const reviews = store.listReviews({ companyId: company.companyId, positionId: position.positionId });
  const rounds = ROUND_KEYS.map((roundKey) => {
    const rs = reviews.filter((r) => r.roundKey === roundKey);
    return {
      roundKey,
      label: roundLabel(roundKey),
      practicedCount: rs.length,
      lastPracticedAt: rs[0]?.createdAt ?? null,
    };
  });
  return {
    companyId: company.companyId,
    companyName: company.name,
    positionId: position.positionId,
    positionTitle: position.title,
    jobType: position.jobType ?? 'tech',
    appliedAt,
    resumeVersionNo,
    rounds,
  };
}

function compactJson(value, max = 400) {
  const text = JSON.stringify(value ?? {});
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * 从预分析七大层生成浓缩 System Prompt（≤2K 字符）：
 * ③本轮人设 + ②候选人画像 + ①JD 要点 + ④本轮考察策略（含跨轮去重）+ ⑤风险预判（含跨轮风险传递）+ ⑦节奏体验。
 * 组装顺序：全局层（①②⑤）→ 轮次层（③④⑦）→ 当次数据（跨轮去重清单）。
 * ①-⑤层只源于简历+JD 推导，不含历次练习转写（面试官失忆原则）。
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

  // ④层跨轮去重清单：本场不重复上一轮已问的问题（计划层，非历次练习记忆）
  const dedupList = Array.isArray(strategy?.dedupList) ? strategy.dedupList : [];
  // ⑤层跨轮风险传递：一面暴露的问题→二面跟进验证（计划层，非历次练习记忆）
  const crossRoundRisks = Array.isArray(rf?.crossRoundRisks) ? rf.crossRoundRisks : [];

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
    // ⑤层跨轮风险传递（计划层）：本轮需跟进验证的风险
    crossRoundRisks.length ? `跨轮风险跟进：${crossRoundRisks.slice(0, 2).map((r) => `${r.risk}（${r.followupRound}）`).join('；')}` : '',
    // ④层跨轮去重清单（当次数据）：本轮不重复上轮已问的问题
    dedupList.length ? `跨轮去重：${dedupList.slice(0, 3).join('；')}` : '',
    rhythm ? `节奏与体验：${rhythm.curve}；时长与问题数：${rhythm.durationAndCount}` : '',
    // 动态调整指令（计划是基线不是脚本）
    '动态调整：候选人展现意外深度→延伸追问到能力边界；暴露新弱点→临时插入追问；严重卡壳→降一档难度并调用救援策略；与简历矛盾→切换验证模式追问到底；主动引导到擅长领域→先展示再施压测上限。每条追问链最多降档1次，换线需2个信号叠加。',
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
  // P1：语音时间戳追踪——用于表达节奏分析（语速/停顿/沉默）与困难点标记
  session.voiceMeta = {
    asrEvents: [], // { text, arrivedAt, charCount }
    chatEvents: [], // { content, arrivedAt }
    silencePeriods: [], // { from, to, durationMs }
    difficultyMarkers: [], // { questionIndex, category, question, answerSummary, notes }
    lastChatAt: null, // 上次面试官发言时间（用于计算沉默时长）
  };
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

/** ASR 文本回写：作为候选人回答喂给面试官 session（信号提取 + 动态决策），返回下一问题与注入决策。 */
export async function handleAsrText(session, text) {
  if (!session || session.state === 'closed' || typeof text !== 'string' || !text.trim()) return null;
  const now = Date.now();
  const meta = session.voiceMeta;
  if (meta) {
    // P1：记录 ASR 到达时间戳，用于表达节奏分析
    meta.asrEvents.push({ text, arrivedAt: now, charCount: text.length });
    // P1：沉默检测——若距上次面试官发言 >10s，记录沉默期
    if (meta.lastChatAt && now - meta.lastChatAt > SILENCE_THRESHOLD_MS) {
      meta.silencePeriods.push({
        from: meta.lastChatAt,
        to: now,
        durationMs: now - meta.lastChatAt,
      });
    }
  }
  const result = await nextQuestion(session, text);
  if (!result) return null;
  // P1：困难点当场标注——基于实时信号判定四分类
  if (meta) {
    const marker = detectDifficultyMarker(session, text, result);
    if (marker) meta.difficultyMarkers.push(marker);
  }
  // 构建动态调整注入决策（仅在显著调整时注入，避免过度干预自然对话）
  const injection = buildAdjustmentInjection(result, session);
  return { ...result, injection };
}

/**
 * P1：困难点四分类当场标注。
 * 基于候选人回答文本 + 本轮信号判定，附在 session.voiceMeta.difficultyMarkers。
 * 分类：noAnswer（未回答上来）/ offTopic（答偏跑题）/ silence（沉默超时）/ shallow（回答浅薄）
 */
function detectDifficultyMarker(session, text, result) {
  const lastSignal = session.signals?.[session.signals.length - 1]?.signals ?? null;
  const lastInterviewerTurn = [...session.turns].reverse().find((t) => t.role === 'interviewer');
  const question = lastInterviewerTurn?.content ?? '';
  const questionIndex = session.turns.filter((t) => t.role === 'interviewer').length;

  // 1. 未回答上来：明确表示不会 / 极短回答
  const noAnswerPatterns = /^(不知道|不会|没想过|不了解|不清楚|说不出来|答不上)/;
  if (noAnswerPatterns.test(text.trim()) || text.trim().length < 4) {
    return { questionIndex, category: 'noAnswer', question, answerSummary: text.slice(0, 80), notes: '候选人明确表示不会或回答极短' };
  }
  // 2. 答偏跑题：信号 direction=off_topic
  if (lastSignal?.direction === 'off_topic') {
    return { questionIndex, category: 'offTopic', question, answerSummary: text.slice(0, 80), notes: '回答偏离问题核心' };
  }
  // 3. 沉默超时：沉默期已记录（>10s）
  const meta = session.voiceMeta;
  if (meta?.silencePeriods?.length) {
    const lastSilence = meta.silencePeriods[meta.silencePeriods.length - 1];
    if (lastSilence && lastSilence.to > (meta.asrEvents[meta.asrEvents.length - 2]?.arrivedAt ?? 0)) {
      return { questionIndex, category: 'silence', question, answerSummary: text.slice(0, 80), notes: `沉默 ${Math.round(lastSilence.durationMs / 1000)}s 后才回答` };
    }
  }
  // 4. 回答浅薄：信号 depth=shallow
  if (lastSignal?.depth === 'shallow') {
    return { questionIndex, category: 'shallow', question, answerSummary: text.slice(0, 80), notes: '回答缺乏细节、泛泛而谈' };
  }
  return null;
}

/**
 * 根据本地协调层的动态决策，构建 ChatRAGText 注入指引。
 * 仅在显著调整（拉回/降档/换线/严重卡壳）时注入——这些场景需要主动引导面试官回应方向；
 * 正常流程（继续/深挖）不注入，保留实时语音模型的自然对话感。
 *
 * 注入时机说明：ASR(451) 到达后立刻发送 ChatRAGText(502)，尽力在模型生成 LLM(550)
 * 前注入；即便时序紧、当轮未生效，executionTrace 仍完整记录信号与决策供复盘教练消费。
 */
function buildAdjustmentInjection(result, session) {
  const adjustment = result.adjustment ?? null;
  const lastSignal = session.signals?.[session.signals.length - 1]?.signals ?? null;
  if (!adjustment && !lastSignal) return null;

  // 换线：候选人在当前维度严重卡壳或偏题+浅薄，需要切换到下一条追问链
  if (adjustment === 'switch-line') {
    return [
      {
        title: '面试官调整提示',
        content: `候选人在当前维度严重卡壳/偏题，已切换到下一条考察线。请自然过渡："我们换个角度来聊。"然后提出下一个问题。`,
      },
    ];
  }
  // 拉回：候选人回答偏题，需要拉回主线
  if (adjustment === 'pull-back') {
    return [
      {
        title: '面试官调整提示',
        content: `候选人刚才的回答偏离了问题核心。请温和拉回："我们回到刚才的问题。"然后换个角度重新提问。`,
      },
    ];
  }
  // 降档：候选人卡壳（流畅度差/难度高），需要降低难度
  if (adjustment === 'level-down') {
    return [
      {
        title: '面试官调整提示',
        content: `候选人刚才回答比较吃力（卡壳/难度偏高）。请降一档难度，换个更简单的角度引导："没关系，我们换个更基础的角度说说。"`,
      },
    ];
  }
  // 无 adjustment 但信号显示严重卡壳（difficulty=high + fluency=poor）→ 救援
  if (lastSignal && lastSignal.difficulty === 'high' && lastSignal.fluency === 'poor') {
    return [
      {
        title: '面试官救援提示',
        content: `候选人严重卡壳。请给予鼓励并降低难度："没关系，这个确实比较难，我们换个角度想想。"避免连续施压导致全程崩盘。`,
      },
    ];
  }
  return null;
}

/** ChatResponse 文本采集：把面试官（实时语音模型）发言记录到 session，供复盘引用。 */
export function collectChatResponse(session, text) {
  if (!session || typeof text !== 'string' || !text.trim()) return null;
  const last = session.turns[session.turns.length - 1];
  if (last?.role === 'interviewer' && last.content === text) return null;
  const now = Date.now();
  session.turns.push({
    role: 'interviewer',
    content: text,
    focusArea: null,
    intent: null,
    mainlineId: session.currentMainlineId ?? null,
    adjustment: null,
    turnNo: session.turns.length + 1,
    askedAt: now,
  });
  // P1：记录面试官发言时间戳，用于沉默检测与节奏分析
  const meta = session.voiceMeta;
  if (meta) {
    meta.chatEvents.push({ content: text, arrivedAt: now });
    meta.lastChatAt = now;
  }
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
  // P1：通话结束后生成表达节奏分析 + 困难点报告，附入 session 供复盘教练消费
  const meta = session.voiceMeta;
  if (meta) {
    session.rhythmAnalysis = analyzeRhythm(session);
    session.difficultyReport = buildDifficultyReport(meta.difficultyMarkers, meta.silencePeriods);
    // 困难点报告写入 session 供复盘教练的 difficultQuestions 消费（困难点沉淀闭环）
    if (meta.difficultyMarkers.length && !session.difficultQuestions) {
      session.difficultQuestions = meta.difficultyMarkers.map((m) => ({
        category: m.category,
        question: m.question,
        answerSummary: m.answerSummary,
        notes: m.notes,
      }));
    }
  }
  const review = await reviewWithMemory(session, {
    store,
    companyId,
    positionId,
    roundKey,
    llm,
    reply,
    resumeVersionId,
  });
  return { review, summary: getSessionSummary(session), rhythm: session.rhythmAnalysis ?? null, difficultyReport: session.difficultyReport ?? null };
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
    /**
     * 列出"准备好的面试"：投递快照 + 各轮次练习情况，供浏览器一键开始。
     * 没有投递时退而列出所有公司+岗位（用最新简历版本练）。
     * latest 指向最近一次有复盘的轮次，没有复盘就默认 round1。
     */
    ready() {
      const items = [];
      const applications = store.listApplications();
      for (const app of applications) {
        const company = store.getCompany(app.companyId);
        const position = store.getPosition(app.companyId, app.positionId);
        if (!company || !position) continue;
        items.push(
          buildReadyItem({
            store,
            company,
            position,
            appliedAt: app.submittedAt,
            resumeVersionNo: app.resumeVersionNo,
          }),
        );
      }
      // 没有投递：列出所有公司+岗位（用最新简历版本练）
      if (!items.length) {
        for (const company of store.listCompanies()) {
          for (const position of store.listPositions(company.companyId)) {
            items.push(buildReadyItem({ store, company, position }));
          }
        }
      }
      let latest = null;
      const allReviews = store.listReviews();
      if (allReviews.length) {
        const r = allReviews[0];
        latest = { companyId: r.companyId, positionId: r.positionId, roundKey: r.roundKey };
      } else if (items.length) {
        latest = { companyId: items[0].companyId, positionId: items[0].positionId, roundKey: 'round1' };
      }
      return { items, latest };
    },

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

    async handleAsr(sessionKey, text) {
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
