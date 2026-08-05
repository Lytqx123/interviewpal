import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ArchiveStore } from '../src/archive/store.js';
import { createSearchProvider } from '../src/search/provider.js';
import { handleResumeUpload, handleJdPaste } from '../src/onboarding/index.js';

function tmpStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ip-onboard-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new ArchiveStore(dir);
}

const RESUME_TEXT = `张三
2019-2023 在字节跳动担任后端工程师，负责订单系统
熟悉 Redis、Kafka，掌握分布式事务`;

test('上传简历：无公司时只存档，不补全', async (t) => {
  const store = tmpStore(t);
  const result = await handleResumeUpload({
    store,
    llm: null,
    search: createSearchProvider({ provider: 'mock' }),
    content: RESUME_TEXT,
  });
  assert.ok(result.resumeProfile.skills.length >= 2);
  assert.equal(result.companyId, null);
  const saved = store.getResumeProfile();
  assert.ok(saved);
  assert.ok(saved.updatedAt);
});

test('上传简历：带公司名时补全入 round1 缓存', async (t) => {
  const store = tmpStore(t);
  const result = await handleResumeUpload({
    store,
    llm: null,
    search: createSearchProvider({ provider: 'mock' }),
    companyName: '字节跳动',
    content: RESUME_TEXT,
  });
  assert.ok(result.companyId);
  const company = store.getCompany(result.companyId);
  assert.equal(company.name, '字节跳动');
  const cache = store.getCache(result.companyId, 'round1');
  assert.ok(cache.entries.length > 0);
  assert.ok(cache.entries.some((e) => e.entityType === 'company'));
});

test('粘贴 JD：解析 → 建公司 → 岗位画像 → round2 补全', async (t) => {
  const store = tmpStore(t);
  const jdText = `岗位名称：产品经理
公司：星辰科技
岗位职责：
- 负责需求分析、撰写 PRD
任职要求：
- 3 年产品经验`;
  const result = await handleJdPaste({
    store,
    llm: null,
    search: createSearchProvider({ provider: 'mock' }),
    jdText,
  });
  assert.equal(result.jobProfile.jobType, 'product');
  assert.equal(result.company.name, '星辰科技');
  const position = store.getPosition(result.company.companyId, result.position.positionId);
  assert.equal(position.jobType, 'product');
  assert.equal(position.profile.responsibilities[0], '负责需求分析、撰写 PRD');
  assert.equal(position.jdText, jdText);
  assert.ok(store.getCache(result.company.companyId, 'round2').entries.length > 0);
});

test('粘贴 JD：重复粘贴同一家公司复用公司档案', async (t) => {
  const store = tmpStore(t);
  const first = await handleJdPaste({
    store,
    llm: null,
    search: createSearchProvider({ provider: 'mock' }),
    companyName: '星辰科技',
    jdText: '岗位名称：后端工程师',
  });
  const second = await handleJdPaste({
    store,
    llm: null,
    search: createSearchProvider({ provider: 'mock' }),
    companyName: '星辰科技',
    jdText: '岗位名称：测试工程师',
  });
  assert.equal(first.company.companyId, second.company.companyId);
  assert.equal(store.listPositions(first.company.companyId).length, 2);
});
