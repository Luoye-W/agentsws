# 55 · 按 dsh 官方方案对齐：Agent 层、浏览器、连接与渠道 v1（方案稿）

| | |
|---|---|
| 状态 | **已定案并全部落地（2026-09-16）**：Q2 WP81 官方 Agent 层、Q3 WP82 浏览器、Q4 WP83（目录 + 岗位清单）+ WP86（职责 preset 承载 + `credentials-openconnector`）、Q5 WP85 微信 / 企业微信 + Q5a 改口、P6 WP84 快捷提示，均已合并进 main；Q1 查证后不做开关（上传通路不存在，见 `packages/dsh-adapter/AGENT-LAYER.md` §7）。编号说明：本文原为 54，与另一会话的「54 岗位是任务主入口」撞号后改为 55；WP 编号从 71–75 改为 81–86。后置项见 docs/35 各条 |
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
