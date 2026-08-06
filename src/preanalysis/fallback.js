// 预分析规则兜底（方案书 §5.4/§5.5）。
// LLM 不可用或输出不合法时，用简历画像 + 目标岗位画像生成确定性的七大层骨架；
// 按方案书 §5.5，规则兜底为"通用模板（不区分岗位类型）"——追问方向统一为
// 关键经历 STAR 展开 → 实现细节与决策理由 → 极端场景与对比方案。

const ROUND_LABEL = { round1: '一面简历面', round2: '二面业务面', round3: '三面总监交叉面' };

function uniq(arr) {
  return [...new Set((arr ?? []).filter((x) => typeof x === 'string' && x.trim()))];
}

function pick(arr, n) {
  return uniq(arr).slice(0, n);
}

const BARS_TEMPLATES = {
  logic: { low: '表述零散，无框架，因果断裂', high: '先总后分，因果闭环，量化结果' },
  relevance: { low: '跑题，未回应核心问题', high: '切中核心意图，有深度延展' },
  depth: { low: '停留在表面，无技术细节', high: '深入原理，有量化数据与创新方案' },
  fluency: { low: '卡顿严重，填充词密集', high: '表达精准，节奏把控好' },
  interaction: { low: '问答考试，无主动延展', high: '展示思考过程，推动对话' },
  confidence: { low: '犹豫密集，语气不坚定', high: '高度自信，对不确定也能展示推理框架' },
};

function makeChain(id, dimension, depthTarget, keyQuestions, questions) {
  return {
    id,
    dimension,
    depthTarget,
    keyQuestions,
    chain: [
      { level: 'shallow', question: questions[0], intent: '确认基础认知与参与度', qualityAnchor: '能具体说出做了什么、边界清晰' },
      { level: 'medium', question: questions[1], intent: '验证决策理由与实现细节', qualityAnchor: '能讲清为什么这么做、有没有对比过' },
      { level: 'deep', question: questions[2], intent: '验证极端场景与方案边界', qualityAnchor: '能指出方案会先崩在哪、怎么改' },
    ],
  };
}

export function buildFallbackPlan({ resumeVersion, company, position }) {
  const resumeProfile = resumeVersion?.profile ?? {};
  const jobProfile = position?.profile ?? {};
  const rawText = resumeVersion?.rawText ?? '';
  const title = position?.title ?? '目标岗位';
  const companyName = company?.name ?? '目标公司';

  const skills = Array.isArray(resumeProfile.skills) ? resumeProfile.skills : [];
  const skillNames = uniq(skills.map((s) => (typeof s === 'string' ? s : s?.name)));
  const experiences = Array.isArray(resumeProfile.experiences) ? resumeProfile.experiences : [];
  const responsibilities = Array.isArray(jobProfile.responsibilities) ? jobProfile.responsibilities : [];
  const requirements = Array.isArray(jobProfile.requirements) ? jobProfile.requirements : [];
  const keywords = Array.isArray(jobProfile.keywords) ? jobProfile.keywords : [];

  const hasNumbers = /\d/.test(rawText);
  const firstSkill = skillNames[0] ?? '核心技术';
  const firstExp = experiences[0]?.summary ?? '';
  const firstResp = responsibilities[0] ?? title;

  // ---------- ① JD 深度解析 ----------
  const jdAnalysis = {
    roleNature: `${title}：核心是解决「${firstResp}」对应的业务问题（岗位定位按 JD 推断）`,
    level: '中级 / 高级（按 JD 职责与年限要求推断）',
    coreResponsibilities: [
      ...pick(responsibilities, 3),
      ...(responsibilities.length < 2 ? [`围绕「${firstResp}」展开方案设计与落地`] : []),
    ],
    hiddenRequirements: ['抗压与多任务并行', '跨部门协作推动力', '对结果负责的闭环意识'],
    redLines: [...pick(requirements, 2), ...(requirements.length < 2 ? ['经验年限与职责匹配度'] : [])],
    industryContext: `目标行业上下文待联网补全（§5.3）：影响考察侧重`,
    companyStage: '公司阶段待联网补全：创业期重动手、成熟期重流程与协作',
    hiringPain: '为什么在招：业务扩张 / 团队补强（推断，待面试验证）',
  };

  // ---------- ② 候选人画像深度分析 ----------
  const candidateProfile = {
    radar: { technicalDepth: 3, technicalBreadth: 3, businessSense: 3, communication: 3, leadership: 3, learning: 3 },
    credibility: [
      ...experiences.slice(0, 3).map((e) => ({
        summary: e.summary?.slice(0, 30) ?? '关键经历',
        level: experiences.length >= 2 ? 'high' : 'medium',
        verifyFocus: '时间线、个人贡献与量化口径',
      })),
      ...(experiences.length < 2
        ? [{ summary: '其他关键经历（待追问验证）', level: 'medium', verifyFocus: '时间线、个人贡献与量化口径' }]
        : []),
    ],
    highlights: [
      ...experiences.slice(0, 2).map((e) => ({
        experience: e.summary?.slice(0, 30) ?? firstResp,
        depthDirection: '项目深挖：职责 → 决策理由 → 极端场景',
        expectedDepth: '能讲清细节、取舍与数据结果',
      })),
      ...(experiences.length < 2
        ? [{
            experience: firstResp,
            depthDirection: '围绕岗位职责展开方案与决策深挖',
            expectedDepth: '能结合公司业务给出有取舍的方案',
          }]
        : []),
    ],
    weaknesses: [
      { point: hasNumbers ? '量化结果需验证口径与归因' : '简历缺少可验证的量化结果', probeApproach: '追问指标口径、提升归因、复盘路径' },
      { point: `技能「${firstSkill}」深度未验证`, probeApproach: '从使用层面追问到底层原理与边界' },
    ],
    exaggerationWarnings: [
      { statement: '「负责/主导」vs「参与/协助」措辞', howToVerify: '追问个人贡献边界与具体动作' },
      { statement: '量化数字是否真实可归因', howToVerify: '追问统计口径与提升来源' },
    ],
    skillDepth: skillNames.slice(0, 4).map((s) => ({ skill: s, depth: '能干' })),
    fitAnalysis: {
      strongMatches: pick(skillNames.filter((s) => requirements.some((r) => r.includes(s))), 2).length
        ? pick(skillNames.filter((s) => requirements.some((r) => r.includes(s))), 2)
        : ['关键技能与岗位要求匹配度：待面试验证'],
      weakMatches: pick(requirements.filter((r) => !skillNames.some((s) => r.includes(s))), 2).length
        ? pick(requirements.filter((r) => !skillNames.some((s) => r.includes(s))), 2)
        : ['岗位要求中尚未验证的项（见红线项）'],
      missingItems: pick(keywords.filter((k) => !skillNames.some((s) => s.includes(k))), 2).length
        ? pick(keywords.filter((k) => !skillNames.some((s) => s.includes(k))), 2)
        : ['岗位关键词覆盖：待面试验证'],
    },
    careerTrajectory: `${experiences.length} 段经历，${experiences.length < 2 ? '经历素材较少，需验证时间线与空白期' : '稳定性与成长性需在行为面验证'}`,
    likelyStuck: [`「${firstSkill}」底层原理与适用边界`, '量化指标的口径与归因', '行为面试 STAR 完整链路'],
  };

  // ---------- ③ 每轮面试官深度人设 ----------
  const interviewerPersona = {
    round1: {
      identity: '直属技术/业务上级',
      background: '带过简历同类经历的 5-8 年从业者',
      style: '温和追问型：一次只问一个问题，逐步加压',
      focus: '简历是不是真的：经历真实性、基础能力、关键细节',
      bias: '偏爱有数据结果、能讲清取舍的候选人',
      killerQuestions: ['这段经历里你个人最有技术含量/决策含量的一件事是什么？', '简历里这个数字是怎么统计出来的？'],
      questionPattern: '开场破冰 → 项目细节追问 → 收尾缓冲',
    },
    round2: {
      identity: '业务负责人 / 用人部门负责人',
      background: `熟悉${companyName}业务与岗位职责的负责人`,
      style: '案例讨论型：业务场景带入，追问细节与取舍',
      focus: '能不能胜任：业务理解、方案设计、情景应变',
      bias: '看重对业务的理解深度与落地意识',
      killerQuestions: [`如果让你负责「${firstResp}」，你会怎么拆解优先级？`, '资源有限时你怎么做取舍？'],
      questionPattern: '公司业务 briefing → 业务方案题 → 情景压力题',
    },
    round3: {
      identity: '总监 / 交叉面负责人',
      background: '跨部门视角、看长期匹配',
      style: '答辩质疑型：开放式问题，深挖价值观与稳定性',
      focus: '适不适合团队：综合素质、软性指标、发展潜力',
      bias: '看重职业规划清晰度与抗压稳定性',
      killerQuestions: ['你未来 3-5 年的规划是什么？为什么是现在这家公司？', '如果入职后发现不适合，你会怎么处理？'],
      questionPattern: '开放式问题 → 价值观深挖 → 反问环节',
    },
  };

  // ---------- ④ 每轮考察策略 ----------
  const roundStrategy = {
    round1: {
      dimensions: [
        { name: '经历真实性', excellent: '细节自洽、时间线清晰、个人贡献明确', failing: '含糊矛盾、口径对不上' },
        { name: '基础能力', excellent: '能讲清原理与适用边界', failing: '停留在使用层面' },
        { name: '行为面试', excellent: 'STAR 完整、有反思', failing: '只有结果没有过程' },
      ],
      followupChains: [
        makeChain('r1c1', '关键经历深挖', '细节、决策理由、极端场景',
          [firstExp ? `简历里提到「${firstExp.slice(0, 40)}」，能具体讲讲你的职责和技术方案吗？` : '挑一段你最熟悉的经历，讲讲你的职责和技术方案。',
           '这个项目里你遇到的最大难点是什么？为什么这么解决？有没有对比过其他方案？'],
          ['你在这个项目里具体负责什么？', '关键设计决策是什么？为什么这么做？', '如果流量放大 10 倍，你的方案哪里会先崩？怎么改？']),
        makeChain('r1c2', '量化结果归因', '指标口径、提升归因、复盘',
          [hasNumbers ? '简历里的量化指标口径是什么？提升主要来自哪个动作？' : '如果让你为这段经历补一个核心指标，你会选什么？为什么？',
           '如果结果没有达到预期，你会怎么排查原因和迭代？'],
          ['这个数字是怎么统计出来的？', '提升归因到哪个具体动作？有没有做过对照？', '如果指标后来回落了，你会从哪几条路径排查？']),
        makeChain('r1c3', `技能「${firstSkill}」原理`, '底层原理、适用边界、高并发/复杂场景',
          [`简历里写了熟悉${firstSkill}，能讲讲它的底层原理和适用场景吗？`, '在极端场景下它会遇到什么瓶颈？你怎么应对？'],
          [`${firstSkill} 你平时主要用在什么场景？`, '它的核心原理是什么？有什么已知的坑？', '如果不用它，你会选什么替代方案？为什么？']),
        makeChain('r1c4', '经历真实性细节', '时间线、个人贡献、矛盾点',
          ['这段经历的时间线和团队规模是怎样的？', '你个人贡献和团队贡献分别是什么？'],
          ['当时团队几个人？你的角色是什么？', '中间有没有返工或推翻重来的情况？', '如果让当时的同事评价你，他们会说什么？']),
        makeChain('r1c5', '行为面试 STAR', '情境-任务-行动-结果完整链路',
          ['用 STAR 完整讲讲你最有代表性的一段经历。', '这段经历里你的个人贡献和团队贡献分别是什么？'],
          ['当时是什么情境？你的任务是什么？', '你具体采取了哪些行动？', '结果如何？如果重来一次你会改哪里？']),
      ],
      opening: { style: '轻松破冰 → 逐步加压', firstQuestion: '先简单做个自我介绍吧，重点聊聊你最近的一段经历。' },
      stressTest: { point: '技能原理追问环节', method: '连续追问到答不上为止', recovery: '换一个相关但更简单的问题，给台阶' },
      scenarioDesign: { scenario: `公司业务中与「${firstResp}」相关的典型场景`, question: '如果让你负责这个场景，你会怎么设计兜底方案？' },
      timeAllocation: '20-25 分钟：破冰 3 分钟 / 项目深挖 10 分钟 / 压力测试 5 分钟 / 收尾 2-5 分钟',
      dedupList: [],
    },
    round2: {
      dimensions: [
        { name: '业务理解', excellent: '能结合公司真实业务拆解职责', failing: '停留在 JD 字面' },
        { name: '方案与情景题', excellent: '有取舍、有落地路径', failing: '泛泛而谈、无边界' },
        { name: '行业与前沿', excellent: '有行业认知与趋势判断', failing: '不了解近期动态' },
      ],
      followupChains: [
        makeChain('r2c1', '公司业务理解', '业务模式、产品线、商业目标',
          [`结合我们公司（${companyName}）的业务，你怎么理解「${title}」这个岗位的核心价值？`, '入职前三个月你会怎么安排优先级？'],
          ['你对我们公司业务有哪些了解？', '这个岗位对公司业务目标直接贡献是什么？', '如果业务目标变了，你会怎么调整职责优先级？']),
        makeChain('r2c2', '岗位职责拆解', '职责理解、优先级、落地路径',
          [`这个岗位职责包括「${firstResp}」，你怎么拆解？`, '哪些是你认为最重要、必须最先做的？'],
          ['你理解的职责边界是什么？', '如果两个职责冲突，你怎么排优先级？', '给你一个具体业务问题，你会怎么拆解落地？']),
        makeChain('r2c3', '业务方案设计', '整体设计、关键取舍、落地路径',
          [`假设让你负责「${firstResp}」，你会怎么设计方案？关键取舍是什么？`, '如果给你更少的资源和时间，你会砍掉什么、保留什么？'],
          ['这个方案的第一步是什么？', '你做过的最难取舍是什么？', '方案上线后你怎么验证它有效？']),
        makeChain('r2c4', '情景题 / 压力题', '突发应对、思维拓展',
          ['假设线上突然出现大规模故障，业务方催着恢复，你会怎么决策？', '如果竞争对手突然上线了一个颠覆性功能，你会怎么应对？'],
          ['你会先排查还是先止血？', '信息不全时你怎么做决策？', '如果第一次修复无效，你会怎么换路径？']),
        makeChain('r2c5', '前沿趋势探索', '行业动态、趋势判断',
          ['最近行业里出现的新趋势，你怎么看它对咱们这块业务的影响？', '如果让你负责应对这个变化，你的思路和优先级是什么？'],
          ['你从哪些渠道了解行业动态？', '这个趋势的底层驱动是什么？', '它会颠覆现有方案还是只是增强？']),
      ],
      opening: { style: '先给公司业务 briefing，再问业务题', firstQuestion: `我们公司目前在${companyName}的业务方向上是这样的……结合这个背景，先聊聊你对这个岗位的理解。` },
      stressTest: { point: '方案题追问环节', method: '逐步削减资源逼出取舍', recovery: '认可思路后转下一维度' },
      scenarioDesign: { scenario: '结合目标公司真实业务的一个典型场景', question: '如果由你负责，你会怎么设计解决方案或拆解解决路径？关键取舍是什么？' },
      timeAllocation: '25-30 分钟：业务 briefing 3 分钟 / 职责理解 5 分钟 / 方案题 10 分钟 / 压力题 5 分钟 / 收尾 2-5 分钟',
      dedupList: ['一面已问的经历细节问题不再重复', '一面已问的技能原理改为业务场景应用'],
    },
    round3: {
      dimensions: [
        { name: '职业规划与动机', excellent: '规划清晰、与岗位长期匹配', failing: '动机模糊、规划与岗位无关' },
        { name: '价值观契合', excellent: '原则清晰、有具体案例', failing: '空话套话' },
        { name: '抗压与综合素质', excellent: '高压下有决策框架', failing: '情绪化或回避' },
      ],
      followupChains: [
        makeChain('r3c1', '职业规划', '3-5 年规划、成长预期',
          ['你未来 3-5 年的职业规划是什么？为什么选择我们公司这个岗位？', '你希望在在这里实现什么成长？'],
          ['你过去是怎么一步步走到现在的？', '这个岗位在你的规划里处于什么位置？', '如果三年后你没有达到预期，你会怎么调整？']),
        makeChain('r3c2', '价值观契合', '原则、团队协作、责任',
          ['你怎么理解「责任感」和「团队协作」？', '能讲一次你坚持原则、和团队达成共识的经历吗？'],
          ['你拒绝过什么不合理要求？', '你怎么处理和同事意见冲突？', '如果公司临时推一项你不认同的政策，你会怎么做？']),
        makeChain('r3c3', '抗压与稳定性', '高压决策、自我认知',
          ['讲一次你在高压下做关键决策的经历——当时什么情况，你怎么权衡的，结果如何？', '如果入职后发现自己不适合，你会怎么处理？'],
          ['你压力最大的一段时间是怎么度过的？', '你做过最艰难的决定是什么？', '你怎么判断自己该坚持还是该放弃？']),
        makeChain('r3c4', '技术视野 / 行业认知', '架构思考、行业判断',
          ['你怎么看这个行业未来三年的发展方向？', '如果让你从零设计一个核心系统/业务，你的整体思路是什么？'],
          ['你关注哪些技术/业务趋势？', '这个趋势对咱们公司意味着什么？', '你会怎么把趋势落地成可执行的方案？']),
        makeChain('r3c5', '开放式终极问题', '综合判断、自我认知',
          ['你有什么想问我的？', '如果给你一个机会重新选择职业方向，你会变吗？'],
          ['你觉得自己最大的优势是什么？', '你最大的盲区是什么？', '如果团队让你带一个新方向，你会怎么开始？']),
      ],
      opening: { style: '开放式、节奏更慢更从容', firstQuestion: '前两轮聊了你的经历和能力，今天咱们聊得更宏观一些：先说说你理想中的工作状态是什么样的？' },
      stressTest: { point: '职业规划与价值观追问', method: '连续追问矛盾点', recovery: '正向反馈后转开放问题' },
      scenarioDesign: { scenario: '格局级开放式场景', question: '如果行业发生颠覆性变化，你怎么判断这家公司和你自己该怎么办？' },
      timeAllocation: '20-25 分钟：开放式破冰 5 分钟 / 价值观深挖 10 分钟 / 反问环节 5 分钟',
      dedupList: ['不重复一面/二面已问的具体经历题', '追问方向转向综合素质与软性指标'],
    },
  };

  // ---------- ⑤ 风险预判 ----------
  const riskForecast = {
    likelyStuck: [
      { question: `「${firstSkill}」的底层原理`, suggestion: '提前准备原理 + 边界 + 替代方案', rescue: '降档为使用场景题，先保流程不断' },
      { question: '量化指标的口径与归因', suggestion: '准备指标统计方式与提升来源', rescue: '改为假设题：如果让你重新设计指标会怎么选' },
      { question: '行为面试 STAR 完整链路', suggestion: '按情境-任务-行动-结果各准备一个案例', rescue: '提示框架，引导分步展开' },
    ],
    exaggerationPoints: [
      { claim: '「负责/主导」类措辞', verifyApproach: '追问个人贡献边界与具体动作', depthNeeded: '能讲清自己做了什么、别人做了什么' },
      { claim: '量化提升数字', verifyApproach: '追问统计口径与对照实验', depthNeeded: '能讲清数字怎么来的、能否复现' },
    ],
    trapQuestions: [
      { question: '你最大的缺点是什么？', intent: '考察自我认知与改进闭环', expectedDirection: '讲真实缺点 + 正在怎么改 + 结果' },
      { question: '为什么从上一家公司离开？', intent: '考察稳定性与职业动机', expectedDirection: '发展导向，不贬低前东家' },
    ],
    crossRoundRisks: [
      { fromRound: '一面', risk: '经历真实性存疑', followupRound: '二面业务方案题中二次验证' },
      { fromRound: '二面', risk: '业务理解薄弱', followupRound: '三面价值观与学习能力收网' },
    ],
    candidateQuestions: [
      { question: '这个岗位为什么在招？', interviewerAnswer: '业务扩张/团队补强（按真实情况回答，不编造）' },
      { question: '团队最看重什么？', interviewerAnswer: '结合岗位职责与团队现状回答' },
    ],
    extremePlans: [
      { situation: '候选人完全答不上来', response: '降档 + 救援提示，记录为困难点（§5.9），不强行施压' },
      { situation: '候选人引导话题到擅长领域', response: '先让展示，再在擅长领域施压测上限（§5.4 动态调整）' },
    ],
  };

  // ---------- ⑥ 复盘评分框架 ----------
  const reviewFramework = {
    dimensions: Object.keys(BARS_TEMPLATES),
    bars: Object.fromEntries(
      Object.entries(BARS_TEMPLATES).map(([dim, tpl]) => [
        dim,
        { expectedScore: 3, lowAnchor: `1 分：${tpl.low}`, highAnchor: `5 分：${tpl.high}` },
      ]),
    ),
    coverageChecklist: ['JD 核心职责覆盖', '关键经历真实性验证', '岗位匹配度评估', '该轮核心维度覆盖'],
    deviationDimensions: ['本场实际考察 vs 该轮应考察', '准备方向偏差提示'],
    progressComparison: ['与上次同轮对比：进步 / 退步 / 持平', '薄弱点变化趋势'],
    hitRateCheck: ['预判翻车点是否真的翻车', '吹牛点是否被戳破', '风险预判命中率'],
  };

  // ---------- ⑦ 面试节奏与体验设计 ----------
  const rhythmDesign = {
    round1: { curve: '轻松破冰 → 逐步加压 → 收尾缓冲', pressureGradient: '松-紧-松', positiveFeedback: '项目细节答得好时给予肯定', durationAndCount: '20-25 分钟，5-8 个问题' },
    round2: { curve: '业务讨论节奏，中间施压，留时间方案设计', pressureGradient: '平-紧-松', positiveFeedback: '方案有取舍时认可思路', durationAndCount: '25-30 分钟，5-8 个问题' },
    round3: { curve: '格局级开放式问题，节奏更慢更从容', pressureGradient: '松-紧-松', positiveFeedback: '价值观表达清晰时给予正向反馈', durationAndCount: '20-25 分钟，4-6 个问题' },
  };

  return {
    version: 1,
    layers: {
      jdAnalysis,
      candidateProfile,
      interviewerPersona,
      roundStrategy,
      riskForecast,
      reviewFramework,
      rhythmDesign,
    },
  };
}
