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
