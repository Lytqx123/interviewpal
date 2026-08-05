// 飞书命令识别（阶段二先不依赖飞书 SDK）。
//
// 消息统一按这个扁平结构进来（字段名对齐飞书事件，方便后面 OpenClaw
// 渠道接好之后直接适配）：
//   { messageType: 'text'|'file', text, fileName, fileKey, companyName }

const COMMANDS = [
  {
    intent: 'upload_resume',
    needs: 'file',
    patterns: [/上传简历/, /发简历/, /简历上传/, /upload\s*resume/i],
    help: '上传简历：直接发简历文件，或发送「上传简历」+ 简历文本',
  },
  {
    intent: 'paste_jd',
    needs: 'text',
    patterns: [/粘贴\s*jd/i, /添加\s*jd/i, /jd\s*粘贴/i, /把jd发给你/, /贴\s*jd/i],
    help: '粘贴 JD：把目标岗位的 JD 文本发给我（可以带公司名，如「粘贴 XX 公司 JD：...」）',
  },
  {
    intent: 'apply_company',
    needs: 'text',
    patterns: [/投递/, /apply\s*to/i],
    help: '投递：发送「投递到 公司名 [岗位名]」，可指定简历版本（如「投递 v2 到 星辰科技 产品经理」）；投递即冻结，不可换版本',
  },
  {
    intent: 'query_progress',
    needs: 'text',
    patterns: [/查进度/, /进度查询/, /轮次状态/, /面试进度/],
    help: '查进度：发送「查进度 公司名」查看该公司各轮次练习与达标情况',
  },
  {
    intent: 'practice_round',
    needs: 'text',
    patterns: [/练一面/, /练二面/, /练三面/, /开始一面/, /开始二面/, /开始三面/, /练习\s*[一二三]面/],
    help: '开始某轮：发送「练二面 公司名 [岗位名]」开始该轮模拟（二面以岗位职责+公司业务+前沿探索题展开）',
  },
];

export function detectCommand(message) {
  const { messageType = 'text', text = '', fileName = '' } = message ?? {};

  // 文件消息：文件名带"简历"直接当上传简历处理
  if (messageType === 'file' && /(简历|resume)/i.test(fileName)) {
    return { intent: 'upload_resume', command: COMMANDS[0] };
  }

  for (const command of COMMANDS) {
    if (command.patterns.some((p) => p.test(text))) {
      return { intent: command.intent, command };
    }
  }
  return { intent: 'unknown', command: null };
}

export function helpText() {
  return COMMANDS.map((c) => c.help).join('\n');
}

// 解析轮次命令：从「练二面 公司名 岗位名」提取 roundKey + 公司名 + 岗位名
const ROUND_MAP = { 一: 'round1', 二: 'round2', 三: 'round3', 1: 'round1', 2: 'round2', 3: 'round3' };
export function parseRoundCommand(text) {
  if (!text) return null;
  const m = text.match(/(?:练|开始|练习)\s*([一二三1-3])\s*面/);
  if (!m) return null;
  const roundKey = ROUND_MAP[m[1]];
  if (!roundKey) return null;
  // 去掉命令前缀，剩下作为"公司名 岗位名"
  const rest = text.replace(/(?:练|开始|练习)\s*[一二三1-3]\s*面/, '').trim();
  let companyName = rest;
  let positionTitle = null;
  const tokens = rest.split(/\s+/).filter(Boolean);
  if (tokens.length >= 2) {
    companyName = tokens[0];
    positionTitle = tokens.slice(1).join(' ');
  } else if (tokens.length === 1) {
    companyName = tokens[0];
  }
  return { roundKey, companyName: companyName || null, positionTitle };
}
