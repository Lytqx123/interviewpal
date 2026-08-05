import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { newId } from './ids.js';
import { ROUND_KEYS, JOB_TYPES, CACHE_TTL_MS } from './constants.js';
import { emptyRounds } from './entities.js';

// companyId / positionId 只允许这些字符，防止路径穿越。
const COMPANY_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const POSITION_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * 档案库（文件存储核心），对应方案书 §5.6 的树状组织 + §5.8 的档案库组件。
 *
 * 目录结构（按公司隔离）：
 *   <root>/
 *     user.json                       全局层：用户画像（跟人走）
 *     companies/<companyId>/
 *       company.json                  公司画像
 *       positions/<positionId>.json   岗位画像（含轮次状态、次数）
 *       applications/*.json           投递快照（投递即冻结，§5.2）
 *       cache/<roundKey>.json         检索缓存（按轮次打标签，§5.5）
 *       reviews/*.json                复盘记录（§5.7/§5.9）
 *
 * 阶段一先用 JSON 文件 + 目录当存储：零依赖、可以直接看、可以手工改。
 * 后面场次多起来或者要并发写，再换 SQLite / OpenClaw 自带的 memory 机制。
 */
export class ArchiveStore {
  constructor(rootDir) {
    this.root = path.resolve(rootDir);
    fs.mkdirSync(this.root, { recursive: true });
  }

  // ---------- 底层文件操作 ----------

  assertCompanyId(companyId) {
    if (typeof companyId !== 'string' || !COMPANY_ID_RE.test(companyId)) {
      throw new Error(`invalid companyId: ${companyId}`);
    }
  }

  assertPositionId(positionId) {
    if (typeof positionId !== 'string' || !POSITION_ID_RE.test(positionId)) {
      throw new Error(`invalid positionId: ${positionId}`);
    }
  }

  assertRoundKey(roundKey) {
    if (!ROUND_KEYS.includes(roundKey)) {
      throw new Error(`invalid roundKey: ${roundKey}, 可选 ${ROUND_KEYS.join('/')}`);
    }
  }

  companyDir(companyId) {
    this.assertCompanyId(companyId);
    return path.join(this.root, 'companies', companyId);
  }

  readJson(file, fallback) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') return fallback;
      throw err;
    }
  }

  saveJson(file, obj) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // 先写临时文件再 rename，避免写到一半进程挂了留下半个 json
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  }

  listJsonFiles(dir) {
    try {
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isFile() && d.name.endsWith('.json'))
        .map((d) => path.join(dir, d.name));
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
  }

  listCompanyIds() {
    const dir = path.join(this.root, 'companies');
    try {
      return fs.readdirSync(dir).filter((name) => COMPANY_ID_RE.test(name));
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
  }

  // ---------- 用户画像（全局层，跟人走） ----------

  getUserProfile() {
    return this.readJson(path.join(this.root, 'user.json'), null);
  }

  saveUserProfile(profile) {
    const now = new Date().toISOString();
    const data = {
      ...profile,
      version: 1,
      userId: profile.userId ?? newId('u'),
      createdAt: profile.createdAt ?? now,
      updatedAt: now,
    };
    this.saveJson(path.join(this.root, 'user.json'), data);
    return data;
  }

  // ---------- 简历画像（全局层，跟人走，§3.3/§5.3） ----------

  // 简历画像是"人"的属性，不是公司/岗位的属性：
  // 一份简历可以投多家公司，所以放在全局层，和 user.json 平级。
  getResumeProfile() {
    return this.readJson(path.join(this.root, 'resume.json'), null);
  }

  saveResumeProfile(profile) {
    const now = new Date().toISOString();
    const data = {
      ...profile,
      version: 1,
      createdAt: profile.createdAt ?? now,
      updatedAt: now,
    };
    this.saveJson(path.join(this.root, 'resume.json'), data);
    return data;
  }

  // ---------- 公司（一层：公司画像） ----------

  createCompany({ name, focus = false, notes = '' } = {}) {
    if (!name || typeof name !== 'string') {
      throw new Error('company name required');
    }
    const companyId = newId('c');
    const now = new Date().toISOString();
    const company = {
      version: 1,
      companyId,
      name,
      focus,
      archived: false,
      notes,
      createdAt: now,
      updatedAt: now,
    };
    this.saveJson(path.join(this.companyDir(companyId), 'company.json'), company);
    return company;
  }

  // 按名字找公司：飞书命令里用户可能直接说"粘贴 XX 公司 JD"，不用再手动建公司
  findCompanyByName(name) {
    if (!name) return null;
    return this.listCompanies({ includeArchived: true }).find((c) => c.name === name) ?? null;
  }

  getCompany(companyId) {
    this.assertCompanyId(companyId);
    return this.readJson(path.join(this.companyDir(companyId), 'company.json'), null);
  }

  updateCompany(companyId, patch) {
    const current = this.getCompany(companyId);
    if (!current) throw new Error(`company not found: ${companyId}`);
    const next = {
      ...current,
      ...patch,
      companyId: current.companyId,
      createdAt: current.createdAt,
      updatedAt: new Date().toISOString(),
    };
    this.saveJson(path.join(this.companyDir(companyId), 'company.json'), next);
    return next;
  }

  listCompanies({ includeArchived = false } = {}) {
    const companies = this.listCompanyIds()
      .map((id) => this.getCompany(id))
      .filter(Boolean);
    return includeArchived ? companies : companies.filter((c) => !c.archived);
  }

  // 焦点公司同时只有一家，设置时把其它公司都取消（§5.6）
  setFocusCompany(companyId) {
    this.assertCompanyId(companyId);
    for (const company of this.listCompanies({ includeArchived: true })) {
      if (company.focus) this.updateCompany(company.companyId, { focus: false });
    }
    return this.updateCompany(companyId, { focus: true });
  }

  archiveCompany(companyId, archived = true) {
    return this.updateCompany(companyId, { archived });
  }

  // ---------- 岗位（二层：岗位画像 + 轮次状态） ----------

  createPosition(companyId, { title, jdText = '', jobType = 'tech' } = {}) {
    if (!title || typeof title !== 'string') {
      throw new Error('position title required');
    }
    if (!JOB_TYPES.includes(jobType)) {
      throw new Error(`invalid jobType: ${jobType}, 可选 ${JOB_TYPES.join('/')}`);
    }
    const positionId = newId('p');
    const now = new Date().toISOString();
    const position = {
      version: 1,
      positionId,
      companyId,
      title,
      jdText,
      jobType,
      // 目标岗位画像：真实 JD 职责/要求/关键词，由联网补全模块填充（§5.3）
      profile: { responsibilities: [], requirements: [], keywords: [] },
      resumeVersionId: null, // 投递后绑定终版简历（§5.2）
      rounds: emptyRounds(),
      createdAt: now,
      updatedAt: now,
    };
    this.saveJson(path.join(this.companyDir(companyId), 'positions', `${positionId}.json`), position);
    return position;
  }

  getPosition(companyId, positionId) {
    this.assertPositionId(positionId);
    return this.readJson(path.join(this.companyDir(companyId), 'positions', `${positionId}.json`), null);
  }

  updatePosition(companyId, positionId, patch) {
    const current = this.getPosition(companyId, positionId);
    if (!current) throw new Error(`position not found: ${companyId}/${positionId}`);
    const next = {
      ...current,
      ...patch,
      positionId: current.positionId,
      companyId: current.companyId,
      createdAt: current.createdAt,
      updatedAt: new Date().toISOString(),
    };
    this.saveJson(path.join(this.companyDir(companyId), 'positions', `${positionId}.json`), next);
    return next;
  }

  listPositions(companyId) {
    const dir = path.join(this.companyDir(companyId), 'positions');
    return this.listJsonFiles(dir)
      .map((file) => this.readJson(file, null))
      .filter(Boolean);
  }

  getRoundState(companyId, positionId, roundKey) {
    this.assertRoundKey(roundKey);
    const position = this.getPosition(companyId, positionId);
    return position?.rounds[roundKey] ?? null;
  }

  // 一轮练完，次数 +1（同一轮次可反复练，§5.4）。复盘记录单独存 review。
  recordRoundSession(companyId, positionId, roundKey, { sessionId, reviewId = null } = {}) {
    this.assertRoundKey(roundKey);
    const position = this.getPosition(companyId, positionId);
    if (!position) throw new Error(`position not found: ${companyId}/${positionId}`);
    const round = position.rounds[roundKey];
    round.completedCount += 1;
    round.lastSessionId = sessionId ?? round.lastSessionId;
    round.lastReviewId = reviewId ?? round.lastReviewId;
    round.lastPracticedAt = new Date().toISOString();
    return this.updatePosition(companyId, positionId, { rounds: position.rounds });
  }

  // ---------- 投递快照（投递即冻结，§5.2） ----------

  createApplication(companyId, { positionId, resumeVersionId, resumeSnapshotText = '' } = {}) {
    if (!positionId || !resumeVersionId) {
      throw new Error('positionId and resumeVersionId required');
    }
    const position = this.getPosition(companyId, positionId);
    if (!position) throw new Error(`position not found: ${companyId}/${positionId}`);

    // 投递即冻结：一家公司一旦绑定某个简历版本，就不能再投其它版本。
    // 版本本身可复用（同一版投多家公司没问题），所以这里只查公司、不查版本。
    if (this.getApplicationByCompany(companyId)) {
      throw new Error('company already has an application, 投递即冻结：不可更换简历版本');
    }

    const applicationId = newId('a');
    const now = new Date().toISOString();
    const application = {
      version: 1,
      applicationId,
      companyId,
      positionId,
      resumeVersionId,
      resumeSnapshot: {
        text: resumeSnapshotText,
        charCount: resumeSnapshotText.length,
        // 先做简单哈希，至少能判断"内容有没有变"；简历解析模块出来后再换正式摘要
        hash: simpleHash(resumeSnapshotText),
      },
      submittedAt: now,
      immutable: true,
    };
    this.saveJson(
      path.join(this.companyDir(companyId), 'applications', `${applicationId}.json`),
      application,
    );

    // 岗位绑定这份终版简历：模拟始终练投出去的那份（§5.2）
    this.updatePosition(companyId, positionId, { resumeVersionId });
    return application;
  }

  getApplicationByCompany(companyId) {
    const files = this.listJsonFiles(path.join(this.companyDir(companyId), 'applications'));
    // 一家公司理论上最多一份，取最新的兜底
    const apps = files.map((f) => this.readJson(f, null)).filter(Boolean);
    apps.sort((a, b) => String(b.submittedAt).localeCompare(String(a.submittedAt)));
    return apps[0] ?? null;
  }

  // 全局审计用：扫所有公司目录（§5.2 的审计链）
  listApplications() {
    const out = [];
    for (const companyId of this.listCompanyIds()) {
      const app = this.getApplicationByCompany(companyId);
      if (app) out.push(app);
    }
    return out;
  }

  // ---------- 检索缓存（按公司 + 轮次隔离，§5.3/§5.5） ----------

  getCache(companyId, roundKey) {
    this.assertRoundKey(roundKey);
    return this.readJson(path.join(this.companyDir(companyId), 'cache', `${roundKey}.json`), null);
  }

  putCacheEntry(companyId, roundKey, entry = {}) {
    this.assertRoundKey(roundKey);
    const cache =
      this.getCache(companyId, roundKey) ?? {
        version: 1,
        companyId,
        roundKey,
        entries: [],
      };
    const now = Date.now();
    const ttl = entry.ttl ?? CACHE_TTL_MS.volatile;
    const item = {
      id: newId('ce'),
      entityType: entry.entityType ?? 'generic',
      entityName: entry.entityName ?? '',
      source: entry.source ?? '',
      summary: entry.summary ?? '',
      confidence: entry.confidence ?? 0.5,
      retrievedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttl).toISOString(),
      verified: Boolean(entry.verified),
    };
    cache.entries.push(item);
    this.saveJson(path.join(this.companyDir(companyId), 'cache', `${roundKey}.json`), cache);
    return item;
  }

  pruneExpiredCache(companyId, roundKey) {
    const cache = this.getCache(companyId, roundKey);
    if (!cache) return 0;
    const now = Date.now();
    const before = cache.entries.length;
    cache.entries = cache.entries.filter((e) => new Date(e.expiresAt).getTime() > now);
    this.saveJson(path.join(this.companyDir(companyId), 'cache', `${roundKey}.json`), cache);
    return before - cache.entries.length;
  }

  clearCache(companyId, roundKey) {
    const file = path.join(this.companyDir(companyId), 'cache', `${roundKey}.json`);
    try {
      fs.rmSync(file);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  // ---------- 复盘记录（§5.7/§5.9） ----------

  saveReview(review) {
    if (!review?.companyId) throw new Error('review.companyId required');
    this.assertCompanyId(review.companyId);
    const now = new Date().toISOString();
    const data = {
      ...review,
      version: 1,
      reviewId: review.reviewId ?? newId('rv'),
      createdAt: review.createdAt ?? now,
      updatedAt: now,
    };
    this.saveJson(
      path.join(this.companyDir(review.companyId), 'reviews', `${data.reviewId}.json`),
      data,
    );
    return data;
  }

  getReview(reviewId) {
    // 复盘挂在公司下面，不知道 companyId 就全扫（数据量小，先这样）
    for (const companyId of this.listCompanyIds()) {
      const review = this.readJson(
        path.join(this.companyDir(companyId), 'reviews', `${reviewId}.json`),
        null,
      );
      if (review) return review;
    }
    return null;
  }

  // 过滤条件可组合：公司 / 岗位 / 轮次。默认返回全部，按时间倒序（对比报告用）。
  listReviews({ companyId, positionId, roundKey } = {}) {
    const companyIds = companyId ? [companyId] : this.listCompanyIds();
    const out = [];
    for (const cid of companyIds) {
      for (const file of this.listJsonFiles(path.join(this.companyDir(cid), 'reviews'))) {
        const review = this.readJson(file, null);
        if (!review) continue;
        if (positionId && review.positionId !== positionId) continue;
        if (roundKey && review.roundKey !== roundKey) continue;
        out.push(review);
      }
    }
    out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return out;
  }
}

// 简历内容的简单哈希，判断"是否同一版"够用了
function simpleHash(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, 16);
}

// 默认把数据放在项目根目录的 data/ 下；测试或部署时传自己的目录
export function createArchive(rootDir = path.join(process.cwd(), 'data')) {
  return new ArchiveStore(rootDir);
}
