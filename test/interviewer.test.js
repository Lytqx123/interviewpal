import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSession, startInterview, askFollowup, nextQuestion, buildBaselinePlan, closeInterview, getSessionSummary, ingestSignal,
  openingByRules, followupByRules, closingByRules,
} from '../src/interviewer/index.js';
import { buildFallbackPlan } from '../src/preanalysis/fallback.js';

// 测试用简历画像（覆盖技能/经历/公司）
const RESUME = {
  basics: { name: '张三', title: '后端工程师' },
  companies: ['字节跳动', '蚂蚁集团'],
  skills: [{ name: 'Redis', level: '熟练' }, { name: 'Kafka', level: '熟悉' }],
  experiences: [
    { id: 'exp_1', summary: '在字节跳动负责订单系统，QPS 从 500 提升到 2000', org: '字节跳动' },
    { id: 'exp_2', summary: '在蚂蚁集团参与支付链路重构', org: '蚂蚁集团' },
  ],
  rawHash: 'abc123',
};

// 测试用岗位画像
function jobProfile(jobType = 'tech', title = '高级后端工程师') {
  return {
    companyName: '星辰科技', title, jobType,
    responsibilities: ['负责订单系统设计', '参与高并发改造'],
    requirements: ['熟悉 Java', '3 年以上经验'],
    keywords: ['订单', '高并发'],
  };
}

describe('面试官 · 规则兜底', () => {
  it('openingByRules：生成开场白 + 首个问题，含候选人名与岗位', () => {
    const r = openingByRules({ resumeProfile: RESUME, jobProfile: jobProfile('tech'), roundKey: 'round1' });
    assert.ok(r.greeting.includes('张三'), '开场白含候选人名');
    assert.ok(r.greeting.includes('后端工程师'), '开场白含岗位');
    assert.ok(r.question.length > 10, '首个问题非空');
    assert.ok(r.focusArea, '有追问方向');
    assert.ok(r.intent, '有考察意图');
  });

  it('openingByRules：首个问题是破冰，不与第 1 轮追问重复', () => {
    const ctx = { resumeProfile: RESUME, jobProfile: jobProfile('tech') };
    const opening = openingByRules(ctx);
    assert.equal(opening.focusArea, '破冰', '开场白首个问题是破冰');
    const session = createSession(ctx);
    session.depth = 1;
    const f1 = followupByRules(session, '回答');
    assert.notEqual(opening.question, f1.question, '开场白问题不应与第 1 轮追问重复');
    assert.notEqual(opening.focusArea, f1.focusArea, '开场白方向不应与第 1 轮追问相同');
  });

  it('openingByRules：三种轮次 intro 不同', () => {
    const r1 = openingByRules({ resumeProfile: RESUME, jobProfile: jobProfile(), roundKey: 'round1' });
    const r2 = openingByRules({ resumeProfile: RESUME, jobProfile: jobProfile(), roundKey: 'round2' });
    const r3 = openingByRules({ resumeProfile: RESUME, jobProfile: jobProfile(), roundKey: 'round3' });
    assert.ok(r1.greeting.includes('简历'));
    assert.ok(r2.greeting.includes('业务'));
    assert.ok(r3.greeting.includes('宏观'));
  });

  it('followupByRules：tech 三层深度追问方向递进（项目深挖→技术原理→系统设计）', () => {
    const session = createSession({ resumeProfile: RESUME, jobProfile: jobProfile('tech') });
    session.depth = 1;
    const f1 = followupByRules(session, '我负责订单系统的核心模块');
    assert.equal(f1.focusArea, '项目深挖');
    session.depth = 2;
    const f2 = followupByRules(session, '用了 Redis 做缓存');
    assert.equal(f2.focusArea, '技术原理');
    session.depth = 3;
    const f3 = followupByRules(session, 'Redis 底层是单线程模型');
    assert.equal(f3.focusArea, '系统设计');
  });

  it('followupByRules：product 三层深度追问方向（场景设计→取舍决策→数据验证）', () => {
    const session = createSession({ resumeProfile: RESUME, jobProfile: jobProfile('product', '产品经理') });
    session.depth = 1;
    assert.equal(followupByRules(session, '回答').focusArea, '场景设计');
    session.depth = 2;
    assert.equal(followupByRules(session, '回答').focusArea, '取舍决策');
    session.depth = 3;
    assert.equal(followupByRules(session, '回答').focusArea, '数据验证');
  });

  it('followupByRules：6 种岗位类型策略池都有 3 层', () => {
    for (const jobType of ['tech', 'product', 'operation', 'sales', 'function', 'civil']) {
      const session = createSession({ resumeProfile: RESUME, jobProfile: jobProfile(jobType) });
      const areas = [1, 2, 3].map((d) => {
        session.depth = d;
        return followupByRules(session, '回答').focusArea;
      });
      assert.equal(areas.length, 3, `${jobType} 应有 3 层`);
      assert.equal(new Set(areas).size, 3, `${jobType} 三层方向应不同`);
    }
  });

  it('followupByRules：未识别 jobType 走默认策略', () => {
    const session = createSession({ resumeProfile: RESUME, jobProfile: jobProfile('unknown_type') });
    session.depth = 1;
    const f = followupByRules(session, '回答');
    assert.ok(f.focusArea, '默认策略也有追问方向');
  });

  it('followupByRules：acknowledgment 根据回答长度变化', () => {
    const session = createSession({ resumeProfile: RESUME, jobProfile: jobProfile() });
    session.depth = 1;
    const short = followupByRules(session, '嗯');
    const long = followupByRules(session, '这是一个很长的回答'.repeat(20));
    assert.notEqual(short.acknowledgment, long.acknowledgment, '长短回答的回应应不同');
  });

  it('closingByRules：生成收尾', () => {
    const session = createSession({ resumeProfile: RESUME, jobProfile: jobProfile() });
    const c = closingByRules(session);
    assert.ok(c.question.includes('面试就到这里') || c.question.includes('想问'));
  });
});

describe('面试官 · 引擎（规则路径）', () => {
  it('createSession：缺参数报错', () => {
    assert.throws(() => createSession({ resumeProfile: RESUME }));
    assert.throws(() => createSession({ jobProfile: jobProfile() }));
  });

  it('startInterview：规则路径生成开场白+首个问题', async () => {
    const session = createSession({ resumeProfile: RESUME, jobProfile: jobProfile('tech') });
    const r = await startInterview(session);
    assert.ok(r.greeting, '有开场白');
    assert.ok(r.question, '有首个问题');
    assert.equal(session.phase, 'probing');
    assert.equal(session.turns.length, 1, '记录了面试官首轮发言');
  });

  it('askFollowup：3 轮追问，第 3 轮 shouldClose=true', async () => {
    const session = createSession({ resumeProfile: RESUME, jobProfile: jobProfile('tech'), maxDepth: 3 });
    await startInterview(session);
    const f1 = await askFollowup(session, '我负责订单系统');
    assert.equal(f1.shouldClose, false);
    assert.equal(session.depth, 1);
    const f2 = await askFollowup(session, '用了 Redis 做缓存');
    assert.equal(f2.shouldClose, false);
    assert.equal(session.depth, 2);
    const f3 = await askFollowup(session, 'Redis 是单线程模型');
    assert.equal(f3.shouldClose, true);
    assert.equal(session.depth, 3);
    assert.equal(session.phase, 'closing');
  });

  it('askFollowup：追问方向随深度递进', async () => {
    const session = createSession({ resumeProfile: RESUME, jobProfile: jobProfile('tech') });
    await startInterview(session);
    const areas = [];
    for (let i = 0; i < 3; i++) {
      const f = await askFollowup(session, `候选人回答第${i + 1}轮`);
      areas.push(f.focusArea);
    }
    assert.deepEqual(areas, ['项目深挖', '技术原理', '系统设计']);
  });

  it('askFollowup：maxDepth 可配置', async () => {
    const session = createSession({ resumeProfile: RESUME, jobProfile: jobProfile(), maxDepth: 2 });
    await startInterview(session);
    const f1 = await askFollowup(session, '回答1');
    assert.equal(f1.shouldClose, false);
    const f2 = await askFollowup(session, '回答2');
    assert.equal(f2.shouldClose, true);
  });

  it('对话历史：面试官与候选人交替记录', async () => {
    const session = createSession({ resumeProfile: RESUME, jobProfile: jobProfile() });
    await startInterview(session);
    await askFollowup(session, '回答1');
    await askFollowup(session, '回答2');
    // turns: [interviewer(开场), candidate(答1), interviewer(追问1), candidate(答2), interviewer(追问2)]
    assert.equal(session.turns.length, 5);
    assert.equal(session.turns[0].role, 'interviewer');
    assert.equal(session.turns[1].role, 'candidate');
    assert.equal(session.turns[2].role, 'interviewer');
    assert.equal(session.turns[3].role, 'candidate');
    assert.equal(session.turns[4].role, 'interviewer');
    // 面试官发言含问题内容
    assert.ok(session.turns[0].content.length > 0);
    assert.ok(session.turns[2].content.length > 0);
  });

  it('closeInterview：正式收尾', async () => {
    const session = createSession({ resumeProfile: RESUME, jobProfile: jobProfile() });
    await startInterview(session);
    const c = await closeInterview(session);
    assert.equal(session.phase, 'closed');
    assert.ok(c.question);
  });

  it('getSessionSummary：摘要正确', async () => {
    const session = createSession({ resumeProfile: RESUME, jobProfile: jobProfile('product', '产品经理'), roundKey: 'round2' });
    await startInterview(session);
    await askFollowup(session, '回答1');
    const summary = getSessionSummary(session);
    assert.equal(summary.roundKey, 'round2');
    assert.equal(summary.jobType, 'product');
    assert.equal(summary.depth, 1);
    assert.equal(summary.maxDepth, 3);
    assert.ok(summary.focusAreas.length > 0);
  });
});

describe('面试官 · LLM 路径', () => {
  // fake LLM：根据 system prompt 判断是开场白还是追问，返回对应 JSON
  function fakeLlm() {
    return async (messages) => {
      const sys = messages[0]?.content ?? '';
      if (sys.includes('生成开场白')) {
        return JSON.stringify({
          greeting: '你好张三，我是星辰科技的面试官。',
          question: '请先做个自我介绍，重点说说你最近的项目经历。',
          focusArea: '自我介绍',
          intent: '破冰与经历概览',
        });
      }
      return JSON.stringify({
        acknowledgment: '明白了。',
        question: '你提到订单系统，能说说你做的缓存方案吗？',
        focusArea: '项目深挖',
        intent: '验证技术细节',
      });
    };
  }

  it('startInterview：LLM 路径解析开场白', async () => {
    const session = createSession({ resumeProfile: RESUME, jobProfile: jobProfile(), llm: fakeLlm() });
    const r = await startInterview(session);
    assert.equal(r.greeting, '你好张三，我是星辰科技的面试官。');
    assert.equal(r.focusArea, '自我介绍');
  });

  it('askFollowup：LLM 路径解析追问', async () => {
    const session = createSession({ resumeProfile: RESUME, jobProfile: jobProfile(), llm: fakeLlm() });
    await startInterview(session);
    const f = await askFollowup(session, '我做过订单系统');
    assert.equal(f.acknowledgment, '明白了。');
    assert.equal(f.focusArea, '项目深挖');
    assert.equal(f.shouldClose, false);
  });

  it('LLM 失败时落回规则兜底', async () => {
    const badLlm = async () => { throw new Error('network error'); };
    const session = createSession({ resumeProfile: RESUME, jobProfile: jobProfile('tech'), llm: badLlm });
    const r = await startInterview(session);
    assert.ok(r.question, 'LLM 挂了仍有开场白');
    assert.ok(r.focusArea, '规则兜底有追问方向');
    const f = await askFollowup(session, '回答');
    assert.ok(f.question, '追问也有规则兜底');
  });

  it('LLM 返回垃圾时落回规则兜底', async () => {
    const garbageLlm = async () => '这不是 JSON';
    const session = createSession({ resumeProfile: RESUME, jobProfile: jobProfile('tech'), llm: garbageLlm });
    const r = await startInterview(session);
    assert.ok(r.question, '垃圾输出仍有规则兜底');
  });
});

// ============ 预分析策略模式（方案书 §5.4：baseline + 实时信号 + 动态调整） ============

function r2StrategyPlan() {
  return buildFallbackPlan({
    resumeVersion: {
      versionId: 'ver_1',
      versionNo: 1,
      rawText: '张三是后端工程师，熟悉 Redis 和 Kafka，负责订单系统 QPS 提升',
      profile: {
        basics: { name: '张三', title: '后端工程师' },
        skills: [{ name: 'Redis', level: '熟练' }],
        experiences: [{ id: 'exp_1', summary: '在字节跳动负责订单系统，QPS 从 500 提升到 2000', org: '字节跳动' }],
      },
    },
    company: { companyId: 'c_1', name: '星宸科技' },
    position: {
      positionId: 'p_1',
      title: '高级后端工程师',
      jobType: 'tech',
      profile: { responsibilities: ['负责订单系统设计'], requirements: ['熟悉 Java'], keywords: ['订单'] },
    },
  });
}

describe('面试官 · 预分析策略模式（方案书 §5.4）', () => {
  const plan = r2StrategyPlan();

  it('createSession：不传 strategyPlan 显式回退规则模式，传了走策略模式', () => {
    const fallback = createSession({ resumeProfile: RESUME, jobProfile: jobProfile() });
    assert.equal(fallback.mode, 'rules-fallback');
    assert.equal(fallback.baselinePlan.items.length, 0);
    assert.equal(fallback.state, 'planned');

    const s = createSession({ resumeProfile: RESUME, jobProfile: jobProfile(), strategyPlan: plan });
    assert.equal(s.mode, 'strategy');
    assert.ok(s.baselinePlan.items.length >= 5);
  });

  it('buildBaselinePlan：题数 ≥5 且每题对应④层追问链之一', () => {
    const ids = new Set(Object.values(plan.layers.roundStrategy).flatMap((r) => (r.followupChains ?? []).map((c) => c.id)));
    for (const round of ['round1', 'round2', 'round3']) {
      const bp = buildBaselinePlan(plan, round);
      assert.ok(bp.items.length >= 5, `${round} 题数 ${bp.items.length} >= 5`);
      for (const item of bp.items) {
        assert.ok(ids.has(item.mainlineId), `${item.mainlineId} 属于④层追问链`);
      }
      assert.ok(bp.positioning, `${round} 有⑦节奏/④策略定位`);
    }
  });

  it('buildBaselinePlan：二面与一面差异化（业务面 + 前沿探索来自⑦节奏/roundContext）', () => {
    const r1 = buildBaselinePlan(plan, 'round1');
    const r2 = buildBaselinePlan(plan, 'round2', {
      responsibilities: ['负责订单系统设计'],
      companyBusiness: [{ name: '星宸科技', summary: '企业级 SaaS' }],
      frontierTopics: [{ topic: '大模型 Agent 面试新趋势' }],
    });
    assert.notEqual(r1.items[0].mainlineId, r2.items[0].mainlineId, '二面主线排序与一面不同');
    assert.notEqual(r1.positioning.rhythm.curve, r2.positioning.rhythm.curve, '⑦节奏体验随轮次不同');
    assert.ok(r2.items.some((i) => i.question.includes('大模型 Agent 面试新趋势')), '前沿探索注入');
    assert.ok(r2.items.some((i) => i.question.includes('订单系统设计')), '业务职责注入');
  });

  it('ingestSignal：四类信号提取（卡顿/偏题）', () => {
    const stuck = ingestSignal('技术方案我不太清楚，没深入研究过，嗯……就是就是……这个……', {
      question: '请讲讲你的技术方案',
    });
    assert.equal(stuck.difficulty, 'high');
    assert.equal(stuck.fluency, 'poor');
    assert.equal(stuck.direction, 'on_topic');

    const off = ingestSignal('我觉得篮球很有意思，平时经常看比赛', { question: '请讲讲你的技术方案' });
    assert.equal(off.direction, 'off_topic');
  });

  it('nextQuestion：卡顿信号触发降档追问（深→中）', async () => {
    const session = createSession({ resumeProfile: RESUME, jobProfile: jobProfile('tech'), strategyPlan: plan });
    await startInterview(session);
    assert.equal(session.state, 'running');
    const f1 = await nextQuestion(session, '我负责订单系统的核心模块，做了 Redis 缓存');
    assert.equal(f1.mainlineId, plan.layers.roundStrategy.round1.followupChains[0].id);

    const f2 = await nextQuestion(session, '技术方案我不太清楚，没深入研究过，嗯……就是就是……这个……');
    assert.equal(f2.adjustment, 'level-down');
    assert.equal(f2.mainlineId, f1.mainlineId);
    assert.equal(session.state, 'adjusting');
    const medium = plan.layers.roundStrategy.round1.followupChains.find((c) => c.id === f1.mainlineId).chain.find((f) => f.level === 'medium');
    assert.equal(f2.question, medium.question, '降档到 medium 追问');
  });

  it('nextQuestion：偏题信号触发拉回话术', async () => {
    const session = createSession({ resumeProfile: RESUME, jobProfile: jobProfile('tech'), strategyPlan: plan });
    await startInterview(session);
    const f1 = await nextQuestion(session, '我负责订单系统的核心模块');
    const f2 = await nextQuestion(session, '我觉得篮球很有意思，平时经常看比赛，工作内容我不是很了解');
    assert.equal(f2.adjustment, 'pull-back');
    assert.ok(f2.question.includes('回到刚才的问题'));
    assert.equal(f2.mainlineId, f1.mainlineId);
  });

  it('nextQuestion：深挖崩盘（难度高+流畅差+浅薄）触发换线', async () => {
    const session = createSession({ resumeProfile: RESUME, jobProfile: jobProfile('tech'), strategyPlan: plan });
    await startInterview(session);
    const f1 = await nextQuestion(session, '我负责订单系统的核心模块');
    const f2 = await nextQuestion(session, '嗯嗯……这个这个这个这个这个这个……就是就是……不清楚，没做过');
    assert.equal(f2.adjustment, 'switch-line');
    assert.notEqual(f2.mainlineId, f1.mainlineId);
    assert.ok(f2.question.includes('换个角度'));
    assert.equal(session.state, 'adjusting');
  });

  it('nextQuestion：同一主线最多 1 次档位调整，再次卡顿走 baseline', async () => {
    const session = createSession({ resumeProfile: RESUME, jobProfile: jobProfile('tech'), strategyPlan: plan });
    await startInterview(session);
    await nextQuestion(session, '我负责订单系统的核心模块');
    const f2 = await nextQuestion(session, '技术方案我不太清楚，没深入研究过，嗯……就是就是……这个……');
    assert.equal(f2.adjustment, 'level-down');
    const f3 = await nextQuestion(session, '方案还是不太清楚，嗯……就是就是……');
    assert.notEqual(f3.adjustment, 'level-down');
    assert.notEqual(f3.mainlineId, 'r1c1');
  });

  it('executionTrace：关闭后输出每题耗时、信号、是否换线', async () => {
    const session = createSession({ resumeProfile: RESUME, jobProfile: jobProfile('tech'), strategyPlan: plan });
    await startInterview(session);
    await nextQuestion(session, '我负责订单系统的核心模块');
    await nextQuestion(session, '技术方案我不太清楚，嗯……就是就是……');
    await closeInterview(session);
    const summary = getSessionSummary(session);
    assert.equal(summary.state, 'closed');
    assert.equal(summary.mode, 'strategy');
    assert.ok(summary.executionTrace.length >= 2);
    for (const entry of summary.executionTrace) {
      assert.ok(Number.isFinite(entry.elapsedMs), '有实际耗时');
      assert.ok(entry.signals?.difficulty, '有信号');
      assert.ok('adjustment' in entry, '有是否换线/调整标记');
    }
  });

  it('失忆不变量：两场 session 独立，信号与 baseline 不串扰', async () => {
    const a = createSession({ resumeProfile: RESUME, jobProfile: jobProfile('tech'), strategyPlan: plan });
    const b = createSession({ resumeProfile: RESUME, jobProfile: jobProfile('tech'), strategyPlan: plan });
    await startInterview(a);
    await startInterview(b);
    await nextQuestion(a, '我负责订单系统的核心模块');
    await nextQuestion(a, '技术方案我不太清楚，嗯……就是就是……');
    assert.equal(a.depth, 2);
    assert.equal(a.signals.length, 2);
    assert.equal(b.depth, 0);
    assert.equal(b.turns.length, 1);
    assert.equal(b.baselineIndex, 0);
    assert.equal(b.signals.length, 0);
  });

  it('nextQuestion：strategy 模式 LLM 可用时保留规则决策的调整标记', async () => {
    const fakeLlm = async (messages) => {
      const sys = messages[0]?.content ?? '';
      if (sys.includes('【实时信号】') && sys.includes('level-down')) {
        return JSON.stringify({
          question: '降档追问：你能更基础地讲讲吗？',
          focusArea: '项目深挖',
          intent: '降档追问',
        });
      }
      return JSON.stringify({
        question: '正常追问：说说你的技术方案',
        focusArea: '项目深挖',
        intent: '验证细节',
      });
    };
    const session = createSession({
      resumeProfile: RESUME,
      jobProfile: jobProfile('tech'),
      strategyPlan: plan,
      llm: fakeLlm,
    });
    await startInterview(session);
    await nextQuestion(session, '我负责订单系统的核心模块');
    const f2 = await nextQuestion(session, '技术方案我不太清楚，没深入研究过，嗯……就是就是……这个……');
    assert.equal(f2.question, '降档追问：你能更基础地讲讲吗？');
    assert.equal(f2.adjustment, 'level-down', 'LLM 未声明时沿用规则决策标记');
  });
});
