// 投递流水线（投递即冻结）：
// 命令「投递到 XX公司 [岗位]」→ 解析公司/岗位/简历版本 → 生成不可变投递快照。
//
// 规则：
//  1. 简历版本由每次上传自动创建（v1/v2...），创建即不可变；
//  2. 一家公司一旦投过某版本，就绑定该版本，重复投递会被拒绝；
//  3. 同一版本可以投多家公司，新版本只能投未投过的公司。

export function parseApplyCommand(text) {
  if (!text) return null;
  const trimmed = String(text).trim();
  const rest =
    trimmed.match(/投递\s*(?:到|给)?\s*(.*)/)?.[1] ??
    trimmed.match(/apply\s+to\s*(.*)/i)?.[1];
  if (!rest) return null;
  let tail = rest.trim();
  if (!tail) return null;

  // 版本：支持「投递 v2 到 XX」「投递版本2到 XX」两种写法
  let versionNo = null;
  const verMatch = tail.match(/(?:版本|v)\s*(\d+)/i);
  if (verMatch) {
    versionNo = Number(verMatch[1]);
    tail = tail.replace(verMatch[0], '').replace(/\s+/g, ' ').trim();
    // 版本号写在中缀时（投递 v2 到 XX），去掉残留的"到/给"
    tail = tail.replace(/^(?:到|给)\s*/, '').trim();
  }

  let companyName = tail;
  let positionTitle = null;

  // 「XX公司YY岗位」这类不带空格的写法：公司名到"公司"为止
  const companyPos = tail.match(/^(.+?公司)\s*(.+)$/);
  if (companyPos) {
    companyName = companyPos[1].trim();
    positionTitle = companyPos[2].trim();
  } else {
    const tokens = tail.split(/\s+/).filter(Boolean);
    if (tokens.length >= 2) {
      companyName = tokens[0];
      positionTitle = tokens.slice(1).join(' ');
    }
  }

  positionTitle = positionTitle?.replace(/^(?:的|岗位|职位)[:：]?/, '').trim() || null;
  return { companyName, positionTitle, versionNo };
}

export async function handleApply({ store, text }) {
  const args = parseApplyCommand(text);
  if (!args) {
    throw new Error('格式：投递到 公司名 [岗位名]；可指定版本，如「投递 v2 到 公司名 岗位名」');
  }
  const company = resolveCompany(store, args.companyName);
  const position = resolvePosition(store, company.companyId, args.positionTitle);
  const version = resolveVersion(store, args.versionNo);
  const application = store.createApplication(company.companyId, {
    positionId: position.positionId,
    resumeVersionId: version.versionId,
  });
  return { application, company, position, version };
}

// 公司名允许轻微模糊（"星辰" → "星辰科技"），但多个候选时必须明确，避免投错公司。
function resolveCompany(store, name) {
  if (!name) throw new Error('请指定公司名，如「投递到 星辰科技」');
  const exact = store.findCompanyByName(name);
  if (exact) return exact;
  const candidates = store
    .listCompanies()
    .filter((c) => c.name.includes(name) || name.includes(c.name));
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    throw new Error(`「${name}」匹配到多家公司（${candidates.map((c) => c.name).join('、')}），请用完整公司名`);
  }
  throw new Error(`没有找到公司「${name}」，请先粘贴该公司 JD`);
}

function resolvePosition(store, companyId, title) {
  const positions = store.listPositions(companyId);
  if (!title) {
    if (positions.length === 0) throw new Error('该公司还没有岗位，请先粘贴 JD');
    if (positions.length > 1) {
      throw new Error(
        `该公司有多个岗位（${positions.map((p) => p.title).join('、')}），请指定岗位，如「投递到 公司名 岗位名」`,
      );
    }
    return positions[0];
  }
  const hits = positions.filter((p) => p.title.includes(title) || title.includes(p.title));
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) throw new Error(`岗位「${title}」匹配到多个，请用完整岗位名`);
  throw new Error(`没有找到岗位「${title}」，该公司岗位：${positions.map((p) => p.title).join('、') || '无'}`);
}

function resolveVersion(store, versionNo) {
  const versions = store.listResumeVersions();
  if (versions.length === 0) throw new Error('还没有简历版本，请先上传简历');
  const version = versionNo
    ? versions.find((v) => v.versionNo === versionNo)
    : versions[versions.length - 1];
  if (!version) {
    throw new Error(
      `没有找到简历版本 v${versionNo}，当前版本：${versions.map((v) => `v${v.versionNo}`).join('、')}`,
    );
  }
  return version;
}
