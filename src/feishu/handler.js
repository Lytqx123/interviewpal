import { detectCommand, helpText } from './commands.js';
import { handleResumeUpload, handleJdPaste, handleApply } from '../onboarding/index.js';

// 飞书消息入口：识别命令 → 调 onboarding 流程 → 返回给飞书的文本回复。
// 现在返回 { text }，等真实渠道接好之后在这里换成飞书消息卡片/语音。
export function createMessageHandler({ store, llm, search, reply = (text) => ({ text }) }) {
  return async function handleMessage(message) {
    const { intent } = detectCommand(message);
    try {
      if (intent === 'upload_resume') {
        if (!message.content && !message.fileKey) {
          return reply('请把简历文件发给我，或直接粘贴简历文本。');
        }
        const content = message.content ?? `[file:${message.fileName}]`;
        const result = await handleResumeUpload({
          store,
          llm,
          search,
          companyName: message.companyName ?? null,
          fileName: message.fileName ?? null,
          content,
        });
        return reply(buildResumeReply(result));
      }
      if (intent === 'paste_jd') {
        if (!message.content) {
          return reply('请把 JD 文本发给我（可以带公司名，如「粘贴 XX 公司 JD：...」）。');
        }
        const result = await handleJdPaste({
          store,
          llm,
          search,
          companyName: message.companyName ?? null,
          jdText: message.content,
        });
        return reply(buildJdReply(result));
      }
      if (intent === 'apply_company') {
        try {
          const result = await handleApply({ store, text: message.content ?? message.text ?? '' });
          return reply(buildApplyReply(result));
        } catch (err) {
          // 投递失败大多是业务规则（公司没建档/版本不存在/重复投递），给明确提示而不是通用错误。
          return reply(`投递失败：${err.message}`);
        }
      }
      return reply(`支持的命令：\n${helpText()}`);
    } catch (err) {
      return reply(`处理失败：${err.message}`);
    }
  };
}

function buildResumeReply(result) {
  const { resumeProfile, companyId, enrichment } = result;
  const lines = [
    '✅ 简历已解析并存入档案：',
    `- 简历版本：v${result.version.versionNo}（不可变，投递时绑定）`,
    `- 技能 ${resumeProfile.skills.length} 项：${resumeProfile.skills.map((s) => s.name).join('、') || '未识别'}`,
    `- 经历 ${resumeProfile.experiences.length} 段`,
    `- 识别到公司：${resumeProfile.companies.join('、') || '无'}`,
  ];
  if (companyId) {
    const cached = enrichment?.cachedCount ?? 0;
    lines.push(`- 已联网补全并缓存 ${cached} 条（来源 + 置信度已记录）`);
  } else {
    lines.push('- 尚未绑定公司：发送「粘贴 XX 公司 JD」绑定公司后会自动补全');
  }
  return lines.join('\n');
}

function buildJdReply(result) {
  const { jobProfile, position } = result;
  const lines = [
    `✅ JD 已解析（公司：${jobProfile.companyName ?? '未命名公司'} / 岗位：${jobProfile.title}）`,
    `- 岗位类型：${jobProfile.jobType}`,
    `- 职责 ${jobProfile.responsibilities.length} 条，要求 ${jobProfile.requirements.length} 条`,
    `- 已联网补全并缓存 ${result.enrichment?.cachedCount ?? 0} 条`,
  ];
  if (position) lines.push(`- 岗位档案：${position.positionId}`);
  return lines.join('\n');
}

function buildApplyReply(result) {
  const { application, company, position, version } = result;
  return [
    '✅ 已投递并冻结：',
    `- 公司：${company.name} / 岗位：${position.title}`,
    `- 简历版本：v${version.versionNo}（快照已存档，不可更换版本）`,
    `- 投递时间：${application.submittedAt}`,
  ].join('\n');
}
