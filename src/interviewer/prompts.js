// 面试官 LLM system prompt 构建。
// 核心思路（联网调研最佳实践）：Context is King——把简历画像、JD 画像、
// 轮次定位、岗位类型追问策略全部塞进 system prompt，让模型生成精准的问题。
// 一次只问一个问题，追问方向由岗位类型驱动，深度递进。

// 岗位类型 → 追问策略描述（供 LLM 参考方向，与 rules.js 的策略池对齐）
const JOBTYPE_STRATEGY_DESC = {
  tech: '技术岗：追问方向为 项目深挖（选简历项目问技术方案与难点）→ 技术原理/八股（技能栈底层原理）→ 系统设计（架构与技术选型）',
  product: '产品岗：追问方向为 场景设计（产品场景与目标用户）→ 取舍决策（优先级与决策框架）→ 数据验证（指标与验证方法）',
  operation: '运营岗：追问方向为 案例分析（过往运营案例与效果）→ 数据指标（目标拆解与关键路径）→ 执行落地（资源协调与执行细节）',
  sales: '销售岗：追问方向为 客户拓展（获客渠道与节奏）→ 异议处理（临场应对）→ 业绩达成（目标拆解与执行）',
  function: '职能岗：追问方向为 行为面试STAR（过往经历）→ 动机匹配（职业动机）→ 压力应对（抗压与情绪管理）',
  civil: '公考岗：追问方向为 政策理解（政策把握）→ 情景处置（应急反应）→ 价值观（价值取向与责任意识）',
};

// 轮次定位（方案书 §5.4：一面简历面 / 二面业务面 / 三面终面）
const ROUND_DESC = {
  round1: '一面（简历面）：聚焦简历经历的真实性、技能栈基础、项目细节。目标是验证候选人"写的是不是真的"。',
  round2: '二面（业务面）：聚焦岗位匹配度、业务场景、项目深度。目标是验证"能不能胜任这个岗位"。',
  round3: '三面（终面）：聚焦价值观、抗压能力、职业规划、综合判断。目标是验证"适不适合这个团队"。',
};

function describeJobType(jobType) {
  return JOBTYPE_STRATEGY_DESC[jobType] ?? JOBTYPE_STRATEGY_DESC.tech;
}

// 开场白 prompt：生成开场白 + 首个问题
export function buildOpeningPrompt({ resumeProfile, jobProfile, roundKey }) {
  return `你是一位经验丰富的面试官，正在面试一位应聘"${jobProfile.title}"岗位的候选人，公司是${jobProfile.companyName ?? '我们公司'}。

【轮次定位】
${ROUND_DESC[roundKey] ?? ROUND_DESC.round1}

【岗位类型与追问策略】
${describeJobType(jobProfile.jobType)}

【候选人简历画像】
${JSON.stringify(resumeProfile, null, 2)}

【目标岗位画像】
${JSON.stringify(jobProfile, null, 2)}

【你的任务】
生成开场白和第一个面试问题。要求：
1. 开场白简短自然（1-2 句），提及候选人名字和应聘岗位
2. 第一个问题以破冰为主（自我介绍或经历概述），不要直接进入深度追问——深度追问留给后续轮次
3. 一次只问一个问题，不要复合问题
4. 问题要基于简历画像，自然引入对话

请以 JSON 格式输出：
{"greeting":"开场白","question":"第一个问题","focusArea":"追问方向","intent":"考察意图"}`;
}

// 追问 prompt：根据候选人回答生成下一个追问
export function buildFollowupPrompt(session, candidateAnswer) {
  const dialogue = session.turns
    .map((t) => (t.role === 'interviewer' ? `面试官：${t.content}` : `候选人：${t.content}`))
    .join('\n');

  return `你是一位经验丰富的面试官，正在面试"${session.jobProfile.title}"岗位的候选人。

【轮次定位】
${ROUND_DESC[session.roundKey] ?? ROUND_DESC.round1}

【岗位类型与追问策略】
${describeJobType(session.jobType)}

【对话历史】
${dialogue}

【候选人刚才的回答】
${candidateAnswer}

【追问进度】
当前是第 ${session.depth} 轮追问（共 ${session.maxDepth} 轮）。

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
