import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createSession, startInterview, askFollowup, followupByRules, prepareRound2Context } from '../src/interviewer/index.js';
import { ArchiveStore } from '../src/archive/index.js';

const RESUME = {
  basics: { name: '李四', title: '后端工程师' },
  companies: ['星宸科技'],
  skills: [{ name: 'Redis', level: '熟练' }],
  experiences: [{ id: 'exp_1', summary: '负责订单系统，QPS 提升 4 倍', org: '星宸科技' }],
  rawHash: 'x',
};
const JOB = { companyName: '星宸科技', title: '高级后端工程师', jobType: 'tech', responsibilities: ['负责订单系统设计', '保障高并发稳定'], requirements: ['熟悉 Java'], keywords: ['订单', '高并发'] };

function tmpStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ip-rounds-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new ArchiveStore(dir);
}
describe('面试官 · 轮次差异化策略（方案书 §5.4）', () => {
  it('二面（round2）追问引用岗位职责与公司业务', async () => {
    const session = createSession({
      resumeProfile: RESUME, jobProfile: JOB, roundKey: 'round2', maxDepth: 3,
      roundContext: {
        responsibilities: ['负责订单系统设计'],
        companyBusiness: [{ name: '订单业务', summary: '日均订单百万级' }],
        frontierTopics: [],
      },
    });
    await startInterview(session);
    await askFollowup(session, '我叫李四，做了三年后端。');
    // 第 1 轮追问应是"业务理解"，引用岗位职责
    const last = session.turns[session.turns.length - 1];
    assert.ok(last.content.includes('订单系统设计'), `业务理解题引用职责：${last.content}`);
  });

  it('二面前沿探索题：有联网话题时引用前沿动态', async () => {
    const session = createSession({
      resumeProfile: RESUME, jobProfile: JOB, roundKey: 'round2', maxDepth: 3,
      roundContext: { responsibilities: ['负责订单系统'], companyBusiness: [], frontierTopics: [{ topic: 'AI 驱动的智能订单调度', summary: '新趋势' }] },
    });
    await startInterview(session);
    await askFollowup(session, '回答一'.repeat(10));
    await askFollowup(session, '回答二'.repeat(10));
    await askFollowup(session, '回答三'.repeat(10));
    // 第 3 轮追问是前沿探索，应含前沿话题
    const frontierQ = session.turns[session.turns.length - 1].content;
    assert.ok(frontierQ.includes('AI 驱动的智能订单调度') || frontierQ.includes('趋势'), `前沿题引用话题：${frontierQ}`);
  });

  it('二面无联网话题时用压力题模板兜底', async () => {
    const session = createSession({
      resumeProfile: RESUME, jobProfile: JOB, roundKey: 'round2', maxDepth: 3,
      roundContext: { responsibilities: [], companyBusiness: [], frontierTopics: [] },
    });
    await startInterview(session);
    await askFollowup(session, '回答一'.repeat(10));
    await askFollowup(session, '回答二'.repeat(10));
    await askFollowup(session, '回答三'.repeat(10));
    // 第 3 轮追问落到前沿探索兜底（无联网话题 → 岗位类型压力题模板）
    const frontierQ = session.turns[session.turns.length - 1].content;
    assert.ok(frontierQ.includes('压力') || frontierQ.includes('突发') || frontierQ.includes('假设'), `兜底压力题：${frontierQ}`);
    // 确认是前沿探索层而非案例深挖层（案例深挖也含"假设"，需靠 focusArea 区分）
    assert.equal(session.turns[session.turns.length - 1].focusArea, '前沿探索', `兜底题聚焦前沿探索：${frontierQ}`);
  });

  it('三面（round3）追问聚焦职业规划/价值观/抗压', async () => {
    const session = createSession({ resumeProfile: RESUME, jobProfile: JOB, roundKey: 'round3', maxDepth: 3 });
    await startInterview(session);
    await askFollowup(session, '回答一'.repeat(10));
    const q1 = session.turns[session.turns.length - 1].content;
    assert.ok(q1.includes('职业规划') || q1.includes('为什么选择'), `三面第1轮职业规划：${q1}`);
  });

  it('followupByRules：round2 与 round1 策略不同', () => {
    const s1 = createSession({ resumeProfile: RESUME, jobProfile: JOB, roundKey: 'round1' });
    s1.depth = 1;
    const r1 = followupByRules(s1, '回答');
    const s2 = createSession({ resumeProfile: RESUME, jobProfile: JOB, roundKey: 'round2', roundContext: { responsibilities: ['订单系统'], companyBusiness: [], frontierTopics: [] } });
    s2.depth = 1;
    const r2 = followupByRules(s2, '回答');
    assert.notEqual(r1.focusArea, r2.focusArea, '一面与二面首追问方向不同');
    assert.equal(r2.focusArea, '业务理解', '二面首追问是业务理解');
  });
});

describe('面试官 · 轮次上下文准备（方案书 §5.5）', () => {
  it('prepareRound2Context：取岗位职责 + 公司业务缓存 + 联网前沿话题', async (t) => {
    const store = tmpStore(t);
    const company = store.createCompany({ name: '星辰科技' });
    const pos = store.createPosition(company.companyId, { title: '高级后端工程师', jobType: 'tech' });
    store.updatePosition(company.companyId, pos.positionId, { profile: { responsibilities: ['负责订单系统设计'], requirements: [], keywords: [] } });
    // 写入公司业务缓存
    store.putCacheEntry(company.companyId, 'round2', { entityType: 'company', entityName: '订单业务', summary: '日均百万订单', source: 'mock' });

    const mockSearch = { async search(q) { return [{ title: `${q} 前沿趋势`, url: 'u', snippet: 'AI 调度', publishedAt: '2026-08-01', confidence: 0.7 }]; } };
    const ctx = await prepareRound2Context({ store, search: mockSearch, companyId: company.companyId, positionId: pos.positionId });
    assert.deepEqual(ctx.responsibilities, ['负责订单系统设计'], '取到岗位职责');
    assert.equal(ctx.companyBusiness.length, 1, '取到公司业务缓存');
    assert.equal(ctx.companyBusiness[0].name, '订单业务', '公司业务名');
    assert.ok(ctx.frontierTopics.length === 1, '联网前沿话题');
    assert.ok(ctx.frontierTopics[0].topic.includes('前沿趋势'), '前沿话题内容');
  });

  it('prepareRound2Context：无 search 时前沿话题降级为空（不阻塞）', async (t) => {
    const store = tmpStore(t);
    const company = store.createCompany({ name: 'X公司' });
    const pos = store.createPosition(company.companyId, { title: '后端', jobType: 'tech' });
    const ctx = await prepareRound2Context({ store, search: null, companyId: company.companyId, positionId: pos.positionId });
    assert.deepEqual(ctx.frontierTopics, [], '无 search 时前沿话题为空');
  });
});

