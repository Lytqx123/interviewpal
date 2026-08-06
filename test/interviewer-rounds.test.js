import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { prepareRound2Context } from '../src/interviewer/index.js';
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
describe('面试官 · 轮次上下文准备（检索与提示词按轮次区分）', () => {
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

