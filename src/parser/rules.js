import crypto from 'node:crypto';

// 规则兜底解析器。
//
// 为什么会有这个：LLM 解析是主力，但本地没配 API key 或者模型临时不可用时，
// 不能让上传流程直接挂掉。这套规则解析写得比较"粗"，只保证 schema 对、
// 常见信息能抓到，不追求跟 LLM 一样全面。

const JOB_TYPE_KEYWORDS = {
  tech: ['后端', '前端', '算法', '测试开发', 'Java', 'Python', 'Golang', '系统设计', '研发', '工程师', '数据结构'],
  product: ['产品经理', '产品运营', '需求分析', 'PRD', '用户研究', '产品设计'],
  operation: ['运营', '增长', '活动策划', '用户运营', '内容运营', '新媒体'],
  sales: ['销售', '市场', '商务', 'BD', '渠道', '客户经理'],
  function: ['行政', '财务', '会计', 'HR', '人力', '法务', '审计'],
  civil: ['公务员', '申论', '结构化面试', '事业单位', '选调', '行政职业能力'],
};

export function detectJobType(text) {
  const scores = {};
  for (const [type, keywords] of Object.entries(JOB_TYPE_KEYWORDS)) {
    scores[type] = keywords.reduce((acc, kw) => acc + (text.includes(kw) ? 1 : 0), 0);
  }
  const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  // 一个关键词都没命中就默认 tech，等 LLM 正式接上后会准很多
  return best[1] > 0 ? best[0] : 'tech';
}

export function extractSkills(text) {
  const pattern = /(?:熟悉|掌握|精通|熟练使用|熟练运用|了解)\s*([^，。；\n]{2,40})/g;
  const out = [];
  for (const m of text.matchAll(pattern)) {
    const raw = m[1].replace(/[、，]/g, ' ').split(/\s+/).filter(Boolean);
    for (const item of raw) {
      if (!out.includes(item)) out.push(item);
    }
  }
  return out;
}

export function extractCompanies(text) {
  const pattern = /(?:在|就职于|入职|工作于)\s*([\u4e00-\u9fa5A-Za-z0-9·（）()]{2,30}?)(?:公司|担任|任职|实习|负责|工作|做|，|。|\n)/g;
  const out = [];
  for (const m of text.matchAll(pattern)) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  // 兼容"XX科技有限公司"这种完整写法
  const fullNamePattern = /([\u4e00-\u9fa5]{2,20}(?:科技|网络|信息|技术|软件|集团|银行|证券))有限公司?/g;
  for (const m of text.matchAll(fullNamePattern)) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

function splitSentences(text) {
  return text
    .split(/[。！？\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 8);
}

export function parseResumeByRules(text) {
  const companies = extractCompanies(text);
  const skills = extractSkills(text);
  const experienceKeywords = ['负责', '参与', '项目', '实习', '工作', '担任', '主导', '设计并实现'];
  const experiences = splitSentences(text)
    .filter((s) => experienceKeywords.some((kw) => s.includes(kw)))
    .map((summary, i) => ({
      id: `exp_${i + 1}`,
      summary,
      org: companies.find((c) => summary.includes(c)) ?? null,
    }));

  return {
    basics: {
      // 姓名/求职方向先不深挖，等 LLM 接上再补
      name: null,
      title: null,
    },
    companies,
    skills: skills.map((name) => ({ name, level: null })),
    experiences,
    rawHash: simpleHash(text),
  };
}

export function parseJdByRules(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const titleMatch = text.match(/(?:岗位|职位)(?:名称)?[:：]\s*(\S+)/) ?? text.match(/(?:招聘|诚聘)\s*([\u4e00-\u9fa5A-Za-z0-9·（）()]{2,20})/);
  const title = titleMatch ? titleMatch[1].replace(/[，。、:：]/g, '') : '未命名岗位';

  // 简单切段：职责和要求的段落通常带标题
  const responsibilities = [];
  const requirements = [];
  let section = null;
  for (const line of lines) {
    if (/岗位职责|工作职责|职责描述/.test(line)) section = 'resp';
    else if (/任职要求|岗位要求|职位要求|任职资格/.test(line)) section = 'req';
    else if (!/岗位职责|任职要求/.test(line) && /(岗位|职位|工作)[:：]/.test(line)) section = null;
    else if (section === 'resp' && line.length > 2 && !line.endsWith('：')) responsibilities.push(stripBullet(line));
    else if (section === 'req' && line.length > 2 && !line.endsWith('：')) requirements.push(stripBullet(line));
  }

  const companyMatch = text.match(/(?:公司|单位)[:：]\s*([\u4e00-\u9fa5A-Za-z0-9·（）()]{2,30})/);
  return {
    companyName: companyMatch ? companyMatch[1] : (extractCompanies(text)[0] ?? null),
    title,
    jobType: detectJobType(text),
    responsibilities,
    requirements,
    keywords: [...new Set([...extractSkills(text), ...extractCompanies(text)])],
  };
}

function stripBullet(line) {
  return line.replace(/^[-•·*\s]+/, '').trim();
}

// 和 store 里的 simpleHash 同款实现，避免为了一个函数再抽公共模块
function simpleHash(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, 16);
}
