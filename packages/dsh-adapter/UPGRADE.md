# dsh 升级记录

一版一节。每节回答同样四个问题：**上游改了什么、我们碰到没有、我们改了什么、怎么证明行为没变**。
流程本身写在 `docs/42-上游升级流程-v1.md`；这里只记具体某一次升级的事实。

---

## 0.1.3-alpha.2 → 0.1.5-rc.1（2026-09-10，WP41）

### 0. 版本口径

npm 上 `@deepseek-ai/dsh` 的 dist-tags（升级当天）：

| tag | 版本 |
|---|---|
| `latest` | **0.1.5-rc.1** |
| `next` | 0.1.5-rc.1（与 latest 同一个） |
| `alpha` | 0.1.5-alpha.2 |

**没有裸 `0.1.5`**：版本表里从 `0.1.3-alpha.2` 直接跳到 `0.1.5-alpha.1` → `0.1.5-alpha.2` → `0.1.5-rc.1`，
`0.1.4` 整个版本号也没发过。所以"升到 latest"就是升到一个 rc，`minimumReleaseAgeExclude` 要跟着加
（见 §3）。锁的仍然是**精确版本**，不用 `^`——上游预发布期可以自由重命名重组，浮动版本等于随时炸。

### 1. 上游改了什么（只列碰得着我们的）

上游没有 CHANGELOG，出处是**包内 README 与 `.d.ts` 的 diff**（比对 0.1.3-alpha.2 与 0.1.5-rc.1 两棵
`node_modules` 的全部 `*.d.ts` + `README.md`），逐条记在下面。

| 包 | 变化 | 出处 | 碰到我们吗 |
|---|---|---|---|
| `dsh-sdk-protocol` | **`.d.ts` 逐字节相同** | `lib/types/{index,transport,types}.d.ts` diff 为空 | 否。`JsonRpcLineTransport` 是子进程档的传输，一个字没动 |
| `dsh-tools` | `run_code` 的 PTC 事件改名：`tool/code-dispatch{,-start}` → `tool/ptc-dispatch{,-start}`；子调用 id 从 `<parent>:code:<n>` 改成不透明的 `<parent>:ptc:<n>` | `lib/types/{types,index}.d.ts` | **否**。我们不用 `run_code`；`pre-execute` / `post-execute` / `defineTool` / `tools.restrict` / `tools.execute` 的签名与语义都没动 |
| `dsh-llm` | 新增 `SystemMessage`、`createSystemMessage()`、`SystemPromptUpdate = 'in-history'`、`LlmResolvedModelInfo.systemPromptUpdate?`、`LlmModelInfo.error?`。`GenerateOptions.system` 的注释改成"**给一次性调用方用**；loop 构造的请求把系统提示词放进 `messages` 的 system 消息里" | `lib/types/{message,types,index}.d.ts` | **否**（但要看清楚）。我们是那个"一次性调用方"：`harness.ts` 走 `ctx.llm.stream({ system, messages, tools })`，这条路仍然受支持、语义不变。`systemPromptUpdate` 是可选的 KV-cache 优化，我们的 `resolveModel` 不声明它，行为按旧的来 |
| `dsh-system-prompt` | **`.d.ts` 没变**；README 说明改了：渲染出来的提示词现在以 system-role 消息进入派生历史（surface node 0），`request/header` 不再带 `system` 字段 | README `#### What the model sees` / `#### KV Cache effect` | **否**。那是 `dsh-agent-loop` 那条路的事；我们不用官方 loop。而且我们的 persona 是 `complete: true` 段，整份提示词就是我们自己那段（见 §4 的实测） |
| `dsh-session` | `SESSION_FORMAT_VERSION` **2 → 3**；`EpochHeader.system` 字段**删除**（系统提示词改为派生历史）；新增 `validateSessionEventData()` / `validateSurfaceMetadata()`；新增迁移包 `dsh-session-format-v2-to-v3` | `lib/types/{types,surface,request-header,index}.d.ts` | **否**。`@deepseek-ai/dsh-session` 在 `package.json` 里，但 `src/` 与 `test/` 一处都没 import——它是 profile 版本矩阵的占位。我们的会话日志是自己的（`session_ref.log_uri`），不是 dsh 的 JSONL |
| `dsh-user-approval` | README 重写，**四个结果值与 fail-closed 语义原样保留**（`allowed-once` / `rejected` / `cancelled` / `unavailable`；缺席、非属主、抛错的 answerer 一律 `unavailable`） | README Summary | 否 |
| `dsh-scope` | README 重写，`createScope` / `scopeOf` / `scopeTarget` 与父子链语义不变 | README Summary | 否 |
| `@deepseek-ai/cordis` | **不动**：0.1.5-rc.1 依旧要 `^4.0.2`，npm `latest` 也还是 4.0.2 | `npm view` + 依赖树 | 否。所以 `packages/kernel` 一个字没改 |

### 2. 原生依赖：少了一个，换了一种做法

| 包 | 0.1.3-alpha.2 | 0.1.5-rc.1 | 处理 |
|---|---|---|---|
| `fs-ext` | `dsh-session-persistence-jsonl` 的直接依赖（node-gyp 源码构建，文件建议锁） | **没有了** | `allowBuilds` 删掉这一条 |
| `nan` | `fs-ext` 的构建依赖 | 没有了 | 随 `fs-ext` 一起消失，本来也没列 |
| `@deepseek-ai/node-addon-landlock-run` | Linux 沙箱 addon | 没有了 | 被 `node-addon-system` 取代 |
| `@deepseek-ai/node-addon-system` | 无 | **新增**，`dsh-session-persistence-jsonl` 依赖它 | `allowBuilds: false`（见下） |

`node-addon-system` 的二进制走 `optionalDependencies`（`node-addon-system-{darwin-arm64,darwin-x64,linux-arm64,linux-x64}`），
**预编译，不走 node-gyp**：包里只有 `build:js` 和 `prepack`，没有 `install` / `postinstall`，
`pnpm install` 本来就不会为它跑任何构建。仍然显式写 `false`，是把纪律记在案上——上游哪天给它加回
构建脚本，也不会因为"默认值"而悄悄跑起来。

`koffi` / `node-pty` / `protobufjs` / `@google/genai` / `@deepseek-ai/dsh-subprocess-local` 照旧 `false`，
仍然在树里、仍然不构建。**这次升级没有为任何 dsh 原生依赖开构建。**

### 3. 我们改了什么

| 文件 | 改动 |
|---|---|
| `packages/dsh-adapter/package.json` | 12 个 `@deepseek-ai/dsh-*` → `0.1.5-rc.1`（精确版本） |
| `profiles/agentsws/package.json` + `README.md` | 9 个 `@deepseek-ai/dsh-*` → `0.1.5-rc.1`；描述与 README 里的版本号改正 |
| `pnpm-workspace.yaml` | `allowBuilds` 删 `fs-ext`、加 `@deepseek-ai/node-addon-system: false`；`minimumReleaseAgeExclude` 加 dsh 0.1.5-rc.1 的整棵传递依赖树（pnpm 展开成 232 条，一包一条写死版本） |
| `pnpm-lock.yaml` | 重解析 |
| `src/headless/protocol.ts` | **只改注释**：WP30 那段"为什么不走官方 SDK"的三条理由里，第 1 条（要开 `fs-ext` 原生构建）已经不成立，重判并注明出处（见 §5） |

**`harness.ts` / `gate.ts` / `llm.ts` / `preset.ts` / `headless/*` 的代码一行没改。**
不是没看——是 §1 那张表里碰得着五个 seam 的变化一条都没有：`pre-execute` / `post-execute` 的
decision 类型、answerer waterfall 的四个结果值、`systemPrompt.section({ complete: true })` 的遮蔽语义、
`tools.restrict({ allow })` 在 scoped context 里的过滤、`LlmAdapter` 的 `stream` / `providerInfo` /
`resolveModel` 三个覆写点，全部原样。`tsc -b --force` 零报错，30 条 seam 契约测试零改动全绿。

### 4. 怎么证明行为没变

四层证据，从窄到宽：

1. **seam 契约测试**（`test/seams.test.ts`，17 §4「任一红 = 不升级」）：30 条，一条没改、全绿。
2. **两档 headless 端到端**（`test/fixture.test.ts` / `test/headless.test.ts` / `test/runtime.test.ts`）：
   65/65 全绿，与升级前的数字一致。
3. **升级前后指纹逐条对比**（`test/upgrade-baseline/*.json` + `test/upgrade.test.ts`）：
   13 条场景 × 2 档 dsh，对比结果——

   | 比什么 | 结果 |
   |---|---|
   | 事件**类型**序列 | 26/26 完全相同 |
   | 事件 `type@at`（连合成时钟时刻一起比） | 26/26 完全相同 |
   | 六条不变量 | 全绿，逐条相同 |
   | 场景断言（`expectations`） | 逐条相同 |
   | 运行摘要（人话那句） | 逐条相同 |
   | `tokens_per_item` | **偏差 0.00%**（阈值 ≤ 5%） |
   | 两档 dsh 之间是否仍然逐条相等 | 是（升级前 0 处差异，升级后 0 处差异） |

   两份基线 JSON 的差别只有 `dsh_version` / `packages` 两个字段里的版本号字符串。
4. **提示词逐字节对比**：把 dsh 自己 `systemPrompt.assemble()` 的结果在两个版本下各导一次——

   | 组合 | 0.1.3-alpha.2 | 0.1.5-rc.1 |
   |---|---|---|
   | 裸 `SystemPrompt`（默认） | 段 `harness:identity`(48 字) / `deployment:persona-prefix`(0) / `deployment:persona-suffix`(0)；渲染 `"You are an AI agent powered by DeepSeek Harness."` | **完全相同** |
   | `includeHarnessIdentity: false`（我们用的那档） | 渲染 `""` | **完全相同** |
   | 加上我们的 `complete: true` persona 段 | 渲染 = 我们那段本身 | **完全相同** |

   所以**没有提示词 diff 要列**。顺带说清楚一件事：模型真正收到的那份 prompt 本来就不来自 dsh 的
   `systemPrompt`——`runtime.ts` 用的是 `@agentsws/stand-ins` 的 `assemblePrompt(req)`（三个运行时同一份，
   17 §6.1 要求与回放重组逐字节一致）；dsh 的 `systemPrompt` 只在 seam 契约测试里被断言。
   这是 WP11 就接受的偏离，这次升级没有改变它。

`packs/dtc-3c-3p/baseline.json` 的 dsh 档**不需要重定**：指标一个数都没动，`--rewrite-baseline` 没用上。

### 5. 官方 SDK 评估（`dsh --profile sdk` + `dsh-sdk-client`）

WP30 在 0.1.3-alpha.2 上给过三条不走官方 SDK 的理由。在 0.1.5-rc.1 上逐条重判：

| # | WP30 的判断（0.1.3-alpha.2） | 0.1.5-rc.1 实测 | 还成立吗 |
|---|---|---|---|
| 1 | 能起，但插件树要 `fs-ext` 原生构建，`allowBuilds: false` 下 boot 死在 `Cannot find module './build/Release/fs_ext.node'` | **不再需要任何原生构建**。`dsh-session-persistence-jsonl` 的依赖从 `fs-ext` 换成预编译的 `@deepseek-ai/node-addon-system`。在 `allowBuilds` 一个都没开的情况下直接起：`initialize{cwd, provider:'deepseek-official', model:'deepseek-chat'}` → `{"serverInfo":{"name":"deepseek-harness-sdk-runtime","version":"0.0.1"}}` | **已解决** |
| 2 | 官方 server 没有 server→client 请求 | **仍然没有**。`HarnessSdkJsonRpcServer`（`lib/index.js`）只 `transport.onRequest(...)` 收 client 的调用，往回只发通知：`session.event` / `session.status` / `subagent.started` / `subagent.finished`；全包**一次 `transport.request(...)` 都没有**，也没有审批 answerer 的挂载点。它的公开面只有 `initialize` / `prompt` / `shutdown` 三个方法 | **成立** |
| 3 | 官方 `sdk` 档由 dsh 自己的 agent loop 驱动 turn，事件序列对不上 | 不变。`session/prompt` 把内容投进 inbox，turn 由 `dsh-agent-loop` 驱动；README 自己写明「There is no per-prompt result」——`MessageId` 只标记 inbox 收下了 | **成立** |

补充一条 0.1.5-rc.1 才有的观察：`dsh-sdk-jsonrpc-server` 的「Known Limitations」一节与 0.1.3-alpha.2
**逐字相同**（四条：无 per-session close / prompt-cancel、无 per-prompt result、stdout 纯净靠部署保证、
自动挂载的 adapter 是 DeepSeek 专用）。也就是说 server→client 这件事上游这一版没动过。

**结论：不换。** 门槛从"一个原生构建 + 两条语义问题"降到"两条语义问题"，但第 2 条正是关键的那条——
我们五个 seam 里有四个要从子进程回调宿主（工具出口、模型网关、stage / 起草、边界卡）。
走官方 server 就得为这四条另开一条自己的旁路（socket 或额外 fd），代码量远超"≤ 100 行"这条换与不换的线，
而且比现在这条（**用官方的传输 + 我们自己的方法集**）更脏。第 3 条则决定了即使旁路搭好，
两档事件序列也不可能仍然相等——而那正是 `runtime-parity.test.ts` 钉住的东西。

**下次值得重判的信号**（写进 `docs/42` 的 checklist 与 `upstream-watch.yml` 的 wishlist）：
`dsh-sdk-jsonrpc-server` 或 `dsh-sdk-protocol` 里出现 server→client 请求（`transport.request` 的调用点、
或者协议类型里出现 server 发起的 method），并且 headless 的 turn 驱动可以被宿主接管。
这两条同时满足时，`src/headless/` 这一层可以整块换成官方 SDK client，方法集不用动。

### 6. 留下的东西

- `@deepseek-ai/dsh` / `dsh-base` / `dsh-headless` / `dsh-session` 四个包在 `package.json` 里但
  `src/` 与 `test/` 都没 import。它们是 profile 版本矩阵的占位（"我们这一版发行版对着哪一版 dsh"），
  这次跟着升到 0.1.5-rc.1，没有删——删它们是另一件事，会让版本矩阵少四行。
- `dsh-session` 的 `SESSION_FORMAT_VERSION` 2 → 3 现在对我们无感，但**真接管 dsh 的会话文件那天**
  （16 §1 说的跨进程 headless run 用官方 profile）要先看 `dsh-session-format-v2-to-v3` 这个迁移包。
- `dsh-llm` 的 `systemPromptUpdate: 'in-history'` 是一条上游给的 KV-cache 优化：真模型档上想省钱时，
  `GatewayLlmAdapter.resolveModel` 可以声明它。现在没声明，因为模拟档的 stub provider 不计缓存。
