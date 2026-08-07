import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ArchiveStore } from '../src/archive/store.js';
import { createSearchProvider } from '../src/search/provider.js';
import { enrichResume, enrichJd, collectResumeEntities, collectJdEntities, enrichCompanyBusiness, refreshEnrich } from '../src/enrich/enrich.js';

function tmpStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ip-enrich-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new ArchiveStore(dir);
}

test('实体收集：简历公司 + 技能，JD 公司 + 职责', () => {
  const resume = { companies: ['字节跳动'], skills: [{ name: 'Redis' }, { name: 'Kafka' }] };
  const resumeEntities = collectResumeEntities(resume);
  assert.equal(resumeEntities.length, 3);
  assert.ok(resumeEntities.some((e) => e.kind === 'company' && e.name === '字节跳动'));

  const jd = { companyName: '星辰科技', responsibilities: ['负责订单系统设计'] };
  const jdEntities = collectJdEntities(jd);
  assert.ok(jdEntities.some((e) => e.kind === 'company'));
  assert.ok(jdEntities.some((e) => e.kind === 'job'));
});

test('简历补全：结果带时间戳/来源/置信度入 round1 缓存', async (t) => {
  const store = tmpStore(t);
  const company = store.createCompany({ name: '星辰科技' });
  const result = await enrichResume({
    store,
    search: createSearchProvider(),
    resumeProfile: { companies: ['星辰科技'], skills: [{ name: 'Redis' }] },
    companyId: company.companyId,
    roundKey: 'round1',
  });
  assert.ok(result.cachedCount > 0);
  const cache = store.getCache(company.companyId, 'round1');
  assert.ok(cache.entries.length > 0);
  const entry = cache.entries[0];
  assert.ok(entry.retrievedAt);
  assert.ok(entry.source.startsWith('https://example.com/'));
  assert.ok(typeof entry.confidence === 'number');
  assert.equal(entry.verified, false);
});

test('JD 补全：入 round2 缓存，未绑定公司时跳过', async (t) => {
  const store = tmpStore(t);
  const company = store.createCompany({ name: '星辰科技' });
  const result = await enrichJd({
    store,
    search: createSearchProvider(),
    jobProfile: { companyName: '星辰科技', responsibilities: ['负责订单系统设计'] },
    companyId: company.companyId,
    roundKey: 'round2',
  });
  assert.ok(result.cachedCount > 0);
  assert.ok(store.getCache(company.companyId, 'round2').entries.length > 0);

  const skipped = await enrichResume({
    store,
    search: null,
    resumeProfile: { companies: ['xx'], skills: [] },
    companyId: null,
  });
  assert.equal(skipped.skipped, true);
});

test('P1 进阶：enrichCompanyBusiness 补全公司业务方向入 round2 缓存', async (t) => {
  const store = tmpStore(t);
  const company = store.createCompany({ name: '星辰科技' });
  const result = await enrichCompanyBusiness({
    store,
    search: createSearchProvider(),
    companyName: '星辰科技',
    companyId: company.companyId,
    roundKey: 'round2',
  });
  assert.ok(result.cachedCount > 0, '应缓存业务方向检索结果');
  const cache = store.getCache(company.companyId, 'round2');
  assert.ok(cache.entries.length > 0);
  // 业务方向检索词应包含公司名
  assert.ok(cache.entries.some((e) => e.entityName.includes('星辰科技')), '缓存条目含公司名');

  // 缺公司名/search/companyId 时跳过
  const skipped = await enrichCompanyBusiness({ store, search: null, companyName: '', companyId: null });
  assert.equal(skipped.skipped, true);
});

test('P1 进阶：refreshEnrich 跳过未过期条目、刷新过期条目（不产生重复）', async (t) => {
  const store = tmpStore(t);
  const company = store.createCompany({ name: '星辰科技' });
  // 先写入一条 round2 缓存
  await enrichJd({
    store,
    search: createSearchProvider(),
    jobProfile: { companyName: '星辰科技', responsibilities: ['负责订单系统设计'] },
    companyId: company.companyId,
    roundKey: 'round2',
  });
  const before = store.getCache(company.companyId, 'round2').entries;
  assert.ok(before.length > 0);

  // 未过期：全部跳过
  const fresh = await refreshEnrich({ store, search: createSearchProvider(), companyId: company.companyId, roundKey: 'round2' });
  assert.equal(fresh.refreshed, 0, '未过期条目不刷新');
  assert.equal(fresh.skipped, before.length);
  assert.equal(fresh.total, before.length);
  // 条目数不变（无重复）
  assert.equal(store.getCache(company.companyId, 'round2').entries.length, before.length, '未过期时条目数不变');

  // 手动把 expiresAt 改到过去，模拟过期
  const cache = store.getCache(company.companyId, 'round2');
  for (const e of cache.entries) e.expiresAt = new Date(Date.now() - 1000).toISOString();
  store.saveJson(
    path.join(store.companyDir(company.companyId), 'cache', 'round2.json'),
    cache,
  );

  // 过期：全部刷新，原地更新（条目数仍不变）
  const refreshed = await refreshEnrich({ store, search: createSearchProvider(), companyId: company.companyId, roundKey: 'round2' });
  assert.equal(refreshed.refreshed, before.length, '过期条目全部刷新');
  assert.equal(refreshed.skipped, 0);
  const after = store.getCache(company.companyId, 'round2').entries;
  assert.equal(after.length, before.length, '原地更新不产生重复条目');
  // expiresAt 已被更新到未来
  assert.ok(new Date(after[0].expiresAt).getTime() > Date.now(), '刷新后 expiresAt 延后');
});

test('P1 进阶：refreshEnrich 无缓存/无 search 时返回 0', async (t) => {
  const store = tmpStore(t);
  const company = store.createCompany({ name: '空公司' });
  const r1 = await refreshEnrich({ store, search: createSearchProvider(), companyId: company.companyId, roundKey: 'round2' });
  assert.equal(r1.total, 0, '无缓存时 total=0');

  const r2 = await refreshEnrich({ store, search: null, companyId: company.companyId, roundKey: 'round2' });
  assert.equal(r2.refreshed, 0, '无 search 时 refreshed=0');
});
