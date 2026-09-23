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
