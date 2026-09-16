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

---

## 0.1.5-rc.1 → 0.1.6-alpha.1（2026-09-15，WP70）

### 0. 版本口径

npm 上 `@deepseek-ai/dsh` 的 dist-tags（升级当天 `npm view @deepseek-ai/dsh dist-tags --json`）：

| tag | 版本 |
|---|---|
| `alpha` | **0.1.6-alpha.1**（`npm view … time` 说是 2026-09-15T03:23:13.750Z 发的） |
| `latest` | 0.1.5-rc.1 |
| `next` | 0.1.5-rc.2 |

**没有 rc、没有裸 `0.1.6`**。版本表到今天是 `… 0.1.5-alpha.1 → 0.1.5-alpha.2 → 0.1.5-rc.1 →
0.1.5-rc.2 → 0.1.6-alpha.1`。所以这次是**主动升到 alpha**，比 WP41 那次（升到 latest，
只不过 latest 碰巧是个 rc）更靠前一档；理由是这一版有一条我们必须处理的安全默认值（见 §5），
留在 0.1.5-rc.1 上不等于更安全，只等于不知道。锁的仍然是**精确版本**，不用 `^`。

`@deepseek-ai/cordis` **不动**：0.1.6-alpha.1 依旧要 `^4.0.2`，npm `latest` 也还是 4.0.2
（`npm view @deepseek-ai/cordis dist-tags` 回 `{"next":"4.0.1-rc.4","latest":"4.0.2"}`）。
所以 `packages/kernel` 一个字没改。

**这一版有 release notes**（`gh release view dsh-v0.1.6-alpha.1 -R deepseek-ai/deepseek-harness`），
是两次升级里的第一次。但按 docs/42 的红线 6，下表的「出处」列仍然落到具体的 `.d.ts` /
README / 上游 `src/` 段落——release notes 只用来**保证没漏看**，不当证据。

### 1. 上游改了什么（只列碰得着我们的 8 个包 + 两个占位包）

比对方法同 WP41：升级前后各把 `packages/dsh-adapter/node_modules/@deepseek-ai/*` 的
全部 `*.d.ts` + `README*` + `package.json` 抄一份（`rsync`），`diff -rq` 之后逐个文件看。
`src/` 与 `test/` 实际 import 的只有 8 个包，下表前 8 行就是它们。

| 包 | 变化 | 出处 | 碰到我们吗 |
|---|---|---|---|
| `dsh-scope` | **`.d.ts` 逐字节相同**（只有 `README.zh.md` / `README.i18n.yaml` 动了） | `lib/types/*.d.ts` diff 为空 | 否。`createScope` / 父子链 / scoped `restrict` 语义原样 |
| `dsh-sdk-protocol` | **`.d.ts` 逐字节相同**；上游源码 `packages/sdk/protocol/src` 也逐字节相同 | `lib/types/{index,transport,types}.d.ts` diff 为空；`diff -rq dsh-015/packages/sdk/protocol/src dsh-016/…` 无输出 | 否。`JsonRpcLineTransport` 是子进程档的传输，一个字没动 |
| `dsh-util-values` | **`.d.ts` 逐字节相同** | 同上 | 否 |
| `dsh-user-approval` | **`.d.ts` 逐字节相同**；README 只改了一个词（`cordis` → `Cordis`，4 行 diff） | `README.md` 的 Further Exploration 一行 | 否。四个结果值与 fail-closed 语义原样 |
| `dsh-system-prompt` | ① `PromptSection` / `AssembledSection` 加可选 `interpolate?: boolean`（默认 true；false 保留字面量）；② `SECTION_ORDERS` 加两个分节位 `TOOL_COMPUTER_USE: 3000`、`MCP_SERVERS: 3100`；③ `renderPrompt` 的注释补上 `interpolate: false` 的例外 | `lib/types/index.d.ts` 的 `PromptSection.interpolate` / `SECTION_ORDERS` / `renderPrompt` 三段 | **否**。两条都是**加法**：我们的 persona 是 `complete: true` 段，`assemble()` 的遮蔽把别的段全滤掉（新分节位也不例外，实测见 §6 spike (b)）；`interpolate` 不声明就是旧行为 |
| `dsh-llm` | ① `AssistantProvenance` **改名** `AssistantProviderMetadata`（`ModelMessageSource` 跟着改 extends）；② `LlmImageRequestPricing.priceImages` 的入参 `ImageAttachmentRef[]` → `ImageBlock[]`；③ 新增 `LlmImageRequestBudget`、`IMAGE_OFFLOAD_REQUIRED_CODE`、`LlmFailure.offloadImages?`、`ImageBlock.offloaded?`；④ `content.ts` 的 `RequestImageOffloadPolicy` / `offloadedImagePrefixCount` / `offloadRequestImagesWithPolicy` 换成 `requiredImageOffload` / `projectOffloadedImages` | `lib/types/{message,types,index,content,error}.d.ts` | **否**。我们从 `dsh-llm` 只拿 `LlmAdapter` / `createMessage` / `GenerateOptions` / `Message` / `ToolSchema` 五个（`grep -rn "from '@deepseek-ai/dsh-llm'" src test`），四条改动一条都不沾——`AssistantProvenance` 我们没引用过，图片那一整套是 `llm-deepseek` 的事，我们的模拟档不发图片 |
| `dsh-tools` | ① `PreToolDecision` 加第三个变体 `{ kind: 'cancel' }`，`deny` 加可选 `info?: ToolErrorInfo`；② `ToolErrorInfo` 加可选 `reason?`；③ `ToolRunContext` 加可选 `schema?`（PTC 内层调用用）；④ PTC 全线改名：`ctx.codeRuntime` → `ctx.ptcRuntime`、`CodeSdkLanguage` → `PtcSdkLanguage`、`requireCodeRuntime` → `requirePtcRuntime`（私有成员）；⑤ `PtcDispatchEventData` 加可选 `error?` | `lib/types/index.d.ts` 的 `PreToolDecision` / `ToolErrorInfo` / `ToolRunContext`；`lib/types/ptc.d.ts` 的 import 与类型名；`lib/types/types.d.ts` 的 `PtcDispatchEventData` | **否**（但要看清楚）。①②③⑤ 全是**可选加法**，`tsc -b --force` 零报错；④ 动的是 PTC 那条路，我们 `grep -rn "ptc\|codeRuntime\|run_code" packages/dsh-adapter/src` 零命中。`gate.ts` 只产 `allow` / `deny` / `ask` 三种 decision，不产也不消费 `cancel` |
| `@deepseek-ai/cordis` | **不动**（仍 4.0.2） | `npm view` + 依赖树 | 否 |
| `dsh-session`（占位，不 import） | ① `SESSION_FORMAT_VERSION` **仍是 3**（没再跳）；② `snapshotEvents` / `eventAt` / `ownEvents` 三个同步读全部标 `@deprecated`（"new calls are prohibited"）；③ 新增 `SessionMessageProjection` / `SessionMessageProjectionContext`，`Session.create` / `fromRestore` 多一个可选 `projections` 参数；④ `MESSAGE_PROJECTION_EVENT_TYPES` 新增；⑤ `replaceGeneration` → `contentGeneration` | `lib/types/{index,surface,types,known-event-types}.d.ts` | **否**。`@deepseek-ai/dsh-session` 在 `package.json` 里但 `src/` 与 `test/` 一处都没 import（它是 profile 版本矩阵的占位）。我们的会话日志是自己的（`session_ref.log_uri`），不是 dsh 的 JSONL |
| `dsh-headless`（占位，不 import） | ① `Config` 的 `task` 变可选，加 `sessionId?` / `json?`；② 新增 `lib/types/json-stream.d.ts`（`projectJsonRun` / `boundJsonLine` / `JsonSink`）与两个 `*-internals.d.ts`；③ **删掉**了导出的 `internals { stdout, stderr }` | `lib/types/{index,startup,json-stream}.d.ts` | **否**。我们的子进程档跑的是**我们自己的** `dist/headless/child.js`（`subprocess.ts` 里 `spawn(process.execPath, [entry])`），不是 `dsh --profile headless`；`internals` 我们从来没引用过。`--json` 的评估见 §6 第 2 条 |

上游 release notes 里列的**破坏性改动**，逐条判"碰到我们吗"（这一列的出处是我们自己的
`grep`，命令写在括号里）：

| release notes 的条目 | 碰到我们吗 | 出处 |
|---|---|---|
| `agent/session-start` → 异步串行 `agent/created`，首次模型请求等初始化完成 | **否** | `grep -rn "session-start\|agent/created" packages/dsh-adapter/src` 零命中。我们不挂 `dsh-agent`，组合里根本没有 Agent（`harness.ts` 只挂 SystemPrompt / ToolRuntime / ApprovalService / LlmRuntime 四个）。两档 headless 实测事件序列与升级前逐字节相同，见 §4 |
| Session 同步读 `snapshotEvents` / `eventAt` / `ownEvents` 弃用 | **否** | `grep -rn "snapshotEvents\|eventAt\|ownEvents" packages/dsh-adapter` 零命中 |
| PTC 包名与服务名统一 `ptc-runtime`（旧名不兼容） | **否** | `grep -rni "ptc\|codeRuntime\|run_code" packages/dsh-adapter/src` 零命中。依赖树里 `dsh-code-runtime` / `dsh-code-runtime-worker-thread` 消失、`dsh-ptc-runtime{,-node}` 进来，我们不 import 任何一个 |
| 工作流执行器改 `workflow-ptc` | **否** | 同上；`dsh-workflow-worker-thread` 消失、`dsh-workflow-ptc` 进来，都不 import |
| E2B 后端删除 | **否** | `grep -rni "e2b" packages/dsh-adapter` 零命中 |
| Node PTC 改独立进程、`process.env` 为空 | **否** | 我们不跑 PTC。我们自己的子进程档本来就走环境变量白名单（`subprocess.ts` 的 `ENV_ALLOWLIST`，10 个键），比上游这条更严 |
| 配置热更新取消事务回滚 | **否** | 我们不用 dsh 的热更新（`profiles/agentsws` 的 `patchReload: startup`） |
| `SandboxProvider.confine` / `ShellExecutor.start` 改可取消异步 | **否** | 不 import `dsh-sandbox` / `dsh-shell` |
| DeepSeek 默认改 Messages 协议（`https://api.deepseek.com/anthropic`） | **否** | 我们的模型调用走 `src/llm.ts` 覆写的 `LlmAdapter`（provider 名 `agentsws-gateway`），`dsh-llm-deepseek` 根本不在两档 headless 的模块图里——实测见 §5 |
| Team 模式 `spawn_teammate`，关闭 `subagent` / `subagent_fork` | **否** | 不 import `dsh-subagent` / `dsh-experimental-agent-team` |
| `dsh-code-runtime-worker-thread` 从 headless bundle 消失；`dsh-mcp-resources` / `dsh-workflow-ptc` 新进 CLI 依赖 | **否**（只记录） | 见 §7 第 4 条 |
| **DeepSeek 适配器 + 官方端点时随请求上报会话事件，实验性默认开启** | **是，唯一命中的一条** | 见 §5 —— 这一条是这次升级最要紧的东西 |

### 2. 原生依赖：没有新的

依赖树 diff（`awk` 取 lockfile 的 `packages:` 段，去版本后号 `comm`）：

| | 包 |
|---|---|
| **新增 11** | `dsh-ptc-runtime`、`dsh-ptc-runtime-node`、`dsh-workflow-ptc`、`dsh-mcp-resources`、`dsh-compaction-image-offload`、`dsh-api-terminal-controller`、`dsh-client-ui-sidebar-terminal`、`dsh-client-ui-settings-unarchive-sessions`、`@modelcontextprotocol/client@2.0.0`、`@modelcontextprotocol/core@2.0.0`、`@xterm/addon-serialize@0.14.0` |
| **消失 3** | `dsh-code-runtime`、`dsh-code-runtime-worker-thread`、`dsh-workflow-worker-thread` |
| **版本跟着动** | `node-addon-require-builtin` 家族 0.1.5 → 0.1.6（8 个平台包 + 1 个 loader），`node-addon-native-custom-loader` 同 |

**新增的三个非 dsh 包一个 `install` / `postinstall` 都没有**（逐个看 `package.json` 的
`scripts`：MCP SDK v2 两个只有 `build` / `typecheck` / `lint` / `test`；`@xterm/addon-serialize`
只有 `build` / `package` / `prepackage` / `prepublishOnly`）。`pnpm install` 的输出里
也没有任何 "ignored build scripts" 之类的提示。**这次升级没有为任何 dsh 原生依赖开构建。**

`allowBuilds` 的改动只有一处**补列**（不是行为变化）：`node-addon-require-builtin` 与
`node-addon-native-custom-loader` 写死 `false`。它们是 `@deepseek-ai/cordis-plugin-loader`
的依赖，**在 0.1.5-rc.1 的树里就有、WP41 漏列了**；和 `node-addon-system` 一样是预编译平台包
（平台二进制走 `optionalDependencies`），没有 install / postinstall，本来就不触发构建。
写死是把 16 §3「最严解释」的纪律记在案上。

`koffi` / `node-pty` / `protobufjs` / `@google/genai` / `@deepseek-ai/dsh-subprocess-local` /
`@deepseek-ai/node-addon-system` 照旧 `false`，仍然在树里、仍然不构建。

`minimumReleaseAgeExclude`：0.1.5-rc.1 那批 **232 条整批替换**成 0.1.6-alpha.1 的 **238 条**
（237 条是 `pnpm install` 自己展开的整棵传递依赖树，第 238 条是 §6 spike 用的
`@deepseek-ai/dsh-browser-use`）。这里有个坑值得记一笔：`pnpm` 默认是**叠加**——
它会把条目改写成 `'<包>@0.1.5-rc.1 || 0.1.6-alpha.1'`，等于把旧版一起继续放行。
按 docs/42 红线 3（"排除的是这一个版本"），全部改回单版本写法，
并把只属于 0.1.5-rc.1 的那三条（`dsh-code-runtime` / `dsh-code-runtime-worker-thread` /
`dsh-workflow-worker-thread`）随包一起删掉。

### 3. 我们改了什么

| 文件 | 改动 |
|---|---|
| `packages/dsh-adapter/package.json` | 12 个 `@deepseek-ai/dsh-*` → `0.1.6-alpha.1`（精确版本）；新增 `devDependencies: { '@deepseek-ai/dsh-browser-use': '0.1.6-alpha.1' }`（只给 §6 的 spike 用，不进 runtime 依赖） |
| `profiles/agentsws/package.json` + `README.md` | 9 个 `@deepseek-ai/dsh-*` → `0.1.6-alpha.1`；描述与 README 里的版本号改正 |
| `profiles/agentsws/cordis.patch.yml` | **加了这份 patch 层里第一条生效的行**：`- id: session-log-deepseek` / `config: { enabled: false }`（见 §5） |
| `pnpm-workspace.yaml` | `allowBuilds` 补列 `node-addon-require-builtin` / `node-addon-native-custom-loader`；`minimumReleaseAgeExclude` 整批替换（见 §2） |
| `pnpm-lock.yaml` | 重解析 |
| `packages/dsh-adapter/test/telemetry.test.ts` | **新增**：3 条，钉住"会话日志不上报官方 API"（见 §5） |
| `packages/dsh-adapter/test/browser-seam.test.ts` | **新增**：11 条，浏览器 seam spike（见 §6 第 3 条） |
| `packages/dsh-adapter/test/upgrade-baseline/0.1.5-rc.1-wp70.json` | **新增**：升级前在**当前代码树**上重采的基线（见 §4 与 docs/42 ① 的新红线） |
| `packages/dsh-adapter/test/upgrade-baseline/0.1.6-alpha.1.json` | **新增**：升级后的基线 |
| `packages/dsh-adapter/test/upgrade.test.ts` | `FROM_FILE` / `FROM` / `TO` 三行；`FROM_FILE` 与 `FROM` 拆开的理由写在文件头 |
| `packages/dsh-adapter/src/headless/protocol.ts` | **只改注释**：WP70 对官方 SDK 的重判（第 2 / 3 条仍成立）与 `--json` 替不了这一档的理由 |
| `docs/39-安全底座自检.md` | 加 §3.3 (d)「运行时不把会话内容随模型请求上报给模型厂商」 |
| `docs/42-上游升级流程-v1.md` | 补两个洞：① 的"当前代码树"红线、④bis 的"默认值扫描"一步；红线从六条变七条；§3 改了 CI 的启用条件 |
| `.github/workflows/upstream-watch.yml` | issue 正文加一段 wishlist（官方 SDK 的 server→client / headless turn 驱动 / **browser-use 转正或进 rc**） |

**`harness.ts` / `gate.ts` / `llm.ts` / `preset.ts` / `headless/*` 的代码一行没改**
（`protocol.ts` 只动注释）。不是没看：§1 那张表里碰得着五个 seam 的变化一条都没有——
`pre-execute` / `post-execute` 的 decision 类型只是加了可选变体、answerer waterfall 的四个
结果值原样、`systemPrompt.section({ complete: true })` 的遮蔽语义原样、
`tools.restrict({ allow })` 在 scoped context 里的过滤原样、`LlmAdapter` 的
`stream` / `providerInfo` / `resolveModel` 三个覆写点原样。`tsc -b --force` 零报错，
30 条 seam 契约测试零改动全绿。

**没有设计事故**：这次没有任何一处要改 `packages/dsh-adapter` 以外的代码。

### 4. 怎么证明行为没变

四层证据，从窄到宽。**先说一件 WP41 没遇到的事**：WP41 留下的 `0.1.5-rc.1.json` 是
WP41 当天代码树的指纹（pack 只有 13 条场景），而今天 pack 是 30 条、WP42–WP69 还加了
`context.injected` / `guardrail.gate_decided` 等事件。直接拿它当 FROM，diff 出来的是
**我们自己的改动**。所以 WP70 在还没动版本号的分支上另采了一份
`0.1.5-rc.1-wp70.json`（同一版 dsh、当前代码树），旧的两份不删。这条已经写进 docs/42 ① 的红线。

1. **seam 契约测试**（`test/seams.test.ts`，17 §4「任一红 = 不升级」）：**30 条，一条没改、全绿。**
2. **两档 headless 端到端**（`test/fixture.test.ts` 6 + `test/runtime.test.ts` 20 +
   `test/headless.test.ts` 9）：**35 条全绿**，与升级前的数字一致。
   `@agentsws/dsh-adapter` 这个 project 升级前 **242 条**、升级后 **466 条**；
   多出来的 224 条全部有解释：`upgrade.test.ts` 172 → 393（场景从 13 涨到 30 条 × 2 档 × 6 项断言
   + 两档相等 + 3 条元断言），加上新写的 `telemetry.test.ts` 3 条与 `browser-seam.test.ts` 11 条。
   **既有的 7 个测试文件一条用例都没改、没删。**
3. **升级前后指纹逐条对比**（`test/upgrade-baseline/*.json` + `test/upgrade.test.ts`）：
   30 条场景 × 2 档 dsh = **60 条**，对比结果——

   | 比什么 | 结果 |
   |---|---|
   | 事件**类型**序列 | 60/60 完全相同 |
   | 事件 `type@at`（连合成时钟时刻一起比） | 60/60 完全相同 |
   | 六条不变量 | 全绿，逐条相同 |
   | 场景断言（`expectations`） | 逐条相同 |
   | 运行摘要（人话那句） | 逐条相同 |
   | `tokens_per_item` | **偏差 0.00%**（阈值 ≤ 5%） |
   | 两档 dsh 之间是否仍然逐条相等 | 是（升级前 0 处差异，升级后 0 处差异） |

   更强的一句：把两份 JSON 的 `dsh_version` 与 `packages` 两个字段去掉之后
   **`diff` 退出码是 0**——除了版本号字符串，两份基线逐字节相同。
   所以 `packs/*/baseline.json` 的 dsh 档**一个数都不用重定**，`--rewrite-baseline` 没用上。
4. **提示词逐字节对比**（docs/42 ⑥）：把 dsh 自己 `systemPrompt.assemble()` 的结果在两个版本下
   各导一次（装 0.1.6 → 导一份 → `git checkout` 回 0.1.5-rc.1 的四个文件 + `pnpm install --frozen-lockfile`
   → 导一份 → 再装回来），三种组合逐字节比——

   | 组合 | 0.1.5-rc.1 | 0.1.6-alpha.1 |
   |---|---|---|
   | 裸 `SystemPrompt`（默认） | 段 `harness:identity`(48 字) / `deployment:persona-prefix`(0) / `deployment:persona-suffix`(0)；渲染 `"You are an AI agent powered by DeepSeek Harness."` | **完全相同** |
   | `includeHarnessIdentity: false`（我们用的那档） | 渲染 `""` | **完全相同** |
   | 加上我们的 `complete: true` persona 段 | 渲染 = 我们那段本身，`sections` 只剩它一个 | **完全相同** |

   导出里还比了每段的 `name` / 长度 / `interpolate` 字段与 `variables` 的键集合，`diff` 退出码 0。
   **没有提示词 diff 要列。** 一处诚实的边界：新加的两个分节位 `TOOL_COMPUTER_USE` / `MCP_SERVERS`
   在 `SECTION_ORDERS` 里是 `declare const`（只出类型 `PromptSectionOrderName`，不出运行时值），
   所以这份导出里看不到它们的数值——它们的影响改用 §6 spike (b) 的实测来盖。

   顺带重申 WP41 就写过的一件事：模型真正收到的那份 prompt 本来就不来自 dsh 的 `systemPrompt`——
   `runtime.ts` 用的是 `@agentsws/stand-ins` 的 `assemblePrompt(req)`（三个运行时同一份，
   17 §6.1 要求与回放重组逐字节一致）；dsh 的 `systemPrompt` 只在 seam 契约测试里被断言。

### 5. 安全：把"会话日志随请求上报官方 API"显式关掉

这是这次升级**唯一**真正碰到我们的上游改动，也是"不做等于没升级"的那一条。

#### 5.1 上游改了什么

release notes 的说法是「使用 DeepSeek 模型适配器且连接官方 API 端点时，支持随请求上报会话事件，
当前实验性开启，可通过配置关闭」。落到代码，是 `@deepseek-ai/dsh-session-log-deepseek` 这个包，
两版之间**唯一的功能改动就是一个默认值**：

```diff
--- dsh-015/packages/session/session-log-deepseek/src/index.ts
+++ dsh-016/packages/session/session-log-deepseek/src/index.ts
 export interface Config {
-  /** Contribute `dsh_session_log` to official DeepSeek requests. Defaults to `false`. */
+  /** Contribute `dsh_session_log` to official DeepSeek requests. Defaults to `true`. */
   enabled?: boolean
 }
 export const Config: z<Config> = z.object({
-  enabled: z.boolean().default(false),
+  enabled: z.boolean().default(true),
 })
```

（其余 diff 只有三行 `oxlint-disable-next-line typescript/no-deprecated` 注释，
因为它用的 `session.snapshotEvents()` / `session.eventAt()` 这一版被弃用了。）

README 的「Configuration」表同步翻了个面：

| | 0.1.5-rc.1 | 0.1.6-alpha.1 |
|---|---|---|
| `enabled` 默认 | `false` | **`true`** |
| 说明 | "**Enable** it only when the official API should receive a Session-log suffix." | "**Disable** it only when the official API must not receive a Session-log suffix." |
| 挂载 | "Shipped profiles mount the plugin so an overlay can enable it, but the default configuration registers no request field" | "Shipped profiles mount the plugin, so the default configuration registers the request field and appends the acceptance watermark" |

打开时它做什么，README 的「Request field」一节写得很清楚：对带 live `sessionId` 的请求，
把上次已被接受的水位之后的**整段 canonical Session 事件**（session header、`afterSeq` /
`throughSeq`、每条事件的完整 envelope）作为 `dsh_session_log` 字段随请求发出去。
会话日志里是客户原文、订单、政策与工具入参——正是 31 §3 / 18 §2.1 要求留在本地的东西。

挂载它的是 dsh-base 的 bundle patch（上游 `packages/bundle/base/cordis.patch.yml`
里的 `- id: session-log-deepseek` / `name: '@deepseek-ai/dsh-session-log-deepseek'`），
所以"我们没有主动装它"不构成任何保证。

**这一条 `.d.ts` 完全看不出来**：`enabled?: boolean` 前后一模一样，改的是 `src/` 里
schema 的 `.default(...)`，而 npm 包里只有编译产物。docs/42 的 ④bis「默认值扫描」就是为它加的。

#### 5.2 我们的两档 headless 到底会不会命中（实测，不是推断）

用 Node 的 ESM `resolve` 钩子（`module.register`）起子进程，录下**真实解析过的每一个模块 URL**，
再按 `node_modules/@deepseek-ai/<名>/` 归到包：

| 档 | 入口 | 解析到的 `@deepseek-ai/*` 包 | `dsh-session-log-deepseek` | `dsh-deepseek-llm-api-extensions` | `dsh-llm-deepseek` |
|---|---|---|---|---|---|
| 同进程 | `packages/dsh-adapter/dist/index.js` | 16 个 | **没有** | **没有** | **没有** |
| 子进程 | `packages/dsh-adapter/dist/headless/child.js`（就是 `spawnChild` 起的那个入口） | 同样 16 个 | **没有** | **没有** | **没有** |

两档的 16 个包完全相同：`cordis`、`cosmokit`、`dsh-brand`、`dsh-llm`、`dsh-sandbox`、`dsh-scope`、
`dsh-sdk-protocol`、`dsh-session`、`dsh-system-prompt`、`dsh-timeout`、`dsh-tools`、
`dsh-typert-protocol`、`dsh-user-approval`、`dsh-util-crypto`、`dsh-util-values`、`schemastery`。
（同进程档另跑了一次真实场景，359 次解析，结论一样。）

原因清楚：`harness.ts` 只 `root.plugin(...)` 四个 dsh 插件（SystemPrompt / ToolRuntime /
ApprovalService / LlmRuntime），**dsh-base 的 bundle 根本不在组合里**；模型调用走
`src/llm.ts` 覆写的 `LlmAdapter`（provider 名 `agentsws-gateway`），不经 `dsh-llm-deepseek`，
也就没有 `dsh_session_log` 这个请求字段的挂载点。

**所以这一版我们没有命中。但这不是可以不做的理由**——"碰巧没装"会随着换 bundle、
接管完整 profile（16 §1 说的跨进程 headless run）而失效，而默认值是上游可以单方面翻的。

#### 5.3 我们做了什么

两道，缺一不可：

1. **`profiles/agentsws/cordis.patch.yml` 显式写死 `enabled: false`。**
   这是这份 patch 层里第一条**生效**的行（之前全是注释掉的占位）。dsh 的 patch 语义是
   **整块替换目标行的 `config`**（上游 `packages/bundle/base/cordis.patch.yml` 开头那段注释：
   "A patch replaces the targeted row's whole `config` rather than merging into it"），
   所以这一行就是最终值，不怕被 base 的默认值合并回来。
2. **`packages/dsh-adapter/test/telemetry.test.ts` 钉住它**，3 条：
   - 子进程档的真实模块图里没有那三个包（带四个反向哨兵 `dsh-tools` / `dsh-llm` /
     `dsh-system-prompt` / `dsh-user-approval`，证明钩子确实录到了东西，不是假绿）
   - 同进程档同样
   - `cordis.patch.yml` 里 `session-log-deepseek` 这一行存在且 `config.enabled === false`

自检条目进了 `docs/39 §3.3 (d)`；总览表从 24 条变 25 条、全绿从 22 变 23。

### 6. 重判上次放弃的选项（docs/42 §⑤）

这次判四条。换与不换的线仍是 WP41 定的那条：**≤ 100 行且两档事件序列仍相等才换。**

#### 第 1 条：官方 SDK（`dsh --profile sdk` + `dsh-sdk-client`）——**仍然不换**

| # | 上次的判断（WP41 / 0.1.5-rc.1） | 这次实测（0.1.6-alpha.1） | 还成立吗 |
|---|---|---|---|
| 1 | 不再需要任何原生构建 | 不变（`allowBuilds` 一个没开，树里也没有新的原生依赖） | **已解决**（WP41 起） |
| 2 | 官方 server 没有 server→client 请求 | `grep -c "transport.request\|\.request(" <dsh-sdk-jsonrpc-server>/lib/index.js` → **0**；`grep -o "transport\.[a-zA-Z]*"` 只回 `close` / `flush` / `notify`×4 / `onRequest` / `start`，四个 notify 是 `session.event` / `session.status` / `subagent.started` / `subagent.finished`。上游源码 `packages/sdk/protocol/src` 与 0.1.5-rc.1 **逐字节相同**（`diff -rq` 无输出），`packages/sdk/server/src/server.ts` 只改了一行（`ctx.plugin(LlmDeepSeek, {})` → `ctx.plugin(LlmDeepSeek)`）。README 的「Known Limitations」四条也原样 | **成立** |
| 3 | 官方 loop 驱动 turn，事件序列对不上 | 不变 | **成立** |

**结论：不换。** 第 2 条决定了我们五个 seam 里那四条"从子进程回调宿主"的路
（工具出口、模型网关、stage / 起草、边界卡）仍然得自己开旁路，代码量远超 100 行。

#### 第 2 条：headless 新增的 `--json` / `--session-id` / stdin 任务——**替不了子进程档**

出处是 `dsh-headless` 新增的 `lib/types/json-stream.d.ts` 与改了的
`lib/types/{index,startup}.d.ts`。`--json` 的形态说得很明确：

> "Project one Agent's run as newline-delimited JSON on `sink`."
> "Every projected event is a commit point: text and reasoning come from committed
> `assistant/message` content"

也就是：**一个方向、一个 stdout、一份对持久 Session 事件的投影。** 句柄只有两个方法
（`finish(text)` / `dispose()`），没有任何接收宿主回答的位置。

我们这条桥上**子进程 → 宿主的请求有五条**（`src/headless/protocol.ts` 的 `M_HOST_*`），
逐条对一下 `--json` 能不能覆盖：

| 我们的回调 | 是什么 | `--json` 覆盖得了吗 |
|---|---|---|
| `agentsws/host/tool` | 工具出口：子进程里的工具调用要回宿主执行（真连接器、真凭据都在宿主侧） | **不能**。`--json` 只往外吐事件，宿主没有"回答一个工具调用"的方向 |
| `agentsws/host/complete` | 模型网关：补全要经宿主的 `@agentsws/model-gateway`（预算、缓存、seed 都在那） | **不能**。同上；而且官方 headless 的模型路由是它自己的 `ctx.llm` |
| `agentsws/host/stage` | `stage` 回调：挂一条待批变更，拿回 `change_id` | **不能**。需要同步拿返回值 |
| `agentsws/host/draft` | `createDraft` 回调：起草，拿回 `approval_item_id` | **不能**。同上 |
| `agentsws/host/boundary` | 边界卡：把没答过的边界发成选择题 | **不能**。同上 |

**五条一条都覆盖不了。** `--session-id` 与 stdin 任务对我们无感：17 §5.1 要求每次运行
无状态（不读上一次的会话文件），恰恰不需要 `--session-id`；任务本来就经 JSON-RPC 的
`agentsws/run` 传，不走 stdin。

**结论：不换，也不重写。** 但 `--json` 有一个**旁支价值**值得记一笔：它是上游第一次给
headless 一个机器可读的出口，如果哪天要做"把 dsh 官方 headless 当外部工具跑一次、只读它的结果"
（而不是当我们的运行时），这条流是现成的。现在没有这个需求。

#### 第 3 条：浏览器 seam spike——**门禁挡得住，但今天挂不进来**

产物是 `packages/dsh-adapter/test/browser-seam.test.ts`，**11 条断言，可复跑**
（`pnpm exec vitest run --project @agentsws/dsh-adapter test/browser-seam.test.ts`）。

**先说没做到的那一半，免得读成"全做了"**：真 provider
`@deepseek-ai/dsh-experimental-browser-use-playwright-mcp` **没有挂进来**，两个硬原因——

1. 它 `dependencies` 里有 `@playwright/mcp@0.0.80` → `playwright`，后者的 postinstall
   下载 Chromium。16 §3 最严解释 / docs/42 红线 2 不给开构建；开不了构建就起不了真浏览器，
   真 MCP 子进程也无从谈起。
2. 它的 `inject` 是 `['browserUse', 'agents', 'tools', 'systemPrompt']`，而
   `mountSessionMcp` 整个挂在 `ctx.on('agent/created')` 上、按 `Agent` 分配资源
   （出处：上游 `packages/experimental/browser-use-runtime/src/mcp.ts`）。
   **我们的组合里根本没有 `agents`，也没有 `Agent`。**

所以 spike 的做法是：`@deepseek-ai/dsh-browser-use` 挂**真的**（加成 dsh-adapter 的
devDependency；它自己只依赖 cordis + dsh-brand，两个都已在树里，**没有**引入
`@playwright/mcp` / `playwright`），provider 槽的独占语义按真实现测；工具与提示词段由一个
**按上游 `mcp.ts` 原样注册**的仿真 provider 出（工具名前缀 `mcp__<name>__`、
提示词段名 `mcp:<name>`）——要测的是**我们这一侧的门禁**，不是 Playwright 本身。

**给 docs/53 §4.3 直接引用的那一小段**（三条结论）：

> **(a) 挡得住。** 浏览器 provider 注册的工具就是普通的 `ctx.tools` 注册，`tools/pre-execute`
> 照样先于工具体跑；门禁 `deny` 的话工具体一次都不执行。preset 的
> `ctx.tools.restrict({ allow })` 在 scoped context 里对它们生效：不在 allowlist 里的
> 浏览器工具对该职责**不可见**（`ctx.tools.schemas(agent)` 里没有）**也调不到**
> （回 `UNKNOWN_TOOL`），而全局注册表仍然看得见它们——restrict 是 scope 级过滤，不是注销。
> 真门禁（`gate.ts`）那条也测了：一个 `mcp__playwright-mcp__browser_navigate` 不在
> `RunRequest.tools.allow` 里 → `blocked: not_in_allowlist`，并照常发一条 `tool.result` 事件
> （16 §2 的 Model-visible ⟺ logged 不因为它是社区工具而打折）。
>
> **(b) 不漏。** 新分节位 `TOOL_COMPUTER_USE: 3000` / `MCP_SERVERS: 3100` 的段确实进
> `systemPrompt.assemble()`；但只要有一个 `complete: true` 段，两段都被遮掉，
> 渲染结果就是 complete 段本身，且**与注册顺序无关**（complete 先注册或后注册结果一样）。
> 真 persona 段同样遮得住：`harness.systemText()` 里既没有浏览器那段也没有 computer-use 那段。
>
> **(c) 不冲突，但也还接不上。** `ctx.browserUse` 的槽是**全组合独占一个 provider**
> （第二个 `register()` 抛错，错误信息带第一个的名字；释放后可以换），这与我们
> "一工作区一 runtime"是同一个方向而不是打架。真正的隔离粒度在上游那一层：
> `mountSessionMcp` 按 `Agent`（≈ 一个 Session）开一个 MCP 客户端，`attach` 模式下
> `exclusive: true`，第二个活 Session 拿不到浏览器工具（它的那份 schema 被
> `ctx.tools.restrict({ deny })` 遮掉、系统提示词里 `mcp:<name>` 那段也被滤掉）。
> 我们每次运行起一棵全新 Cordis 树、结束即 dispose（17 §5.1），天然是"一个 Session 一个
> 浏览器"。**真正的障碍不是语义，是装配**：provider 要 `agents` 服务和一个活的 `Agent`，
> 我们的组合两样都没有。要用它，得先决定"引入 dsh 的 Agent 这一层"——那是另一个 WP，
> 不是升级能顺手带出来的。

> **WP82 后记（2026-09-16）：上面那两个"硬原因"现在一个都不成立了。**
>
> 1. WP81 引进了官方 Agent 层 —— `agents` 与活的 `Agent` 都有了；
> 2. **实测**：`@playwright/mcp` 的 `cli.js` **启动时不碰浏览器**（连接推迟到第一次真调
>    工具），所以不给 `playwright` 开构建照样能起 provider；而我们两条路都不需要它下载
>    的那份 Chromium（attach 接用户自己的 Chrome，`launch` 一律带 `executable_path`）。
>    `allowBuilds` 里写死 `playwright: false` / `playwright-core: false`，
>    `pnpm install --frozen-lockfile` 通过。
>
> 于是 `browser-seam.test.ts` 从"仿真 provider 的 spike"升级成**真 provider 的回归**
> （23 条），契约 #20 落地见 `AGENT-LAYER.md` §9 与 docs/55 §3「落点（WP82）」。
> 这一条留在原地不改，是因为它记的是**当时**的判断——判断错在哪、为什么错，
> 比把它抹掉有用。

#### 第 4 条：`dsh-mcp-resources` 与 MCP SDK v2——**只记录，零影响**

- 我们的"MCP"面**全是我们自己的**：`packages/dsh-adapter/src/tools.ts` 里唯一一处是
  `import { isMcpReadTool } from '@agentsws/stand-ins'`，判的是 Shopify 官方 Dev MCP
  三个工具名的副作用类别（WP44）。`test/mcp-tools.test.ts` 的 3 条也只测 `classifySideEffect`。
- 全仓 `grep -rn "dsh-mcp"`（排除 lockfile 与 node_modules）**零命中**：
  `@deepseek-ai/dsh-mcp-client` / `dsh-mcp-resources` 我们一个都没 import。
- `@modelcontextprotocol/sdk@1.30.0` 仍在树里（别的东西在用），新进来的是
  `@modelcontextprotocol/client@2.0.0` + `core@2.0.0`，纯 JS、无 install 脚本。
- 所以 **SDK v2 对 `tools.ts` 与 `mcp-tools.test.ts` 的影响是零**，两个文件一个字没改、测试全绿。
- 值得记一笔的一条**将来的**影响：`dsh-mcp-resources` 会给配了 MCP 服务器的 profile 注册
  `list_mcp_resources` / `list_mcp_resource_templates` / `read_mcp_resource` 三个共享工具
  （名字见上游 `browser-use-runtime/src/mcp.ts` 里的 `resourceTools` 集合）。
  它们和别的工具一样走 `ctx.tools`，所以 §6 第 3 条 (a) 的结论对它们同样成立——
  但它们**不是** `mcp__` 前缀，真要放进来时 `classifySideEffect` 的兜底会把它们判成
  `write_external`（executor 档下直接拒）。届时要么显式分类、要么进 allowlist，别忘了。

### 7. 留下的东西

1. **`docs/34` 里的 dsh 版本号还写着 0.1.5-rc.1**（第 10 行那条 WP41 的修订记录）。
   docs/42 ⑦ 的收尾清单要求改它，但这次 WP 的改动范围红线里没有 `docs/34`，所以**没有动**。
   这是一条明确的待办，不是遗漏。
2. **`@deepseek-ai/dsh` / `dsh-base` / `dsh-headless` / `dsh-session` 四个包**仍然在
   `package.json` 里而 `src/` / `test/` 都没 import。它们是 profile 版本矩阵的占位，
   这次跟着升到 0.1.6-alpha.1。`dsh-headless` 这一版删掉了导出的 `internals`——
   我们没用过，但记一笔：真接管官方 headless 进程那天，测试替身要换个挂法。
3. **`dsh-session` 的三个同步读接口被弃用**（`snapshotEvents` / `eventAt` / `ownEvents`）。
   我们现在不用，但 16 §1 说的"真接管 dsh 的会话文件"那天要走新的 projection 路
   （`SessionMessageProjection`）。
4. **`node-addon-require-builtin` 家族是 WP41 漏列的**，这次补上了。
   下次升级时值得顺手扫一遍：`allowBuilds` 里列的，与树里真实存在的原生包，对不对得上。
5. **`upstream-watch.yml` 的自动对比盖不住 §5 那类改动**：它只看基线指纹，而默认值翻转
   既不改类型也不改指纹（因为我们的组合里本来就没装那个插件），全绿的报告会整条漏掉它。
   docs/42 §3 因此把启用 `schedule:` 的条件改了一条：先给 job 加上 ④bis 的默认值扫描。

---

## WP81（2026-09-16）：不是升级，但动了组合——引入官方 Agent 层

dsh 版本没动（仍是 `0.1.6-alpha.1`）。改的是**我们自己的回合逻辑**：
回合改由官方 `dsh-agent` + `dsh-agent-loop` 驱动，我们不再自排。
设计记录、挂载清单、事件映射表、指标解释、给 WP82 的接口都在
**`packages/dsh-adapter/AGENT-LAYER.md`**，这里只记与"下次升级"直接相关的三条：

1. **升级基线换了一份自比的**：`test/upgrade-baseline/0.1.6-alpha.1-wp81.json`，
   `upgrade.test.ts` 的 `FROM_FILE` / `TO_FILE` 都指它。下次升 dsh 时
   `FROM_FILE` 用它、`TO_FILE` 用新版本，docs/42 的流程一步不变。旧的四份一个没删。
2. **上一节 §7 第 3 条（`dsh-session` 的三个同步读接口被弃用）现在真的碰到了**：
   `harness.ts` 的 `summarizeTurn()` 用 `session.eventAt(seq)` 取这一轮的最后一段
   assistant 文本与终止原因——官方 `bundle/headless/src/index.ts` 的 `summarize()`
   也是这么写的（带着一条 `oxlint-disable … no-deprecated`）。上游哪天真删了它，
   这一处要改成 projection 路（`SessionMessageProjection`）。**这是升级时第一个会红的地方。**
3. **新增三个直接依赖**：`dsh-agent` / `dsh-agent-loop` / `dsh-session-projection`，
   精确版本，`minimumReleaseAgeExclude` 里 WP70 就已逐包写死、无需新增行。
   下次升级这三个也要一起换版本号，而且 `AgentLoop` 的 `static inject`
   （`agents` / `sessions` / `llm` / `tools` / `systemPrompt` / `sessionProjections`）
   是"最小挂载"的判据——它变了，`createHarness()` 的插件列表就得跟着变。
