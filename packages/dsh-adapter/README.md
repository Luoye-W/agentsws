# @agentsws/dsh-adapter

`RuntimeAdapter`（`name='dsh'`，17 §4）。
**唯一允许 import `@deepseek-ai/dsh-*` 的包**：业务代码只见 `RuntimeAdapter`，
升级 dsh 只看这里的 seam 契约测试红不红。

## 先读哪一份

**一次运行到底发生了什么，看 [`AGENT-LAYER.md`](./AGENT-LAYER.md)**——它跟着代码走，
一节一件事；这份 README 只说"这个包是什么、怎么验它"。

| 想知道 | 去 AGENT-LAYER.md 的 |
|---|---|
| 挂了哪些官方包、为什么不挂 `dsh-base` | §1 |
| 一次运行的形状（`agents.create` → `followup` → `whenIdle` → `dispose`） | §2 |
| dsh 的 `session/event` 怎么变成我们的 `RunEvent` | §3 |
| 五个门禁在官方 Agent 层下怎么落地 | §4 |
| 模拟 parity 与指标变动 | §5 |
| 升级基线（`test/upgrade-baseline/`） | §6 |
| 会话日志上报（Q1）的查证结论 | §7 |
| 浏览器：官方 provider + 我们这一侧的策略 | §8–§9 |
| 职责 preset 与凭据 | §10 |
| 终端与沙箱（`bash` + 命令 allowlist） | §11 |
| 网页搜索与抓网页（官方 `web_search` / `web_fetch`，WP179） | §13 |

这一节以前是一张"一次运行做了什么"的流程图。WP81 把回合交给官方 Agent 层之后
那张图就不准了（它画的还是我们自己排回合的样子），所以撤掉，换成上面这张索引——
**一件事只在一个地方说**，免得代码改了图没改。

哈希用 `@agentsws/stand-ins` 导出的 `assemblePromptHash` / `contextItemHash`：
**一处定义**，运行时发事件与回放重组共用它，`prompt_replayable` 才有意义（17 §6.1）。

## seam 契约测试

`test/seams.test.ts` 七组，一组一个 seam。任一红 = 不升级 dsh：

| seam | 我们依赖的行为 |
|---|---|
| `tools/pre-execute` | `allow` / `deny{reason}` / `ask`；`ask` 无 answerer 时 fail-closed |
| `tools/post-execute` | 成功结果可 replace `value`（围栏）、可 `block`；失败结果不可替换 value |
| `approval/request` | answerer waterfall，`next()` 委托；无 answerer / 抛错 → `unavailable` |
| `systemPrompt.section` / `.context` | `complete` 段是唯一有效段；context 落成持久快照分节 |
| `ctx.tools.restrict` | 只在 scoped context 生效；默认拒绝；子 scope 继承 |
| SDK `run()` / `subscribe()` | `initialize` → `session/prompt` → inbox 收据 → `assistant/message` → `session.status: idle` |
| preset | 一目录一 `agent.cordis.yml`，具名插件行；组合只由 RunRequest 决定 |

后挂上来的三层各有自己的 seam 用例：

| 层 | 用例 | 钉的是 | 细节 |
|---|---|---|---|
| 浏览器（WP82） | `test/browser-seam.test.ts` | 真 provider 报的 24 个工具名、域名白名单、读写分类、注 JS 硬拒 | §9 |
| 职责 preset（WP86） | `test/preset-seam.test.ts` | 生成幂等、凭据只有名字、按职责隔离、`read_tools` 判定、`restrict` 顺序 | §10 |
| 终端与沙箱（WP89） | `test/shell-seam.test.ts` | 命令 allowlist 逐条、沙箱真起一次、发布物化成卡、凭据不进事件 | §11 |

SDK 那组用 `test/fake-runtime.mjs`（只说线协议、不跑模型）——我们要钉的是协议，不是模型。

## 与上游的已知差异

见 `test/seams.test.ts` 里带「已知差异」的用例：

1. 可遮蔽的 persona 段名是 `deployment:persona-prefix` / `deployment:persona-suffix`
   （不是文档里的 `deployment:persona`）；我们用 `complete: true` 段整段接管。
2. `tools/post-execute` 不允许替换**失败**结果的 `value`（会把调用变成 pipeline 错误）。
3. `@deepseek-ai/dsh-sdk-client` 的类型声明导出 `createProcessDeepSeekHarness` /
   `createProcessHarnessClient`，但运行时入口没有导出它们。
4. 本适配器跑的是**同进程** headless 组合，不是 `dsh --profile headless` 子进程：
   `stage` / `createDraft` / 合成时钟都是进程内回调，跨进程要先有一层 IPC。
   跨进程形态的组合由 `writePreset()` 生成到同目录的 `host.cordis.yml`，两边是同一份定义。
5. （WP86）官方 `ctx.credentials` 是**单 provider**：一棵树上挂第二个 `CredentialProvider`
   当场抛 `service "credentials" has been registered`。本机凭据与 OpenConnector 的分层
   只能在一个 provider 内部做（`@agentsws/credentials-openconnector`）。
6. （WP86）`agent-presets` 挂上来的工具**受** `ctx.tools.restrict` 管，且 `restrict` 必须
   在 `mount()` **之后**调——与官方浏览器 provider 的语义正好相反（AGENT-LAYER §9.4 / §10.1）。
   （WP132：0.1.7 换成 `dsh-agent-preset-registry` 之后这条照旧成立，`preset-seam.test.ts` 17 条一条没改；
   另外 0.1.7 是**注册即激活**，凭据引用在 `register()` 那一跳解析。）
7. （WP89）`dsh-subprocess` 对**继承来的**环境有一道清洗：`/KEY|PASSWORD|SECRET|TOKEN/i`
   的名字一律不往子进程传。所以 Shopify CLI 的令牌不能经 `process.env`，得经执行器的
   显式 `env`（AGENT-LAYER §11.2 第 ③ 条）。
8. （WP89）`sandbox-policy` 的 `workspaceRoot` 只是"没有会话时的兜底"；Agent 那次调用的
   可写边界是**会话的 `cwd`**，两处必须一致（AGENT-LAYER §11.2 第 ① 条）。

## 逐行重判：官方功能优先（WP179，Luoye 09-29）

Luoye 09-29 定的新规矩：**官方更新了什么、有什么新功能，尽量都集成进来用起来；除非真的有冲突、导致我们整个工具运行不起来，
否则一定要尽量多。** 所以 `profiles/agentsws/cordis.patch.yml` 的每一行锁定、以及这个包里别处"默认关"的东西，逐行按三类重判：

- **A 功能、不冲突 → 打开并接进来**（说清接在哪；只是打开没有入口的写"已开，入口排后"）；
- **B 真冲突 → 保留锁定**：只有"打开会让我们的工具跑不起来"或"会绕过出卡 / 授权 / 花钱闸"才算，写清冲突在哪、有没有办法包一层后打开；
- **C 把用户业务数据发给第三方的上报 → 先关**，逐条写清"打开会把什么数据发给谁"，交 Luoye 定（这不是功能，是数据外发）。

测试口径（`test/profile-lockdown.test.ts`）：B / C 类（`LOCKDOWN`）原断言不改；A 类撤锁的（`OPENED`）钉"我们的 patch 里没有这一行、组合树里是开的、
两档模块图里真有这个包"；跟官方的（`FOLLOW_OFFICIAL`）钉"组合结果等于官方 bundle 自己写的值"。

### 表一：profile 层的每一行

| 行（id） | 是什么 | 判 | 为什么；打开后在哪里用得上 |
|---|---|---|---|
| `web-search-deepseek` | 官方 DeepSeek 原生网页搜索（Messages 口 + 服务端 `web_search` 工具；账号会话用账号令牌免 key） | **A，已撤锁、已接** | Luoye 09-29 第 1 条。两档运行时由 `src/web.ts` 挂官方 `dsh-web` + `dsh-tool-web` + `dsh-web-fetch-http` + 这个包的 `DeepSeekSearchProvider`；我们只包一层：凭据（账号优先、其次用户自己的官方 key，现取）、审计、用量、每条运行的次数上限。职责 YAML 的 `web_tools` 决定谁有（查资料的十四条），服务端 `apps/server/src/runtime.ts` 组 `RunRequest.web`、这类运行走 dsh；模型页有「用你的 DeepSeek 账号搜索」开关（数据接口路由 `web.search` 第一级） |
| `web` / `web-fetch-http` / `tool-web` | 官方 `ctx.web` 服务、匿名抓公网网页、模型面的 `web_search` / `web_fetch` | **A（WP177 就没锁），已接** | Luoye 09-29 第 2 条"官方的抓网页工具不要关"。同上一行，抓网页不要凭据，职责挂了就给 |
| `hmr` | 监视 profile 目录、热替换模块（开发用） | **A，跟官方** | 不是冲突、也不外发，撤掉我们这一行；官方 headless 包自己就关着它（一次性任务用不上热替换），组合结果仍是关——入口：无（开发工具，不是给用户的功能） |
| `deepseek-account` | 官方 DeepSeek 账号登录 / 余额 / 登出 | **A，已接（WP134）** | 设置里选「用我的 DeepSeek 账号登录」就开（服务进程懒加载官方模块；完整 profile 叠 `deepseek-account.on.patch.yml`）。profile 这一行留着是"没选时关"的那一半 |
| `computer-use` / `computer-use-cua-driver-mcp`（插进来） | 官方电脑操控 + Cua Driver MCP 提供方 | **A，已接（WP144）** | 设置里打开「电脑操控」、这件事的授权卡批了才叠 `computer-use.on.patch.yml`。插进来写死关是"没选时关"的那一半 |
| `plugin-manager` / `tool-plugin-manager` | 插件管理页 / 模型面的装插件工具：以宿主用户身份跑 pnpm 装任意包，装完的代码在沙箱外、同进程里跑，还能放行被挡的构建脚本、改写这份 patch | **B** | 绕过出卡 / 授权：装一段任意第三方代码没有任何人批；装进来的插件还能把下面 C 类的上报悄悄打开。**包一层能开**：装插件改成出卡、只从我们审过的清单装、装完不写 profile patch（另立一单，M）。自动审阅、定时任务这类官方可选包都要经它装，所以它们也一起等这一单（见表二） |
| `config-editor` / `settings` | 把表单保存**写回这份 patch 文件**并立刻生效；`settings` 的写回走前者，还会导入并改名 `$DSH_HOME/settings.yaml` | **B** | 一次表单保存就能把 C 类的上报打开（那是要 Luoye 拍板的数据外发），也绕开 `patchReload: startup`；我们的产品没有官方设置页这个入口。**包一层能开**：只许写不在锁定表里的行，或改写到 `$DSH_HOME` 那一层（另立一单，S–M） |
| `session-log-deepseek`（`enabled: false`） | 每次走官方 DeepSeek API 的请求附上会话日志 | **C** | 打开会把**整条会话记录**（客户原文、订单、政策、工具入参与结果、系统提示）随每次请求增量发给 **DeepSeek（官方 API 的 `dsh_session_log` 字段）**。注：我们的模型走自己的网关，这条上传通路今天根本不存在（AGENT-LAYER §7）；它管的是"哪天真起了完整 profile、真接了官方 provider" |
| `otel` | 上报通道工厂 | **C** | 单独挂着不发东西，但它是下面那条反馈上报与官方产品埋点的发送层；打开 = 给它们开了往 **DeepSeek 的收集端**发数据的通道 |
| `session-telemetry-otel` | 反馈上报（默认 `FEEDBACK_ONLY`） | **C** | 打开后用户一点"反馈"，就把**整条会话日志**（消息原文、工具参数与结果、系统提示……）连同匿名用户 id 发到 **DeepSeek 的收集端 `dsh-otel-collector.deepseeksvc.com`** |
| `plugin-package-inventory-deepseek` | 每次官方 API 请求附插件包清单 | **C** | 打开会把**当前挂着的全部插件包名与版本**（含我们自己的包）随每次官方 DeepSeek API 请求发给 **DeepSeek**。不含客户数据，但暴露了用户装了什么；是否接受由 Luoye 定 |

### 表二：这个包里别处"默认关 / 没挂"的官方东西

| 项 | 判 | 为什么；在哪里用得上 |
|---|---|---|
| `tool-bash` 的 `enableRunInBackground: false` / `promoteOnTimeout: false` | **B** | 后台命令在一次运行结束（树销毁）之后没有主人，还在跑——绕过「停止」按钮与时间 / 花钱上限。**包一层能开**：后台任务登记成事项里一条可停的任务、跟着事项走（M） |
| `dsh-agent-loop` 的 `maxParallelToolCalls: 1`（串行） | **A，入口排后** | 并行不绕闸（每个调用照样过门禁），但会让同一件事两次跑出的事件顺序不同；打开要先把模拟 parity 与升级指纹改成按 `call_id` 比（S–M），另立一单 |
| `dsh-system-prompt` 的 `includeHarnessIdentity: false` | **A，但打开没有效果** | 我们的 persona 是 `complete` 段，官方那句身份说明打开也会被遮掉；不动 |
| `dsh-time-context`（每一步给模型报时） | **A，入口排后** | 不冲突；但它挂在 agent-loop 每一步、会改每一次运行的提示词，只在 dsh 一档挂会破三运行时 parity。建议另一单在三个运行时的上下文里写一次"现在时间 + 公司时区"（S） |
| `dsh-schedule` / `ui-schedule` / `dsh-experimental-schedule-bundle`（定时 / 提醒） | **A，但官方说 headless 挂不上** | 官方 README：要官方 Web 的会话控制器与持久会话；我们的定时是自己的 `packages/schedule`。借设计（daily / weekly 写法、运行记录翻页），见 UPGRADE.md WP149 §5.1 |
| `dsh-experimental-auto-review`（自动审阅） | **B** | 每次工具调用前让模型自己判，"放行"就按全权执行——正好绕过出卡 / 授权（我们要人批的都经 `approval/request` 出卡）。官方也标了"可能放行不安全的动作"。只能经插件管理装（上表 B） |
| Inspector | **没有可开的** | 官方 0.1.7-rc.2 起不再默认提供，依赖树里没有这个包 |
| 工作过程展示（官方 web 客户端 `ui-chat` 的 transcript 设置） | **A，借形** | 是官方网页客户端的界面设置，我们的界面是自己的工作台；事项时间线就是"工作过程"，不挂包 |
| Cua 驱动的遥测 / 查更新（`applyCuaEnv`） | 遥测 **C**；查更新**不归这张表** | 遥测打开会把驱动的使用数据发给 **Cua（trycua，驱动厂商）**，交 Luoye 定；查更新是第三方驱动自己去 GitHub 看新版，我们的驱动钉版本 + sha256 装（`computer-use.lock.json`），换版本走 docs/42 |
| BrowserSkill 的自动更新 / 查更新（`applyBskEnv`） | **不归这张表** | 腾讯插件自己的，不是 dsh 官方功能；换版本同样走钉版本那条路 |
