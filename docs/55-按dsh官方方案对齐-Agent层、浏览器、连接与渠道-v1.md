# 55 · 按 dsh 官方方案对齐：Agent 层、浏览器、连接与渠道 v1（方案稿）

| | |
|---|---|
| 状态 | **已定案并全部落地（2026-09-16）**：Q2 WP81 官方 Agent 层、Q3 WP82 浏览器、Q4 WP83（目录 + 岗位清单）+ WP86（职责 preset 承载 + `credentials-openconnector`）、Q5 WP85 微信 / 企业微信 + Q5a 改口、P6 WP84 快捷提示，均已合并进 main；Q1 查证后不做开关（上传通路不存在，见 `packages/dsh-adapter/AGENT-LAYER.md` §7）；Q7（终端与沙箱）09-17 拍板、WP89 已落地（见 §8 落点）。编号说明：本文原为 54，与另一会话的「54 岗位是任务主入口」撞号后改为 55；WP 编号从 71–75 改为 81–86。后置项见 docs/35 各条 |
| 日期 | 2026-09-16 |
| 起因 | Luoye 看完 docs/53 的 P1–P7 后定方向：**能用 dsh 官方方案的都用官方方案，不然以后兼容性会很差**；浏览器按官方来、作为个人端；会话日志上报"优先按官方"；连接要有统一目录但又怕太大、希望按岗位 / 职责能快速知道连哪些；个人微信可以做（微信有官方的 Agent bot 入口）；P5 没看懂 |
| 事实来源 | dsh 0.1.6-alpha.1 源码走读（Agent 层嵌入、preset、credentials、browser-use、webhook；细节引用在 §2–§5）；微信 ClawBot / iLink 官方仓库 `Tencent/openclaw-weixin` 与使用条款；WP70 的浏览器 seam spike（`packages/dsh-adapter/test/browser-seam.test.ts`） |
| 关联 | 53（调研与 P1–P7）、16（与 dsh 生态共存）、17（运行协议：§5.1 无状态运行、§2 事件流）、42（升级流程）、46 I5（勾岗位 = 要配的东西清单）、05 §1.2（职责的 `connectors[]`）、13 §4（凭据不经模型）、41（我的代理）、20（个人身份类渠道留本机） |

## 0. 一句话

"按官方"落到实处是**五件事**，其中第一件是其余四件的前提：

1. **把 dsh 官方的 Agent 层引进来**（`ctx.agents.create` → `followup` → `whenIdle`），我们不再自己排模型回合；我们的五个门禁继续以插件形式挂在它上面。官方的浏览器、MCP 按 preset、子代理、定时都挂在 `agent/created` 上，不引这一层它们一个都用不了。
2. **浏览器用官方 `dsh-browser-use` + Playwright MCP provider**，个人端 `attach` 到用户自己的 Chrome（带登录态、不用下载 Chromium）；ego-lite 不做了。
3. **"一职责一套连接"用官方 `agent-presets` 承载**：每条职责一个 preset 目录，里面放它要的 MCP 服务器行与凭据引用；统一目录只是"可选项的清单"，岗位页只显示这个岗位缺什么。
4. **凭据走官方 `ctx.credentials` 的 provider 抽象**：OpenConnector 作为一个 credentials provider 接进去，而不是并列两套。
5. **会话日志上报按官方默认**，但作为设置页里一个看得见的开关，公司端例外（见 §1 Q1）。

没有官方方案的三样继续自己做、但按官方形状：**对话渠道 / IM**（dsh 无渠道 seam，入站就是 `agent.followup()`）、**多用户与权限**（dsh 单用户）、**审批账本与工作台**。

---

## 1. 对 Luoye 七条答复的逐条处理

| # | Luoye 的话 | 事实 | 建议（待拍板项见 §6） |
|---|---|---|---|
| 0 | 会话日志上报"优先按官方" | 上报由 `dsh-session-log-deepseek` 做，0.1.6 默认开；它**只在 `dsh-base` / `sdk-minimal` 两个 bundle 的 patch 里挂**，核心包不引；开着时把整条会话事件（客户来信原文、订单、工具入参）随每次官方 DeepSeek 请求上传 | **Q1**：默认值跟官方——**个人端、模型走 DeepSeek 官方端点时默认开**；设置页给一个白话开关"把会话记录分享给 DeepSeek 用于改进模型"；**公司端与托管档默认关**（那里的会话是公司客户的数据，不是用户自己的，31 §3 / 18 §2.1）；README 的"一切都在你自己机器上"要改成"除非你打开分享" |
| 1 | 同意 | — | **定案**：对外"开源自托管的跨境电商 AI 团队工作台 / AI teammates"；岗位 Agent 文案"AI 同事"；"中台"只留技术文档。WP 改 README 与工作台文案 |
| 2 | 浏览器不是有官方方案了吗，按官方 | 有：`dsh-browser-use`（注册 seam）+ 三个实验 provider。工具名 `mcp__playwright-mcp__browser_navigate` 等，对 hook **不透明**（无读写标注）；每个 Agent 一个 MCP 客户端，在 `agent/created` 里连接 | **Q3**：用官方；前提 Q2。契约 #20 从"浏览器工具面"瘦成"我们这一侧的策略"（§3） |
| 3 | 按官方最新方案，作为个人端 | provider `mode: attach` + `endpoint`（`http://` 或 `ws://` 的 CDP 地址）可接用户已开的 Chrome（`--remote-debugging-port`），保留标签与登录态，收尾只断连不关浏览器；`launch` 模式可 `executablePath` 指本机 Chrome | **Q3**：个人端 = attach 用户 Chrome；公司端以后 = `launch --headless`。ego-lite 不做（无 API、只 mac、三个 open 安全 issue） |
| 4 | 要统一目录，但怕太大；按岗位 / 职责能快速知道连哪些 | 职责模板**已经**声明 `connectors[] { kind, required, grants }`（05 §1.2），岗位会算出 `missing_connectors`（`packages/roles/src/effective.ts`）；46 I5 定了"勾岗位 = 生成要配的清单"。缺的只是界面与 preset 承载 | **Q4**：目录是"可选项总表"（只在设置页 / 搜索里出现），岗位页放一张"连上这 N 个就能开工"的卡，每项一键跳安全表单；首次设置第 ③ 步按勾的岗位只列它需要的。官方承载：每条职责一个 `agent-presets` 目录（§4） |
| 5 | 没太明白 | 白话：我们的文档里写"对话渠道用一个叫 dsh-channels 的第三方包"，还说要把我们的邮件适配器"贡献回 dsh-channels"。这次查证：**那个包是空壳**（npm 上 1.5KB 占位、GitHub 11 星），我们的代码从没用过它——`packages/channels` 一直是自己写的 IMAP / SMTP。dsh 官方**没有**渠道这一层。所以只是文档写错了，代码不用动 | **Q5a**：改口三处（09 §7、README 第 44 行、`vendor/README.md`）：渠道契约是我们自己的，IM 适配器自己写；个人端可装社区的 `dsh-im`（community 档，16 §4） |
| 6 | OK | — | **定案**：职责模板加 `quick_prompts` / `task_examples`，首页岗位卡与指导抽屉用 |
| 7 | 个人微信也可以做，微信有 Agent bot 入口 | 对，是**官方**的：微信 ClawBot 插件（微信 ≥ 8.0.70，我 → 设置 → 插件），协议 iLink Bot API，官方仓库 `Tencent/openclaw-weixin`（MIT，2.4.9-beta.0，09-08），纯 HTTPS 长轮询、扫码得 token、无需公网回调。**限制**：只是"本人 ↔ 自己的 Agent"的私聊通道，Bot 是一个独立联系人，**同事加不了、不能进群、收不到别人发给你的消息**；主动推送要最近一条入站的 `context_token`，约 15 小时后失效；无公布配额。团队内聊要用**企业微信智能机器人**（官方 WebSocket 长连接，支持群 @，≤10 人小团队可用） | **Q5b**：做，但定位精确——ClawBot = "我的代理"（41）的个人微信入口：老板 / 员工在微信里问自己的代理、收自己的卡片；团队与客户不走它。企业微信机器人作为团队渠道另做。两者都是个人 / 公司身份类渠道，按 20 的规则：个人微信留本机，企业微信归公司工作区 |

---

## 2. 第一件事：引入官方 Agent 层（Q2）

### 2.1 现状与差距（白话）

今天 `packages/dsh-adapter` 是这样用 dsh 的：只挂了工具、提示词、审批、模型四个"零件"，**回合是我们自己排的**——`runtime.ts` 里先让模型说一次，再按 grounding 规则决定调哪几个工具，把结果做成卡片。这条路的好处是三个运行时（stub / direct / dsh）行为逐字节一致，模拟回路好比；坏处是**dsh 官方把新能力都挂在它自己的 Agent 上**（浏览器、MCP 按 preset、子代理、定时、`--json` 事件流），我们这条路上一个都接不到——WP70 的 spike 已经实证：Playwright provider 要 `agents`，我们的组合里没有。

官方 Agent 层的最小挂法（有官方范例：`bundle/sdk-minimal` 与 headless 的测试）：挂 `dsh-agent` + `dsh-agent-loop` + `dsh-session` + `dsh-session-projection` + 我们已有的四个零件，**不需要 `dsh-base`**、不需要 web server、不需要 DSH_HOME。宿主这样用：

```
handle = await ctx.agents.create({ sessionId, meta, agentOptions, setup })   // setup 里挂职责 preset
await handle.agent.followup(createUserMessage(...))                         // 投一轮
await handle.agent.whenIdle()                                               // 等它跑完（含多轮工具调用）
读 session 事件（session/event）→ 投影成我们的 RunEvent                       // 17 §2
handle.dispose()                                                            // 17 §5.1 无状态：一次运行一棵树
```

我们的五个门禁**一个不少**，还是插件：`tools/pre-execute` / `post-execute` waterfall 照拦每次工具调用；`approval/request` 的 answerer 照旧（无 answerer 时官方就是 fail-closed）；`ctx.tools.restrict({ allow })` 在 Agent 的 ctx 上调；`systemPrompt.section({ complete: true })` 照遮；`ctx.llm.registerAdapter` 照挂我们的模型网关。这正是 dsh 自己那句 "Plugins, not loop changes"。

### 2.2 要接受的三个变化

| 变化 | 影响 | 处理 |
|---|---|---|
| **模型回合由 dsh 驱动**，会多轮调工具，不再是"说一次 + 按规则调" | 17 §2 的事件序列会变；`tokens_per_item` 会变；stub / direct 两个运行时不会自然产生同样的序列 | 模拟回路的"三运行时逐字节一致"改为"**结果一致**"：六条不变量 + 场景断言 + 卡片结果照比，事件序列只在 dsh 两档之间比（in-process vs subprocess） |
| **会话事件是 dsh 的格式**（`session.v3`） | 我们的事件日志（21）是真源，dsh 的 session 不能变成第二份真源 | 会话不落 dsh 的 JSONL（内存 session，一次运行一棵树即销毁），运行中把 `session/event` 投影成我们的 `RunEvent` 进事件日志；将来要"回放 dsh 轨迹"再实现官方 `SessionPersistence` 接口写进我们的库 |
| **提示词装配**：dsh 的 `systemPrompt.assemble()` 成为真正送模型的那份 | 17 §6 要求静态前缀字节稳定（prompt 缓存） | 我们的 `assemblePrompt` 整段作为 `complete: true` 段进去（今天已经这么做，只是没真送）；新增分节位（`MCP_SERVERS` 等）被遮蔽，WP70 已证 |

### 2.3 收益

- 官方浏览器、`mcp-client` 按 preset、`mcp-resources`、`subagent`、`schedule`、headless `--json` 事件流全部可用；
- `packages/dsh-adapter` 的 `runtime.ts`（约 500 行自排回合）可以退掉一半以上；
- 以后 dsh 升级只碰 seam，不碰回合逻辑——这才是 Luoye 担心的"兼容性"的根。

### 2.4 代价与风险（诚实）

- 这是 **1b 以来最大的一次底层改动**，牵动 `dsh-adapter`、`simulation`（parity 定义）、`runtime-direct`（要不要留）、17 与 26 两份规范；
- dsh 仍是 developer preview，Agent 层 API（`AgentHandle`、`followup` / `steer` / `inject`）本身也会改，docs/42 的每次升级都要重跑；
- 官方明说"直接进程内挂载不是 Harness 应用启动器"——这是上游仓库对自己的纪律，对下游没有技术约束，但意味着这条路不在官方测试矩阵里，要靠我们自己的两档 headless 用例守。

---

## 3. 浏览器：契约 #20 瘦身（Q3）

工具面不自造，全部来自官方 provider。我们这一侧只剩**策略**，都落在已有的 seam 上：

| 策略 | 落在哪 | 怎么做 |
|---|---|---|
| 读写分类 | `tools/pre-execute`（`gate.ts` 的 `classifySideEffect`） | 官方工具对 hook 不透明，按名判：`browser_navigate / snapshot / take_screenshot / tabs / console_messages / network_requests` = `read_external`；`browser_click / type / fill_form / select_option / press_key / drag / file_upload / evaluate` = `write_external`（公司端默认 block → 进审批卡）；未知名兜底按写 |
| 域名白名单 | 同上，只看 `browser_navigate` 的 `url` 入参 | 职责模板加 `browser_scope: string[]`（红人五渠道各自域名、Amazon 只开 sellercentral）；缺省为空 = 什么都不能开；越界 block 并出卡 |
| 人接管（登录 / 验证码 / 2FA） | 个人端 attach 模式下用户本来就能直接操作自己的 Chrome | Agent 遇到登录页 → 出一张"请你在浏览器里登录后点继续"的卡（14 的 `boundary` 类）；不做 ego-lite 那种 ownership 锁，官方没有这个语义 |
| 凭据不经模型 | 13 §4 已有 | 密码只在用户自己的浏览器里输，Agent 只看到"已登录"状态 |
| 一 Session 一浏览器 | 官方语义 | 与 17 §5.1 一次运行一棵树天然一致；attach 模式一次只允许一个 Session 占用用户 Chrome，运行结束即释放 |
| 录制 → 技能 | 后置 | 官方无此能力；Octop 有。等前面稳了再议 |

个人端安装形态：桌面壳（Electron）里"连接浏览器"一步 = 用带 `--remote-debugging-port` 的方式为用户起一个**单独的 Chrome Profile**（工作账号用），provider 以 attach 接它。不用用户日常那个 Profile，避免 ego-lite #319 那类跨 Profile 泄漏。

### 落点（WP82，已实现）

上面那张表逐行落在哪，以及**实测到的三件与预判不同的事**。

| 策略 | 落点 | 实测 |
|---|---|---|
| 工具面 | `harness.ts`：`RunRequest.browser` 在场才 `root.plugin(BrowserUseRegistry)` + 在 `setup()` 里 `agentCtx.plugin(PlaywrightMcpProvider, …)` | 真 provider **挂得上**（见下 ①）；默认报 **24 个**工具（Core automation 23 + Tab management 1，provider 没传 `--caps`） |
| 读写分类 | `tools.ts` 的 `classifySideEffect`：只读 9 个显式列名，其余按写；`browser_tabs` 按 `action` 分 | 与上游 README 的 `Read-only` 标注**有意不同**两处：`browser_navigate` 我们判读（55 §3 原话），`browser_wait_for` / `browser_resize` 我们判读（它们碰不到外面） |
| 域名白名单 | `browser.ts` 的 `checkBrowserNavigation`；来源 = 职责模板 `browser_scope` → `RunRequest.allowed_hosts` | `browser_tabs action=new` **也带 `url`**，一起查（预判里漏了这一个） |
| 注 JS | 同上，公司端（`executor`）对 `browser_evaluate` / `browser_run_code_unsafe` 硬拒 | 上游 0.0.80 新增了 `browser_run_code_unsafe`（自称 "RCE-equivalent"），一起拒 |
| 人接管 | `browser.ts` 的 `browserBrief` 写进 persona 的 `complete` 段 | 官方自己那段 `mcp:playwright-mcp` 被 `complete` 段遮掉，所以"能开哪些站 / 登录页怎么办"**只能由我们写**，不写模型就不知道 |
| 一 Session 一浏览器 | provider 的 `exclusive: mode === 'attach'`，随 `handle.dispose()` 一起走 | 与 17 §5.1 天然一致 |
| 个人端单独 Profile | 桌面壳托盘「打开工作用的浏览器」→ `~/Library/Application Support/agentsws/browser-profile` + `--remote-debugging-port=9333` → 地址 `PUT /v1/settings/browser` | 已实现（`apps/desktop/src/work-browser.ts`） |

三件与预判不同的事：

① **真 provider 在 CI 里挂得上，不用假 MCP 服务器。** `@playwright/mcp` 的 `cli.js`
启动时不碰浏览器（连接推迟到第一次真调工具），所以 attach 指一个**没人监听**的回环
端口，provider 照样把 24 个工具报上来——`browser-seam.test.ts` 因此用的是真 provider。

② **浏览器工具不能列进 `ctx.tools.restrict({ allow })`。** 上游原话是 "Restrictions
intersect; scoped registrations remain visible"：provider 在自己那个 agent scope 里注册
工具，本来就不受职责白名单影响；真列进去还会抛，因为 `restrict` 只认调用当刻**已经
全局注册**的名字，而 provider 挂在 `agent/created` 上、比 `setup` 晚一步。

③ **`playwright` 的 postinstall 不用开构建也能装。** `allowBuilds` 里写死
`playwright: false` / `playwright-core: false`，`pnpm install --frozen-lockfile` 照常通过，
provider 照常起——它只要 `cli.js` 那段 JS。attach 与 `executable_path` 两条路都不需要
它下载的那份 Chromium（16 §3 因此一行没破）。

**服务端带浏览器的运行走 dsh 运行时（WP148，2026-09-24）。** 上面这些都挂在 dsh 那棵树上，而服务端平时走 direct
运行时（那条路上没有浏览器工具）。所以照 WP144 电脑操控的分流：`RunRequest.browser` 在场（职责 `browser_scope` 非空 +
设置页选了一种浏览器 + `forRun()` 给了）的运行改走 dsh 运行时，两种浏览器（官方 Playwright / BrowserSkill）都一样；
其余运行照旧 direct，一个字节不变（`apps/server/test/browser-dsh-route.test.ts` 用改前录的金样钉着）。
没配模型的 stub 档不改（没有模型，本来也驱动不了浏览器）。

---

## 4. 连接：目录 + 岗位清单 + 职责 preset（Q4）

三层，各管一件事：

| 层 | 是什么 | 大不大 |
|---|---|---|
| **连接目录**（18 加一节） | 所有可接的东西的总表，一条 = `{ kind, 名称, 鉴权方式（OAuth / API key / 扫码 / 客户端凭据）, 模式（OpenConnector provider / MCP 服务器 / 渠道适配器 / 浏览器）, 需要的字段, 读写分类 }`。Shopify、邮箱、YouTube、Amazon、飞书、**自定义 MCP 服务器**都是条目 | 会大，但**只在设置页与搜索里出现**，不是首页 |
| **岗位连接清单**（岗位页 + 向导第 ③ 步） | 从这个人勾的岗位 → 职责模板的 `connectors[]` 并集 → 减去已连的 → "连上这 N 个就能开工"，每项一键拉起 13 §4 的安全表单；`required` 的没连，岗位标"未就绪" | 小，通常 2–4 项 |
| **职责 preset**（官方 `agent-presets`，一职责一目录） | `agent.cordis.yml` 里放：该职责需要的 `mcp-client` 服务器行（`serverName` 全局唯一）、凭据引用（只放名字，值由 `ctx.credentials` 解析）、只挂它需要的工具行（这就是官方版的 allowlist：Config 里没有 `restrict` 字段，靠"只挂需要的"）、浏览器 provider（若该职责要浏览器） | 由职责模板**生成**，用户不直接编辑 |

凭据：官方 `ctx.credentials` 是一个 provider 抽象（默认 `credentials-local` 存 `$DSH_HOME/.credentials.yaml`，OS keychain 官方推迟未发）。我们写一个 **`credentials-openconnector` provider**：把 OpenConnector 里的 token 当 `records` 暴露，refresh 放在官方的 `modifyRecord`（跨进程锁的读改写）里。这样 dsh 侧的任何插件要凭据都从 OpenConnector 拿，13 §4 的"凭据不经模型"不变。**未验证**：官方 seam 是单 provider，本机凭据（模型 key）与 OpenConnector 能否分层，做的时候实测。

### 落点（WP86，已实现）

三层里的**第三层**与凭据段落地在哪，以及**实测到的四件与预判不同的事**。

| 件 | 落点 | 实测 |
|---|---|---|
| 职责 preset 由模板生成 | `dsh-adapter/src/preset.ts` 的 `writePreset()`：`<root>/<workspace>/<preset_id>/{agent,host}.cordis.yml + preset.yml`；`harness.ts` 在 `setup` 里 `ctx.agentPresets.mount()` | 挂得上，而且**不用** `PluginPackages`；只要 `cordis-plugin-loader` + `builtins.include`（见下 ①） |
| 一职责一套连接 | `apps/server/src/connection-directory.ts` 的 `roleConnections()`：职责模板 `connectors[]` 里写 `mcp:<名字>` → `RunRequest.connections[]` | 隔离成立：另一条职责的 Agent 看不到那个 `serverName`（用例钉着） |
| 自定义 MCP 接进运行时 | 同上 → preset 里一条连接一行 `@deepseek-ai/dsh-mcp-client`；工具名 `mcp__<workspace>_<kind>__<tool>` | 走现有 `classifySideEffect`，兜底 `write_external`；`read_tools` 勾出来的才按读 |
| 凭据引用 | preset 里写 `!!js process.env.<REF> ?? ''`；`harness.ts` 在 `mount()` 前一跳经 `ctx.credentials.resolve()` 放进 `process.env`，挂完还原 | `?? ''` 不能省（见下 ③） |
| `credentials-openconnector` | **新包** `packages/credentials-openconnector`（不放进 connect-adapter：那个包不依赖 dsh，`apps/server` 也不该因此拖进整棵 cordis） | seam 是**单 provider**（见下 ②），所以做的是**组合 provider** |

四件与预判不同的事：

① **preset 这一层要 `loader`，但不要整个 app-boot。** `AgentPresets` 的 `inject` 是
`['loader', 'sessionProjections']`，`mount()` 走 `cordis-plugin-include` 的子树。
所以最小挂载只多两个包：`cordis-plugin-loader`（服务）+ `cordis-plugin-include`
（`ctx.loader.builtins.include`）。官方测试里那个 `@deepseek-ai/dsh-app-boot` 的
`PluginPackages` **实测不需要**。`ctx.baseUrl` 必须指回 `dsh-adapter` 这个包——
preset 目录在数据目录下，Node 的 `node_modules` 上溯到不了我们的依赖。

② **`ctx.credentials` 是单 provider，本机与 OpenConnector 分不了层。**
`CredentialProvider extends Service`，服务名 `credentials`；一棵树上挂第二个当场抛
`service "credentials" has been registered at <…>`，先挂的那个继续有效。
所以 55 §4 那句"未验证"的答案是**不能分层**，改做一个组合 provider：
`CredentialRef`（环境变量名）走本机、`CredentialKey`（`<workspace>/<kind>` 记录）走
OpenConnector。

③ **解析不出来的凭据引用会让整份 preset 挂不上。** `!!js process.env.X` 求值成
`undefined` 时，上游 `mcp-client` 的 config 校验直接拒（`env` 要
`{ [key: string]: string }`），`mount()` 抛，这次运行整个失败。补上 `?? ''` 之后，
没配凭据的后果退回它该有的样子：那台服务器连不上、它的工具不出现，运行照常。

④ **preset 挂上来的工具受 `ctx.tools.restrict` 管——与浏览器 provider 正好相反。**
浏览器那一组是 `agent/created` 里的 scoped registration，白名单遮不住、列进去还会抛
（AGENT-LAYER §9.4）；preset 是 `setup` 里 `mount()` 的，**不列就整组被白名单挡掉**。
而且 `restrict` 只认调用当刻已注册的名字，所以顺序是硬的：**先 mount 后 restrict**，
反过来抛 `tools.restrict() names unknown global tools`，抛完整张白名单都没装上（更松）。
白名单的来源是那台服务器**探测出来的**工具清单（`RunConnection.tools`）。

---

## 5. 渠道：没有官方 seam，按官方形状自己做（Q5）

dsh 0.1.6 仍没有渠道 / IM 这一层（全仓文档零命中）。官方入站的做法只有一种：`agent.followup(createUserMessage({ source: { kind: 'webhook' } }))`——`webhook` 包自己就是这么把外部事件变成一个新 Session 的。所以我们的渠道层（18 §2 入站管线：去重 / 队列 / 重试 / 死信）**保留**，出口改成官方的 `followup`，这就是"按官方形状"。

三个渠道的定位：

| 渠道 | 官方入口 | 我们的定位 | 归属 |
|---|---|---|---|
| 个人微信 ClawBot | `Tencent/openclaw-weixin` 协议（扫码、HTTPS 长轮询） | "我的代理"的微信入口：本人问自己的代理、收自己的卡片；不做客服、不做团队 | 个人身份类，留本机（20） |
| 企业微信智能机器人 | 官方 WebSocket 长连接，群 @ | 团队渠道：审批卡推送、同事问代理 | 公司工作区 |
| 飞书 / 钉钉 | 各自官方 SDK | 同上 | 公司工作区 |

条款要点（微信 ClawBot 使用条款 6.1 / 6.4）：违规可牵连主账号。所以 ClawBot 只做"本人 ↔ 代理"这一件事，不用它对外发消息。

---

## 6. 待拍板

| # | 事项 | 我的建议 |
|---|---|---|
| Q1 | 会话日志上报 | 默认跟官方：个人端 + DeepSeek 官方端点时**开**，设置页白话开关；公司端 / 托管档**关**；README 改口 |
| Q2 | 引入官方 Agent 层，接受 §2.2 三个变化（模拟 parity 改按结果、会话不落 dsh JSONL、提示词经 dsh 装配） | 同意，**WP81**，其余 WP 的前提 |
| Q3 | 浏览器 = 官方 browser-use + Playwright provider；个人端 attach 用户单独 Profile 的 Chrome；契约 #20 瘦成 §3 的策略；ego-lite 不做 | 同意，**WP82**，依赖 WP81；首用途红人 YouTube 只读 |
| Q4 | 连接三层（目录 / 岗位清单 / 职责 preset）+ `credentials-openconnector` provider | 同意，**WP83**（目录与岗位清单可与 WP81 并行；preset 承载与 credentials provider 依赖 WP81） |
| Q5 | a) 文档改口 dsh-channels；b) 微信 ClawBot 做"本人 ↔ 代理"，企业微信机器人做团队渠道 | a) 我直接改；b) **WP85**，可并行（`packages/channels`） |
| Q6 | 派工顺序 | WP81 先单独派（大、碰底层）；WP83（目录 + 岗位清单部分）、WP84（quick_prompts / task_examples）、WP85（微信）三个与它并行——它们不碰 `dsh-adapter`；WP82 与 WP83 后半等 WP81 合并 |

## 7. 对既有文档的改动（拍板后）

- 17 §2 / §5.1 / §6：回合由 dsh 驱动、会话不落 dsh 文件、parity 改按结果
- 26 模拟 DSL：三运行时一致性的定义
- 09 契约表：#20 改名"浏览器策略"；ARCHITECTURE.md
- 18：加"连接目录"一节；05：`browser_scope?`、`quick_prompts?`、`task_examples?`
- 09 §7、README 第 44 行、`vendor/README.md`：dsh-channels 改口（Q5a）
- README："一切在你机器上"加"除非打开分享"（Q1）；对外叫法（P1）
- 53：§4 整节以本文 §3 取代；表头状态改"P1–P7 已答复，落地方案见 54"
- 41：我的代理加微信 ClawBot 入口

## 8. Q7（2026-09-17 补）：终端 / Shopify CLI 走官方 shell 与沙箱 seam

Luoye：Shopify 之后要用官方 CLI 改主题等，"终端"这种集成要考虑进来。53 §3 说过 Terminal AI+ 不进用户面，这一条不变；变的是**Agent 自己要能跑命令**。

| 项 | 建议 |
|---|---|
| 谁需要 | 只有 `site.builder`（建站与主题，43）这类职责；客服 / 运营 / 红人职责不给 shell 工具 |
| 用什么 | 官方 `dsh-tool-bash` + `dsh-sandbox`（macOS Seatbelt / Linux bwrap→Landlock / Windows restricted token）+ `dsh-sandbox-policy`，档位 `workspace-write`，工作区根 = 该品牌的主题工作副本目录，不给 `danger-full-access` |
| 与 43 的关系 | 主题改动流程不变：改的是副本 → `theme push` 到未发布主题 → 审批卡 → 批了才发布（`ThemePublishProposal`）。区别只是"跑 `shopify theme` 命令"这一步从服务端写死的几条（`shopify-theme.ts`）变成 Agent 在沙箱里按需跑 |
| 门禁 | 命令走 `tools/pre-execute`：`shopify theme push --unpublished` / `pull` / `list` / `check` = 读或本地写；`theme publish`、任何带 `--live` 的 = `write_external`（公司端拒，走审批卡）；非 `shopify` / `git` / `node` 前缀的命令一律拒（allowlist 白名单） |
| 凭据 | `SHOPIFY_CLI_THEME_TOKEN` 等仍由 13 §4 的方式进沙箱环境变量（与 WP86 的 `withPresetCredentials` 同一跳），不进模型 |
| 不做 | 用户面的终端窗口；给非建站职责开 shell |

**与另一会话 WP77（建站，docs/59）的分工（09-17 已对齐）**：WP77 不引入 shell / 沙箱、不做命令门禁，它把 `site.builder` 改名 `site.shopify-theme`（yml 在 `packages/roles/roles/site/shopify-theme.yml`），写动作 `theme_edit`（副本）/ `publish_theme`（永远 L1）已在，主题那一跳仍是 43 的 `apps/server/src/shopify-theme.ts` CLI 封装。Q7 落点沿用它：职责 id 用 `site.shopify-theme`；allowlist 把 `theme publish` / `--live` 归到 `publish_theme` 那张卡；合并顺序 WP77 先进 main、Q7 的 WP 再合。

**待拍板 Q7**：同意的话派 WP（`site.shopify-theme` preset 挂官方 shell + 沙箱、命令 allowlist 门禁、主题流程改由 Agent 在沙箱里跑 CLI），依赖 WP86 的 preset 机制与 WP77 合并。

## 9. Q8（2026-09-17 补）：用 ChatGPT / Claude 订阅登录（官方 `dsh-llm-pi-ai`）

Luoye：很多客户在用 ChatGPT 的套餐，官方连接器好像能直接用订阅，把它也连上。已核实（上游 0.1.6-alpha.1 + 已装的 `@earendil-works/pi-ai@0.85.1`）：

| 项 | 事实 |
|---|---|
| 机制 | dsh 不自己写 OAuth，全交给 `pi-ai`：provider `openai-codex`（"OpenAI (ChatGPT Plus/Pro)"，`isSubscription: true`），client id 是 OpenAI 给 Codex CLI 的公开 id（`app_EMoamEEZ73f0CkXaXp7hrann`），浏览器 PKCE（回调固定 `localhost:1455`）或设备码两种登录；请求打 `https://chatgpt.com/backend-api/codex/responses`，带 `chatgpt-account-id`；流式 + 工具调用都支持；模型 gpt-5.x 系列 |
| 凭据 | 记录键 `llm-pi-ai/openai-codex`，`{ kind: 'grant', payload: { access, refresh, expires, accountId } }`；到期前 5 分钟在 `modifyRecord` 里刷新（跨进程锁）；官方存 `~/.dsh` 下 0600 文件 |
| 登录入口 | `dsh-authorization` 的 `registerFlow` 已自动注册（`llm-pi-ai/src/login.ts`），但 0.1.6 的 web / desktop **没有任何 UI 调 `begin()`**——种子在、界面没接 |
| 计费 | dsh 只记 token 不记钱；订阅在我们这边 = `cost_base` 0、只显示 token 与"订阅额度" |
| 同类可登 | `pi-ai` 还带 **Anthropic (Claude Pro/Max)**、GitHub Copilot、OpenRouter、Kimi Coding、xAI 的 OAuth；**Gemini 没有** |
| 风险 | OpenAI 官方只授权自家 Codex 工具用订阅登录，对第三方客户端至今未表态；2026-03 起有第三方被 429 限流、2026-04 起 `chatgpt.com/backend-api` 对 headless 客户端 Cloudflare 403 的记录；Plus 有每周额度 + 5 小时滚动窗。账号是个人的 → **只能个人端登录**，公司档 / 托管档代持 = 共享账号，违反条款 |

**方案（按官方，路 ①）**：组合里加 `@deepseek-ai/dsh-llm-pi-ai`（只开 `openai-codex` 与 `anthropic` 两个订阅 provider）+ `dsh-authorization`；`ctx.llm` 按 provider 名并存：`openai-codex/*`、`anthropic/*` 归官方适配器，其余仍归 `agentsws-gateway`；网关那一侧对订阅路由只做记账（会话 usage 事件里的 token）、预算按 token 算、`cost_base` 记 0；凭据记录 `llm-pi-ai/*` 由 WP86 的组合 provider 路由到**本机加密秘密库**（不是 OpenConnector；这是个人身份类凭据，20 的规则），刷新沿用官方 `modifyRecord`；设置页模型一节加"用 ChatGPT 订阅登录 / 用 Claude 订阅登录"两张卡（设备码优先，浏览器流次之），**只在个人档出现**，卡上写明"第三方工具用订阅登录未获 OpenAI / Anthropic 明文授权，可能被限流或封禁；账号只属于你本人"。不做路 ②（自己复刻 Codex 协议）。

**落地**：WP90，排在 WP88（百炼模板）合并之后（同改设置页模型一节）。

### 9.1 落点（WP90，2026-09-17）

方案按路 ① 全部落地，外加 Luoye 中途追加的两条 UI 规矩。实测到哪一步、与预判差在哪：

| 事 | 落点 | 与 §9 表里的预判 |
|---|---|---|
| 组合 | `packages/dsh-adapter/src/subscription.ts`（新文件）+ `harness.ts` 五处挂载行。`RunRequest.runtime.model.provider` 是 `openai-codex` / `anthropic` 才 `root.plugin(PiAiLlm, { providers: { 'openai-codex': {}, anthropic: {} } })`；与 `agentsws-gateway` 按 provider 名并存（`ctx.llm.listProviders()` 三个都在） | 一致。profile **全空**是有意的：路由键命中 pi-ai 装着的 provider 时端点 / 协议 / 模型目录全继承它的，覆盖一个字段就等于把上游目录抄了一份进我们仓库 |
| 记账 | **`llm/stream` 这道 waterfall**（上游给的环绕钩子）：进去之前判预算 + 发 `progress{model_request}`，出来时把 `usage` chunk 投影成 `Completion`、`cost_base` 恒 0 | **与预判不同**：原以为要再包一个 `LlmAdapter`，但 `ctx.llm` 的 provider 名是独占的，官方插件已经占了这两个名字，第二次注册会被拒。waterfall 是唯一不改上游又能两头各切一刀的地方 |
| 凭据 | `credentials-openconnector` 的组合 provider 第三条路：owner 为 `llm-pi-ai` 的记录读写**本机加密秘密库**；`modifyRecord` 是真读改写（官方 `pi-ai` 的刷新就跑在里面），写完发 `credentials/record-updated`——**少发这一条，官方 `begin()` 会判 `NOT_COMMITTED`，登录报失败** | 一致，外加上面那条实测细节 |
| 登录流 | `POST /v1/settings/models/subscription/login` → `ctx.authorization.begin()`。设备码：用户码与验证页原样回给前端、后台轮询；浏览器：把授权页地址回给前端用 `openExternal` 打开，人在别的机器上就把授权码贴回来（`POST …/answer`） | **与预判不同一处**：`method: 'device' \| 'browser'` 不是官方 seam 的方法 id。官方 flow 只报 `oauth` / `api-key`，设备码与浏览器是 `pi-ai` 在流**里面**用一个 `select` 问的——我们在 `prompt` 里代答那一问（只答它自己列出来的 id，上游改了选项当场报错而不是瞎答） |
| Claude 没有设备码 | 实测：`pi-ai` 的 `anthropic` OAuth 只有浏览器 + 贴授权码。所以两张卡能点的按钮不一样，清单由服务端给（`SUBSCRIPTION_FACTS.methods`），前端不写死 | §9 表里没提，是这次查出来的 |
| 档位 | 公司档 / 托管档（`AGENTSWS_RUNTIME_MODE=docker\|hosted`）整块不可用：读一律"不存在"（不是"没权限"——报权限会泄漏"这台机器上有人登过"）、写一律拒、`login` 403 + 人话 | 一致 |
| 卡怎么摆 | **Luoye 中途定**：一家一张卡、点进去选方案。百炼三张收成一张（Token Plan 默认第一）、OpenAI / Anthropic 各一张（订阅登录是方案一、API key 是方案二）。承载方式是给 `ModelProviderTemplate` 加 `vendor` / `plan_label` / `plan_order` / `auth` 四个**可选**字段，不填的照旧一条一张卡 | §9 原本写的是"加两张订阅卡"，改口了 |
| 图标 | `pnpm icons:fetch` 按 WP48 那条路抓官网 favicon 入库：`bailian.png`（64×64，百炼控制台）、`openai.svg`（矢量，openai.com）、`anthropic.png`（256×256，anthropic.com）。图标按**卡的 id**（`vendor`）认，不再按 `kind` 认 | §9 没提，是追加项 |

**实测到哪一步（假服务器）**：`packages/dsh-adapter/test/fixtures/fake-openai.ts` 拦
`globalThis.fetch`，替身认这四条——设备码 usercode、设备码 token（第一次回 403 = 还没点）、
`oauth/token`（换票与刷新同一条）、`chatgpt.com/backend-api/codex/responses`（Responses
API 的 SSE）。**认不出的请求当场抛，CI 一个包都不出网**。跑通的是**整条真路**：
设备码登录 → 记录落库 → 一次带工具调用的运行真的经官方适配器打到 `/codex/responses`
→ 用量投影 → `cost_base` 0 → 到期前刷新经 `modifyRecord` 换了一把新的、请求头跟着换。
**没有用真账号登录过，也没向任何人要过账号。**

## 10. Q9（2026-09-17 补）：腾讯 BrowserSkill 作个人端第二执行器

已核实（`Tencent/BrowserSkill`，MIT，3.3k★，2026-06 开源，两周一版，0.3.0 于 09-17）：Rust `bsk` CLI + 本机 daemon + Chrome / Edge MV3 扩展，在**用户自己的浏览器**里 `chrome.debugger` 附加（不带 Chromium、不开调试端口），每 session 一个独立 Agent 窗口、借用户标签要确认；页面感知是自研 VOM（压缩 DOM + ref + 悬浮探测 + 分页）也有无障碍树；内置人接管弹层（`request-help`）；**远程模式**（Agent 在服务器、扩展在本机，WSS 配对）；操作录制成 trace（非录成 Skill）；无基准数据。它的 dsh 插件 `@wxg-prc-cpg/browser-skill-dsh-plugin` **直接注册 `ctx.tools`、不走官方 `dsh-browser-use` seam**，6 个多态工具（动作在 `action` 参数里，读写混），不暴露 evaluate；无原生构建、不下载浏览器；无腾讯云绑定、无遥测（daemon 每 30 分钟查 GitHub 更新，`BSK_AUTO_UPDATE=off` 可关）。

**Luoye 纠正（09-17）**：我们的尺子是"能用官方的就先用官方"，不是"只走 dsh 官方 seam"。Codex / Claude 都是"自带浏览器 + 浏览器插件"两条腿，很多东西只有在用户正在用的浏览器环境里才看得到、操作得到，所以第二方案必须有，腾讯这个就是很好的补充——**现在就做，直接用腾讯官方的 dsh 插件**，不自写 provider。

| 事项 | 做法 |
|---|---|
| 挂法 | `@wxg-prc-cpg/browser-skill-dsh-plugin` 按官方方式挂（它直接注册 6 个工具 + 一个 skill，`lazyTools`）；只在个人档、且用户在设置页选了"我正在用的浏览器"时挂 |
| 读写分类 | 门禁看 `args.action`：`browser_inspect` 全读；`browser_page` 的 navigate / back / forward / reload / wait 读；`browser_interact` 全写；`browser_session` start 读（带 url 走白名单）、stop 读；`browser_tabs` list / select 读，create（带 url 走白名单）/ close / borrow / return 写；`browser_assist` 读 |
| 域名白名单 | 拦 `browser_page{url}`、`browser_session start{url}`、`browser_tabs create{url}` 三处，规则与官方 provider 同一套（`browser_scope`） |
| evaluate | dsh 工具面本来没有；`bsk evaluate` 归 shell allowlist（WP89）一并禁 |
| 隐私 | daemon 的 30 分钟 GitHub 查更新默认关（`BSK_AUTO_UPDATE=off`），更新由我们的上游哨兵盯 |
| 安装 | 向导两步：装扩展（Chrome / Edge 商店链接或本地加载）+ 装 `bsk`（我们钉版本与 sha256 从 GitHub Releases 下载，不用它的 `install.sh`）；`bsk doctor` 前置检查 |
| 与官方 provider 并存 | 设置页"浏览器"一节两种方式并列：「单独的工作 Chrome（官方 Playwright）」「我正在用的浏览器（腾讯 BrowserSkill 扩展）」，一次运行只挂一种 |

**落地：WP92（已实现，落点见下）。**


### 落点（WP92，已实现）

上面那张表逐行落在哪，以及**实测到的四件与预判不同的事**。

| 约束 / 策略 | 落点 | 实测 |
|---|---|---|
| 工具面 | **直接挂腾讯官方插件**（Luoye 拍板：不自写 provider）。`harness.ts` 在 `setup` 里、与 WP82 同一位置同一顺序（mount → installGate → 浏览器）`await agentCtx.plugin(BrowserSkillPlugin, …)`；这一档**不挂** `BrowserUseRegistry`（它不走那个 seam，挂了也没人占槽） | 六个工具照常报上来；`lazyTools` 必须显式关（见下 ①） |
| 读写分类 | `browserskill.ts` 的 `BROWSERSKILL_READ_ACTIONS`（按 `args.action`）→ `tools.ts` 的 `classifySideEffect` 多一条分支 | 与派工书那张表一致；表外动作与"没给 action"一律按写 |
| 域名白名单 | `browserskill.ts` 的 `checkBrowserSkillPolicy`，三处：`browser_page{navigate}` / `browser_session{start}` / `browser_tabs{create}`；规则（`hostAllowed` + 人话理由）与官方 provider 同一套 | 三处都拦得住；`navigate` 少给 url 按"打不开这个地址"拒 |
| 公司端禁 evaluate | 工具面里**没有** evaluate，所以这一层不写代码；能跑脚本的是 `bsk evaluate` 这条 CLI，归 shell allowlist（WP89） | 另外我们把 `bsk` **装在数据目录、不进 PATH**，少一条顺手能敲到的路 |
| 人接管 | `browser_assist{request-help}` 两档都放行，并发 `progress{step:'browser_handoff'}`；提示词里多三条（单独窗口 / 借标签先问 / 卡住了请人接管） | 这是这一种相对官方 provider 真正多出来的东西 |
| 供应链 | `bsk` 由我们钉版本 + sha256 下载（`browserskill.lock.json` + `apps/server/src/browserskill-install.ts`），**不用上游 `install.sh`**（它校验不了会"只警告"、还会改用户的 `~/.zshrc`）；插件锁死 `0.3.0` 进 `minimumReleaseAgeExclude`（无 postinstall、无原生模块、无 dependencies——逐条核实过） | 本机真装了一次：darwin-arm64 产物 sha256 与 lock 逐字相同 |
| 只在个人档 | `browser-settings.ts`：`browserskill_allowed = runtimeMode() === 'local'`，`forRun()` 还要 `bsk` **真的装了**才给 | 没装就当这次运行没有浏览器（比给一个坏路径安全，见下 ③） |

四件与预判不同的事：

① **`lazyTools` 的默认值会让工具面整个空掉。** 上游缺省 `lazyTools: true`：六个工具要等
`browser-skill` 这个**技能**被成功调用过一次才注册（progressive disclosure，触发器挂在
`tools/result` 上等一个名为 `skill` 的调用）。我们的最小组合里没有 `dsh-skill` /
`dsh-tool-skill`，那个触发器一辈子不会响——实测 `lazyTools: true` 时
`ctx.tools.schemas(agent)` 是**空的**。所以配置里写死 `false`。

② **它的六个工具是 scoped registration，不能列进 `restrict`——与派工书的预判相反。**
派工书按"插件直接 `ctx.tools.register` = 全局注册"推断要把六个名字列进职责白名单。
实测：**挂在哪个 ctx 上决定的是哪一种**——我们挂在 Agent 的 scoped ctx 上（与官方
provider 同一位置），于是注册就是 scoped 的：`restrict({allow})` 遮不住它们，
而把它们**列进去当场抛** `tools.restrict() names unknown global tools`（抛完整张白名单
都装不上，反而更松，AGENT-LAYER §9.4 那条坑）。所以这一条**按官方 provider 那一套办**：
一个字都不列。"只有 `browser_scope` 非空的职责才有这六个工具"照样成立，靠的是另一条
既有的链：职责没填 `browser_scope` → `allowed_hosts` 空 → `runtime.ts` 根本不给
`RunRequest.browser` → 插件不挂、门禁的 allowlist 也不放这六个名字。

③ **`bsk` 路径指错会把我们自己的进程打死。** 插件加载时会 spawn 一次 `bsk --version`
探活；文件不存在时那个子进程 spawn 失败（ENOENT）却已经被记进它的 in-flight 表，
卸载时 `killAll()` 对一个**还没有 pid** 的子进程调 `child.kill('SIGINT')`——信号落到
**我们自己这个进程组**上，服务进程当场收到 SIGINT 退出（复现：挂上插件后立刻 dispose）。
所以纪律是**装好了才挂**：`bskBinaryUsable()` 在挂之前查一次，没装就让这次运行
明明白白失败；服务端那一侧更早一步，`forRun()` 没装就不给 `browser`。

④ **`BSK_AUTO_UPDATE=off` 只关"装"，不关"查"。** 本机实测：设着 `off` 跑一次
`bsk doctor`，`~/.bsk/update-check.json` 里照样多出一条 `latest_version`——上游
`daemon/start.rs` 的周期任务里 `refresh_update_cache()`（出网取 version.json）发生在
`auto_update_step()` 之前，`off` 只让后者不装。所以我们**两个开关一起设**：
`BSK_AUTO_UPDATE=off` + `BSK_UPDATE_MANIFEST_URL` 指到一个没人监听的回环地址。
一种管不到的情况得说清楚：daemon 早就在跑时，它继承的是当初那个环境。

设置页：三种方式并列单选（不开 / 连接我电脑上的 Chrome / 用独立的 Chrome / **我正在用的浏览器**），
第四种选中后出三步向导——① 装扩展（只给两个官方商店链接，扩展只能用户自己装）
② 装 `bsk`（一键，走上面那个安装器）③ `bsk doctor`（把它那几条**原样**列出来，含
"怎么修"）。桌面壳托盘多一项「检查浏览器扩展」。白话那一句写在向导底下：
"独立的浏览器不碰你日常的登录；用你正在用的浏览器能看到你登录后才看得到的东西，
Agent 会在单独窗口里操作，动你已开的标签会先问你。"

手工验证步骤 `scripts/dev-browserskill.md`；这次实测到第 ③ 步（装扩展要真人点"添加"，
所以"真的 observe 一次"仍欠着）。
### 落点（WP89，2026-09-17 已实现）

上面那张表逐行落在哪，以及**实测到的三件与预判不同的事**。

| Q7 那一行 | 落点 | 实测 |
|---|---|---|
| 谁需要 | `dsh-adapter/src/shell.ts` 的 `SHELL_ROLE_IDS = ['site.shopify-theme','site.builder']`，**加上** `RunRequest.shell` 给没给——两道都过 `harness.ts` 才挂那一摞 | 冗余是有意的：契约说的是"怎么跑"，"谁能跑"不该由请求方说了算。客服职责即使请求里带了 `shell` 也不挂（测试钉着） |
| 用什么 | `dsh-tool-bash` + `dsh-bash-sandbox` + `dsh-sandbox-local` + `dsh-sandbox-policy`（+ `shell-env` / `subprocess-local`），全在 `harness.ts` 的 `root.plugin(...)` 里——**不是**写进职责 preset（交付单原话是写进 preset，实测挂不上，见下面"偏离"一段） | **① 档位的真源不是 config，是会话的 cwd**。`sandbox-policy` 的 `workspaceRoot` 只是"没有会话时的兜底"，管着 Agent 那次调用的是 `SessionHeader.cwd`（上游原话：normal agent calls use their session cwd instead）——所以 `agents.create` 的 `meta.cwd` 必须是同一个目录，少一处就写到别处去了 |
| 与 43 的关系 | 43 新增 §5b；`apps/server/src/shopify-theme.ts` 一条没删，头部加了分工表 | Agent 管"改与看"，服务端管"发与长驻"（`publish` / `theme dev`）。`ThemePublishProposal` 是两边的接缝 |
| 门禁 | `shell.ts` 的 `checkShellCommand`，接在 `gate.ts` 的 `tools/pre-execute` 上、**排在读写分类之前** | **② `bash` 按工具名判不出读写**：一个名字底下几十条命令，落到 `classifySideEffect` 的兜底会被整个当成写外部，公司端连 `theme list` 都跑不了。所以这一关先把命令拆开，判完直接给出分类 |
| 门禁（发布那一条） | `gate.ts` 的 `materializePublish`：`shopify theme publish` / `--live` → 一条 `publish_theme` 的 staged change（15 §2 永远 L1），然后拒掉这次调用 | 卡上的 `before` 这里填不出来（Agent 没读过线上那一份，15 §1 不许编），由服务端 `proposePublish()` 渲染卡之前真读一次补上 |
| 凭据 | `shell.ts` 的 `AgentswsBashExecutor`（`dsh-bash-sandbox` 的子类）在 `resolve()` 里把这一跳的 env 合进 spec | **③ WP86 那条"放进 `process.env` 再还原"的路在这里走不通**：官方 `dsh-subprocess` 对继承来的环境有一道清洗，`/KEY\|PASSWORD\|SECRET\|TOKEN/i` 的名字一律不往子进程传，`SHOPIFY_CLI_THEME_TOKEN` 正好撞上。改走执行器的显式 env 之后反而更紧：令牌**一次都不进这个进程的环境** |
| 不做 | 用户面终端、非建站职责的 shell、`danger-full-access`（契约 `RunShell.mode` 里拼不出来） | 升档请求（`bash` 的 `sandbox_permissions`）门禁一律拒 |

**沙箱实测**：macOS 26 / arm64 / dsh 0.1.6-alpha.1，`workspace-write` 真起得来，
上游报 `enforcement: 'full'`（Seatbelt），副本目录外的写回 `Operation not permitted`；
`pnpm install --frozen-lockfile` 不开任何构建。Linux（bwrap→Landlock）与 Windows
（受限令牌）按上游文档，未在本机实测。

**偏离一件（实测过，不是猜的）**：交付单说"在这条职责的 preset 里挂"。试了——把那六行写进
`agent.cordis.yml` 再 `mount()`，上游当场拒：

> `agent-presets: preset "…" failed to mount: row(s) published process-global service(s)`
> `[sandbox, sandboxPolicy, shell, shellEnv, subprocess]; a preset service must sit behind an`
> `` `isolate` realm or move to the host composition ``

与 §3「浏览器 provider 不写进 preset」是同一条纪律（`preset.ts` 的 manifest 注释早写过
"不许往 root realm 发服务"，只是那次没撞上）。上游给的两条路——`isolate` realm、
或者搬到宿主组合——选了后者，还有第二个独立理由：**沙箱根是一次运行一个值**
（这家店的副本目录），写进 preset 文件等于每次运行重写它，而上游把"代"钉在组合文件的
mtime + size 上、被顶掉的那一代永不回收。所以职责 preset 那一层仍然只管 MCP 连接；
"谁有终端"照旧由职责说了算（`SHELL_ROLE_IDS`），只是挂的地方在宿主。

**顺带动的两处**（3 人 pack 那条建站题要它们才跑得起来）：`synth.ts` 的 `PEOPLE_3`
给店主多挂一条 `site.builder`（3 人公司没有专职建站，壳是店主自己按模板凑的——
这是他身上多出来的一顶帽子，不是一个岗位），`assignments.yml` / `manifest.yml`
随生成器重出；三处写死"38 条场景"的断言改成 39（`synth.test.ts` / `report.test.ts` /
`cli.test.ts`），`cli.test.ts` 那条的超时从 60s 对齐到 120s（`report.test.ts` 同形的题
一直是 120s）。

**后置一件**：Agent 还没有"在副本目录里改文件"的手（白名单里没有 `cat` / `sed`），
要挂官方 `dsh-tool-fs` + `dsh-fs-sandbox`（它们读同一个 `ctx.sandboxPolicy`）。见 43 §5b 末尾。

---

## 11. 电脑操控（2026-09-24，Luoye 定「先加进来，和官方一起同步更新」；WP144）

浏览器之外的第三条"让 AI 动手"的路：官方 `dsh-computer-use` + Cua Driver **MCP 提供方**（驱动是独立进程；
不用 native——它在我们的进程里跑原生模块，上游原话「原生崩溃可能终止该进程」）。纪律照抄本文 §3 / §10：
工具面全部来自官方，我们只写策略；挂在与浏览器同一个 `setup`、排在浏览器之后（mount → installGate → 浏览器 →
电脑操控）；驱动钉版本 + sha256 下载到数据目录、不进 PATH、不用上游安装脚本（照 WP92 的 `bsk`）；
**装好了才挂**；遥测 / 查更新默认关。与浏览器两条腿不同的三处：**只本机档**、**驱动工具一律按写**、
**每次运行先出授权卡、批了才挂提供方**（三层开关：总开关 → 勾职责 → 授权 N 分钟）。

全文（形态、三层开关、门禁、隐私、平台差异、实测到的四件事）见 **docs/80**。

**WP147（2026-09-24）截图进模型**：Playwright 的 `browser_take_screenshot` 与 BrowserSkill 的截图动作，
在路由验证过能看图时同样进模型（官方 MCP 桥 / BrowserSkill 插件都认 `ctx.attachments` + 路由的图片声明）；
门禁读写分类不变。截图会发给用户选的 AI 模型用来看界面，不会存进 Agents 工坊的记录。机制与预算见 docs/80 §11。

