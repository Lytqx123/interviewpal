import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSession, startInterview, askFollowup, closeInterview, getSessionSummary,
  openingByRules, followupByRules, closingByRules,
} from '../src/interviewer/index.js';

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
