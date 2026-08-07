# InterviewPal · Offer 陪练

> 求职面试陪练 Agent —— 以个人简历驱动的深度陪练与复盘闭环。
>
> 一位装在手机里的面试陪练：每次模拟都基于**你的简历 + 目标 JD**，追问链随回答逐层深入；复盘教练跨场次记住你的薄弱点与进步，每次复盘都与上次对比，给出可执行的"下次改法"清单。

## 核心亮点

- **不预设岗位分类**：LLM 深度预分析（七大层）按简历 + JD 动态适配任意岗位；
- **计划是基线，不是脚本**：面试官以预分析为基线，按实时信号动态调整（卡壳降档 / 偏题拉回 / 意外深度延伸追问）；
- **面试官失忆、教练全记忆**：面试官每场独立、无跨场记忆（模拟保真）；复盘教练读写档案库，跨场次对比进步与薄弱点；
- **语音单一模拟模式**：豆包端到端实时语音还原"听题 → 组织 → 开口"的压力；
- **本地优先**：简历与对话默认留在本机，联网检索只提交实体名（公司名 / 技术名），不提交个人信息；
- **全链路可降级**：未配置任何 API Key 时，解析 / 预分析 / 面试 / 复盘均可走规则兜底与 mock 模式，保证演示可复现。

## 功能特性

| 优先级 | 功能 | 说明 |
| --- | --- | --- |
| P0 | 简历 / JD 解析与双画像 | 提取经历、技能、目标岗位要求，形成"简历画像 + 目标岗位画像" |
| P0 | LLM 深度预分析 | 一次调用输出七大层面试计划，按「简历版本 + 公司 + 岗位」缓存 |
| P0 | 角色化模拟面试 | 实时语音通话；面试官身份 / 风格 / 追问链由预分析动态生成 |
| P0 | 动态追问链 | 表面经历 → 实现细节与决策理由 → 极端场景与对比方案 |
| P0 | 多维复盘报告 | 六维 BARS 评分 + 方向偏差报告 + 与上次对比 + 本场困难题清单 |
| P0 | 改进清单 | 每条点评落到"具体怎么改"，可勾选完成 |
| P1 | 基线诊断与通关建议 | 首次练习前输出各轮能力基线，连续达标后建议进入下一轮 |
| P1 | 困难点标记与沉淀 | 未回答上来 / 答偏跑题 / 沉默超时 / 回答浅薄，自动进入下次重点练习 |
| P1 | 跨场次记忆与进步跟踪 | 重复题逐题对比、薄弱点变化、防背答案式刷分提示 |
| P1 | 联网补全与校验 | 公司 / 技能 / 真实 JD 事实缓存（时间戳 + 来源 + 置信度） |
| P1 | 轮次配置化 | 一面简历面 / 二面业务面 / 三面总监交叉面，检索与提示词按轮次区分 |
| P1 | 多公司并行管理 | 公司 × 岗位 × 轮次树状组织，信息隔离，删除即释放 |
| P1 | 双 Agent 分工 | 面试官（实时语音，无状态）+ 复盘教练（文本 LLM，全记忆） |
| P1 | 表达节奏 / 高频题库 / 报告导出 | 语速停顿卡壳分析；岗位高频题推送；Markdown / HTML 导出 |

## 架构总览

| 模块 | 职责 |
| --- | --- |
| `src/archive/` | 档案存储：简历版本化、投递即冻结、多公司档案、预分析 / 检索缓存 |
| `src/parser/` | 简历 / JD 解析（LLM 优先 + 规则兜底） |
| `src/preanalysis/` | 七大层预分析（schema / prompt / fallback / cache / engine） |
| `src/enrich/` + `src/search/` | 联网补全与校验（事实缓存） |
| `src/interviewer/` | baseline + 实时信号 + 动态调整、轮次差异化 |
| `src/coach/` | 六维复盘、记忆闭环、困难点沉淀、双 Agent |
| `src/onboarding/` | 上传简历 / 粘贴 JD / 投递流水线 |
| `src/voice/` | 豆包实时语音桥接（Node 中继 + mock） |
| `src/gateway/` | OpenClaw Gateway 适配（命令路由 + 子代理编排） |
| `src/llm/` | 文本 LLM 统一入口（豆包 Ark / DeepSeek，Chat + Responses 双协议） |

### 数据流

```mermaid
flowchart LR
    A["上传简历 + 粘贴目标 JD"] --> B["联网补全与校验"]
    B --> C["建立双画像（简历画像 + 岗位画像）"]
    C --> PA["LLM 深度预分析：七大层面试计划（按 版本+公司+岗位 缓存）"]
    PA --> D["选择轮次：一面 / 二面 / 三面"]
    D --> E["面试官（实时语音）：baseline + 实时信号动态调整"]
    E --> T["Transcript + 困难点报告"]
    T --> F["复盘教练（全记忆）：六维报告 + 方向偏差 + 与上次对比"]
    F --> G["个性化改进清单 + 下次重点"]
    G --> D
```

## 快速开始

环境要求：Node.js ≥ 22.22.3（本机已验证 v24.15.0）。

```bash
npm install

# 可选：配置真实凭据（不配置也能以 mock / 规则兜底模式运行）
# 复制 .env.voice.example 为 .env.voice.local 并填写豆包语音凭据
# 创建 .env.local 填写文本 LLM / 网关凭据（参考下方「配置」表）

npm test          # 全量测试（当前 179 用例）
npm run seed      # 一键播种 mock 数据（3 简历 × 3 公司 × 9 岗位）
npm run demo      # 端到端演示剧本（mock 模式，一键跑通全链路）
npm run voice     # 启动豆包实时语音本地中继（http://localhost:8780/voice/call.html）
npm run gateway   # 启动 OpenClaw Gateway 适配层（无 token 自动降级 mock）
```

## 配置

所有 `*.local` 凭据文件均已 gitignore，不入库。无任何 key 时，预分析 / 面试 / 复盘均可降级为规则与 mock 模式。

| 变量 | 用途 | 必填 |
| --- | --- | --- |
| `ARK_API_KEY` | 豆包（火山方舟）文本 LLM，主力模型 `doubao-seed-2-1-pro-260628` | 否 |
| `DEEPSEEK_API_KEY` | DeepSeek 文本 LLM，备选模型 `deepseek-v4-pro` | 否 |
| `LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL` | 任意 OpenAI 兼容厂商透传（优先级最高） | 否 |
| `DOUBAO_APP_ID` / `DOUBAO_API_KEY` | 豆包端到端实时语音（新版控制台 API Key 鉴权） | 否 |
| `DOUBAO_APP_ID` / `DOUBAO_ACCESS_KEY` | 豆包实时语音（旧版控制台 Access Token 鉴权） | 否 |
| `DOUBAO_WS_URL` / `DOUBAO_BOT_NAME` 等 | 语音会话参数 | 否 |
| `OPENCLAW_GATEWAY_URL` / `OPENCLAW_GATEWAY_TOKEN` | OpenClaw Gateway 接入 | 否 |
| `GATEWAY_DATA_DIR` / `VOICE_DATA_DIR` | 档案库数据目录（默认 `data/`；演示可指向 `data/demo`） | 否 |

OpenClaw Gateway 的详细接入清单见 [docs/gateway-setup.txt](docs/gateway-setup.txt)。

## 目录结构

```text
interviewpal/
  src/
    archive/      档案存储（公司/岗位/简历版本/投递快照/预分析缓存）
    preanalysis/  七大层预分析（schema / prompts / fallback / cache / engine）
    interviewer/  baseline + 实时信号 + 动态调整（engine / signals / rules / prompts / rounds）
    coach/        复盘教练（六维复盘 / 记忆闭环 / 困难点 / 节奏 / 题库 / 导出 / agents）
    parser/       简历与 JD 解析（LLM 优先 + 规则兜底）
    enrich/       联网补全（公司 / 技能 / 前沿话题）
    search/       检索层
    onboarding/   上传简历 / 粘贴 JD / 投递流水线
    voice/        豆包实时语音桥接（bridge / protocol / call / mock）
    gateway/      OpenClaw Gateway 适配（命令路由 + 子代理编排）
    llm/          文本 LLM 统一入口
  data/mock/      demo 数据（简历 / 公司 / 岗位）
  scripts/        seed.mjs / e2e-demo.mjs
  test/           全量测试
```

## 测试与验收

- `npm test` 全量通过（当前 179 用例 / 18 个套件）；
- 每阶段独立提交、独立可运行；
- 预分析七大层校验：子维度 ≥ 45（±3）；
- 缓存生命周期：同「版本 + 公司 + 岗位」命中不重复调 LLM；删公司 / 删岗位联动释放缓存与复盘记录；
- 投递即冻结：简历版本不可变，投递快照可审计。

## 隐私与数据

- 简历与对话数据默认留在本机（OpenClaw 单机部署优先）；
- 联网检索只提交实体名，不提交个人信息；缓存可查看、可删除；
- 投递即冻结：简历版本不可变，投递快照可审计，去留由用户决定；
- `.env.local`、`.env.voice.local` 等凭据文件一律不入库。
