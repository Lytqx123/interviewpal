import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ArchiveStore } from '../src/archive/index.js';
import { newReviewRecord } from '../src/archive/entities.js';

// 每个用例都用一个独立的临时目录，测完自动删掉
function tmpStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ip-archive-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new ArchiveStore(dir);
}

test('用户画像：保存、读取、保留 userId、更新时间', (t) => {
  const store = tmpStore(t);
  assert.equal(store.getUserProfile(), null);

  const created = store.saveUserProfile({ jobIntent: { targetRole: '后端工程师' } });
  assert.ok(created.userId.startsWith('u_'));

  const updated = store.saveUserProfile({
    ...store.getUserProfile(),
    jobIntent: { targetRole: '产品经理' },
  });
  assert.equal(updated.userId, created.userId);
  assert.equal(updated.jobIntent.targetRole, '产品经理');
  assert.equal(store.getUserProfile().jobIntent.targetRole, '产品经理');
});

test('公司：创建 / 列表 / 焦点唯一 / 归档', (t) => {
  const store = tmpStore(t);
  const a = store.createCompany({ name: 'A 公司' });
  const b = store.createCompany({ name: 'B 公司' });
  assert.equal(store.listCompanies().length, 2);

  store.setFocusCompany(a.companyId);
  assert.equal(store.getCompany(a.companyId).focus, true);
  assert.equal(store.getCompany(b.companyId).focus, false);

  store.archiveCompany(b.companyId, true);
  assert.equal(store.listCompanies().length, 1);
  assert.equal(store.listCompanies({ includeArchived: true }).length, 2);
});

test('岗位与轮次：次数自增、轮次互不影响、非法输入拒绝', (t) => {
  const store = tmpStore(t);
  const company = store.createCompany({ name: '测试公司' });
  const pos = store.createPosition(company.companyId, { title: '后端工程师', jobType: 'tech' });

  assert.equal(pos.rounds.round1.completedCount, 0);
  assert.throws(() => store.createPosition(company.companyId, { title: 'x', jobType: 'nope' }), /jobType/);

  store.recordRoundSession(company.companyId, pos.positionId, 'round1', { sessionId: 's_1' });
  const after = store.getPosition(company.companyId, pos.positionId);
  assert.equal(after.rounds.round1.completedCount, 1);
  assert.equal(after.rounds.round1.lastSessionId, 's_1');
  assert.equal(after.rounds.round2.completedCount, 0);

  assert.throws(
    () => store.recordRoundSession(company.companyId, pos.positionId, 'round9', {}),
    /roundKey/,
  );
});

test('投递快照：投递即冻结、版本可跨公司复用、岗位绑定终版', (t) => {
  const store = tmpStore(t);
  const c1 = store.createCompany({ name: '公司一' });
  const c2 = store.createCompany({ name: '公司二' });
  const p1 = store.createPosition(c1.companyId, { title: '后端' });
  const p2 = store.createPosition(c2.companyId, { title: '后端' });

  const app = store.createApplication(c1.companyId, {
    positionId: p1.positionId,
    resumeVersionId: 'r_A',
    resumeSnapshotText: '简历 v1 全文',
  });
  assert.equal(app.resumeVersionId, 'r_A');
  assert.equal(store.getApplicationByCompany(c1.companyId).resumeVersionId, 'r_A');
  assert.equal(store.getPosition(c1.companyId, p1.positionId).resumeVersionId, 'r_A');

  // 同一家公司再投别的版本：冻结，必须拒绝
  assert.throws(
    () =>
      store.createApplication(c1.companyId, {
        positionId: p1.positionId,
        resumeVersionId: 'r_B',
        resumeSnapshotText: '简历 v2',
      }),
    /投递即冻结/,
  );

  // 同一版本投另一家公司：允许
  const app2 = store.createApplication(c2.companyId, {
    positionId: p2.positionId,
    resumeVersionId: 'r_A',
    resumeSnapshotText: '简历 v1 全文',
  });
  assert.equal(app2.resumeVersionId, 'r_A');
  assert.equal(store.listApplications().length, 2);
});

test('检索缓存：写入 / 过期清理 / 清空', (t) => {
  const store = tmpStore(t);
  const company = store.createCompany({ name: '缓存公司' });

  store.putCacheEntry(company.companyId, 'round2', {
    entityType: 'company',
    entityName: 'XX科技',
    source: '官网',
    summary: '主营芯片设计',
    confidence: 0.9,
    ttl: 60 * 60 * 1000,
  });
  store.putCacheEntry(company.companyId, 'round2', { entityName: '过期消息', ttl: -1 });

  assert.equal(store.getCache(company.companyId, 'round2').entries.length, 2);
  assert.equal(store.pruneExpiredCache(company.companyId, 'round2'), 1);

  const cache = store.getCache(company.companyId, 'round2');
  assert.equal(cache.entries.length, 1);
  assert.equal(cache.entries[0].entityName, 'XX科技');

  store.clearCache(company.companyId, 'round2');
  assert.equal(store.getCache(company.companyId, 'round2'), null);
});

test('复盘记录：保存 / 过滤 / 倒序 / 按 ID 读取', (t) => {
  const store = tmpStore(t);
  const company = store.createCompany({ name: '复盘公司' });
  const pos = store.createPosition(company.companyId, { title: '产品经理', jobType: 'product' });

  const r1 = store.saveReview(
    newReviewRecord({
      companyId: company.companyId,
      positionId: pos.positionId,
      roundKey: 'round1',
      sessionId: 's_1',
      createdAt: '2026-08-05T01:00:00.000Z',
    }),
  );
  const r2 = store.saveReview(
    newReviewRecord({
      companyId: company.companyId,
      positionId: pos.positionId,
      roundKey: 'round1',
      sessionId: 's_2',
      createdAt: '2026-08-05T02:00:00.000Z',
    }),
  );

  assert.equal(store.listReviews({ companyId: company.companyId }).length, 2);
  assert.equal(store.listReviews({ companyId: company.companyId, roundKey: 'round2' }).length, 0);
  assert.equal(store.getReview(r1.reviewId).sessionId, 's_1');
  assert.equal(store.getReview('not_exist'), null);

  const list = store.listReviews({ companyId: company.companyId });
  assert.equal(list[0].reviewId, r2.reviewId); // 最新的在前
});

test('公司隔离与路径安全', (t) => {
  const store = tmpStore(t);
  const a = store.createCompany({ name: '公司A' });
  const b = store.createCompany({ name: '公司B' });
  store.createPosition(a.companyId, { title: '岗位A' });
  store.createPosition(b.companyId, { title: '岗位B' });

  const titlesA = store.listPositions(a.companyId).map((p) => p.title);
  assert.deepEqual(titlesA, ['岗位A']);
  assert.equal(store.getPosition(b.companyId, 'p_not_exists'), null);

  // 非法 companyId 直接拒绝，防止路径穿越
  assert.throws(() => store.getCompany('../../etc'), /companyId/);
  assert.throws(() => store.createPosition('..\\..\\x', { title: 'x' }), /companyId/);
});
