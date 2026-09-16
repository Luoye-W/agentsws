# 53 · 同类项目调研：Octop、ego-lite 与 dsh 插件生态 v1（调研 + 借鉴方案稿）

| | |
|---|---|
| 状态 | **P1–P7 已答复（2026-09-16，Luoye：能用 dsh 官方方案的都用官方）**；P1 / P6 定案，其余落地方案改写在 `54-按dsh官方方案对齐-Agent层、浏览器、连接与渠道-v1.md`（§4 契约 #20 以 54 §3 为准；ego-lite 不做；个人微信走官方 ClawBot） |
| 日期 | 2026-09-15 |
| 起因 | Luoye：腾讯开源了 Octop（多 Agent、自托管），里面的 "Connector ecosystem / Terminal AI+ / Browser AI+" 值得借鉴；我们做的东西该怎么称呼；浏览器操作还没考虑进来，ego-lite 评价很高但只有 mac 版；另看有没有现成的 dsh 插件可用 |
| 方法 | 三个只读调研子代理分别克隆 Octop（v1.0.0）、ego-lite（HEAD d01be93）读源码 + GitHub / npm / PyPI 元数据 + 社区评价；本机核对 dsh 0.1.5-rc.1 的 231 个官方包清单与我们仓库的实际依赖 |
| 09-15 晚补 | dsh **0.1.6-alpha.1** 当天发布：新增正式 `dsh-browser-use` 注册 seam + 三个实验 provider（Playwright MCP / Chrome DevTools MCP / Stagehand）、`dsh-computer-use`、`dsh-mcp-resources`。§1.3 "官方无浏览器 seam"一句在 0.1.6 起不再成立；§4.3 契约 #20 应**挂在官方 seam 之下**（我们的读写分类 / handOff / 域名白名单落在 pre-execute 门禁与 preset allowlist，不自造浏览器工具面），执行器 B = 官方 Playwright MCP provider 的 `launch` / `attach` 两档。升级由 WP70 做，spike 结论回写本节 |
| 关联 | 09 §7（dsh-channels 与 OpenConnector 分工）、13 §5（浏览器壳与插件串联）、16（与 dsh 生态共存：插件三档）、31 §3（安全修正）、38（MCP / IM 后置到开源后）、48 §5 / 50 §3（红人五渠道）、51（网站运营）、12（建站与开发岗位） |

## 0. 一句话

三个项目里**真正该搬进来的只有一件事：浏览器操作要成为我们的一个契约（第 20 份），带"人接管"和"读写分类"两条硬规矩**。Octop 的连接器目录、专家模板的写法可以借形不借体；Terminal AI+ 对我们的非技术用户不是需求；ego-lite 只能当个人端 macOS 上的一种可选执行器，不能进公司端。dsh 生态一个月膨胀到 1.5 万个插件，但**官方仍没有浏览器 seam、没有渠道 seam、没有连接器凭据库**——我们 09-08 定的三条分工（OpenConnector 管系统动作、自己写渠道、门禁插件独立发布）都站得住，只是 "dsh-channels" 这个名字要从文档里改掉。

---

## 1. 三份调研的事实

### 1.1 Octop（TencentCloud/Octop）

| 项 | 事实 |
|---|---|
| 自述 | 英文 "A smarter, self-hosted AI assistant — multi-user, multi-agent"；中文"支持多用户、多 Agent 的自托管 AI 助手"。目标用户写明 "teams, families, and individuals"，家庭共享是卖点 |
| 品类词 | **AI assistant / AI 助手**、platform；角色叫 Expert（专家）与 Sub-agent；没有用 "agent OS""AI employee""workbench" |
| 栈 | Python 3.12 + FastAPI 单进程（ADR 001：无队列无 worker）；前端 React + Ant Design；SQLite 默认、Postgres 可选；桌面壳是 **Wails（Go）内嵌便携 Python**，不是 Electron |
| 运行时 | 自研四个 PyPI 包 `orcakit-harness-agent / harness-memory / harness-gateway / harness-browser`，底层是 **LangChain Deep Agents + LangGraph**；harness 仓库在 GitHub 全部 404（可能私有） |
| 多 Agent | 每用户多 Agent，各自工作区 `~/.octop/agents/<id>/`（SOUL.md + skills）；`@Agent` 同步调用与 `ask_agent` 后台调用走**内存 inbox，重启丢任务**（文档自认）；217 张 Markdown 子智能体角色卡按 16 个部门分；"AgentTeams" 自主编排在 roadmap 里没做 |
| Connector ecosystem | 23 个，一个 Python dataclass 描述（kind / auth_kind / mcp_mode / credential_fields / oauth_issuer / mcp_url）。两种模式：`remote` 直连第三方 MCP（腾讯文档、腾讯会议、Notion、滴答清单…，OAuth 走 DCR + PKCE）；`gateway` 自己写适配器包成 MCP（QQ 邮箱 IMAP、微信读书、飞书 CLI、企微 CLI、百度地图…）。另支持任意自定义 MCP server。凭据 Fernet 加密存控制面库，密钥在 `~/.octop/secrets/` |
| Terminal AI+ | 浏览器里 xterm.js 连 WebSocket，服务端 `openpty` 起本机 shell，cwd = Agent 工作区，会话可重连回放；旁边的"AI"是一个默认用 `ops-engineer` 专家的聊天窗，能读终端上下文。**就是内嵌终端 + 侧栏聊天**，不是 shell 内联补全 |
| Browser AI+ | **自带 CDP 驱动的 Chromium**（Playwright 下载或系统 Chrome），`--remote-debugging-port` + 命名 profile；Agent 侧一个 `browser_use` 工具，底层 MCP 工具 navigate / dom_tree / screenshot / click / type / fill / eval_js / new_tab / record_* / replay_run。页面感知是 **CDP DOM 树分层压缩 + ref 句柄**（不是无障碍树）+ 截图。登录态靠持久 profile 跨 Agent 共享；控制台有"远程浏览器"页用截帧流让人接管鼠标键盘登录，Agent 在人操作时暂停。**操作录制 → 回放 → 生成 Skill** |
| 同类 | Remote Desktop（mss + pynput 截屏注入）、Remote Android（adb） |
| 模型 | 40 个预设，中国模型一等：DeepSeek（`deepseek-v4-flash/pro`）、腾讯云混元、Kimi、MiniMax、智谱、Qwen、火山、硅基流动、ModelScope、小米 MiMo + OpenAI / Anthropic / Gemini / Ollama；ChatGPT Codex OAuth 登录 |
| IM | feishu、wecom、**weixin（个人微信，扫码经 ilink）**、qq、dingtalk、telegram、yuanbao（腾讯元宝） |
| 其他 | Skills = Agent Skills 格式 + 市场对接 skillhub.cn；Plugins = `plugin.yaml` + `setup(ctx)`（tool / skill / hook，可带前端）；**ACP 双向**（Zed / OpenCode 可驱动它；它也能把任务委派给 Claude Code / Codex / OpenCode）；TTS / STT；MBTI 16 人格；"主动关怀"推送；Langfuse 观测 |
| 安全 | Shell 命令 YAML 守卫**默认 `mode: warn`**，**HITL（人审）默认关**；PII 策略 block / redact / mask / hash；JWT 多用户行级隔离；工作区后端可选 local / docker / opensandbox / 对象存储 |
| 许可与活跃 | MIT；2,176★ / 218 fork / 181 open issues；2026-07-08 建，v1.0.0 于 09-14 GA；26 位贡献者但前两名占 263 commits；9 月以来 142 commits、几乎每 1–3 天一个 release |
| 平台与归属 | mac / win / linux 桌面、Docker、FnOS NAS；数据全在 `~/.octop/`，未见遥测端点；与腾讯云耦合只在安装脚本 CDN、模型预设、腾讯系连接器与专家模板，**不需要腾讯云账号** |

### 1.2 ego-lite（citrolabs/ego-lite）

| 项 | 事实 |
|---|---|
| 是什么 | 一个 macOS 上的 **Chromium 派生浏览器 app（闭源，DMG）** + 开源的 `ego-browser` 运行时与 Agent Skill（MIT）。`AGENTS.md` 原话：仓库包含 harness 与 skill 包，**不含浏览器本身**。定位"人和 Agent 共用一个浏览器"：Agent 在自己的 Task Space（隔离标签组）里跑，直接继承用户登录态 |
| 不是什么 | 不是电脑操作 Agent（操作原生应用在 roadmap 标 Planned）；不是无头浏览器（官方直言 "Not for headless CI"）；**不自带 LLM**，是给 Claude Code / Codex / Cursor / Gemini CLI 等外部 Agent 用的工具 |
| 驱动 | app 内置 `ego-browser` 二进制；Agent 用 heredoc 把 JS 喂给 `ego-browser nodejs <<'EOF' … EOF`，每次起一个内嵌 Node 进程，经内核内置的 CDP bridge 操作页面。卖点 "Code base, not CLI base"：一段脚本串多步动作、只 snapshot 一次 |
| 感知 / 动作 | `page.snapshot()` 由内核原生生成**压缩语义树**（典型页 200–400 tokens，含跨域 iframe 与 shadow DOM）；动作按 ref（`@21`）、文本、CSS、XPath、坐标；`page.evaluate()` 注 JS；裸 CDP |
| 为何只有 mac | **没有硬性 macOS API 依赖**，开源运行时里唯一 darwin 代码是剪贴板 `osascript`。真正原因是闭源浏览器只出了 mac 构建；作者在 V2EX 说精力有限。Linux / Windows 社区 PR（#291 / #202 / #228）均未合并，官方 roadmap 标 Planned 无日期 |
| 登录态 | 首启一键迁移 Chrome 的 cookie / 密码 / 扩展 / 多 Profile，之后定期同步；Task Space 绑定一个 Profile，**同 Profile 下所有 Space 与用户自己的标签共享同一个 cookie jar** |
| 人机交接 | `task.handOff()` 把控制权交给人（登录 / 验证码 / 2FA），人做完 Agent `takeOverTaskSpace` 恢复；人控期间所有变更 API 报错 `EGO_TASK_SPACE_USER_IN_CONTROL`。不自动解验证码 |
| 对外接口 | **只有 CLI**。无 MCP server、无 HTTP / WS API、无 SDK（roadmap 有 "Browser ACP" 进行中）。以 Skill 分发（`npx skills add citrolabs/ego-lite`）。社区有 dsh 封装 `Fisfzy/dsh-ego-browser`（自称 Linux 可用，未验证） |
| 活跃 | 15,909★ / 830 fork / 169 open issues / 9 位贡献者；2026-04-16 建，最近 push 09-11；浏览器 0.5.0.32（09-12）从 `cdn.ego.app` 下载，无 App Store、无 Homebrew |
| 好评 | 第三方实测（Claude Code + Sonnet 抓 HN top5）：ego 16.4s / $0.12，agent-browser 19.0s / $0.18，Chrome DevTools MCP 26.4s / $0.23；6 个并发 Space 约 0.9 GB；登录零摩擦、不抢用户标签。官方 2.5× benchmark 是厂商自报 |
| 差评 | **三个 open 安全问题**：#303 从 Task Space 清 cookie 把用户主 Space 登出；#319 `Storage.getCookies` 跨 Profile 泄漏默认 Profile 全部 cookie；#315 模型生成的 JS 跑在特权 Node 进程里、有裸 CDP + 出网能力，可拿 HttpOnly cookie。第三方结论"适合个人，不适合多用户生产"。Claude Code 默认权限下 heredoc 含 `{ }` 触发 shell 拦截，11 次调用 5–11 次被挡；GPU 高、闲置 Space 不回收、26h swap 10→35 GB |

### 1.3 dsh 插件生态

| 项 | 事实 |
|---|---|
| 官方 | `deepseek-ai/deepseek-harness`，MIT，**224,285★ / 26,669 fork**（08-13 建，一个月）；**issues 0**，反馈走 Discussions（6,561 条）+ Discord。CLI 包是 `@deepseek-ai/dsh`（0.1.5-rc.1 于 09-10，30 天 191 万下载；无 scope 的 `dsh` 是 2016 年一个无关包）。仍是 developer preview，明示破坏性变更 |
| 插件定义 | cordis 插件：`name / inject / apply(ctx)`，一切注册是可撤销 effect。四种形态：tool 插件 / hook 插件 / UI 插件 / 外部协议驱动。`dsh plugin --profile <p> add <npm>` 转发 pnpm；配置叠加靠 `cordis.patch.yml` |
| 官方有的 seam | `ctx.tools`、`ctx.llm`、`ctx.shell / sandbox / sandboxPolicy / fs / subprocess / terminal / codeRuntime`、skills、**mcp-client（只桥 tools，不桥 resources / prompts）**、hooks（**兼容 Claude Code / Codex 的 hook 线协议**）、credentials + authorization（"向人索要凭据"流程）、schedule（**仅会话内提醒，不推送**）、jobs、workflow、webhook、subagent、sdk（JSON-RPC）、acp、Python SDK |
| 官方没有的 | **浏览器自动化 seam**（`packages/web/` 只有 fetch / search）、**渠道 seam**（无 `dsh-channel*` 官方包）、第三方 SaaS 连接器目录与 OAuth 凭据库、跨会话 cron 推送、插件注册表（官方立场：加 `dsh-plugin` topic 即可被发现）、桌面端安装包（`apps/desktop` Electron 代码在仓库里，但 releases 无资产） |
| 规模 | GitHub `dsh-plugin` topic **14,877** 个仓库；市场全是社区：`dsh-market`（3.9k★，30 天 44 万下载）、`dsh-plugin-hub`、`awesome-dsh-plugin`（15.7k★）；社区桌面端 `anywhere-labs/dsh-desktop` 26.6k★ |
| (a) 浏览器 | 社区很多：`Lum1104/dsh-browser`（654★，Chrome 侧栏扩展）、`@yeesy369/dsh-browser-playwright`（自称 "dsh-browser capability seam" 的 provider，该 seam 是社区自定义）、`dsh-agent-browser`、`@anweat/dsh-browser`（自带 chromium）、`antibrow/dsh-antibrow`（292★，指纹伪装）；computer use 三个（macOS Accessibility / 跨平台 / Windows UIA） |
| (b) 终端沙箱 | 官方最完整：bash-local / bash-sandbox / pwsh、tool-bash-persistent（PTY）、sandbox（Linux bwrap→Landlock、macOS Seatbelt、Windows restricted token），三档 read-only / workspace-write / danger-full-access |
| (c) MCP | 官方 `dsh-mcp-client`；社区补管理 UI（`dsh-mcp-manager`、`dsh-mcp-connector` 1.1 万下载） |
| (d) IM | 无官方。社区聚合 `xmanrui/dsh-im`（1,316★，飞书 / 微信 / 钉钉 / 企微 / QQ / Slack / Telegram / Discord / WhatsApp 扫码接入）；`dsh-feishu-bot` 最热（1.3 万下载）；`dsh-wechat`（走 iLink，合规未查）；`tencent-connect/dsh-qqbot`（腾讯 org）；`@dingtalk-real-ai/dsh-dingtalk`（自称官方，未核实）；`dsh-slack` |
| (e) 连接器 / OAuth | 社区 OAuth 几乎全是**模型订阅登录**（Copilot / Codex 订阅）；`dsh-oauth` 自称通用凭据生命周期但 425 下载。**没有成熟的通用连接器凭据库** |
| (f) cron | 社区 `@goodandready/dsh-cron`（4.6k 下载）等五六个 |
| **dsh-channels 的真相** | npm `dsh-channels` 是一个 1.5KB 的占位包（"name reserved"，作者 dushaobindoudou）；GitHub `wsz987/dsh-channels` 只有 11★，与 npm 包不是同一作者。**我们的 `packages/channels` 实际只依赖 imapflow / mailparser / nodemailer，从未引用它；`vendor/` 目录只有一个 README** |

未能核实：Octop 四个 harness 包的仓库是否公开；ego-lite 闭源 app 的遥测与 Mojo IPC 细节；dsh 22 万★是否含刷星（Discussions 数量真实）；钉钉插件是否真官方。

---

## 2. 我们该叫什么

先看同类各自用的词：

| 项目 | 自称 | 给谁 |
|---|---|---|
| Octop | self-hosted **AI assistant**，multi-user multi-agent | 家庭、个人、小团队 |
| dsh | **harness**（Agent 运行时 / 骨架） | 开发者 |
| Claude Code / Codex | coding agent | 开发者 |
| ego-lite | browser for agents | Agent 开发者 |
| 我们 README 现状 | 中文"中台"，英文 "agent middle-office" | 跨境电商 3–50 人团队 |

"中台"和 "middle-office" 是给技术人看的词，非技术用户第一眼不知道装的是什么；"AI 助手"又太像 Octop / 元宝那种聊天产品，而我们没有全局聊天框（36 定的）。我们真正的差异是三样：**按岗位分职责、只提议不执行（人审队列）、公司知识与品牌工作区**——这是"同事"的形态，不是"助手"的形态。

**建议（P1）**：对外一句话用"**开源、自托管的跨境电商 AI 团队工作台**"，英文 "open-source, self-hosted **AI teammates** for cross-border e-commerce teams"；用户文案层管每个岗位的 Agent 叫"AI 同事"（与 09-10 定的"我的代理"并存：代理 = 替我说话的秘书，同事 = 干岗位活的）。"Agent 中台 / middle-office" 保留为技术描述，放 ARCHITECTURE.md 与 docs，不上首页。品类词若必须一个：**AI 团队工作台（AI team workstation）**。

不建议用的：AI 员工（"雇"的隐喻与"只提议不执行"矛盾，且被 SaaS 用烂）、数字生命体（Octop 用了）、Agent OS（承诺过大）。

---

## 3. Octop 逐项对照：借什么、不借什么

| Octop 的东西 | 我们现状 | 借不借 | 落到哪 |
|---|---|---|---|
| Connector 目录（一个 dataclass 描述 23 个连接器；remote MCP + gateway 适配器两种模式；自定义 MCP server） | OpenConnector 管系统动作（08 / 18），连接页只有 Shopify / 邮箱 / 数据后端；MCP 面后置到开源后（38 D5）；`dsh-mcp-client` 已在 profile 里但没接进连接页 | **借形**：把"连接"做成一张统一目录（kind / 鉴权方式 / 模式 / 需要哪些字段 / 读写分类），Shopify、邮箱、OpenConnector 的 provider、**自定义 MCP server** 都是目录里的条目；不借它的 Fernet 自存凭据（凭据只在 OpenConnector，31 §3） | 18 连接器规范加 §"连接目录"；连接页加"自定义 MCP 服务器"一种（个人端可装；公司端仅 verified 档，16 §4） |
| Terminal AI+（xterm.js + PTY + 侧栏聊天） | 无用户面终端；dsh 自带 `dsh-terminal` / `tool-bash-persistent` | **不借进用户面**。我们的用户是运营不是运维，看到终端只会关掉。开发者场景（12 的建站 / 开发岗位、DevKit）已有 dsh 自己的 PTY seam 可直接用 | 12 建站岗位落地时再议，本文不立项 |
| Browser AI+（自带 CDP Chromium、DOM 树 + ref、持久 profile、远程接管、录制→回放→Skill） | **空白**：13 §5 只定了 KOLAgents 采集插件走配对 API；48 说插件"只读用户正在看的页面、用户主动触发" | **借体**：这是本文唯一要新立契约的东西，见 §4。其中"人接管"与"录制→技能"两条直接采 | 新契约 #20 浏览器会话；WP 待派 |
| 217 张子智能体角色卡 + 18 个专家模板（manifest：中英 label、quick_prompts、task_examples、SOUL.md） | 职责模板（27）+ role-packs；首页岗位卡片没有"示例任务 / 快捷提示" | **借形**：给每条职责模板加 `quick_prompts` 与 `task_examples` 两个字段，首页岗位卡片与指导抽屉用它做冷启动；不借 MBTI 人格与 SOUL.md 人设（36 定的"卡片优先、不聊天"） | 05 职责 schema 加两个可选字段；WP 小 |
| 多 Agent 协作走内存 inbox，重启丢任务 | 我们的事项 / 待办 / 撞车 / 认领全落库（37 / 40） | 不借，是反例 | — |
| ACP 双向（Zed / OpenCode 驱动它；它委派给 Claude Code / Codex） | dsh 自带 `acp` 包，我们没暴露 | **借入站半边**：DevKit（12）里"用 Claude Code 给 agentsws 写应用"这条路，靠 dsh 的 ACP 入站就能让编码 Agent 在我们的模拟回路里跑测试；出站委派不做（公司端无第三方代码） | 12 DevKit 章节加一行；不立项 |
| 40 个模型预设、中国模型一等 | 22 模型网关 + WP42 已有 DeepSeek / OpenAI / Kimi / 智谱 / 通义 / 硅基流动 | 补腾讯混元、MiniMax、火山、ModelScope 四个预设即可 | WP42 后续小补 |
| IM：飞书 / 企微 / 个人微信（ilink）/ QQ / 钉钉 / 元宝 | 13 定了"飞书 / 企微推审批卡片"，38 把 IM 投递后置 | 飞书、企微、钉钉三个**用官方 SDK 自己写适配器**进 `packages/channels`（公司端无第三方代码）；**个人微信 ilink 协议合规存疑，不做** | 38 D5 顺序里 IM 提到 B 期之后第一位（托管档值守要靠它推卡） |
| Skills 市场对接 skillhub.cn；插件 `plugin.yaml + setup(ctx)` | 11 / 16 的应用市场三档 | 不借（我们已有更严的三档 + wrapper 包） | — |
| 安全默认：HITL 关、命令守卫 warn | fail-closed、全部写操作进人审 | 不借，反而是我们 build in public 的对照案例 | README "别处 vs 我们"加一行 |
| Wails + 便携 Python 桌面壳 | Electron 壳已合并（WP16） | 不借 | — |

---

## 4. 浏览器操作怎么进来（本文核心）

### 4.1 为什么现在要立项

三条职责已经卡在"没有 API 只能进网页"上：

1. **红人五渠道**（50 §3：YouTube / Facebook / Instagram / TikTok / X）：找人、看主页、发私信，官方 API 要么没有要么不给个人开发者；KOLAgents 靠浏览器插件采集。
2. **Amazon**：35 末尾明记"亚马逊无真连接器"，Seller Central 的大部分操作只有网页。
3. **Shopify 后台的非 API 角落**：主题已走官方 CLI（43），但市场 / 应用设置 / 部分报表只有后台页面。

### 4.2 三个候选执行器，各自适合什么

| 执行器 | 平台 | 登录态 | 页面感知 | 谁在跑 | 适合 |
|---|---|---|---|---|---|
| **A. ego-lite** | 仅 macOS，闭源浏览器 + 开源 CLI | 直接继承用户 Chrome 登录态；同 Profile 共享 cookie jar | 内核原生压缩语义树，最省 token | 用户本机桌面会话 | 个人端、有人在电脑前、要登录态的活（红人私信、Seller Central） |
| **B. 自带 Chromium（Playwright / CDP，Octop 方式）** | 三平台，可 headless | 我们自己的持久 profile，首次由人登录 | DOM 树 + ref（自己做压缩） | 本机或公司常开机器 / 托管档 | 公司端、无人值守、定时采集（红人主页巡检、Amazon 报表下载） |
| **C. 浏览器插件（KOLAgents 现有）** | 三平台，用户自己的浏览器 | 用户的 | 只读当前页 | 用户主动触发 | 只读采集、零安全负担 |

三者不互斥。**建议 v1 的组合：契约一份，先做 C（已有，改指向 agentsws）与 B（跨平台、公司端能跑），A 作为个人端 macOS 上的可选执行器接在同一契约后面**——因为 ego-lite 只有 CLI 没有 API，接入就是"spawn 一个子进程喂 JS"，成本低；但它不能进公司端（§4.4）。

### 4.3 契约 #20 浏览器会话（草案，字段级放到 v1 规范时再定）

| 对象 | 说明 |
|---|---|
| `BrowserSession` | 一次浏览器任务：`executor: 'ego' \| 'chromium' \| 'extension'`、`profile_ref`（指向哪个登录身份，公司端只能指 OpenConnector 登记过的"网页账号"）、`ownership: 'agent' \| 'user'`、`scope`（允许的域名白名单，缺省为空 = 什么都不能开） |
| `page.snapshot / click / type / navigate / evaluate / screenshot` | 工具面照 ego-lite 与 Octop 的交集来，ref 优先、坐标兜底；`evaluate`（注 JS）**公司端默认禁用** |
| 读写分类 | 每个动作在 pre-execute 里打 `read_external` / `write_external`：导航、快照、截图、滚动 = 读；点击提交 / 发送 / 发布 / 支付类按钮、表单提交、文件上传 = 写。判定方式：动作落在 `<form>` 提交、`type=submit`、或按钮文案命中"发送 / 发布 / 提交 / 支付 / 确认"词表（中英）→ 写；判不了按写。**写动作在公司端一律先进审批卡**，批了才由执行器点下去；个人端记事件并提示 |
| `handOff / takeOver` | 直接采 ego-lite 的语义：登录、验证码、2FA、支付页一律交给人；人控期间 Agent 的变更调用报错而不是排队 |
| 录制 → 技能 | 采 Octop：人做一遍 → 录成步骤 → 生成一份 Agent Skills 格式的 SKILL.md 进技能三层里的个人层（24），晋升走现有审批 |
| 事件 | `browser.session.opened / handed_off / taken_over / action.blocked / closed`，全部进事件日志（Model-visible ⟺ logged） |

### 4.4 安全边界（这三条不能让）

1. **模型生成的 JS 不能碰用户的全量登录态**。ego-lite 的 #315 就是这个：JS 跑在有裸 CDP 与出网能力的特权进程里，能读 HttpOnly cookie。所以 ego-lite **只能在个人端**、且要求用户为 Agent 单独建一个 Chrome Profile（只登录工作账号）——这条写进连接向导，不靠用户自觉的话至少要在"选 Profile"那一步用红字讲清楚。公司端执行器只有 B，`evaluate` 关闭，profile 由 OpenConnector 管。
2. **域名白名单缺省为空**。红人职责只开五个平台的域名，Amazon 职责只开 sellercentral，越界导航直接 block 并出卡。
3. **凭据不经模型**（13 §4 已定）：网页登录也一样——密码只在 handOff 期间由人输入，Agent 看到的是"已登录"的状态。

### 4.5 第一用途与派工顺序

| 顺序 | 做什么 | 依赖 |
|---|---|---|
| ① | 契约 #20 上 `packages/contracts` + 模拟替身（一个假页面、一个假"发布"按钮，断言写动作被拦、handOff 后变更报错） | 无 |
| ② | 执行器 B（Playwright 自带 Chromium、持久 profile、DOM 压缩 + ref、域名白名单、读写分类） | ① |
| ③ | 红人 YouTube 渠道的"看主页 + 采基础数据"跑通（只读，公司端可跑） | ②、C 期 kol-core |
| ④ | 执行器 A（ego-lite 子进程封装，个人端 macOS 可选；连接向导里的 Profile 提示） | ① |
| ⑤ | 录制 → 技能 | ②③ |

Amazon Seller Central 的写操作、红人私信等 `write_external` 场景等 ③ 稳了再开。

---

## 5. dsh 生态对我们的三处修正

1. **"dsh-channels 作对话渠道契约"这句话要改**（09 §7、README 第 44 行、vendor/README、memory）。事实是 npm 包是占位、GitHub 仓 11★、我们的代码从未依赖它。改成：**渠道契约是我们自己的（契约 #9 入站 / #14 投递），`packages/channels` 自己实现 IMAP / SMTP，IM 适配器也自己写；愿意的话把适配器按 dsh 插件规矩反向发布**，这与 16 §5 的精神一致。09 §7 的分工表本身不变（渠道 ≠ 系统动作）。
2. **MCP 可以从"开源后"提前半步**：`dsh-mcp-client` 是官方包、已在 profile 里；把"自定义 MCP 服务器"当作连接目录里的一种条目，个人端就能装（community 档），公司端仍按 16 §4 只放 verified。我们**不做** MCP server 端（dsh 自己也不是 server；48 的旧 SaaS MCP 只给迁移工具用）。
3. **社区插件三档（16 §4）现在更有必要**：1.5 万个插件、零官方审核、市场全是社区办的；`dsh-market` 44 万下载说明用户就是会去装。我们的市场 v1 只做索引 + wrapper，不重复造市场。另外 dsh hooks 兼容 Claude Code / Codex 的 hook 线协议，意味着 16 §5 说的 `dsh-guardrails` 独立发布后，Claude Code 用户也能装我们的门禁——这是免费的引流面，写进 32 的 build in public 里程碑。

顺带两个可直接拿的：`@deepseek-ai/dsh-terminal` / `tool-bash-persistent` 给 12 的开发岗位用；`packages/hooks` 的 permission-gate 示例可对照我们 pre-execute 的写法查缺。

---

## 6. 明确不借的

- Terminal AI+ 进用户面（§3）
- MBTI 人格、SOUL.md 人设、"主动关怀"推送：与 36 "卡片优先、不聊天"相反
- 个人微信 ilink 桥：合规未查，且个人身份类渠道按 20 本来就留在本机
- 内存 inbox 式的 Agent 互调：我们已有落库的事项 / 撞车 / 认领
- 自存 Fernet 凭据：凭据只在 OpenConnector
- ego-lite 进公司端或托管档：无 API、只 mac、不能 headless、三个 open 安全 issue

---

## 7. 待拍板

| # | 事项 | 我的建议 |
|---|---|---|
| P1 | 对外叫法 | 中文"开源自托管的跨境电商 AI 团队工作台"，英文 "AI teammates for e-commerce teams"；岗位 Agent 用户文案叫"AI 同事"；"中台 / middle-office" 只留技术文档 |
| P2 | 浏览器操作立契约 #20（§4.3）并按 §4.5 顺序派工 | 同意；① ② 先派，③ 等 C 期 kol-core |
| P3 | ego-lite 的位置 | 个人端 macOS 可选执行器，连接向导强制提示单独 Profile；不进公司端 |
| P4 | 连接目录（§3 第一行）+ "自定义 MCP 服务器"作为一种连接 | 同意；18 加 §，连接页加一种；公司端仅 verified |
| P5 | 文档里 "dsh-channels" 改口（§5 第 1 条） | 同意；改 09 §7、README、vendor/README、memory |
| P6 | 职责模板加 `quick_prompts` / `task_examples` | 同意；小 WP，与 WP62 / WP65 不撞（改 05 schema 与 role-packs） |
| P7 | IM 顺序：飞书 / 企微 / 钉钉官方 SDK 自写适配器，排在 B 期托管档之后第一位 | 同意；个人微信不做 |

## 8. 对既有文档的改动（拍板后执行）

- 09 §7、README 第 44 行、`vendor/README.md`：去掉"回 dsh-channels"，改为"渠道契约自有，适配器按 dsh 插件规矩反向发布"
- 18 连接器规范：加"连接目录"一节与"自定义 MCP 服务器"条目
- 09 契约表：加 #20 浏览器会话；ARCHITECTURE.md 契约数 19 → 20
- 05 职责 schema：`quick_prompts?` / `task_examples?`
- 12 DevKit：加 "dsh ACP 入站让编码 Agent 跑我们的模拟回路" 一行
- 32 build in public 里程碑：加 `dsh-guardrails` 兼容 Claude Code hooks
- 38 D5：IM 投递提前到 B 期之后
- README 对照表：加 "HITL 默认关 / 命令守卫 warn（Octop）vs 全部写操作进人审（我们）"
- docs/README.md 索引仍停在 38，待补 39–53
