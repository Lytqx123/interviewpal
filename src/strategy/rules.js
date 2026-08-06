// 预分析规则兜底（方案书 §5.4 / 重构计划 R1）。
// LLM 不可用或输出不合法时，用双画像 + 岗位类型生成确定性的七层骨架，
// 保证无 key 也能产出合法结构（子维度数 ≥ 45）。

const ROUND_META = {
  round1: {
    focus: '简历面：验证经历真实性与基础，深挖项目细节',
    style: '温和逐步加压，一次只问一个问题',
    duration: '20-25 分钟',
    keyDimensions: ['逻辑结构', '专业深度'],
  },
  round2: {
    focus: '业务面：岗位匹配度、业务场景、项目深度与前沿探索',
    style: '业务场景带入，追问细节与取舍',
    duration: '25-30 分钟',
    keyDimensions: ['内容相关性', '专业深度'],
  },
  round3: {
    focus: '终面：价值观契合、抗压能力、职业规划与综合素质',
    style: '开放式综合面，考察长期匹配',
    duration: '20-25 分钟',
    keyDimensions: ['自信心态', '互动质量'],
  },
};

const SCORE_ANCHOR_TEMPLATES = {
  logic: { name: '逻辑结构', low: '表述零散，无框架，因果断裂', high: '先总后分，因果闭环，量化结果' },
  relevance: { name: '内容相关性', low: '跑题，未回应核心问题', high: '切中核心意图，有深度延展' },
  depth: { name: '专业深度', low: '停留在表面，无技术细节', high: '深入原理，有量化数据与创新案例' },
  fluency: { name: '表达流畅度', low: '卡顿严重，填充词密集', high: '表达精准，节奏把控好' },
  interaction: { name: '互动质量', low: '问答考试，无主动延展', high: '展示思考过程，推动对话' },
  confidence: { name: '自信心态', low: '犹豫密集，语气不坚定', high: '高度自信，对不确定也能展示推理框架' },
};

function uniq(arr) {
  return [...new Set((arr ?? []).filter((x) => typeof x === 'string' && x.trim()))];
}

function pick(arr, n) {
  return uniq(arr).slice(0, n);
}

export function buildRulesPlan({ resumeVersion, company, position }) {
  const resumeProfile = resumeVersion?.profile ?? {};
  const jobProfile = position?.profile ?? {};
  const rawText = resumeVersion?.rawText ?? '';
  const title = position?.title ?? '该岗位';
  const jobType = position?.jobType ?? 'tech';
  const companyName = company?.name ?? '目标公司';

  const skills = Array.isArray(resumeProfile.skills) ? resumeProfile.skills : [];
  const skillNames = uniq(skills.map((s) => (typeof s === 'string' ? s : s?.name)));
  const experiences = Array.isArray(resumeProfile.experiences) ? resumeProfile.experiences : [];
  const responsibilities = Array.isArray(jobProfile.responsibilities) ? jobProfile.responsibilities : [];
  const requirements = Array.isArray(jobProfile.requirements) ? jobProfile.requirements : [];
  const keywords = Array.isArray(jobProfile.keywords) ? jobProfile.keywords : [];

  const hasNumbers = /\d/.test(rawText);
  const firstSkill = skillNames[0] ?? '核心技能';
  const firstExp = experiences[0]?.summary ?? '';
  const firstResp = responsibilities[0] ?? title;

  // L1 候选人画像摘要
  const strengths = [
    ...pick(skillNames.map((s) => `掌握 ${s}`), 2),
    ...(firstExp ? [`有可深挖的经历：${firstExp.slice(0, 30)}`] : []),
  ];
  while (strengths.length < 2) strengths.push('具备基础沟通与学习能力');

  const weaknesses = [
    ...(hasNumbers ? [] : ['简历缺少可验证的量化结果']),
    ...(skillNames.length ? [`技能深度未验证：${firstSkill} 需要面试深挖`] : ['技能清单不完整']),
  ];
  while (weaknesses.length < 2) weaknesses.push('岗位匹配度需在面试中验证');

  const redFlags = [
    ...(experiences.length < 2 ? ['经历素材较少，需追问时间线与真实性'] : []),
    ...(hasNumbers ? [] : ['简历未见量化指标，存在"做了但没结果"风险']),
  ];
  while (redFlags.length < 2) redFlags.push('职业动机与稳定性待验证');

  // L2 岗位匹配度
  const hardSkills = pick([...requirements, ...keywords, ...skillNames], 5);
  const softSkills = pick(['沟通协作', '问题分析', '执行落地', '学习能力', '抗压'], 3);
  const experienceFit = `候选人有 ${experiences.length} 段经历、${skillNames.length} 项技能，目标岗位职责 ${responsibilities.length} 条，匹配度需在面试中逐条验证`;

  // L3 风险点清单（≥6）
  const riskPoints = [
    {
      category: '简历瑕疵',
      description: hasNumbers ? '简历含量化结果，需追问口径与真实性' : '简历缺少量化结果，回答可能停留在表面',
      severity: hasNumbers ? 'medium' : 'high',
    },
    {
      category: '经历断层',
      description: experiences.length < 2 ? '经历数量少，时间线与空白期需验证' : '多段经历间关联性需验证',
      severity: experiences.length < 2 ? 'high' : 'low',
    },
    {
      category: '技术深挖风险',
      description: `「${firstSkill}」需要从使用层面追问到底层原理与边界`,
      severity: 'medium',
    },
    {
      category: '岗位匹配风险',
      description: `职责「${firstResp.slice(0, 24)}」与候选人经历的直接对应关系待验证`,
      severity: 'medium',
    },
    {
      category: '行为面试素材',
      description: experiences.length < 2 ? '行为面试素材不足，需引导 STAR 展开' : '行为面试需验证冲突处理与决策质量',
      severity: experiences.length < 2 ? 'high' : 'low',
    },
    {
      category: '稳定性风险',
      description: '职业动机、期望与公司/岗位匹配度需在终面验证',
      severity: 'medium',
    },
  ];

  // L4 必问主线（≥8，每条 ≥1 关键问题）
  const mainlines = [
    {
      id: 'm1',
      focus: '项目深挖-主项目',
      intent: '验证项目真实性与技术深度',
      depthTarget: '细节、决策理由、极端场景',
      keyQuestions: [
        firstExp
          ? `你简历里提到"${firstExp.slice(0, 40)}"，能具体讲讲你在其中的职责和技术方案吗？`
          : '挑一个你最熟悉的项目，讲讲你在其中的职责和技术方案。',
        '这个项目里你遇到的最大难点是什么？为什么这么解决？有没有对比过其他方案？',
      ],
    },
    {
      id: 'm2',
      focus: '项目深挖-量化结果',
      intent: '验证数据真实性与归因能力',
      depthTarget: '指标口径、提升归因、复盘',
      keyQuestions: [
        hasNumbers ? '简历里的量化指标口径是什么？提升主要来自哪个动作？' : '如果让你为这段经历补一个核心指标，你会选什么？为什么？',
        '如果结果没有达到预期，你会怎么排查原因和迭代？',
      ],
    },
    {
      id: 'm3',
      focus: jobType === 'tech' ? '技术原理' : '业务理解',
      intent: jobType === 'tech' ? '考察基础知识扎实度' : '考察业务认知与岗位理解',
      depthTarget: '底层原理、适用边界、高并发/复杂场景',
      keyQuestions: [
        skillNames.length
          ? `你简历里写了熟悉${firstSkill}，能讲讲它的底层原理和适用场景吗？`
          : `你怎么理解「${firstResp.slice(0, 24)}」这个职责背后的业务目标？`,
        `在极端场景下（如${jobType === 'tech' ? '高并发、数据一致性' : '资源有限、需求冲突'}），它会遇到什么瓶颈？你怎么应对？`,
      ],
    },
    {
      id: 'm4',
      focus: '方案设计',
      intent: '考察架构能力与技术选型 / 方案拆解与取舍',
      depthTarget: '整体设计、关键取舍、落地路径',
      keyQuestions: [
        `假设让你负责"${firstResp.slice(0, 30)}"，你会怎么设计方案？关键取舍是什么？`,
        '如果给你更少的资源和时间，你会砍掉什么、保留什么？',
      ],
    },
    {
      id: 'm5',
      focus: '行为面试-冲突处理',
      intent: '考察沟通、协作与原则',
      depthTarget: '情境、行动、结果',
      keyQuestions: [
        '讲一次你和同事/业务方意见冲突的经历，你是怎么处理的？结果如何？',
        '如果对方坚持一个你认为有风险的方案，你会怎么推进？',
      ],
    },
    {
      id: 'm6',
      focus: '行为面试-STAR',
      intent: '考察经历真实性与总结能力',
      depthTarget: '情境-任务-行动-结果完整链路',
      keyQuestions: [
        experiences[1]?.summary
          ? `简历里这段经历"${experiences[1].summary.slice(0, 40)}"能用 STAR 完整讲讲吗？`
          : '用 STAR 方法完整讲讲你最有代表性的一段经历。',
        '这段经历里你的个人贡献和团队贡献分别是什么？',
      ],
    },
    {
      id: 'm7',
      focus: '岗位匹配-职责理解',
      intent: '考察对目标岗位的理解',
      depthTarget: '职责拆解、优先级、业务理解',
      keyQuestions: [
        `结合我们公司（${companyName}）的业务，你怎么理解「${title}」这个岗位的核心价值？`,
        '入职前三个月，你会怎么安排优先级？',
      ],
    },
    {
      id: 'm8',
      focus: '岗位匹配-动机与稳定性',
      intent: '考察职业动机、成长预期与稳定性',
      depthTarget: '动机、规划、价值观',
      keyQuestions: [
        `为什么选择我们公司（${companyName}）的${title}岗位？你的职业规划是什么？`,
        '你怎么看待加班/不确定性/快速变化？',
      ],
    },
  ];

  // L5 追问树（核心主线 m1/m3/m5/m7 × 三档 = 12）
  const followupTree = [
    { mainlineId: 'm1', level: 'shallow', question: `你负责「${firstResp.slice(0, 20)}」时具体做了什么？`, intent: '确认职责边界与参与度' },
    { mainlineId: 'm1', level: 'medium', question: '这个方案的关键设计决策是什么？为什么这么做？', intent: '验证决策理由' },
    { mainlineId: 'm1', level: 'deep', question: '如果流量再放大 10 倍或出现极端故障，你的方案哪里会先崩？怎么改？', intent: '验证极限场景与应变' },
    { mainlineId: 'm2', level: 'shallow', question: '这个量化数字是怎么统计出来的？', intent: '验证指标口径' },
    { mainlineId: 'm2', level: 'medium', question: '提升归因到哪个具体动作？有没有做过对照？', intent: '验证归因能力' },
    { mainlineId: 'm2', level: 'deep', question: '如果指标后来又回落了，你会从哪几条路径排查？', intent: '验证复盘与迭代能力' },
    { mainlineId: 'm3', level: 'shallow', question: `${skillNames.length ? `${firstSkill} 你平时主要用在什么场景？` : '你怎么理解这个岗位对应的业务目标？'}`, intent: '确认基础认知' },
    { mainlineId: 'm3', level: 'medium', question: '它的核心原理是什么？有什么已知的坑？', intent: '验证原理掌握' },
    { mainlineId: 'm3', level: 'deep', question: '如果不用它，你会选什么替代方案？为什么？', intent: '验证技术选型与边界' },
    { mainlineId: 'm7', level: 'shallow', question: '你觉得这个岗位最重要的三件事是什么？', intent: '验证岗位理解' },
    { mainlineId: 'm7', level: 'medium', question: '如果业务目标和资源冲突，你怎么排优先级？', intent: '验证取舍框架' },
    { mainlineId: 'm7', level: 'deep', question: '给你一个具体的业务问题（结合公司业务），你会怎么拆解落地？', intent: '验证业务落地' },
  ];

  // L6 评分锚点（六维）
  const scoreAnchors = {};
  for (const [dim, tpl] of Object.entries(SCORE_ANCHOR_TEMPLATES)) {
    scoreAnchors[dim] = {
      expectedScore: 3,
      lowAnchor: `1 分：${tpl.low}`,
      highAnchor: `5 分：${tpl.high}`,
    };
  }

  // L7 轮次定位
  const roundPositioning = {};
  for (const [key, meta] of Object.entries(ROUND_META)) {
    roundPositioning[key] = {
      focus: meta.focus,
      style: meta.style,
      duration: meta.duration,
      keyDimensions: [...meta.keyDimensions],
    };
  }

  return {
    version: 1,
    layers: {
      candidateProfile: { strengths, weaknesses, redFlags },
      positionFit: { hardSkills, softSkills, experienceFit },
      riskPoints,
      mustAskMainlines: mainlines,
      followupTree,
      scoreAnchors,
      roundPositioning,
    },
  };
}
