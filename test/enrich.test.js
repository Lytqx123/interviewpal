import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ArchiveStore } from '../src/archive/store.js';
import { createSearchProvider } from '../src/search/provider.js';
import { enrichResume, enrichJd, collectResumeEntities, collectJdEntities } from '../src/enrich/enrich.js';

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
    search: createSearchProvider({ provider: 'mock' }),
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
    search: createSearchProvider({ provider: 'mock' }),
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
