import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { seedDemoData } from '../scripts/seed.mjs';
import { runDemo } from '../scripts/e2e-demo.mjs';
import { generatePlan } from '../src/preanalysis/engine.js';
import { preanalysisCacheKey } from '../src/preanalysis/cache.js';

const silent = { info() {}, error() {} };

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ip-seed-demo-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('seed：3 简历 × 3 公司 × 3 岗位，投递绑定正确简历版本', async (t) => {
  const dir = tmpDir(t);
  const { store, summary } = await seedDemoData({ storeDir: dir, log: silent });

  assert.equal(summary.resumes.length, 3);
  assert.equal(summary.companies.length, 3);
  assert.equal(summary.positions.length, 9);
  assert.equal(summary.applications.length, 3);

  // 覆盖 ≥3 种岗位类型
  const titles = new Set(summary.positions.map((p) => p.title));
  for (const expect of ['前端工程师', '后端工程师', '产品经理']) {
    assert.ok(titles.has(expect), `缺少岗位类型：${expect}`);
  }

  // 投递即冻结：一家公司一份，版本绑定正确（v1/v2/v3）
  const apps = store.listApplications();
  const byCompany = Object.fromEntries(apps.map((a) => [a.companyName, a]));
  assert.equal(byCompany['星辰科技'].resumeVersionNo, 1);
  assert.equal(byCompany['蓝海网络'].resumeVersionNo, 2);
  assert.equal(byCompany['云帆数据'].resumeVersionNo, 3);
  assert.notEqual(
    byCompany['蓝海网络'].resumeSnapshot.hash,
    byCompany['云帆数据'].resumeSnapshot.hash,
    '不同简历快照哈希应不同',
  );
});

test('seed：可重复播种（reset 幂等，无残留重复数据）', async (t) => {
  const dir = tmpDir(t);
  await seedDemoData({ storeDir: dir, log: silent });
  await seedDemoData({ storeDir: dir, log: silent });
  const store = new (await import('../src/archive/index.js')).ArchiveStore(dir);
  assert.equal(store.listCompanies().length, 3);
  assert.equal(store.listResumeVersions().length, 3);
  assert.equal(store.listApplications().length, 3);
});

test('预分析缓存：同「版本+公司+岗位」二次生成命中，删除公司联动释放', async (t) => {
  const dir = tmpDir(t);
  const { store, summary } = await seedDemoData({ storeDir: dir, log: silent });
  const resumeVersion = store.getResumeVersion(summary.resumes[0].versionId);
  const company = store.getCompany(summary.companies[0].companyId);
  const position = store.getPosition(summary.companies[0].companyId, summary.companies[0].positions[0].positionId);

  const first = await generatePlan({ resumeVersion, company, position, llm: null, store });
  const again = await generatePlan({ resumeVersion, company, position, llm: null, store });
  assert.equal(again.cached, true);
  assert.equal(first.cacheKey, again.cacheKey);

  const key = preanalysisCacheKey({
    resumeVersion,
    companyId: company.companyId,
    positionId: position.positionId,
  });
  assert.ok(store.getPreanalysisCache(key));
  store.deleteCompany(company.companyId);
  assert.equal(store.getPreanalysisCache(key), null);
});

test('demo：端到端输出包含全部验收段落', async (t) => {
  const dir = tmpDir(t);
  const { out } = await runDemo({ storeDir: dir, log: silent });
  const markers = [
    '简历解析结果',
    'JD 解析结果',
    '投递快照',
    '预分析七大层',
    '一面（简历面）baseline',
    'executionTrace',
    '六维评分',
    '逐题点评',
    '方向偏差',
    '二面（业务面）baseline 差异化',
    '二面复盘',
    '困难题沉淀清单',
    '缓存命中，秒出',
    '已联动释放',
    '端到端演示完成',
  ];
  for (const marker of markers) {
    assert.ok(out.includes(marker), `demo 输出缺少：${marker}`);
  }
});
