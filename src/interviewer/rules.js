// 面试官规则兜底（方案书 §5.5）。
// LLM 不可用或预分析缺失时，降级为通用模板——不区分岗位类型、不预设轮次策略，
// 追问方向统一为：关键经历 STAR 展开 → 实现细节与决策理由 → 极端场景与对比方案。

// 从简历经历里挑第一条做 STAR 素材
function pickExperience(resumeProfile) {
  const exps = resumeProfile?.experiences ?? [];
  return exps[0] ?? null;
}

// 从技能里挑第一个做原理追问素材
function pickSkill(resumeProfile) {
  const skills = resumeProfile?.skills ?? [];
  return skills[0] ?? null;
}

// 开场白按轮次定位（方案书 §5.4：一面简历面 / 二面业务面 / 三面总监交叉面）
const ROUND_INTROS = {
  round1: '我看过你的简历，对你申请的这个岗位很感兴趣，我们先聊聊你的经历。',
  round2: '前面一面同事已经和你聊过基础情况，今天我们重点聊聊业务和项目层面的东西。',
  round3: '前两面的反馈都不错，今天我们聊聊更宏观的一些话题，看看你的整体素质。',
};

// 开场白首个问题：破冰为主（自我介绍/经历概述），不占用追问策略层
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

// ============ 规则兜底追问：通用三层模板（方案书 §5.5，不区分岗位类型） ============

const FALLBACK_FOLLOWUP_LEVELS = [
  {
    focus: '关键经历 STAR 展开',
    intent: '验证经历真实性与完整性',
    build: (ctx) => {
      const exp = pickExperience(ctx.resumeProfile);
      return exp
        ? `简历里提到"${exp.summary}"，能用 STAR（情境-任务-行动-结果）完整讲讲这段经历吗？`
        : '讲一段你最有代表性的经历，用 STAR 方式展开。';
    },
  },
  {
    focus: '实现细节与决策理由',
    intent: '验证细节、逻辑与决策依据',
    build: (ctx) => {
      const skill = pickSkill(ctx.resumeProfile);
      const exp = pickExperience(ctx.resumeProfile);
      if (skill) return `简历里写了熟悉${skill.name}，能讲讲它的底层原理和适用边界吗？`;
      return exp
        ? '这段经历里你遇到的最大难点是什么？为什么这么解决？有没有对比过其他方案？'
        : '你做过的最重要的一次技术/业务决策是什么？为什么？';
    },
  },
  {
    focus: '极端场景与对比方案',
    intent: '验证能力边界与应变',
    build: (ctx) => {
      const exp = pickExperience(ctx.resumeProfile);
      return exp
        ? '如果当时流量/规模放大 10 倍或出现极端故障，你的方案哪里会先崩？怎么改？'
        : '如果给你更少的资源和时间，你会砍掉什么、保留什么？';
    },
  },
];

// 规则兜底：按深度生成追问（通用模板，深度递进）
export function followupByRules(session, candidateAnswer) {
  const idx = Math.min(session.depth - 1, FALLBACK_FOLLOWUP_LEVELS.length - 1);
  const s = FALLBACK_FOLLOWUP_LEVELS[idx];
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
  if (answer.length > 100) return '你讲得比较细，我理解了你的思路。';
  return '好的，我了解了。';
}

// ============ 预分析策略模式（方案书 §5.4：以预分析为基线，实时动态调整） ============
// 预分析缺失时显式降级为上方通用模板（方案书 §5.5 规则兜底）。
// 决策：继续（消费 baseline）→ 追问（④层追问链深档）→ 降档/拉回/换线 → 结束。

function askedQuestions(session) {
  return new Set(session.turns.filter((t) => t.role === 'interviewer').map((t) => t.content));
}

function findChain(session, mainlineId) {
  const chains = session.preanalysisPlan?.layers?.roundStrategy?.[session.roundKey]?.followupChains ?? [];
  return chains.find((c) => c.id === mainlineId) ?? null;
}

function pickFollowup(session, mainlineId, level, asked) {
  const chain = findChain(session, mainlineId);
  const items = (chain?.chain ?? []).filter((f) => f.level === level);
  return items.find((f) => !asked.has(f.question)) ?? items[0] ?? null;
}

function nextBaseline(session, baseline) {
  const item = baseline[session.baselineIndex];
  session.baselineIndex++;
  session.adjustedMainlineId = null;
  if (!item) {
    session.currentMainlineId = null;
    return {
      question: '今天的时间差不多了，我们到这里结束。你还有什么想问我的吗？',
      focusArea: '收尾',
      intent: '结束面试',
      mainlineId: null,
      adjustment: null,
      done: true,
    };
  }
  session.currentMainlineId = item.mainlineId;
  return {
    question: item.question,
    focusArea: item.focus,
    intent: item.intent,
    mainlineId: item.mainlineId,
    adjustment: null,
  };
}

function pullBack(currentItem) {
  return {
    question: '我们回到刚才的问题：' + currentItem.question + '（刚才的回答有点跑题，换个角度再说说）',
    focusArea: currentItem.focus,
    intent: '拉回话题',
    mainlineId: currentItem.mainlineId,
    adjustment: 'pull-back',
  };
}

function levelDown(session, currentItem) {
  const asked = askedQuestions(session);
  const lower =
    pickFollowup(session, currentItem.mainlineId, 'medium', asked) ??
    pickFollowup(session, currentItem.mainlineId, 'shallow', asked);
  session.adjustedMainlineId = currentItem.mainlineId;
  return {
    question: lower?.question ?? '换个更简单的角度再说一下：' + currentItem.question,
    focusArea: currentItem.focus,
    intent: lower?.intent ?? '降档追问',
    mainlineId: currentItem.mainlineId,
    adjustment: 'level-down',
  };
}

function switchLine(session, baseline) {
  const next = nextBaseline(session, baseline);
  if (next.done) return next;
  return {
    ...next,
    question: '我们换个角度来聊。' + next.question,
    adjustment: 'switch-line',
  };
}

// 策略模式决策入口：每条追问链最多 1 次档位调整；换线需 2 个信号叠加
// （难度高+流畅差+浅薄，或偏题+浅薄）——防止面试跳跃（方案书 §5.4 风险对策）。
export function nextQuestionByRules(session, signals) {
  const baseline = session.baselinePlan?.items ?? [];
  const currentId = session.currentMainlineId;
  const currentItem = baseline.find((i) => i.mainlineId === currentId) ?? null;
  const alreadyAdjusted = session.adjustedMainlineId === currentId;

  if (currentId && currentItem && signals && !alreadyAdjusted) {
    const off = signals.direction === 'off_topic';
    const stuck = signals.fluency === 'poor' || signals.difficulty === 'high';
    const collapsed = signals.difficulty === 'high' && signals.fluency === 'poor' && signals.depth === 'shallow';
    if (collapsed) return switchLine(session, baseline);
    if (off && signals.depth === 'shallow') return switchLine(session, baseline);
    if (off) return pullBack(currentItem);
    if (stuck) return levelDown(session, currentItem);
  }

  if (currentId && currentItem && signals?.direction === 'on_topic' && signals.depth === 'deep' && signals.difficulty !== 'high') {
    const deep = pickFollowup(session, currentId, 'deep', askedQuestions(session));
    if (deep) {
      return {
        question: deep.question,
        focusArea: currentItem.focus,
        intent: deep.intent,
        mainlineId: currentItem.mainlineId,
        adjustment: null,
      };
    }
  }
  return nextBaseline(session, baseline);
}
