import { detectCommand, helpText, parseRoundCommand } from './commands.js';
import { handleResumeUpload, handleJdPaste, handleApply } from '../onboarding/index.js';
import { diagnoseBaseline, passRecommendation } from '../coach/index.js';

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
      if (intent === 'query_progress') {
        return reply(buildProgressReply(store, message.content ?? message.text ?? ''));
      }
      if (intent === 'practice_round') {
        return reply(buildPracticeReply(store, message.content ?? message.text ?? ''));
      }
      return reply(`支持的命令：\n${helpText()}`);
    } catch (err) {
      return reply(`处理失败：${err.message}`);
    }
  };
}

// 查进度：返回该公司各轮次练习与达标情况 + 通关建议（返回字符串，由外层 reply 包裹）
function buildProgressReply(store, text) {
  const companyName = text.replace(/查进度|进度查询|轮次状态|面试进度/, '').trim();
  const company = companyName ? store.findCompanyByName(companyName) : null;
  if (!company) return '请指定公司名，如「查进度 星辰科技」';
  const positions = store.listPositions(company.companyId);
  if (!positions.length) return `「${company.name}」还没有岗位，请先粘贴 JD`;
  const lines = [`📊 ${company.name} 面试进度`];
  for (const pos of positions) {
    const diag = diagnoseBaseline({ store, companyId: company.companyId, positionId: pos.positionId });
    lines.push(`\n【${pos.title}】${diag.overall}`);
    for (const r of diag.rounds) {
      const label = { round1: '一面', round2: '二面', round3: '三面' }[r.roundKey];
      const scoreText = r.latestScores ? `均分 ${(Object.values(r.latestScores).filter((v) => typeof v === 'number').reduce((a, b) => a + b, 0) / 6).toFixed(1)}` : '未练';
      const status = r.completedCount === 0 ? '⚪ 未练' : r.ready ? '🟢 达标' : '🟡 已练未达标';
      lines.push(`  ${label}：${status}（练 ${r.completedCount} 次，${scoreText}）`);
    }
    const cur = diag.currentRound;
    lines.push(`  → 下一步：${cur.label}（${cur.reason}）`);
  }
  return lines.join('\n');
}

// 开始某轮：解析轮次 + 公司，返回二面业务面参考资料（岗位职责+公司业务+前沿话题）
function buildPracticeReply(store, text) {
  const args = parseRoundCommand(text);
  if (!args) return '格式：练二面 公司名 [岗位名]，如「练二面 星辰科技 后端工程师」';
  const company = store.findCompanyByName(args.companyName ?? '');
  if (!company) return `没有找到公司「${args.companyName}」，请先粘贴该公司 JD`;
  const positions = store.listPositions(company.companyId);
  const pos = args.positionTitle
    ? positions.find((p) => p.title.includes(args.positionTitle) || args.positionTitle.includes(p.title))
    : positions[0];
  if (!pos) return `「${company.name}」没有匹配的岗位`;
  const label = { round1: '一面', round2: '二面', round3: '三面' }[args.roundKey];
  const round = pos.rounds[args.roundKey];
  const lines = [
    `🎯 准备开始${label}：${company.name} / ${pos.title}`,
    `已练 ${round.completedCount} 次${round.completedCount ? `，上次 ${round.lastPracticedAt?.slice(0, 10)}` : ''}`,
  ];
  if (args.roundKey === 'round2') {
    const resps = pos.profile?.responsibilities ?? [];
    const cache = store.getCache(company.companyId, 'round2');
    const biz = (cache?.entries ?? []).slice(0, 3).map((e) => e.entityName);
    lines.push('\n【二面业务面参考资料】');
    lines.push(`- 岗位职责：${resps.length ? resps.join('；') : '（参考 JD）'}`);
    lines.push(`- 公司业务：${biz.length ? biz.join('、') : '（暂无缓存，将联网补全）'}`);
    lines.push('- 前沿探索题：将联网搜索行业前沿话题，考察突发应对与思维拓展力');
  }
  const advise = passRecommendation({ store, companyId: company.companyId, positionId: pos.positionId, roundKey: args.roundKey });
  lines.push(`\n通关建议：${advise.reason}（${advise.action}）`);
  return lines.join('\n');
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
