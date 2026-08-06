// Gateway 命令处理器：把 App 聊天指令翻译成 onboarding / interviewer / coach 调用。
// 每个 handler 返回 { intent, reply, data }，reply 为 App 聊天 UI 直接可读的中文文本。

import { handleResumeUpload, handleJdPaste, handleApply, parseApplyCommand } from '../onboarding/index.js';
import { formatReport, getQuestions, recommendByWeakness } from '../coach/index.js';
import { ROUND_KEYS } from '../archive/constants.js';

const ROUND_LABEL = {
  round1: '一面简历面',
  round2: '二面业务面',
  round3: '三面总监交叉面',
};

function summaryOfProfile(profile = {}) {
  const basics = profile.basics ?? {};
  const skills = (profile.skills ?? []).slice(0, 6).map((s) => s.name).filter(Boolean);
  const experiences = (profile.experiences ?? []).slice(0, 3).map((e) => e.summary).filter(Boolean);
  const lines = [
    basics.name ? `姓名：${basics.name}` : '',
    basics.title ? `意向：${basics.title}` : '',
    skills.length ? `技能：${skills.join('、')}` : '',
    experiences.length ? `经历：${experiences.join('；')}` : '',
  ].filter(Boolean);
  return lines.join('\n') || '（规则兜底未提取到画像字段）';
}

function resolveCompany(store, text = '') {
  const m = text.match(/(?:在|到|投给|投递到)?\s*([\u4e00-\u9fa5A-Za-z0-9·]+?公司)/);
  if (m) {
    const exact = store.findCompanyByName(m[1]);
    if (exact) return exact;
    const fuzzy = store
      .listCompanies()
      .filter((c) => c.name.includes(m[1]) || m[1].includes(c.name));
    if (fuzzy.length === 1) return fuzzy[0];
    if (fuzzy.length > 1) {
      throw new Error(`「${m[1]}」匹配到多家公司，请写完整公司名`);
    }
  }
  const focus = store.listCompanies().find((c) => c.focus);
  if (focus) return focus;
  const companies = store.listCompanies();
  if (companies.length === 1) return companies[0];
  if (companies.length > 1) {
    throw new Error(`有 ${companies.length} 家公司，请指定：在 XX公司 开始一面`);
  }
  throw new Error('还没有公司档案，请先粘贴 JD');
}

function resolvePosition(store, company, text = '') {
  const positions = store.listPositions(company.companyId);
  if (!positions.length) throw new Error(`「${company.name}」还没有岗位，请先粘贴 JD`);
  const m = text.match(/([\u4e00-\u9fa5A-Za-z0-9·+]+?(?:工程师|开发|产品|运营|经理|专员|设计师|岗))/);
  const title = m?.[1] ?? null;
  if (!title) {
    if (positions.length === 1) return positions[0];
    throw new Error(`「${company.name}」有多个岗位（${positions.map((p) => p.title).join('、')}），请指定岗位`);
  }
  const hits = positions.filter((p) => p.title.includes(title) || title.includes(p.title));
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) throw new Error(`岗位「${title}」匹配到多个，请用完整岗位名`);
  throw new Error(`没有找到岗位「${title}」，该公司岗位：${positions.map((p) => p.title).join('、')}`);
}

function parseRoundKey(text = '') {
  if (/三面|第3面|第三面/.test(text)) return 'round3';
  if (/二面|第2面|第二面/.test(text)) return 'round2';
  return 'round1';
}

export function handleHelpCommand() {
  const commands = [
    '上传简历：上传简历\n（后跟简历全文）',
    '粘贴 JD：粘贴 JD\n（后跟岗位描述全文）',
    '投递：投递到 公司名 [岗位名]，可带版本「投递 v2 到 XX公司」',
    '开始一面 / 二面 / 三面：如「在 星辰科技 开始一面」',
    '复盘报告：查看最近一场复盘',
    '困难题 / 高频题：查看重练清单与高频题',
    '状态：查看档案概览',
    '离线：查看离线发件箱',
  ];
  return {
    intent: 'help',
    reply: `我是 InterviewPal 网关助手，可以这样用：\n${commands.map((c) => `• ${c}`).join('\n')}`,
    data: { commands },
  };
}

export async function handleUploadResumeCommand({ store, llm, search, text }) {
  const content = text
    .replace(/^(?:请)?(?:帮我)?(?:上传|粘贴|添加)?\s*(?:简历|resume)\s*[:：]?\s*/i, '')
    .trim();
  if (!content) {
    return {
      intent: 'upload_resume',
      reply: '请把简历全文发给我，例如：\n上传简历\n张三，前端工程师，熟悉 React…',
      data: null,
    };
  }
  const result = await handleResumeUpload({ store, llm, search, content });
  const version = result.version;
  const profile = result.resumeProfile;
  return {
    intent: 'upload_resume',
    reply: [
      `简历已存档：v${version.versionNo}（${version.rawHash.slice(0, 8)}，${version.charCount} 字）`,
      summaryOfProfile(profile),
      '接下来可以「粘贴 JD」或直接「投递到 公司名」。',
    ].join('\n'),
    data: {
      resumeVersionId: version.versionId,
      resumeVersionNo: version.versionNo,
      profile: result.resumeProfile,
    },
  };
}

export async function handlePasteJdCommand({ store, llm, search, text }) {
  const content = text
    .replace(/^(?:请)?(?:帮我)?(?:粘贴|上传|添加)?\s*(?:JD|jd|岗位描述|职位描述|岗位职责)\s*[:：]?\s*/i, '')
    .trim();
  if (!content) {
    return {
      intent: 'paste_jd',
      reply: '请把岗位描述全文发给我，例如：\n粘贴 JD\n我们是星辰科技，招聘高级前端工程师…',
      data: null,
    };
  }
  const result = await handleJdPaste({ store, llm, search, jdText: content });
  const position = result.position;
  return {
    intent: 'paste_jd',
    reply: [
      `已建立岗位画像：${result.company.name} · ${position.title}`,
      `职责 ${(position.profile?.responsibilities ?? []).length} 条、要求 ${(position.profile?.requirements ?? []).length} 条`,
      '接下来可以「投递到 公司名」或「开始一面」。',
    ].join('\n'),
    data: {
      companyId: result.company.companyId,
      positionId: position.positionId,
      jobProfile: result.jobProfile,
    },
  };
}

export async function handleApplyCommand({ store, text }) {
  const args = parseApplyCommand(text);
  if (!args) {
    return {
      intent: 'apply',
      reply: '格式：投递到 公司名 [岗位名]，可指定版本，如「投递 v2 到 星辰科技 高级前端工程师」',
      data: null,
    };
  }
  const result = await handleApply({ store, text });
  const app = result.application;
  return {
    intent: 'apply',
    reply: [
      `已投递：${result.company.name} · ${result.position.title}`,
      `简历版本：v${result.version.versionNo}（投递即冻结）`,
      `快照：${app.resumeSnapshot.charCount} 字 · ${app.resumeSnapshot.hash.slice(0, 8)}`,
      '可以「开始一面」用这份终版简历模拟面试。',
    ].join('\n'),
    data: { application: app, company: result.company, position: result.position },
  };
}

export async function handleStartRoundCommand({ store, llm, search, coordination, text }) {
  const company = resolveCompany(store, text);
  const position = resolvePosition(store, company, text);
  const roundKey = parseRoundKey(text);
  if (!ROUND_KEYS.includes(roundKey)) throw new Error(`未知轮次：${roundKey}`);

  const resumeVersion = store.getLatestResumeVersion();
  if (!resumeVersion) throw new Error('还没有简历，请先上传简历');

  const session = await coordination.start({
    companyId: company.companyId,
    positionId: position.positionId,
    roundKey,
  });
  return {
    intent: 'start_round',
    reply: [
      `已创建 ${ROUND_LABEL[roundKey]}：${company.name} · ${position.title}`,
      `会话号：${session.sessionKey}`,
      `面试官：${session.config.botName}`,
      session.config.systemRole ? `System Prompt：${session.config.systemRole.slice(0, 120)}…` : '',
      'App Talk 模式可直接进入语音通话；文本模式下回复「下一题」继续。',
    ].join('\n'),
    data: {
      sessionKey: session.sessionKey,
      config: session.config,
      companyId: company.companyId,
      positionId: position.positionId,
      roundKey,
      resumeVersionId: resumeVersion.versionId,
    },
  };
}

export function handleReviewCommand({ store, text }) {
  const company = (() => {
    try {
      return resolveCompany(store, text);
    } catch {
      return null;
    }
  })();
  const reviews = company
    ? store.listReviews({ companyId: company.companyId })
    : store.listReviews();
  const review = reviews[0];
  if (!review) {
    return {
      intent: 'review',
      reply: company
        ? `「${company.name}」还没有复盘记录，先完成一场语音面试吧。`
        : '还没有复盘记录，先完成一场语音面试吧。',
      data: null,
    };
  }
  const position = store.getPosition(review.companyId, review.positionId);
  const report = formatReport(review, {
    session: {
      jobProfile: { title: position?.title ?? review.positionTitle ?? '' },
      roundKey: review.roundKey,
    },
  });
  return {
    intent: 'review',
    reply: `${report}\n\n（最近一场：${review.createdAt}）`,
    data: { review, companyId: review.companyId, positionId: review.positionId },
  };
}

export function handleDifficultCommand({ store, text }) {
  const company = (() => {
    try {
      return resolveCompany(store, text);
    } catch {
      return null;
    }
  })();
  const reviews = company
    ? store.listReviews({ companyId: company.companyId })
    : store.listReviews();
  const latest = reviews[0];
  const difficult = latest?.difficultQuestions ?? [];
  const jobType = latest ? store.getPosition(latest.companyId, latest.positionId)?.jobType ?? 'tech' : 'tech';
  const roundKey = latest?.roundKey ?? 'round1';

  if (/高频|题库|重练|recommend/i.test(text) && latest) {
    const recommended = recommendByWeakness(jobType, roundKey, latest.scores);
    return {
      intent: 'difficult',
      reply: [
        '【按弱项推荐重练】',
        ...recommended.map((q, i) => `${i + 1}. ${q.q}`),
        '——来源：最近复盘六维评分。',
      ].join('\n'),
      data: { recommended, scores: latest.scores },
    };
  }

  const bank = getQuestions(jobType, roundKey);
  const lines = [
    company ? `【${company.name} · ${ROUND_LABEL[roundKey]}】` : `【${ROUND_LABEL[roundKey]}】`,
  ];
  if (difficult.length) {
    lines.push('本场困难题（优先重练）：');
    difficult.forEach((q, i) => lines.push(`${i + 1}. ${q.question}（${q.tag ?? '未答'}）`));
  }
  lines.push('高频题：');
  bank.forEach((q, i) => lines.push(`${i + 1}. ${q.q}`));
  return {
    intent: 'difficult',
    reply: lines.join('\n'),
    data: { difficult, bank, jobType, roundKey },
  };
}

export function handleStatusCommand({ store, outbox = null }) {
  const companies = store.listCompanies();
  const resumeVersion = store.getLatestResumeVersion();
  const applications = store.listApplications();
  const reviews = store.listReviews();
  const lines = [
    '【InterviewPal 档案概览】',
    `公司：${companies.length} 家${companies.length ? `（${companies.map((c) => c.name).join('、')}）` : ''}`,
    `简历版本：${resumeVersion ? `v${resumeVersion.versionNo}（${resumeVersion.charCount} 字）` : '未上传'}`,
    `投递快照：${applications.length} 份`,
    `复盘记录：${reviews.length} 场`,
  ];
  if (outbox) {
    const stats = outbox.stats();
    lines.push(`离线发件箱：${stats.queued}/${stats.max} 条待补发`);
  }
  return {
    intent: 'status',
    reply: lines.join('\n'),
    data: {
      companies: companies.map((c) => c.name),
      resumeVersion: resumeVersion ? { versionNo: resumeVersion.versionNo } : null,
      applicationCount: applications.length,
      reviewCount: reviews.length,
    },
  };
}

export function handleOutboxCommand({ outbox }) {
  if (!outbox) {
    return { intent: 'outbox', reply: '离线发件箱未启用', data: null };
  }
  const stats = outbox.stats();
  const pending = outbox.pending();
  const lines = [
    `【离线发件箱】${stats.queued}/${stats.max} 条待补发（48 小时有效）`,
    ...pending.slice(-5).map((e) => `• ${e.createdAt} ${String(e.message).slice(0, 40)}`),
  ];
  return {
    intent: 'outbox',
    reply: lines.join('\n'),
    data: { stats, pending },
  };
}
