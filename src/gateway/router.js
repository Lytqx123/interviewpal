// Gateway 命令路由：识别 App 聊天指令 → 调用 handlers → 返回统一回复。
// 双路径复用：真实 OpenClaw Gateway 模式下作为主机侧命令脑；
// mock 模式下本地直接执行，保证无 key 也能端到端演示。

import {
  handleApplyCommand,
  handleDifficultCommand,
  handleHelpCommand,
  handleOutboxCommand,
  handlePasteJdCommand,
  handleReviewCommand,
  handleSalaryCommand,
  handleStartRoundCommand,
  handleStatusCommand,
  handleUploadResumeCommand,
} from './handlers.js';

const COMMAND_PATTERNS = [
  { intent: 'upload_resume', re: /^\s*(?:请|帮我)?(?:上传|粘贴|添加)?\s*简历\s*[:：]?\s*[\s\S]*|^\s*resume\s*[:：]?\s*[\s\S]*/i },
  { intent: 'paste_jd', re: /^\s*(?:请|帮我)?(?:粘贴|上传|添加)?\s*(?:JD|jd|岗位描述|职位描述|岗位职责)\s*[:：]?\s*[\s\S]*/ },
  { intent: 'apply', re: /^\s*(?:请|帮我)?\s*(?:投递|apply\s+to)/i },
  { intent: 'start_round', re: /^\s*(?:请|帮我)?\s*(?:在\s*)?[\u4e00-\u9fa5A-Za-z0-9·]{1,20}?(?:公司|科技|集团|银行|网络|信息|技术|软件|有限)?\s*(?:开始|进入|进行|练|约)?\s*(?:第?[一二三1-3]面|一面|二面|三面|面试|语音面试|talk)/ },
  { intent: 'review', re: /^\s*(?:请|帮我)?\s*(?:复盘|复盘报告|看下复盘|报告|review)/i },
  { intent: 'salary', re: /薪资(?:建议|报告)?|谈薪|salary/i },
  { intent: 'difficult', re: /^\s*(?:请|帮我)?\s*(?:困难题|难点题|高频题|题库|重练|difficult|question)/i },
  { intent: 'outbox', re: /^\s*(?:离线|发件箱|outbox)/i },
  { intent: 'status', re: /^\s*(?:状态|档案|概览|status)/i },
  { intent: 'help', re: /^\s*(?:帮助|菜单|指令|命令|help|\?|？)\s*$/i },
];

export function detectIntent(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return 'help';
  for (const { intent, re } of COMMAND_PATTERNS) {
    if (re.test(trimmed)) return intent;
  }
  return 'unknown';
}

/**
 * 创建命令路由器。
 * @param {object} deps { store, llm, search, coordination, outbox, log }
 */
export function createCommandRouter({ store, llm = null, search = null, coordination = null, outbox = null, log = console } = {}) {
  if (!store) throw new Error('createCommandRouter 需要 store');
  const logger = typeof log?.info === 'function' ? log : { info: () => {}, error: () => {} };

  async function route(text, context = {}) {
    const intent = detectIntent(text);
    try {
      const result = await dispatch(intent, text, context);
      logger.info(`[gateway] 命令路由 ${intent} -> ok`);
      return { ok: true, intent, ...result };
    } catch (err) {
      logger.error(`[gateway] 命令路由 ${intent} 失败:`, err.message);
      return {
        ok: false,
        intent,
        reply: `⚠️ ${err.message}`,
        data: null,
        error: { message: err.message },
      };
    }
  }

  async function dispatch(intent, text, context) {
    const deps = { store, llm, search, coordination, outbox, text, ...context };
    switch (intent) {
      case 'upload_resume':
        return handleUploadResumeCommand(deps);
      case 'paste_jd':
        return handlePasteJdCommand(deps);
      case 'apply':
        return handleApplyCommand(deps);
      case 'start_round':
        if (!coordination) {
          return {
            intent,
            reply: '语音编排器未启用，无法开始面试；请先启动 voice 中继（npm run voice）。',
            data: null,
          };
        }
        return handleStartRoundCommand(deps);
      case 'review':
        return handleReviewCommand(deps);
      case 'salary':
        return handleSalaryCommand(deps);
      case 'difficult':
        return handleDifficultCommand(deps);
      case 'outbox':
        return handleOutboxCommand(deps);
      case 'status':
        return handleStatusCommand(deps);
      case 'help':
        return handleHelpCommand();
      default:
        return {
          intent: 'unknown',
          reply: `我不太确定你想做什么：「${String(text).slice(0, 50)}」。\n发送「帮助」查看可用指令。`,
          data: { text: String(text) },
        };
    }
  }

  return { route, detect: detectIntent, dispatch };
}
