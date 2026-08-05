// 面试官规则兜底：无 LLM 时也能生成开场白、追问与收尾。
// 模板按 岗位类型 × 追问深度 组织，方向由 jobType 驱动（方案书 §5.4）。
// 联网调研最佳实践：一次只问一个问题、追问方向由岗位类型驱动、深度递进（广度→深度→应用）。

// 从简历经历里挑第一条做项目深挖素材
function pickExperience(resumeProfile) {
  const exps = resumeProfile?.experiences ?? [];
  return exps[0] ?? null;
}

// 从技能里挑第一个做八股素材
function pickSkill(resumeProfile) {
  const skills = resumeProfile?.skills ?? [];
  return skills[0] ?? null;
}

// 从 JD 职责里挑第一条
function pickResponsibility(jobProfile) {
  return (jobProfile?.responsibilities ?? [])[0] ?? null;
}

// 追问策略池：[depth0, depth1, depth2]，方向由岗位类型驱动。
// 每层 build(ctx) 从简历/JD 画像动态提取素材，保证问题不空泛。
const FOLLOWUP_STRATEGIES = {
  tech: [
    {
      focus: '项目深挖',
      intent: '验证项目真实性与技术深度',
      build: (ctx) => {
        const exp = pickExperience(ctx.resumeProfile);
        return exp
          ? `你在简历里提到"${exp.summary}"，能具体讲讲这个项目里你负责的技术方案吗？遇到最大的技术难点是什么，怎么解决的？`
          : '挑一个你最熟悉的项目，讲讲你在其中的技术方案和遇到的难点。';
      },
    },
    {
      focus: '技术原理',
      intent: '考察基础知识扎实度',
      build: (ctx) => {
        const skill = pickSkill(ctx.resumeProfile);
        return skill
          ? `你简历里写了熟悉${skill.name}，能讲讲它的底层原理吗？比如它在高并发场景下会有什么瓶颈？`
          : '挑一个你最熟悉的中间件，讲讲它的底层原理和适用场景。';
      },
    },
    {
      focus: '系统设计',
      intent: '考察架构能力与技术选型',
      build: (ctx) => {
        const resp = pickResponsibility(ctx.jobProfile);
        return resp
          ? `假设让你负责"${resp}"这件事，你会怎么设计这套系统的架构？关键的技术选型有哪些考虑？`
          : '给你一个高并发场景，你会怎么设计系统架构？说说你的技术选型思路。';
      },
    },
  ],
  product: [
    {
      focus: '场景设计',
      intent: '考察产品 sense 与需求拆解',
      build: (ctx) => {
        const resp = pickResponsibility(ctx.jobProfile);
        return resp
          ? `如果让你来负责"${resp}"，你会怎么定义这个产品的核心场景和目标用户？`
          : '给你一个全新的产品方向，你会怎么从 0 到 1 拆解需求？';
      },
    },
    {
      focus: '取舍决策',
      intent: '考察判断力与优先级意识',
      build: () => '如果业务方要求同时做三个功能但资源只够做一个，你怎么排优先级？说说你的决策框架。',
    },
    {
      focus: '数据验证',
      intent: '考察数据驱动思维',
      build: () => '你设计了一个新功能，上线前怎么定指标、上线后怎么用数据验证它是否达到了预期？',
    },
  ],
  operation: [
    {
      focus: '案例分析',
      intent: '考察运营方法论与实操经验',
      build: (ctx) => {
        const exp = pickExperience(ctx.resumeProfile);
        return exp
          ? `你提到"${exp.summary}"，能讲讲这次运营活动的设计思路吗？核心指标和最终效果如何？`
          : '讲一个你做过最有成就感的运营案例，重点说说你的策略和效果。';
      },
    },
    {
      focus: '数据指标',
      intent: '考察数据拆解能力',
      build: () => '如果目标是把某个核心指标提升 30%，你会怎么拆解这个目标？关键路径是什么？',
    },
    {
      focus: '执行落地',
      intent: '考察资源协调与执行细节',
      build: () => '给你一个目标但预算和人力都有限，你会怎么排兵布阵保证落地？',
    },
  ],
  sales: [
    {
      focus: '客户拓展',
      intent: '考察获客方法论',
      build: () => '面对一个全新的市场，你会怎么搭建获客渠道？前三个月的节奏怎么安排？',
    },
    {
      focus: '异议处理',
      intent: '考察临场应对与沟通',
      build: () => '客户对你的报价提出异议，说竞品便宜 20%，你会怎么应对？',
    },
    {
      focus: '业绩达成',
      intent: '考察目标拆解与执行',
      build: () => '给你一个年度业绩目标，你会怎么拆解到季度、月度，怎么保证团队执行到位？',
    },
  ],
  function: [
    {
      focus: '行为面试',
      intent: '用 STAR 考察过往经历',
      build: (ctx) => {
        const exp = pickExperience(ctx.resumeProfile);
        return exp
          ? `你提到"${exp.summary}"，能用 STAR 方法（情境-任务-行动-结果）详细讲讲这段经历吗？`
          : '讲一个你主导过的项目，用 STAR 方法说说你在其中的角色和成果。';
      },
    },
    {
      focus: '动机匹配',
      intent: '考察职业动机与岗位匹配',
      build: (ctx) => `为什么选择我们公司的${ctx.jobProfile?.title ?? '这个岗位'}？你觉得自己的哪些特质适合？`,
    },
    {
      focus: '压力应对',
      intent: '考察抗压与情绪管理',
      build: () => '讲一次你在工作中遇到的最大挫折，你是怎么走出来的？学到了什么？',
    },
  ],
  civil: [
    {
      focus: '政策理解',
      intent: '考察政策把握与理论功底',
      build: () => '请谈谈你对当前某项重点政策的理解，它对基层工作有什么影响？',
    },
    {
      focus: '情景处置',
      intent: '考察应急反应与群众工作能力',
      build: () => '假设你负责一项群众工作，遇到突发矛盾冲突，你会怎么处置？',
    },
    {
      focus: '价值观',
      intent: '考察价值取向与责任意识',
      build: () => '你怎么理解"为民服务"？举一个你坚持原则的经历。',
    },
  ],
};

// 默认策略（未识别的 jobType 走通用行为面试）
const DEFAULT_STRATEGY = [
  { focus: '经历深挖', intent: '验证经历真实性', build: (ctx) => { const e = pickExperience(ctx.resumeProfile); return e ? `你提到"${e.summary}"，能详细讲讲吗？` : '介绍一下你最有代表性的一段经历。'; } },
  { focus: '岗位匹配', intent: '考察岗位理解', build: (ctx) => `你怎么理解${ctx.jobProfile?.title ?? '这个岗位'}的核心职责？` },
  { focus: '综合素质', intent: '考察综合判断', build: () => '讲一个你需要综合判断做决策的经历。' },
];

function getStrategy(jobType) {
  return FOLLOWUP_STRATEGIES[jobType] ?? DEFAULT_STRATEGY;
}

// 开场白按轮次定位（方案书 §5.4：一面简历面 / 二面业务面 / 三面终面）
const ROUND_INTROS = {
  round1: '我看过你的简历，对你申请的这个岗位很感兴趣，我们先聊聊你的经历。',
  round2: '前面一面同事已经和你聊过基础情况，今天我们重点聊聊业务和项目层面的东西。',
  round3: '前两面的反馈都不错，今天我们聊聊更宏观的一些话题，看看你的整体素质。',
};

// 开场白首个问题：破冰为主（自我介绍/经历概述），不占用追问策略层。
// 追问策略层 strategy[0..2] 留给 3 轮追问，避免开场白与第 1 轮追问重复。
function firstQuestionByRules(ctx) {
  const exp = pickExperience(ctx.resumeProfile);
  const question = exp
    ? `先简单做个自我介绍吧，重点聊聊你在${exp.org ?? '最近一家公司'}的经历。`
    : '先简单做个自我介绍吧。';
  return { question, focusArea: '破冰', intent: '了解候选人背景与表达' };
}

// 规则兜底：生成开场白 + 首个问题
export function openingByRules({ resumeProfile, jobProfile, roundKey }) {
  const name = resumeProfile?.basics?.name || '候选人';
  const title = jobProfile?.title || '该岗位';
  const intro = ROUND_INTROS[roundKey] ?? ROUND_INTROS.round1;
  const first = firstQuestionByRules({ resumeProfile, jobProfile });
  return {
    greeting: `${name}你好，我是今天的面试官，应聘${title}岗位。${intro}`,
    question: first.question,
    focusArea: first.focusArea,
    intent: first.intent,
  };
}

// 规则兜底：生成追问（根据当前 depth 选策略层，深度递进）
export function followupByRules(session, candidateAnswer) {
  const strategy = getStrategy(session.jobType);
  const idx = Math.min(session.depth - 1, strategy.length - 1);
  const s = strategy[idx];
  return {
    acknowledgment: ackByRules(candidateAnswer),
    question: s.build(session),
    focusArea: s.focus,
    intent: s.intent,
  };
}

// 规则兜底：生成收尾
export function closingByRules(session) {
  return {
    acknowledgment: '好的，我了解了。',
    question: '今天的面试就到这里，你有什么想问我的吗？',
    focusArea: '收尾',
    intent: '给候选人提问机会',
  };
}

// 根据回答长度生成简短回应（模拟面试官倾听反馈）
function ackByRules(answer) {
  if (!answer || answer.length < 10) return '嗯，我记下了。';
  if (answer.length > 100) return '你讲得比较详细，我理解了你的思路。';
  return '好的，我了解了。';
}
