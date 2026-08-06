// 面试官 LLM system prompt 构建（方案书 §5.5：每轮提示词由预分析驱动，引擎只有一套）。
// 组装顺序：全局上下文 → 预分析全局层（①②⑤）→ 预分析轮次层（③④⑦）→ 当次数据。
// 一次只问一个问题，追问方向由预分析④层追问链驱动；规则回退模式按岗位类型策略池。

// 岗位类型 → 追问策略描述（规则回退模式使用，方案书 §5.5 规则兜底）
const JOBTYPE_STRATEGY_DESC = {
  tech: '技术岗：追问方向为 项目深挖（选简历项目问技术方案与难点）→ 技术原理/八股（技能栈底层原理）→ 系统设计（架构与技术选型）',
  product: '产品岗：追问方向为 场景设计（产品场景与目标用户）→ 取舍决策（优先级与决策框架）→ 数据验证（指标与验证方法）',
  operation: '运营岗：追问方向为 案例分析（过往运营案例与效果）→ 数据指标（目标拆解与关键路径）→ 执行落地（资源协调与执行细节）',
  sales: '销售岗：追问方向为 客户拓展（获客渠道与节奏）→ 异议处理（临场应对）→ 业绩达成（目标拆解与执行）',
  function: '职能岗：追问方向为 行为面试STAR（过往经历）→ 动机匹配（职业动机）→ 压力应对（抗压与情绪管理）',
  civil: '公考岗：追问方向为 政策理解（政策把握）→ 情景处置（应急反应）→ 价值观（价值取向与责任意识）',
};

// 轮次定位（方案书 §5.4：一面简历面 / 二面业务面 / 三面总监交叉面）
const ROUND_DESC = {
  round1: '一面（简历面）：聚焦简历经历的真实性、技能栈基础、项目细节。目标是验证候选人"写的是不是真的"。',
  round2: '二面（业务面）：聚焦岗位匹配度、业务场景、项目深度。目标是验证"能不能胜任这个岗位"。',
  round3: '三面（总监交叉面）：聚焦价值观、抗压能力、职业规划、综合判断。目标是验证"适不适合这个团队"。',
};

function describeJobType(jobType) {
  return JOBTYPE_STRATEGY_DESC[jobType] ?? JOBTYPE_STRATEGY_DESC.tech;
}

// 二面业务面上下文块（方案书 §5.4：目标岗位画像 + §5.3 联网补全的公司业务/前沿话题）
function roundContextBlock(roundContext) {
  if (!roundContext) return '';
  const { responsibilities = [], companyBusiness = [], frontierTopics = [] } = roundContext;
  const lines = ['【二面业务面参考资料（主要依据）】'];
  lines.push(`- 岗位职责：${responsibilities.length ? responsibilities.join('；') : '（未填写，参考 JD 画像）'}`);
  lines.push(`- 公司实际业务：${companyBusiness.length ? companyBusiness.map((b) => `${b.name}：${b.summary}`).join('；') : '（暂无缓存，结合公开认知展开）'}`);
  if (frontierTopics.length) {
    lines.push(`- 联网前沿话题（用于前沿探索/压力题）：${frontierTopics.map((t) => t.topic || t.summary).join('；')}`);
  }
  return lines.join('\n') + '\n';
}

// ============ 预分析作战地图注入 + 动态调整指令（方案书 §5.4/§5.5） ============

export function strategyPlanBlock(session) {
  const plan = session?.strategyPlan;
  if (!plan?.layers) return '';
  const { layers } = plan;
  const roundKey = session.roundKey;
  const persona = layers.interviewerPersona?.[roundKey] ?? null;
  const strategy = layers.roundStrategy?.[roundKey] ?? null;
  const rhythm = layers.rhythmDesign?.[roundKey] ?? null;
  const baseline = session.baselinePlan?.items ?? [];
  return [
    '【预分析作战地图】',
    `① JD 深度解析：${JSON.stringify(layers.jdAnalysis ?? {})}`,
    `② 候选人画像：${JSON.stringify(layers.candidateProfile ?? {})}`,
    `③ 本轮面试官人设（${roundKey}）：${JSON.stringify(persona ?? {})}`,
    `④ 本轮考察策略（${roundKey}）：${JSON.stringify(strategy ?? {})}`,
    `⑤ 风险预判：${JSON.stringify(layers.riskForecast ?? {})}`,
    `⑥ 复盘评分框架：${JSON.stringify(layers.reviewFramework ?? {})}`,
    `⑦ 本轮节奏体验（${roundKey}）：${JSON.stringify(rhythm ?? {})}`,
    `当前 baseline 队列：${JSON.stringify(
      baseline.slice(0, 8).map((i) => ({ mainlineId: i.mainlineId, focus: i.focus, question: i.question })),
    )}`,
  ].join('\n');
}

export function dynamicAdjustmentInstruction() {
  return `【动态调整指令】（方案书 §5.4：计划是基线，不是脚本）
1. 候选人展现意外深度（超出预判）→ 突破计划深度，延伸追问到真正的能力边界
2. 候选人暴露预分析未覆盖的新弱点 → 临时插入追问，探索新弱点的范围与影响
3. 候选人严重卡壳（超出预判程度）→ 降低后续难度（深→中或中→浅），调用⑤层救援策略
4. 候选人说出与简历矛盾的内容 → 立即切换验证模式，顺着矛盾点追问到底
5. 候选人主动引导话题到擅长领域 → 先让 ta 展示，再在擅长领域施压测试上限
6. 时间不够、剩余考察维度多 → 按优先级砍低权重维度，保住①层红线项与核心能力
每条追问链最多只降档 1 次；换线需要 2 个信号叠加，避免面试跳跃`;
}

export function buildOpeningPrompt(opts) {
  const session = {
    roundKey: opts.roundKey,
    strategyPlan: opts.strategyPlan,
    baselinePlan: opts.baselinePlan,
  };
  const base = buildOpeningPromptBase(opts);
  const block = strategyPlanBlock(session);
  return block ? `${base}\n\n${block}` : base;
}

export function buildFollowupPrompt(session, candidateAnswer, signals = null, decision = null) {
  const base = buildFollowupPromptBase(session, candidateAnswer);
  const parts = [base];
  const block = strategyPlanBlock(session);
  if (block) parts.push(block);
  if (session?.mode === 'strategy') parts.push(dynamicAdjustmentInstruction());
  if (signals) parts.push(`【实时信号】${JSON.stringify(signals)}`);
  if (decision) parts.push(`【本轮决策】${JSON.stringify(decision)}`);
  return parts.join('\n\n');
}

// 开场白 prompt：生成开场白 + 首个问题（规则回退模式的基础模板）
export function buildOpeningPromptBase({ resumeProfile, jobProfile, roundKey, roundContext }) {
  return `你是一位经验丰富的面试官，正在面试一位应聘"${jobProfile.title}"岗位的候选人，公司是${jobProfile.companyName ?? '我们公司'}。

【轮次定位】
${ROUND_DESC[roundKey] ?? ROUND_DESC.round1}

【岗位类型与追问策略】
${describeJobType(jobProfile.jobType)}
${roundKey === 'round2' ? roundContextBlock(roundContext) : ''}
【候选人简历画像】
${JSON.stringify(resumeProfile, null, 2)}

【目标岗位画像】
${JSON.stringify(jobProfile, null, 2)}

【你的任务】
生成开场白和第一个面试问题。要求：
1. 开场白简短自然（1-2 句），提及候选人名字和应聘岗位
2. 第一个问题以破冰为主（自我介绍或经历概述），不要直接进入深度追问——深度追问留给后续轮次
3. 一次只问一个问题，不要复合问题
4. 问题要基于简历画像，自然引入对话${roundKey === 'round2' ? '\n5. 二面开场可结合岗位职责与公司业务引入，但首个问题仍以破冰为主' : ''}

请以 JSON 格式输出：
{"greeting":"开场白","question":"第一个问题","focusArea":"追问方向","intent":"考察意图"}`;
}

// 追问 prompt：根据候选人回答生成下一个追问（规则回退模式的基础模板）
export function buildFollowupPromptBase(session, candidateAnswer) {
  const dialogue = session.turns
    .map((t) => (t.role === 'interviewer' ? `面试官：${t.content}` : `候选人：${t.content}`))
    .join('\n');

  return `你是一位经验丰富的面试官，正在面试"${session.jobProfile.title}"岗位的候选人。

【轮次定位】
${ROUND_DESC[session.roundKey] ?? ROUND_DESC.round1}

【岗位类型与追问策略】
${describeJobType(session.jobType)}
${session.roundKey === 'round2' ? roundContextBlock(session.roundContext) : ''}
【对话历史】
${dialogue}

【候选人刚才的回答】
${candidateAnswer}

【追问进度】
当前是第 ${session.depth} 轮追问（共 ${session.maxDepth} 轮）。${session.roundKey === 'round2' ? '\n二面追问应以岗位职责 + 公司实际业务为主要参考资料展开，最后一轮可设计前沿探索/压力题考察突发应对与思维拓展力。' : ''}

【你的任务】
根据候选人的回答生成下一个追问。要求：
1. 先简短回应候选人的回答（acknowledgment），再提出追问
2. 追问方向要符合岗位类型策略的第 ${Math.min(session.depth, 3)} 层（深度递进：广度→深度→应用）
3. 如果候选人的回答有漏洞或浅薄，要追问细节；如果回答充分，可以转换方向
4. 一次只问一个问题
5. 追问要有梯度，不要停留在同一层面反复问

请以 JSON 格式输出：
{"acknowledgment":"简短回应","question":"追问问题","focusArea":"追问方向","intent":"考察意图"}`;
}
