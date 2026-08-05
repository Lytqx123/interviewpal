import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ArchiveStore } from '../src/archive/store.js';
import { createSearchProvider } from '../src/search/provider.js';
import { handleResumeUpload, handleJdPaste, handleApply, parseApplyCommand } from '../src/onboarding/index.js';

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
  assert.equal(result.version.versionNo, 1);
  assert.equal(result.version.immutable, true);
  const saved = store.getResumeProfile();
  assert.ok(saved);
  assert.equal(saved.activeVersionId, result.version.versionId);
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

test('投递命令解析：公司 / 岗位 / 版本', () => {
  assert.deepEqual(parseApplyCommand('投递到 星辰科技'), {
    companyName: '星辰科技',
    positionTitle: null,
    versionNo: null,
  });
  assert.deepEqual(parseApplyCommand('投递 v2 到 星辰科技 产品经理'), {
    companyName: '星辰科技',
    positionTitle: '产品经理',
    versionNo: 2,
  });
  assert.deepEqual(parseApplyCommand('投递到星辰科技公司产品经理'), {
    companyName: '星辰科技公司',
    positionTitle: '产品经理',
    versionNo: null,
  });
  assert.equal(parseApplyCommand('你好'), null);
  assert.equal(parseApplyCommand('投递到'), null);
});

test('投递：上传简历 + 粘贴 JD → 投递生成冻结快照，重复投递被拒绝', async (t) => {
  const store = tmpStore(t);
  await handleResumeUpload({
    store,
    llm: null,
    search: createSearchProvider({ provider: 'mock' }),
    content: RESUME_TEXT,
  });
  await handleJdPaste({
    store,
    llm: null,
    search: createSearchProvider({ provider: 'mock' }),
    companyName: '星辰科技',
    jdText: '岗位名称：产品经理',
  });

  const result = await handleApply({ store, text: '投递到 星辰科技' });
  assert.equal(result.company.name, '星辰科技');
  assert.equal(result.position.title, '产品经理');
  assert.equal(result.version.versionNo, 1);

  const app = store.getApplicationByCompany(result.company.companyId);
  assert.equal(app.resumeVersionNo, 1);
  assert.equal(app.immutable, true);
  assert.ok(app.resumeSnapshot.charCount > 0);

  // 同一家公司重复投递：冻结，必须拒绝
  await assert.rejects(() => handleApply({ store, text: '投递到 星辰科技' }), /投递即冻结/);
});

test('投递：指定版本与岗位，同一版本可投多家公司', async (t) => {
  const store = tmpStore(t);
  await handleResumeUpload({ store, content: '第一版简历' });
  await handleResumeUpload({ store, content: '第二版简历' });
  await handleJdPaste({ store, companyName: 'A公司', jdText: '岗位名称：后端工程师' });
  await handleJdPaste({ store, companyName: 'B公司', jdText: '岗位名称：测试工程师' });

  const r = await handleApply({ store, text: '投递 v2 到 A公司 后端工程师' });
  assert.equal(r.version.versionNo, 2);
  assert.equal(r.position.title, '后端工程师');

  // B 公司还没投过，可以用 v1（新版本只能投未投递的公司，旧版本仍可投新公司）
  const r2 = await handleApply({ store, text: '投递 v1 到 B公司' });
  assert.equal(r2.version.versionNo, 1);
  assert.equal(r2.position.title, '测试工程师');
});

test('投递：缺少前置条件时给出引导', async (t) => {
  const store = tmpStore(t);
  await assert.rejects(
    () => handleApply({ store, text: '投递到 不存在的公司' }),
    /请先粘贴该公司 JD/,
  );

  await handleJdPaste({ store, companyName: 'A公司', jdText: '岗位名称：后端工程师' });
  await assert.rejects(() => handleApply({ store, text: '投递到 A公司' }), /还没有简历版本/);
});
