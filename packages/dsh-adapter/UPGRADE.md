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

---

## 0.1.6-alpha.1 → 0.1.6-alpha.2（2026-09-18，WP93）

### 0. 版本口径

npm 上 `@deepseek-ai/dsh` 的 dist-tags（升级当天 `npm view @deepseek-ai/dsh dist-tags --json`）：

| tag | 版本 |
|---|---|
| `alpha` | **0.1.6-alpha.2**（`npm view … time` 说是 2026-09-17T13:52:10.201Z 发的） |
| `latest` | 0.1.5-rc.2 |
| `next` | 0.1.5-rc.2（与 latest 同一个） |

**仍然没有 rc、没有裸 `0.1.6`**，而且 `latest` 从 WP70 那天的 0.1.5-rc.1 往前挪了一格到
0.1.5-rc.2 —— 按"升到 latest"办事仍然是**降级**（docs/42 §3.1 那条写死在模板里的判断）。
所以这次和 WP70 一样是**主动升到 alpha**，锁的仍然是**精确版本**，不用 `^`。

兄弟包一个没动：`@deepseek-ai/cordis` 的 dist-tags 回 `{"next":"4.0.1-rc.4","latest":"4.0.2"}`，
`@deepseek-ai/schemastery` 回 `{"next":"3.18.1-rc.4","latest":"3.18.2"}`，
alpha.2 依旧要 `^4.0.2` / `^3.18.2`。**`packages/kernel` 一个字没改。**

第 ② 步用的是 WP91 做的工具，不是手搓：`pnpm upstream:watch --dry-run --scope daily`
（输出见 §8）。它如实报了 `alpha` 最高、我们落后一格；GitHub 那一半 403（rate limit），
报告照实写"查不到"，release notes 是我用 `gh release view dsh-v0.1.6-alpha.2` 自己取的。

**这一版的 release notes 很长，但九成在 web 客户端**（右侧边栏那一大摞）。按 docs/42 红线 6，
下面每一条的「出处」仍然落到具体的 `.d.ts` / README / 上游 `src/` 段落——
release notes 只用来**保证没漏看**，不当证据。

### 1. 上游改了什么

比对方法同前两次：升级前后各把 `packages/dsh-adapter/node_modules/@deepseek-ai/*`
（41 个包）的全部 `*.d.ts` + `README*` + `package.json` 用 `rsync` 抄一份，`diff -rq` 之后逐个文件看。

**结果比想象的小得多**：41 个包里，`.d.ts` 真的变了的只有 **9 个文件**，分布在 6 个包
（`dsh-agent-loop` 1、`dsh-llm` 1、`dsh-sandbox` 1、`dsh-subprocess` 2、`dsh-subprocess-local` 3、
`dsh-util-values` 1）；另有 2 个新文件（`dsh-llm-pi-ai/lib/types/models.d.ts`、
`dsh-subprocess-local/lib/types/shell-activity.d.ts`）与 1 个新目录（`dsh/lib/types/`，
这个包以前不发类型）。**其余 34 个包的 `.d.ts` 逐字节相同**，只有 `package.json` 里的
版本号在动。`tsc -b --force` **零报错**。

| 包 | 变化 | 出处 | 碰到我们吗 |
|---|---|---|---|
| `dsh-tools` | **`.d.ts` 逐字节相同** | `lib/types/*.d.ts` diff 为空 | 否。`pre-execute` 的 allow/deny/ask、`post-execute` 的 replace/enrich/block、`defineTool`、`tools.execute` 全部原样 |
| `dsh-scope` | **`.d.ts` 逐字节相同** | 同上 | 否。`createScope` / scoped `restrict` 语义原样 |
| `dsh-user-approval` | **`.d.ts` 逐字节相同** | 同上 | 否。answerer waterfall 的四个结果值与 fail-closed 原样 |
| `dsh-system-prompt` | **`.d.ts` 逐字节相同**，而且上游**源码整包逐字节相同**（只有 `package.json` 的版本号变了） | `diff -rq dsh-016/packages/core/system-prompt dsh-0162/…` 只报 `package.json` 一行 | 否。提示词不可能变——实测见 §4 第 4 层 |
| `dsh-agent` / `dsh-session` / `dsh-session-projection` / `dsh-agent-presets` / `dsh-credentials` / `dsh-authorization` / `dsh-mcp-client` / `dsh-browser-use` / `dsh-experimental-browser-use-*` / `dsh-sdk-protocol` / `dsh-sdk-client` / `dsh-shell` / `dsh-shell-env` / `dsh-bash-sandbox` / `dsh-tool-bash` / `dsh-sandbox-local` / `dsh-sandbox-policy` / `dsh-base` / `dsh-headless` / `dsh-home-paths` / `dsh-jobs` / `dsh-settings` / `dsh-timeout` | **`.d.ts` 逐字节相同**（`dsh-tool-bash` 只有 README 动了一段，见下） | `diff -rq` 在这些包下只报 `package.json` | 否 |
| `dsh-agent-loop` | `lib/types/inbox.d.ts` **只改一句注释**：`ReactLoopInbox` 的 `projections` 参数从「registry that owns the standard Inbox projection」改成「registry with the standard Inbox projection registered by AgentLoop」。README 同步：Inbox 投影的注册**从 `ReactLoopInbox` 的构造函数挪到 `AgentLoop` 的服务生命周期**，"cold reads work before any Agent exists and after all Agents unload" | `lib/types/inbox.d.ts` 的 JSDoc；`README.md` §"Turn and step flow" 第一段 | **否**（但这就是 release notes 那条"修复重启后待处理的 Inbox 消息无法恢复"）。我们一次运行一棵树、结束即 dispose（17 §5.1），没有"重启后恢复 Inbox"这回事；`AgentLoop` 的 `static inject` 没变，`createHarness()` 的插件列表一行没动 |
| `dsh-llm` | **加一个可选字段**：`LlmModelCandidate.inputModalities?: readonly ModelModality[]`（"absent means unknown"） | `lib/types/types.d.ts` 第 286 行附近；README §"Discover and resolve models" | **否**。纯加法；我们从 `dsh-llm` 只拿 `LlmAdapter` / `createMessage` / `GenerateOptions` / `Message` / `ToolSchema`，`LlmModelCandidate` 一处都不引用 |
| `dsh-llm-pi-ai` | 新增 `lib/types/models.d.ts`（`createModels` / `createProvider` / `getSupportedThinkingLevels` 三个 helper），README 说明改成"运行时只走 pi-ai 的 provider / api / utility 窄入口，不再求值它的聚合入口"；README 还补了一句：目录里有的路由用目录里的 `input` 数组当 `inputModalities` | `lib/types/models.d.ts`（新文件）；`README.md` §"Design philosophy" 与 §"Discover models from endpoints" | **否**。这就是 release notes 那条"修复 pi-ai 视觉模型被识别为仅支持文本"。我们走的是 `subscription.ts` 里 `await import('@deepseek-ai/dsh-llm-pi-ai')` 的默认导出插件 + `providers` 字典，没有引用这三个 helper；订阅那条路发的是文本 |
| `dsh-sandbox` | **语义改了**（注释与 README，`.d.ts` 的类型签名没变）：`approveEscalation` 从「必须严格更宽，否则不提示人直接 fail-closed」改成「**重复当前有效档位不需要审批、直接返回**；更宽的要审批且只对这一条调用生效；更窄或不支持的仍然抛」 | `lib/types/escalation.d.ts` 的 `EscalationRequest.effectiveMode` 注释与 `approveEscalation` 的 JSDoc；`README.md` §"Denied calls and escalation" / §"Escalation choreography"；`dsh-tool-bash/README.md` §"Sandboxed execution and escalation" 同步改 | **否，但这是这次唯一一条真改了语义的**。原因是我们的门禁**比它更严、而且排在它前面**：`gate.ts` 的 `tools/pre-execute` 里 `checkShellCommand()` 对 `sandbox_permissions` 是**一律拒**（`shell_escalation_forbidden`，`src/shell.ts:318`），不分更宽还是相等——所以 `approveEscalation` 在我们这条路上永远到不了。`test/shell-seam.test.ts` 的 `(a)` 组钉着这一条，19 条零改动全绿 |
| `dsh-subprocess` | **接口加了一个必选方法**：`SubprocessTerminalHandle.inspectActivity(): Promise<SubprocessTerminalActivity>`；新增 `SubprocessTerminalActivity`（`state: 'idle' \| 'busy' \| 'unknown'` + `revision`）；`SubprocessTerminalSpawnSpec` 加可选 `shellActivity?: boolean` | `lib/types/types.d.ts`（新 interface + 新方法）、`lib/types/index.d.ts`（导出名）；`README.md` §"Running terminal sessions" 后新增一段 | **否**（要看清楚）。它是**实现者**的破坏性改动，我们不实现 `SubprocessTerminalHandle`——`tsc -b --force` 零报错就是证据。我们也不开 PTY：`AgentswsBashExecutor` 走的是普通 `spawn`（AGENT-LAYER §11.1） |
| `dsh-subprocess-local` | ① 新增 `lib/types/shell-activity.d.ts`（`ShellActivity` 类 + `prepareShellActivity()`：给 `bash -i` / `zsh -i` 装私有的生命周期记录文件）；② `LocalTerminalProcess` 的构造函数多三个参数、加 `inspectActivity()`；③ `BoundProcessOwner` 加可选 `inspectTaskCount?()`；④ `ProcessSnapshot` 加可选 `complete?`，`snapshot()` 的 JSDoc 补 `@throws`；⑤ README 新增一段：Windows 普通子进程用 `windowsHide` 起 Job runner | `lib/types/{shell-activity,terminal,managed-owner,process-inspector}.d.ts`；`README.md` §"Running terminal sessions" | **否**。我们只把它 `root.plugin(SubprocessLocal, …)` 挂上去拿 `ctx.subprocess`，不 new 它的类、不传 `shellActivity`（默认不开）。⑤ 那条是 release notes 的"修复 Windows 控制台窗口闪现"，对我们是白得的改善 |
| `dsh-util-values` | **新增一个导出**：`WeakMapWithValues<Key, Value>`（弱键 + 强引用的值集合，不自动清理） | `lib/types/index.d.ts` 尾部；`README.md` §"Publish, compare, or retain keyed values" | **否**。纯加法；我们从它只拿 `deepFreeze` / `deepEqualJson` |
| `dsh`（CLI 元包，不 import） | 新增整个 `lib/types/` 目录（`args` / `bin` / `dump-config` / `plugin` / `process-shutdown` / `profile-boot` / `startup-diagnostics`）——以前这个包不发类型。README：`dsh <name>` 可以直接当 `--profile <name>` 用；新增 `@deepseek-ai/dsh/profile-boot` 导出给 Desktop 宿主 | `lib/types/*.d.ts`（整目录新增）；`README.md` 命令表与末尾新增段 | 否。我们不跑 `dsh` 这个 CLI（两档运行时都是 `harness.ts` 自己搭树） |
| `@deepseek-ai/cordis` / `@deepseek-ai/schemastery` | **不动**（仍 4.0.2 / 3.18.2） | `npm view` + 依赖树 | 否 |

#### 1.1 bundle 的 patch 层：这才是碰到我们的那一条

`.d.ts` 与 README 之外还有第三个面：**上游 bundle 自己的 `cordis.patch.yml`**。
我们的 profile 写的是 `bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless']`，
所以这两份 patch 是**我们这一层的上游**，它们改了就是改了我们的组合。

`packages/bundle/base/cordis.patch.yml` 的 diff：

```diff
 - insert:
+    - id: tool-plugin-manager
+      name: '@deepseek-ai/dsh-plugin-manager/tools'
+      disabled: true
+
+    - id: plugin-manager
+      name: '@deepseek-ai/dsh-plugin-manager'
+      disabled: !!js "!ctx.get('profileContext')"
+
     - id: timer
       name: '@deepseek-ai/cordis-plugin-timer'

     - id: hmr
-      name: '@deepseek-ai/cordis-plugin-hmr'
-      disabled: true
+      name: '@deepseek-ai/dsh-hmr'
+      disabled: !!js "!ctx.get('profileContext')"
       config:
-        root: ['.']
+        root: []
```

`packages/bundle/headless/cordis.patch.yml` 的 diff 只有三行：`- id: hmr` / `disabled: true`。

**`profileContext` 的定义是「Present only in a profile launched by dsh」**
（上游 `packages/boot/app-boot/src/profile-context.ts` 的 `declare module` 那段），
也就是说 `dsh --profile agentsws` 一起，`plugin-manager` 默认就是**开**的
（`hmr` 被 headless 那层顶回 `disabled: true`，但那是上游替我们做的决定，不是我们的）。

这一条按 docs/42 红线 7 处理，见 §5。

#### 1.2 release notes 的其余条目逐条判

| release notes 的条目 | 碰到我们吗 | 出处 |
|---|---|---|
| **插件依赖解析改运行时解析、Plugin Manager 支持运行时卸载，"请开发者检查插件加载和卸载逻辑"** | **否**（这是本次最要紧的实证项，见 §4 第 1/2 层） | 四类 `agentCtx.plugin(...)` 挂载（浏览器 provider / BrowserSkill / 订阅适配器 / preset mount）与宿主组合里的 shell 沙箱一摞，**五组用例一条不改地全过**：`browser-seam` 23 + `browserskill-seam` 49 + `preset-seam` 17 + `shell-seam` 19 + `subscription` 13。`dispose()` 后资源真释放由 `browser-seam.test.ts` 的「attach 模式下两次运行不会同时占住同一个 Chrome：第一棵树 dispose 之后槽才空出来」直接钉着 |
| 新增插件管理页 / 侧边栏四个新面板 / 工作区按目录分组 / 侧边栏布局持久化 / 输入框菜单键盘操作 / Trajectory 附件 / 思考内容排版 / 上下文用量位置 | **否** | 全在 `@deepseek-ai/dsh-client-ui-*`（官方 web 客户端）。我们的第三栏是自己的 React 轨（`apps/workstation/src/components/rail/*`），不引任何 `dsh-client-*`。只读对照另写在 `docs/upstream/sidebar-compare.md` |
| 会话新增回合结束文件改动卡 + 逐文件对比审阅 | **否**（但值得重判，见 §6 第 3 条） | 新包 `@deepseek-ai/dsh-workspace-changes`，`grep -rn "workspaceChanges" packages/dsh-adapter/src` 零命中 |
| 侧边栏 Office 预览 | **否**（但拖来 259 MB 的原生依赖，见 §2） | 新包 `dsh-office-to-pdf` + `dsh-skill-office`（后者根本没进我们的树） |
| 修复 pi-ai 视觉模型被识别为仅支持文本 | **否** | 见 §1 `dsh-llm-pi-ai` 那行。我们的订阅登录走 `/codex/responses`，不发图片 |
| 修复 Messages API 地址拼接及历史工具输入格式异常 | **否** | 改的是 `packages/llm/llm-deepseek/src/protocols/messages/*` 与新增的 `src/common/messages-api.ts`。`dsh-llm-deepseek` 不在两档的模块图里（`test/telemetry.test.ts` 钉着），我们的模型调用走 `src/llm.ts` 覆写的 `LlmAdapter` |
| 修复重启后待处理的 Inbox 消息无法恢复 | **否** | 见 §1 `dsh-agent-loop` 那行 |
| 修复重复申请当前有效权限模式时仍需审批 | **否** | 就是 `dsh-sandbox` 那条语义改动；我们的门禁排在它前面且一律拒 |
| Windows 执行 PTC / Shell 时控制台窗口闪现 | **否**（白得的改善） | `dsh-subprocess-local` README 新增段 |
| 会话被其他 DSH 实例占用时提示 / 启动失败分类显示 / CLI 与 Web 启动等候时间 | **否** | 都在 `dsh` CLI 与 `app-boot` 那一层，我们不跑它 |
| Web 用户终端用系统用户权限，不受 Agent 沙箱模式限制 | **否**（而且**明确不借**） | `dsh-client-ui-sidebar-terminal` + `dsh-api-terminal-controller`，我们一个都不挂。理由见 `docs/upstream/sidebar-compare.md` #14 |
| **默认模型列表移除 V4 Flash 和 V4 Flash Vision Exp** | **否**（核过了） | 上游删的是 `packages/llm/llm-deepseek/src/common/models.ts` 里的 `deepseek-v4-flash` 与 `deepseek-v4-flash-vision-exp` 两个 id。我们 `packages/simulation/src/realistic.ts` 的默认档是 **`deepseek-flash`**（WP87 定的，不是同一个 id），而且它走的是我们自己的 `@agentsws/model-gateway` + `PRICE_CATALOG`，不经 `dsh-llm-deepseek`。**`realistic.ts` 一个字没改** |
| CLI 支持 `dsh <profile>` | 否 | `dsh/README.md` 命令表 |
| Subagent 链默认最多 8 个、深度 1 | **否** | 新默认值在 `packages/subagent/subagent/src/index.ts`（见 §3 的默认值扫描）。我们不 import `dsh-subagent`，模块图实测零命中 |
| 创造模式移除 Cordis 动态定义及运行工具，改 Plugin Manager 持久化插件 | **否** | `dsh-tool-cordis` 我们不挂；Plugin Manager 见 §5 |
| 客户端 Session 多实例，API 及 slot 有变化 | **否** | 客户端 |

### 2. 原生依赖：来了一个 259 MB 的，一律不装

依赖树 diff（`awk` 取 lockfile 的 `packages:` 段，去版本号后 `comm`）：

| | 包 |
|---|---|
| **新增 13 个 dsh 包** | `dsh-plugin-manager`、`dsh-hmr`、`dsh-lazy-require`、`dsh-workspace-changes`、`dsh-office-to-pdf`、`dsh-experimental-agent-team{,-profile,-web-profile}`、`dsh-experimental-tool-agent-team`、`dsh-experimental-client-ui-agent-team`、`dsh-client-ui-slots`、`dsh-client-ui-plugin-manager`、`dsh-client-ui-sidebar-browser` |
| **新增 6 个 `@deepseek-ai/libreoffice-kit*`** | 本体 + `darwin-arm64` / `darwin-x64` / `win32-arm64` / `win32-x64` / `wasm` 五个平台包 |
| **新增 14 个第三方** | `@swc/helpers`、`brotli`、`clone`、`dfa`、`fontkit`、`pako`、`restructure`、`tiny-inflate`、`unicode-properties`、`unicode-trie`、`which-command`、`execa`、`fflate`（后两个是新版本进树） |
| **消失 1** | `@deepseek-ai/cordis-plugin-hmr`（被 `dsh-hmr` 顶掉） |

两个**容易记错**的：`dsh-tool-present` 在上游从 `packages/fs/` 挪到了 `packages/deliverables/`，
**npm 包名没变**，所以依赖树里既不新增也不删除；`dsh-skill-office` 是上游新包，但**没进我们的树**
（没人依赖它）。

#### 2.1 `allowBuilds`：一个字没改

新进树的 20 个非 dsh 包逐个看了 `scripts`：**没有一个有 `install` / `preinstall` / `postinstall`**。
`brotli` / `dfa` / `fontkit` / `unicode-properties` 有 `prepublish`，那是**发布期**脚本，
装依赖时不跑。`pnpm install` 的输出里也没有任何 "ignored build scripts" 之类的提示。
`koffi` / `node-pty` / `protobufjs` / `@google/genai` / `dsh-subprocess-local` / `node-addon-system` /
`node-addon-require-builtin` / `node-addon-native-custom-loader` / `playwright` / `playwright-core`
照旧 `false`，仍然在树里、仍然不构建。

#### 2.2 `ignoredOptionalDependencies`：`allowBuilds` 挡不住的那种

`dsh-office-to-pdf`（侧边栏 Office 预览）依赖 `@deepseek-ai/libreoffice-kit`，后者用
`optionalDependencies` 挂着**五个平台包**，里面是整套 LibreOffice 程序——
本机那个 `darwin-arm64` 实测 **259 MB**（`du -sh node_modules/.pnpm/@deepseek-ai+libreoffice-kit-darwin-arm64@0.0.1/`）。

它**没有 install / postinstall**（只有一个 `prepack`），所以 `allowBuilds` 里写 `false` 是没用的——
那一栏只挡"构建"，挡不住"下载 + 解包"。按 16 §3 最严解释与派工书"一律不构建、不装"，
`pnpm-workspace.yaml` 新增：

```yaml
ignoredOptionalDependencies:
  - '@deepseek-ai/libreoffice-kit-*'
```

装完实测：`grep -c 'libreoffice-kit-darwin' pnpm-lock.yaml` = **0**，
`node_modules/.pnpm/@deepseek-ai+libreoffice-kit@0.0.1/node_modules/@deepseek-ai/` 下只剩本体自己。
纯 JS 的 `libreoffice-kit` 本体（168 KB）留着：它是 `office-to-pdf` 的**硬依赖**，删了会让依赖图缺边；
没有平台包时它只是转换不了，不影响加载。整条 Office 预览是官方 web 客户端（`dsh-web-app`）的事，
我们一个 `dsh-client-*` 都不挂。

#### 2.3 `minimumReleaseAgeExclude`：240 → 253，整批替换

0.1.6-alpha.1 那批 **240 条整批替换**成 alpha.2 的 **253 条**。老坑复现了一次，记一笔：
**pnpm 默认是叠加**，它会把条目改写成 `'<包>@0.1.6-alpha.1 || 0.1.6-alpha.2'`，等于把旧版
一起继续放行；按 docs/42 红线 3（"排除的是这一个版本"）全部改回单版本写法。
多出来的 13 条全部是 §2 那张表里新进树的 dsh 包，一条都不是我们主动加的。

#### 2.4 `overrides` 要加第四条（install 直接红的那个坑）

改完版本号第一次 `pnpm install` 是**红的**：

```
[ERR_PNPM_NO_MATCHING_VERSION] No matching version found for
@deepseek-ai/dsh-client-ui-primitives@>=0.1.6 <0.2.0-0
```

追下去是 WP92 那个坑的第四次发作。BrowserSkill 插件（`@wxg-prc-cpg/browser-skill-dsh-plugin@0.3.0`）
把六个 dsh peer 写成 `^0.1.0-rc.6`，与我们整棵预发布树**不相交**（semver 的预发布规则），
pnpm 就去 registry 另找一份。WP92 当时给撞上的三个（`dsh-attachment` / `dsh-tools` / `dsh-llm`）
写了 `overrides`，并留了一句"剩下三个 `dsh-client-ui-*` 是 optional peer，树里没有那些包，
所以一个都不装"。

alpha.2 把 `dsh-experimental-agent-team-web-profile` 加进了 `@deepseek-ai/dsh` 的直接依赖
（`npm view @deepseek-ai/dsh@<两版> dependencies` 的 diff：新增 5 个、消失 1 个），
它 → `dsh-experimental-client-ui-agent-team` → **`dsh-client-ui-primitives`**——
于是这个包第一次进树，那条 optional peer 第一次被解析，install 当场炸。
处理同 WP92：钉到树里已经有的那一版。另两个（`dsh-client-ui-attachment` / `dsh-client-ui-tool`）
仍然不在树里，所以**仍然不写**——等它们哪天也被拖进来再说。

> 排查过程记一笔，因为 pnpm 的报错很容易把人带沟里：它把范围打印成
> `>=0.1.6 <0.2.0-0`（看着像 `^0.1.6`），而且说"a direct dependency of packages/dsh-adapter"。
> 两条都不是字面意思。先试着把 `minimumReleaseAge` 临时设成 0 排除了静默期的嫌疑
> （仍然红），再用两个临时目录二分（只装 `@deepseek-ai/dsh@0.1.6-alpha.2` → 绿；
> 加上插件 → 红），才定位到 peer 那一层。

### 3. ④bis 默认值扫描：12 行，一条都不是出网 / 上报 / 遥测

`scripts/scan-default-flips.sh deepseek-ai/deepseek-harness dsh-v0.1.6-alpha.1 dsh-v0.1.6-alpha.2 packages`
（WP91 做的那个脚本，不是手搓）报 **12 行**变化，逐条判：

| 行 | 是什么 | 判断 |
|---|---|---|
| `api/terminal-controller`: `activityPollIntervalMs` 30s / `cleanupRetryMs` 60s / `unattendedTimeoutMs` 2h | 新包的三个超时，Web 用户终端的保活与回收 | **无关**。`dsh-api-terminal-controller` 不在两档模块图里 |
| `boot/app-boot`: `levels: { default: 2 }` | 日志等级 | **无关**，不是开关 |
| `boot/app-boot/tests/app-boot.spec.ts`: 同一行 | 测试文件 | **无关** |
| `subagent/subagent`: `maxActiveSubagents` **新增** `.default(8)`、`maxDepth` **新增** `.default(1)` | release notes 的"Subagent 链默认最多 8 个、深度 1" | **无关**。不 import `dsh-subagent`，模块图零命中 |
| `subagent/tool-subagent`: `maxDepth` `.default(3)` **消失** | 同上，挪到 `subagent` 包了 | **无关** |
| `client/hmr`、`experimental/webworker-runtime`: 裸 `default:` | `switch` 的 `default:` 分支标签 | **误报**（脚本的正则会捞到源码里的 `default:`） |
| `subprocess/subprocess-local/tests/linux-execve.spec.ts` 两行 `vi.doMock('koffi', () => ({ default: … }))` | 测试里的 mock | **误报** |

**一条出网 / 上报 / 遥测开关都没有翻。** 反过来也核了一遍 WP70 那条：
`packages/session/session-log-deepseek/src/index.ts` 第 45 行仍然是
`enabled: z.boolean().default(true)`（`diff -rq` 整个包只报 `package.json`），
所以 `profiles/agentsws/cordis.patch.yml` 里那行 `enabled: false` **仍然必须留着**，
`test/telemetry.test.ts` 3 条仍然绿。

「整个文件新增 / 消失」那一段 157 处逐个扫了一遍，新包里的 `.default(` 也看了
（`plugin-manager` 的 `pnpmCommand: 'pnpm'` / `lockWaitMs` 等、`hmr` 的 `root: ['.']` /
`debounce` 、`office-to-pdf` 的十个上限、`workspace-changes` 的五个上限、
`tool-present` 的 `maxFiles: 8`）——**没有一个是出网 / 上报 / 遥测**。
但 `plugin-manager` 这个包本身是另一类风险，见 §5。

### 4. 怎么证明行为没变

四层证据，从窄到宽。

1. **seam 契约测试**（`test/seams.test.ts`，17 §4「任一红 = 不升级」）：**30 条，一条没改、全绿。**
2. **五组"重点实证"用例一条不改地全过**（派工书点名的那五组）：

   | 组 | 文件 | 条数 | 钉的是什么 |
   |---|---|---|---|
   | 浏览器 provider | `browser-seam.test.ts` | 23 | `agentCtx.plugin(PlaywrightMcpProvider, …)` 的挂载、四道门的顺序、**`dispose()` 后 Chrome 槽真释放** |
   | BrowserSkill 插件 | `browserskill-seam.test.ts` | 49 | `agentCtx.plugin(BrowserSkillPlugin, …)`、按 action 分读写、三处 url 白名单 |
   | 职责 preset | `preset-seam.test.ts` | 17 | `agentPresets.mount()`、`withPresetCredentials`、幂等写 |
   | shell 沙箱 | `shell-seam.test.ts` | 19 | 宿主组合里那一摞（`subprocess-local` / `sandbox-local` / `sandbox-policy` / `AgentswsBashExecutor` / `shell-env` / `tool-bash`）、命令 allowlist、**升档一律拒** |
   | 订阅登录 | `subscription.test.ts` | 13 | 动态 import `dsh-llm-pi-ai`、凭据只在记录里、token 零泄漏 |

   这就是对 release notes 那条"插件依赖解析改运行时解析、支持运行时卸载，请开发者检查
   插件加载和卸载逻辑"的回答：**四类 `agentCtx.plugin(...)` 的加载与卸载行为与 alpha.1 相同。**
   再加一条独立实测：用 ESM resolve 钩子录两档的真实模块图，
   `@deepseek-ai/dsh-plugin-manager` / `-hmr` **两档都是 0 命中**（新加的
   `test/profile-lockdown.test.ts` 钉住）。唯一新进模块图的是
   `@deepseek-ai/dsh-lazy-require`（经 `dsh-subprocess-local` 进来），
   它是一个 25 行的 `createRequire` 缓存，不联网、不装东西——反而是好事，
   它让 `koffi` / `node-pty` 变成用到才 require。

   `@agentsws/dsh-adapter` 这个 project 升级前 **14 文件 596 条**，
   升级后 **15 文件 872 条**，多出来的 276 条全部有解释：
   `upgrade.test.ts` 393 → 666（WP81 的"自比"退化成两条断言，这次换回完整的跨版本六项断言），
   加上新写的 `profile-lockdown.test.ts` 3 条。**既有的 14 个测试文件一条用例都没改、没删。**
3. **升级前后指纹逐条对比**（`test/upgrade-baseline/*.json` + `test/upgrade.test.ts`）：
   51 条场景 × 2 档 dsh = **102 条**——

   | 比什么 | 结果 |
   |---|---|
   | 事件**类型**序列 | 102/102 完全相同 |
   | 事件 `type@at`（连合成时钟时刻一起比） | 102/102 完全相同 |
   | 六条不变量 | 全绿，逐条相同 |
   | 场景断言（`expectations`） | 逐条相同 |
   | 运行摘要（人话那句） | 逐条相同 |
   | `tokens_per_item` | **偏差 0.00%**（阈值 ≤ 5%） |
   | 两档 dsh 之间是否仍然逐条相等 | 是（升级前 0 处差异，升级后 0 处差异） |

   更强的一句：把两份 JSON 的 `dsh_version` 与 `packages` 两个字段去掉之后，
   其余部分**逐字节相同**。所以 `packs/*/baseline.json` 的 dsh 档**一个数都不用重定**，
   `--rewrite-baseline` 没用上。

   FROM 用的是 `0.1.6-alpha.1-wp93.json`——**升级前在当前代码树重采的**（docs/42 ① 的红线）。
   WP81 留下的 `0.1.6-alpha.1-wp81.json` 不能直接当 FROM：那是 WP82–WP92（浏览器 /
   BrowserSkill / preset / shell 沙箱 / 订阅登录）之前的代码树。旧的六份一个不删。
4. **提示词逐字节对比**（docs/42 ⑥）：这次有一条更硬的先行证据——
   **上游 `packages/core/system-prompt` 整个包逐字节相同**（`diff -rq` 只报 `package.json`），
   所以渲染结果不可能变。仍然按流程把三种组合导了一遍（`systemPrompt.assemble()` +
   `renderPrompt()`，记每段的 `name` / 长度 / `interpolate` 与 `variables` 的键集合），
   与 WP70 记在上一节 §4 的那张表逐项对照——

   | 组合 | WP70 记的（0.1.6-alpha.1） | 这次实测（0.1.6-alpha.2） |
   |---|---|---|
   | 裸 `SystemPrompt`（默认） | 段 `harness:identity`(48 字) / `deployment:persona-prefix`(0) / `deployment:persona-suffix`(0)；渲染 `"You are an AI agent powered by DeepSeek Harness."` | **完全相同** |
   | `includeHarnessIdentity: false`（我们用的那档） | 渲染 `""`，只剩两个空的 persona 段 | **完全相同** |
   | 加上我们的 `complete: true` persona 段 | `sections` 只剩它一个，渲染 = 它本身 | **完全相同** |

   **没有提示词 diff 要列。** 顺带重申 WP41 就写过的一件事：模型真正收到的那份 prompt
   本来就不来自 dsh 的 `systemPrompt`——`runtime.ts` 用的是 `@agentsws/stand-ins` 的
   `assemblePrompt(req)`；dsh 的 `systemPrompt` 只在 seam 契约测试里被断言。

### 5. 安全：把 Plugin Manager 与 HMR 在 patch 层关死

这是这次升级**唯一**真正碰到我们的上游改动，也是"不做等于没升级"的那一条。
形状与 WP70 的 `session-log-deepseek` 一模一样：**上游单方面把一个默认值翻成了开**，
而我们的组合里"碰巧没有它"不能当保证（docs/42 红线 7）。

上游改了什么：见 §1.1 的两份 bundle patch diff。落到一句话——
`dsh --profile agentsws` 一起，`@deepseek-ai/dsh-plugin-manager` 这个服务默认就是挂的。

为什么必须关（出处全在上游 `packages/boot/plugin-manager/README.md`）：

- **它装任意代码，而且装完的代码不在沙箱里**：「installed Host code executes in-process
  outside the workspace sandbox」。安装动作是在 profile 目录里跑 `pnpm`（`pnpmCommand`
  默认就是 `pnpm`），以**宿主用户**的权限。
- **它能改我们这份 patch 文件本身**：「A plugin toggle updates only `disabled` in the last
  matching override in the profile's `cordis.patch.yml`, or appends an override when none matches」；
  bundle 开关改的是 `package.json` 的 `dsh.profile.bundles`。
- **它带一条绕过 `allowBuilds` 的路**：pnpm 11 挡下构建脚本时，
  「the tool can grant permission on the user's behalf through `approvedBuilds`」，
  而且「The service validates pending names; it does not verify conversation approval」。
  那正是 `pnpm-workspace.yaml` 的 `allowBuilds` 在守的门（16 §3 最严解释）。
- 与 31 §3.5「v1 的公司端执行器不装任何第三方代码」正面冲突。

`hmr` 一并关掉：它会在运行中热替换模块，而我们这份 profile 写的是 `patchReload: startup`
（启动时应用一次）。`headless` bundle 确实把它顶回了 `disabled: true`，但那是**上游替我们
做的决定**——上游哪天改回去，我们就跟着开了。

所以 `profiles/agentsws/cordis.patch.yml` 加三行（`tool-plugin-manager` 上游已经写死
`disabled: true`，我们再写一遍：默认值是上游可以单方面翻的）：

```yaml
- id: plugin-manager
  disabled: true
- id: tool-plugin-manager
  disabled: true
- id: hmr
  disabled: true
```

钉住它的测试：**`packages/dsh-adapter/test/profile-lockdown.test.ts`（3 条）**，
结构照抄 `telemetry.test.ts`——两道：① 两档运行时的**真实模块图**里
`dsh-plugin-manager` / `dsh-hmr` 零命中（ESM resolve 钩子，带反向哨兵防假绿）；
② patch 层三行确实是 `disabled: true`。

### 6. 重判上次放弃的选项（docs/42 §⑤）

**换与不换的线事先说死**（WP41 定的那条，这次沿用）：≤ 100 行且两档事件序列仍然相等才换。

| # | 上次的判断 | 这次实测 | 还成立吗 |
|---|---|---|---|
| 1 | 官方 SDK（`dsh --profile sdk` + `dsh-sdk-client`）**没有 server→client 请求**，五个 seam 有四个要从子进程回调宿主 | `@deepseek-ai/dsh-sdk-jsonrpc-server@0.1.6-alpha.2` 的 `lib/index.js` 里 `transport.request(` 仍然是 **0 处**（连 `request(` 都是 0 处）；往回只有四个 `transport.notify`：`session.event` / `session.status` / `subagent.started` / `subagent.finished`。上游源码 `packages/sdk/protocol/src` 与 alpha.1 **逐字节相同**（`diff -rq` 无输出），`packages/sdk/server/src/server.ts` 也没再动 | **成立**，不换 |
| 2 | （新）`plugin-manager` 的"运行时解析 + 运行时卸载"能不能替掉我们 `withPresetCredentials` / `agentPresets.mount()` 那套？ | **不能，而且不该**。三条实测出来的不匹配：① **粒度**——它管的是 **profile 级**的插件（改 `cordis.patch.yml` 与 `package.json`、跑 pnpm），"Changes affect every session using the profile"；我们的 preset 是**一次运行一个职责**、内存里的、结束即销毁（17 §5.1）。② **信任模型**——它"装任意包、装完在沿进程里跑、在工作区沙箱之外"，每个工具动作要 `danger-full-access` 或审批；我们的 preset 只挂**已经在依赖树里**的官方插件，凭据只在一条命令里活着（AGENT-LAYER §10.3 / §11.2 ③）。③ **持久性**——它的改动跨会话持久化并落盘到 profile 目录；我们要的恰恰是"一次运行一棵树、两次运行之间没有任何共享状态"。**代码量那条线根本轮不到判**：第 ② 条就已经否掉了 | **成立**（保持现状） |
| 3 | （新）`deliverables/workspace-changes` 的"回合结束文件改动卡"能不能给 WP89 的主题副本改动用？ | **形可以借，体不能用**。三条硬伤（出处全在上游 `packages/deliverables/workspace-changes/README.md`）：① **存活期**——摘要与快照"活到 Session 销毁为止"，「A conversation reopened after a Host restart therefore has no card」；而变更账本（docs/15）要的是能回看能追责的持久记录。② **它要 git**——没有仓库或没有 git 时只列"文件工具改的那些"，「Changes made only through shell commands outside the snapshot coverage are not recorded」，而 WP89 的主题改动**全是 shell**（`shopify theme …`）。③ **它挂在 `turn/start` / `agent/turn-stopping` 上，并且每个 `tools/pre-execute` 都要等它的 git 队列**——那正是我们五道门禁那一条，把每次工具调用的延迟绑到 `git add --all` 上不可接受。**能直接借的是它的三条设计约束**：私有 index + 临时对象目录（仓库的 index/objects/worktree/refs 一个都不动）、git 走清洗过的 `subprocess` 且 `GIT_CONFIG_COUNT=0` / `GIT_TERMINAL_PROMPT=0` / `GIT_OPTIONAL_LOCKS=0` 带超时带输出上限、行对比超时就降级成"整文件替换一个 hunk 并标 `coarse`" | **只评估，不做**。展开写在 `docs/upstream/sidebar-compare.md` §4 |

### 7. 留下的东西

1. **`session.eventAt(seq)` 仍然在**（上一节 WP81 那条"升级时第一个会红的地方"）。
   `dsh-session` 的 `.d.ts` 这次逐字节相同，三个同步读接口还挂着 `@deprecated`。
   `harness.ts` 的 `summarizeTurn()` 仍然用着它——**下一跳仍然是第一个会红的地方**。
2. **`upstreams.yml` 只钉得住 `@deepseek-ai/dsh` 一个包**。
   `packages/credentials-openconnector/package.json` 锁的是 `@deepseek-ai/dsh-credentials`，
   `scripts/check-upstreams.mjs` 的 `locked_in` 是按 `it.npm`（= `@deepseek-ai/dsh`）查的，
   所以把这个文件加进 `locked_in` 会直接红（"里根本没有依赖 `@deepseek-ai/dsh`"）。
   这次是**人工记着**改的。兄弟包靠 `release_age_prefix: '@deepseek-ai/dsh'` 间接兜住
   （`minimumReleaseAgeExclude` 里每一条 `@deepseek-ai/dsh*` 都必须等于 `locked_version`），
   但"某个包 json 里漏改一个版本号"这件事**登记表查不出来**。v2 值得给
   `locked_in` 加一个"这个文件里所有 `<prefix>*` 的依赖都必须等于 locked_version"的模式。
3. **`ignoredOptionalDependencies` 是这次新用上的一把刀**，下次升级要顺手看一眼：
   它挡掉的五个 `libreoffice-kit-*` 还在不在树里、`office-to-pdf` 有没有变成硬性必需。
4. **BrowserSkill 插件的 peer 会一版一版地炸**。`^0.1.0-rc.6` 与我们的预发布树永远不相交，
   所以每当有新的 `dsh-*` 或 `dsh-client-ui-*` 第一次进树、而它正好是那六个 peer 之一，
   install 就会红一次。现在已经写了四条 `overrides`，还剩两个
   （`dsh-client-ui-attachment` / `dsh-client-ui-tool`）没进树。**下次红了先看这里。**
   真正的解法是等上游（`Tencent/BrowserSkill`）把 peer 范围放宽——已登记进
   `upstreams.yml` 的 wishlist。
5. **右侧边栏那一大摞是这一版的主体，但一条都不碰我们**。只读对照单独写在
   `docs/upstream/sidebar-compare.md`：官方怎么做的（三层 kit/host/tab type、两段式 slot 注册、
   布局持久化"存结构不存内容"、面板绑 session）对照我们的第三栏（docs/36 §9），
   18 条逐条标了"借形 / 不借 / 待定"。**结论由 Luoye 回写 docs/36。**

### 8. 第 ② 步的原始输出（`pnpm upstream:watch --dry-run --scope daily`）

```
# 上游哨兵 · 每日 dsh 检查（2026-09-18）

观察窗口：2026-09-11 → 2026-09-18（7 天）。**这份报告里没有任何东西被改、被装、被合并。**

| 看了几个上游 | 1 |
| 有更新版本的 | `dsh` |
| wishlist 命中 | 无 |
| 查不到的 | `dsh` |

## dsh · runtime-dep
- npm `@deepseek-ai/dsh`：锁 `0.1.6-alpha.1`，dist-tags 里最高的是 `0.1.6-alpha.2` → **上游有更新的版本**
  - dist-tags：`next` = `0.1.5-rc.2`，`latest` = `0.1.5-rc.2`，`alpha` = `0.1.6-alpha.2`
  - 最近发布：`0.1.6-alpha.2`(2026-09-17)、`0.1.6-alpha.1`(2026-09-15)、`0.1.5-rc.2`(2026-09-10)、…
- GitHub deepseek-ai/deepseek-harness：查不到（403 rate limit exceeded）

## 给评估例程的提示
- `dsh`：`0.1.6-alpha.1` → `0.1.6-alpha.2`。按 docs/42 走完 ①→⑦，**先在当前代码树重采基线**。
- `dsh` 这一趟查不到（GitHub meta：403 rate limit exceeded）。**查不到 ≠ 没变**，下一趟仍要看。
```

**GitHub 那一半 403 是这一趟的盲区**，报告如实写了（docs/42 §3.2 的纪律：扫不成不把流程染红，
但要说出来）。release notes 是我用 `gh release view dsh-v0.1.6-alpha.2 -R deepseek-ai/deepseek-harness`
（带鉴权，不走匿名 API）另取的，两个 tag 的源码也是 `scan-default-flips.sh` 自己克隆的——
所以这次的盲区只影响"周报里那几行链接"，不影响任何一条判断的出处。

---

## 0.1.6-alpha.2 → 0.1.7-rc.1（2026-09-24，WP132）

### 0. 版本口径

Luoye 09-23 原话是"DeepSeek harness 0.1.7.2 更新了"。npm 上**没有 `0.1.7.2` 这个号**
（semver 也写不出四段）。升级当天 `npm view @deepseek-ai/dsh dist-tags --json`：

| tag | 版本 | 发布时间（`npm view … time`） |
|---|---|---|
| `next` | **0.1.7-rc.1** | 2026-09-23T13:44:12Z |
| `alpha` | 0.1.7-alpha.2 | 2026-09-22T16:08:55Z |
| `latest` | 0.1.5-rc.3 | 2026-09-22T05:55:20Z |

0.1.7 系列一共三个号：`0.1.7-alpha.1`（09-22）、`0.1.7-alpha.2`（09-22）、`0.1.7-rc.1`（09-23）。
他说的"0.1.7.2"最可能是 alpha.2，但**最新的是 rc.1**，这次按 rc.1 升。这是 dsh 第一次出 rc 之后
我们跟 rc（前三次跟的都是 alpha）。`latest` 仍然停在 0.1.5 系列（09-22 还补发了一个 0.1.5-rc.3），
按"升到 latest"办事仍然是**降级**。锁精确版本，不用 `^`。

**兄弟包这次必须跟着升**（docs/42 ② 说的"必要时"第一次发生）：dsh 0.1.7-rc.1 的依赖写的是
`@deepseek-ai/cordis ~4.0.4`、`@deepseek-ai/schemastery ~3.18.4`、`cordis-plugin-loader ~1.0.5`、
`cordis-plugin-include ~1.0.9`（`npm view @deepseek-ai/dsh@0.1.7-rc.1 dependencies`），
我们锁的 4.0.2 / 3.18.2 / 1.0.3 / 1.0.7 进不了同一棵树。于是 `packages/kernel`、`packages/roles`、
`packages/credentials-openconnector`、`apps/server`、`profiles/agentsws`、`packages/dsh-adapter`
六处一起改；`dsh-adapter` 里那个 `^3.18.2`（upstreams.yml 记在案的擦边球）顺手统一成精确版本。
kernel / roles / credentials-openconnector 的测试全过（见 §4）。

**四个包一起升？实际是 38 个。** 派工单写的是"`dsh` / `dsh-agent` / `dsh-agent-loop` / `dsh-agent-presets`
四个包"，但 `dsh-adapter/package.json` 里写死 0.1.6-alpha.2 的 `@deepseek-ai/dsh*` 有 38 个
（+ profile 里 10 个、credentials-openconnector 1 个），它们互为 peer、必须同版本。逐个 `npm view <包>@0.1.7-rc.1 version`：
**37 个都在，唯独 `@deepseek-ai/dsh-agent-presets` 没有 0.1.7**（它的 dist-tags 停在 `alpha = 0.1.6-alpha.2`）——
上游把它下线了，见 §1.1。

第 ② 步的 release notes：`gh release view dsh-v0.1.7-{alpha.1,alpha.2,rc.1} -R deepseek-ai/deepseek-harness`
（带鉴权）。rc.1 那份自称「汇总了自 v0.1.5-rc.3 以来的主要用户和开发者相关变更」，
所以它和 0.1.6 两个 alpha 的说明有重叠；逐条判的时候以三份 0.1.7 的说明为准，旧条目只核"有没有变"。
上游源码两个 tag 用 codeload 的 tarball 取（`git clone --depth 1` 这天两次 early EOF），
④bis 的默认值扫描在这两份源码上照 `scripts/scan-default-flips.sh` 的同一套 diff + awk 跑。

### 1. 上游改了什么

比对方法同前三次：升级前后各把 `packages/dsh-adapter/node_modules/@deepseek-ai/*`（41 个包）
的 `*.d.ts` + `README*` + `package.json` 抄一份，`diff -rq`。**这次比 WP93 大得多**：
`.d.ts` 变了 **56 个文件 / 22 个包**，新增 1 个包（registry）、消失 1 个包（presets）。
五个 seam 所在的包：`dsh-scope` **逐字节相同**；`dsh-tools` / `dsh-user-approval` / `dsh-system-prompt` 只有加法
（见表）；**真正碰到我们的是三处：preset、消息形状、shell 执行接口。**

**先记一个流程上的坑**：改完版本号、`pnpm install` 之后跑增量 `npx tsc -b`，**退出码 0**；
单独 `npx tsc -p packages/dsh-adapter --noEmit` 却报 14 处错。增量构建只看**源码**变没变，
node_modules 里上游 `.d.ts` 换了它照样判"已是最新"。docs/42 ④ 原文写的是 `tsc -b --force`，
而日常用的 `scripts/verify-changed.sh` 走增量——这次顺手给它补了一步（锁文件一动，
就对 package.json 也动了的工程跑 `tsc -p … --noEmit`），见 docs/42 修订注。

| 包 | 变化 | 出处 | 碰到我们吗 |
|---|---|---|---|
| `dsh-agent-presets` → **`dsh-agent-preset-registry`** + `dsh-agent-preset` | **整包下线换新**。旧的按 `roots` 扫 `<root>/<id>/agent.cordis.yml`；新的「neither scans directories nor accepts preset paths」，定义只能以插件行（`dsh-agent-preset`）或 `ctx.agentPresets.register(definition)` 交进去；**注册即激活**（「Each declaration eagerly creates a registry-owned scope and an in-memory Loader tree」）；旧一代在最后一个引用释放时销毁 | registry `README.md`「Minimal configuration」「Understand the implementation」；`lib/types/index.d.ts` 的 `register()` / `mount()` / `resolve()` | **碰到，改了**（§3 ①）。`mount(ctx, id)` 签名没变，所以 setup 里那一行照旧；变的是"定义怎么交进去"与"凭据在哪一跳解析" |
| `dsh-llm` | **消息形状改了**：工具结果从"带 `tool-result` 块的 user 消息"升成一等的 **`role: 'tool'` 消息**（`ToolResultMessage`：`toolCallId` + 结果块）；`ToolResultBlock` 删除；新增 `developer` 角色（`tool-addition` / `tool-removal` 块，「reserved for Session V4 persistence」）；`Message` 变成按 role 区分的并集、`content` 变 `readonly`；`GenerateOptions.messages` 放宽成 `RequestMessage[]`（可含无 id 的 `RequestUserInput`）；`createSystemMessage` 少一个参数；`ToolSchema.deferLoading?` | `lib/types/message.d.ts`、`types.d.ts`（`ContentBlockMap`、`RequestUserInput`）、`content.d.ts` | **碰到，改了**（§3 ②）。`llm.ts` 的 `toChatMessages` 与 `harness.ts` 的 `toDshMessages` |
| `dsh-shell` / `dsh-bash-local` / `dsh-bash-sandbox` | **执行接口合并**：`run(spec)` / `start(spec)` → **`execute(spec): Promise<ShellExecution>`**，前台结果改由句柄上的 `result()` 给；新增 `onExpiry: 'kill' \| 'none'`；`LocalBashExecutor.Config` 各字段变 `Volatile` | `dsh-shell/lib/types/index.d.ts` 的 `ShellExecutor`、`types.d.ts` 的 `ShellExecution`；release notes「`SandboxProvider.confine` 和 `ShellExecutor.start` 改为可取消的异步接口」 | **碰到测试，没碰到实现**。`AgentswsBashExecutor` 只覆写 `resolve()`，`tsc` 零报错；`shell-seam.test.ts` 里有一条绕开门禁直接调 `ctx.shell.run()` 的替身跟着改成 `execute().result()`，断言不动 |
| `dsh-tool-bash` | 新开关 **`promoteOnTimeout`，默认 `true`**：前台命令到时不杀、转成后台 job 接着跑 | README 配置表；源码 `src/index.ts` 第 236 行 `(config.promoteOnTimeout ?? true) && backgroundEnabled` | **否**（与 `enableRunInBackground` 取与，我们写的是 false）。照样在 `harness.ts` 显式写 `promoteOnTimeout: false`：默认值是上游能单方面翻的，"超时不杀转后台"与 17 §5.1 正面冲突 |
| `dsh-tools` | 加法：`projectContent?()`、`deferLoading?`、`MessageSourceMap` 加 `tool-registry` | `lib/types/index.d.ts`、`schema.d.ts` | 否。`pre-execute` 的 allow/deny/ask、`post-execute` 的 replace/enrich/block 原样 |
| `dsh-user-approval` | 只加一个 `MessageSourceMap['user-approval']` 声明 | `lib/types/index.d.ts` 头部 | 否。answerer waterfall 与 fail-closed 原样 |
| `dsh-system-prompt` | 分节位 `TOOL_CORDIS: 2500` 删除（创造模式改走 Plugin Manager） | `lib/types/index.d.ts` 的 `SECTION_ORDER` | 否。我们只用 `complete: true` 的 persona 段与 `context`；提示词三组合逐字节相同（§4 第 4 层） |
| `dsh-agent-loop` | `maxParallelToolCalls` 变 `Volatile`；`AGENT_LOOP_SETTINGS_*` 三个导出删除；`MessageSourceMap` 加 `runtime-context` | `lib/types/index.d.ts`、`runtime-context.d.ts` | 否。我们传 `{ maxParallelToolCalls: 1, agents: [] }`，形状照收 |
| `dsh-session` | `SESSION_FORMAT_VERSION` 3 → **4**；新事件 `developer/message`；fork 相关调整；`eventAt` / `snapshotEvents` / `ownEvents` **仍在、仍标弃用** | `lib/types/types.d.ts`、`index.d.ts` 第 181 行 | 否。我们用内存 Session、不落 JSONL，没有 V3→V4 迁移这回事；`runtime.ts` 的投影对不认识的事件类型本来就跳过 |
| `dsh-agent` | 加 `archive-admission.d.ts`、`SessionActivityKindMap.turn` | `lib/types/*` | 否 |
| `dsh-authorization` | 抽象类加 `commit(record)` | `lib/types/index.d.ts` | 否。我们不实现它（`tsc -p packages/credentials-openconnector --noEmit` 零报错） |
| `dsh-llm-pi-ai` | README 与 5 个 `.d.ts`：大型流式工具参数不再阻塞进程等 | `lib/types/*` | 否。订阅那条路只用默认导出插件 + `providers`，`subscription.test.ts` 13 条不改全过 |
| `cordis` 4.0.2 → 4.0.4 | `Fiber.update()` 不再返回 Promise；导出 `Volatile` 类型 | `lib/types/fiber.d.ts`、`events.d.ts`、`index.d.ts` | 否。`packages/kernel` 测试全过 |
| `cordis-plugin-loader` 1.0.3 → 1.0.5 | 新增 `config/diff.d.ts`（按 schema 的 volatile 字段比较配置） | `lib/types/config/diff.d.ts` | 否 |
| `dsh-scope` / `dsh-session-projection` / `dsh-browser-use` / `dsh-credentials` / `dsh-sandbox` / `dsh-sandbox-policy` / `dsh-subprocess` / `dsh-sdk-protocol` / `dsh-sdk-client` / `dsh-util-values` / `dsh-home-paths` / `dsh-timeout` / `dsh-mcp-client` | **`.d.ts` 逐字节相同** | `diff -rq` 只报 `package.json` / README | 否 |

#### 1.1 bundle 的 patch 层（第三个面）

`packages/bundle/headless/cordis.patch.yml` **逐字节相同**。`packages/bundle/base/cordis.patch.yml` 的 diff：

```diff
-    - id: settings
-      name: '@deepseek-ai/dsh-settings-file'
+    - id: config-editor
+      name: '@deepseek-ai/dsh-config-editor'
+      disabled: !!js "!ctx.get('profileContext')"
+
+    - id: settings
+      name: '@deepseek-ai/dsh-settings'
+      disabled: !!js "!ctx.get('profileContext')"
 …
+    - id: authorization
+      name: '@deepseek-ai/dsh-authorization'
+
+    - id: deepseek-account
+      name: '@deepseek-ai/dsh-deepseek-account-platform'
+      config:
+        desktopPlatform: !!js "ctx.get('profileContext')?.name === 'desktop' && …"
 …
     - id: spill-policy
       config:
-        maxInlineBytes: 50000
+        maxInlineTokens: 12500
```

三行按 docs/42 红线 7 处理（§5）：`config-editor` 把表单保存**写回 profile 的这份 patch 文件**并立即生效；
`settings` 写回走它，另外会把 `$DSH_HOME/settings.yaml` 导入一次并改名；`deepseek-account` **没有 `disabled`
表达式、任何组合默认就挂**，是 DeepSeek 账号的浏览器登录 / 资料 / 余额查询，出网。
`authorization` 不关（授权服务本身，我们早就直接 import）。`spill-policy` 改单位不碰我们（没挂）。

#### 1.2 release notes 的条目逐条判（只列有可能碰到的；纯 web 客户端的界面条目略）

| 条目 | 碰到我们吗 | 出处 |
|---|---|---|
| **Agent 预设改由插件组合包声明和安装……旧目录预设需迁移** | **碰到**，§3 ① | registry README |
| **工具结果升一等 tool 消息 / Session 日志 V4** | **碰到**（消息形状），§3 ②；V4 迁移不碰（内存 Session） | `dsh-llm` / `dsh-session` `.d.ts` |
| **`SandboxProvider.confine` 与 `ShellExecutor.start` 改为可取消的异步接口** | 实现不碰、测试替身跟改 | `dsh-shell` `.d.ts` |
| 长时间命令超时后可转后台（`promoteOnTimeout`） | 否（与 `enableRunInBackground: false` 取与），仍显式写 false | `tool-bash` 源码第 236 行 |
| **默认不再限制任务完成后连续唤醒 Agent 的次数**（`tool-jobs` 的 `maxConsecutiveWakes` 去掉默认 3） | 否。不挂 `dsh-jobs` / `tool-jobs`，模块图 0 命中 | ④bis 扫描那一行 |
| 设置改由 Profile 插件配置保存；旧 settings.yaml 仅导入一次 | 否（不挂），但 profile 层关死，§5 | `settings/settings/README.md` |
| 插件安装和启动检查与当前 DSH 版本的兼容性；不兼容时可对确切版本授予例外 | **可能**：BrowserSkill 插件的 peer 写的是 `^0.1.0-rc.6`。我们是 `agentCtx.plugin()` 直接挂，不经 Plugin Manager 的安装 / 启动检查——`browserskill-seam.test.ts` 49 条不改全过就是证据 | release notes；browserskill-seam |
| 修复启用 Playwright 浏览器插件后，新会话、子代理及其他 Agent 创建失败 | 否（白得）。`browser-seam.test.ts` 23 条不改全过 | — |
| 修复多个带检查工具的 Agent 预设共存时重复注册导致加载失败 | 否。我们一棵树一个 preset | — |
| 可选插件启动失败时其余可用插件仍可运行 | 否 | — |
| 配置热更新取消事务回滚 | 否。`patchReload: startup` | — |
| 官方 DeepSeek 适配器只用 Messages API，移除 `protocol` | 否。不经 `dsh-llm-deepseek`（telemetry.test 钉着模块图） | — |
| 默认不再启用 Ralph / 移除 E2B / PTC 改名 / workflow-ptc | 否。都不挂 | — |
| MCP 升级到官方 SDK v2（协议协商、工具分页） | 否（0.1.6 已经是 v2，WP70 记过）。`preset-seam` 17 条不改全过 | — |
| 工具返回按统一 token 预算保留首尾；`spill-policy` 的 `maxInlineBytes` → `maxInlineTokens` | 否。不挂 `spill-policy` | base patch diff |
| 新增实验性语音转写插件（首次使用下载识别模型） | 否，但它拖进来一个原生库，§2 | — |
| 新增 `--dump-config-schema` | 否（可借，见报告"官方化"一节） | — |
| 插件组合包支持按顺序加载多个 patch 文件 | 否（可借） | — |
| DeepSeek 账号登录 / 反馈入口 / Agent Team / Auto review / Computer Use / 侧边栏一大摞 | 否（web 客户端或我们不挂的插件）；账号那一行 profile 层关死，§5 | — |

### 2. 原生依赖：又来一个"下载型"的

依赖树 diff（`awk` 取 lockfile 的 `packages:` 段，去版本号后 `comm`）：

| | 包 |
|---|---|
| **新增 22 个 dsh 包** | `dsh-agent-preset`、`dsh-agent-preset-registry`、`dsh-api-account-controller`、`dsh-api-job-controller`、`dsh-client-store`、`dsh-client-ui-primitives`、`dsh-client-ui-settings-{account,agent-loop,shell,subagent,web-search}`、`dsh-config-editor`、`dsh-deepseek-account`、`dsh-deepseek-account-platform`、`dsh-experimental-{api-speech-to-text,client-ui-voice-input,speech-to-text,speech-to-text-sensevoice,voice-input-bundle}`、`dsh-session-format-v3-to-v4`、`dsh-skill-office`、`dsh-tool-workspace-dependencies` |
| **新增第三方** | `sherpa-onnx-node`（Apache-2.0）+ 六个 `sherpa-onnx-<平台>` 平台包；`@eslint-community/regexpp`（MIT，`dsh-app-boot` 的新依赖） |
| **消失 4 个** | `dsh-agent-presets`、`dsh-client-ui-settings-unarchive-sessions`、`dsh-experimental-agent-team-web-profile`、`dsh-settings-file` |
| 兄弟包升版 | `cordis` 4.0.4、`schemastery` 3.18.4、`cordis-plugin-{loader 1.0.5, include 1.0.9, group 1.0.4, timer 1.1.6}`、`cosmokit` 1.8.5、`libreoffice-kit` 0.0.1 → 0.1.0 |

- **`allowBuilds` 一个字没改**：新进树的第三方都没有 `install` / `preinstall` / `postinstall`。
- **`ignoredOptionalDependencies` 加三条**：`sherpa-onnx-node` 用 optionalDependencies 挂着六个平台包，
  里面是 onnxruntime 与 sherpa-onnx 的原生 `.node` / `.dylib`，本机 `darwin-arm64` 实测 **33 MB**
  （`du -sh node_modules/.pnpm/sherpa-onnx-darwin-arm64@1.13.8`），同样没有 install 脚本、`allowBuilds` 管不着。
  它来自官方 web 客户端的实验性语音转写（`dsh` 元包 → `voice-input-bundle` → `speech-to-text-sensevoice`），
  这个 bundle 只有被 profile 列进 `bundles` 或经 Plugin Manager 打开才会挂，我们两样都没有。
  写成 `sherpa-onnx-darwin-*` / `-linux-*` / `-win-*` 三条，不写 `sherpa-onnx-*`（字面上会盖住本体，读的人会误会）。
  装完 `grep sherpa-onnx-darwin pnpm-lock.yaml` 只剩 `ignoredOptionalDependencies` 那三行，本体 104 KB 留着。
- `libreoffice-kit` 升到 0.1.0，五个平台包**仍被**上次那条 `'@deepseek-ai/libreoffice-kit-*'` 挡着（lockfile 里 0 处）；
  release notes 那句「Office 任务默认使用随应用安装的 LibreOffice 运行环境」说的是官方桌面端自带，不是变硬依赖。
- **`minimumReleaseAgeExclude` 253 → 271，整批替换**：+22 新包、-4 消失包，全部单版本写法；
  pnpm 自己追加的 23 条挪回排序位置，其中 `@deepseek-ai/libreoffice-kit@0.1.0` 单列一段注释（它不带 `dsh` 前缀）。
  脚本核对：lockfile 里 `@deepseek-ai/dsh*@0.1.7-rc.1` 271 个 = 排除表 271 条，逐条相等。
- **`overrides` 这次没炸**：BrowserSkill 插件那四条钉的版本跟着改成 0.1.7-rc.1，
  没有新的 `dsh-client-ui-*` peer 第一次进树（`dsh-client-ui-attachment` / `-tool` 仍然不在）。

### 3. 我们改了什么

改动全在 `packages/dsh-adapter` 与 `profiles/agentsws`（红线 4）：

① **preset 走 registry**（`harness.ts` / `preset.ts`）：
`root.plugin(AgentPresetRegistry, { default: id })` 取代 `AgentPresets({ roots, includeShippedRoot: false, includeUserRoot: false })`；
新增 `presetDefinition(req)`——与 `agent.cordis.yml` **同源**（都是 `presetComposition(req).rows`），`!!js` 标量换成 loader 的
`{ __jsExpr }`；注入就绪后 `ctx.agentPresets.register(definition)`，再 `resolve(id)` 一次把 broken 当场翻成错误。
**`withPresetCredentials` 从 `mount()` 挪到 `register()`**——0.1.7 注册即激活，mcp-client 的子进程 / 连接在注册那一刻起，
凭据引用必须在那一跳能解析；`mount()` 现在只绑定。三个文件照旧幂等地写（`host.cordis.yml` 是跨进程那一面的描述）。
结果：`includeShippedRoot` / `includeUserRoot` 两个开关没了，但**结构上更严**——registry 不扫目录，
我们的树里又没有任何 bundle 行，roster 里只有我们注册的那一条。

② **消息翻译**（`llm.ts` / `harness.ts`）：`toChatMessages` 认 `role: 'tool'`（取 `toolCallId` 与块文本，
与 0.1.6 从 `tool-result` 块里取出来的逐字段相同）；`developer` 消息有文字才按 system 送（我们的工具集一次运行定死，
这类消息不该出现）；一次性调用的 `toDshMessages` 里 user / tool 走 `RequestUserInput`（不进会话日志，正合适），
assistant 的 `source` 如实标 `{ kind: 'model', provider: 'agentsws-gateway', model }`。

③ **两个测试替身跟上游形状改**：`llm.test.ts` 的工具结果替身改成 `role: 'tool'`；
`shell-seam.test.ts` 那条绕开门禁直调执行器的改成 `execute(spec)` → `result()`。**断言一条没动。**

④ **profile 层关三行 + bash 一个开关**：见 §5。

⑤ 版本号：38 + 10 + 1 处 `0.1.6-alpha.2` → `0.1.7-rc.1`，`dsh-agent-presets` → `dsh-agent-preset-registry`
（dsh-adapter 与 profile 两处）；cordis 家族与 schemastery 见 §0。

### 4. 怎么证明行为没变

1. **seam 契约**（`seams.test.ts`）：**30 条，一条没改、全绿。**
2. **五组重点实证**，除 §3 ③ 那两个替身外一条不改全过：`browser-seam` 23、`browserskill-seam` 49、
   `preset-seam` 17（**registry 换了，17 条一条没改**——包括"凭据解析出来的值到得了 MCP 子进程、挂完从 `process.env` 消失"、
   "两条职责各挂各的看不见对方"、"preset 的工具受 `restrict` 管"）、`shell-seam` 19、`subscription` 13。
   `@agentsws/dsh-adapter` 升级前 **16 文件 877 条**，升级后 **16 文件 1020 条**：
   多的 143 条全在 `upgrade.test.ts`（666 → 809：场景 51 → 62，是 WP94–WP131 加的场景，不是这次加的；
   另有 1 条新断言"两份 `skipped` 一致"）。
   `packages/kernel`、`packages/credentials-openconnector`、`packages/roles`（cordis / schemastery 升版的下游）全过。
3. **指纹逐条对比**（FROM = 升级前在当前代码树重采的 `0.1.6-alpha.2-wp132.json`，TO = `0.1.7-rc.1.json`）：
   62 条场景 × 2 档 = **124 条**，事件类型序列 / `type@at` / 六条不变量 / 场景断言 / 运行摘要 **全部相同**，
   `tokens_per_item` **偏差 0.00%**，两档之间仍逐条相等。去掉 `dsh_version` 与 `packages` 两个字段后两份 JSON **逐字节相同**。
   `packs/*/baseline.json` **一个数都没重定**。
   两个模拟包 `--runtime dsh` fast 档：3 人 pack **62/62**、15 人 pack **22/22**，门禁"通过"；
   逐场景比 `metrics`，升级前后 **0 处差异**（数字见报告 WP132 §4）。
   - 一段插曲要说清楚：开工时（main = cea0afeb）`kol/public-library-reveal-charges-credits` 在 **stub 档就抛**
     `insufficient_credits`（45921fd4 取消插件贡献奖励之后，这道题依赖的那 1 积分没了），采集器整份中断。
     第一轮于是给 `capture.mjs` 加了 `CAPTURE_SKIP`，前后两次都跳这一条（61 × 2 = 122 条，同样逐字节相同）。
     收尾 `git merge main` 时 main 已经有 110f8ba3 修好了它，于是**在 main 的树（升级前的代码）上重采了 FROM、
     在合并后的分支上重采了 TO，两份都是完整的 62 条、不跳任何场景**——仓库里提交的是这两份。
     `CAPTURE_SKIP` 与 `upgrade.test.ts` 那条"两份 `skipped` 一致"的断言留着，给下次同样的情况用（docs/42 ① 写了纪律）。
4. **提示词**：新旧两版各在一棵只挂 `SystemPrompt` 的树上 `assemble()` + `renderPrompt()`，三种组合
   （裸默认 / `includeHarnessIdentity: false` / 加我们的 `complete: true` 段）的段名、长度、渲染结果、`variables` 键集合
   **逐字节相同**，也与 WP70 / WP93 记的那张表一致。没有提示词 diff 要列。
5. **两档的真实模块图**（ESM resolve 钩子，同 `telemetry.test.ts` 手法）：47 → 50 个包。
   新进：`dsh-agent-preset-registry`、`cordis-plugin-group`、`dsh-app-boot`、`dsh-launch-environment`（后两个是 registry 的库依赖，
   只 import 不启动）；消失：`dsh-agent-presets`。`dsh-plugin-manager` / `dsh-hmr` / `dsh-config-editor` /
   `dsh-deepseek-account-platform` / `dsh-session-log-deepseek` / 语音那一摞 / `dsh-product-telemetry-otel`（新包，未进任何 bundle）**全部 0 命中**。

### 5. 安全：把配置写回与账号登录在 patch 层关死

形状与 WP70 的 `session-log-deepseek`、WP93 的 `plugin-manager` 一样：**上游 bundle 往我们这一层塞了默认会开的行**。
`profiles/agentsws/cordis.patch.yml` 加三行（理由逐条写在文件里那一段）：

```yaml
- id: config-editor
  disabled: true
- id: settings
  disabled: true
- id: deepseek-account
  disabled: true
```

`config-editor` 这条值得单说：它的 Summary 是「Save plugin configuration in the active profile's patch and apply it
immediately」——**它写的就是这份文件**。开着它，任何一次表单保存都可能把上面 `session-log-deepseek: enabled: false`
或 `plugin-manager: disabled: true` 改回去，前两次升级的锁定就形同虚设。

钉住它们：`test/profile-lockdown.test.ts` 的禁用名单加 `dsh-config-editor` / `dsh-deepseek-account-platform`（两档模块图 0 命中），
patch 必须 `disabled: true` 的行从 3 行加到 6 行。`session-log-deepseek` 仍是 `.default(true)`（上游 `src/index.ts` 第 45 行），
我们那行 `enabled: false` 必须留，`telemetry.test.ts` 3 条仍绿。

另外 `harness.ts` 挂官方 `bash` 工具时显式加 `promoteOnTimeout: false`（§1 表里那一行的理由）。

### 6. ④bis 默认值扫描

两份源码（codeload tarball）照 `scan-default-flips.sh` 的 diff + awk 跑：**138 行**，去掉测试文件与 `switch` 的 `default:` 误报后逐条看：

| 行 | 判断 |
|---|---|
| `shell/tool-bash`、`tool-pwsh`：`promoteOnTimeout` **新增 `.default(true)`** | 不出网，但属于"上游能单方面翻的行为默认值"；我们这条路本就不生效，仍显式写 false（§5） |
| `jobs/tool-jobs`：`maxConsecutiveWakes` 的 `.default(3)` **消失**（改成不限） | 无关，不挂 jobs |
| `workflow/tool-workflow`：`enableRunInBackground` 新增 `.default(true)` | 无关，不挂 workflow |
| `boot/plugin-manager`：`fallbackRegistries` 默认 `[npmmirror]`、`githubConnectionTimeoutMs` 等 | 出网类，但 plugin-manager 上次就关死了，模块图 0 命中 |
| `client/ui-plugin-manager`：`registryProbeEnabled` **`.default(true)`**（探测 npm 源） | 出网类，但只在官方 web 客户端；我们不挂任何 `dsh-client-*` |
| `llm/llm-deepseek`：十几个字段加 `.volatile()`，`protocol` 删除 | 无关，不经官方 DeepSeek 适配器 |
| `bash-local` / `pwsh-local` / `subagent` / `web-search-deepseek` / `llm-pi-ai`：只是加 `.volatile()`，默认值本身没变 | 无关 |
| `workspace/spec.ts` 加 `pinnedSessionIds` 等 | 无关 |

**一条出网 / 上报 / 遥测开关都没有从关翻成开。** 但"新包里一个默认打开的出网服务"在这张表里看不见——
`deepseek-account` 没有 `.default(true)`，它是**base patch 里一行不带 `disabled` 的新 insert**。这正是 WP93 补的"第三个面"
抓到的，不是 ④bis 抓到的；两道都要做。

### 7. 重判上次放弃的选项（docs/42 §⑤）

线照旧：≤ 100 行且两档事件序列仍然相等才换。

| # | 上次的判断 | 这次实测 | 还成立吗 |
|---|---|---|---|
| 1 | 官方 SDK 没有 server→client 请求 | `dsh-sdk-jsonrpc-server@0.1.7-rc.1` 的 `lib/index.js` 里 `transport.request(` **0 处**，往回仍只有 `session.event` / `session.status` / `subagent.started` / `subagent.finished` 四个 `notify`；上游 `packages/sdk/protocol/src` 与 0.1.6-alpha.2 **逐字节相同** | **成立**，不换 |
| 2 | headless `--json` 替不了子进程档（单向 stdout 投影） | `bundle/headless/src` 的 diff 只有两处：`json-stream.ts` 跟着消息形状改（从 `content[0]` 取 → 直接取 `message.toolCallId`），`index.ts` 两行注释改包名 | **成立** |
| 3 | `plugin-manager` 不能替 preset 承载 | 这次不用它也换了：registry 就是官方的 preset 承载，**我们已经在用它的 `register()`**（§3 ①）。plugin-manager 仍然关死 | **已部分解决**（官方承载换上了；安装 / 持久化那半仍不借） |
| 4 | `workspace-changes` 形可借体不能用 | README 两句硬伤原样还在：「Host restart therefore has no card」「shell commands outside the snapshot coverage are not recorded」 | **成立** |
| 5 | `session.eventAt()` 弃用（"下次第一个红"） | 仍在、仍标弃用（`dsh-session/lib/types/index.d.ts` 第 181 行），这次**没红** | 仍是悬着的一条，留给下一跳 |

### 8. 留下的东西

1. **`session.eventAt()` 仍在用**（`harness.ts` 的 `summarizeTurn()`）。上游已经三版挂着 `@deprecated`，迟早删；
   替代是 `session.read()` 的异步分页（上游 Agent Note 2026-09-09），改起来是 S。
2. **`capture.mjs` 的 `CAPTURE_SKIP` 留着**（只许跳"升级前 main 上就红、stub 档也红"的场景）；这次最终提交的两份基线没用上它。
3. **`@deepseek-ai/dsh-agent-preset`（声明插件行）没用上**：我们直接 `register()`，因为我们的定义是按 RunRequest
   一次运行生成一次、不是 profile 里的静态行。真接管 dsh 进程那天，profile 的写法见 `cordis.patch.yml` 末尾的注释。
4. **`upstreams.yml` 的 `locked_in` 仍只钉 `@deepseek-ai/dsh` 一个包名**（WP93 记过）。这次 `dsh-agent-presets`
   整包消失也是逐个 `npm view` 才发现的——登记表查不出"某个锁住的兄弟包新版里根本没有"。v2 值得给哨兵加一步：
   对 `locked_in` 文件里每个 `<prefix>*` 依赖查一次 `<包>@<新版>` 在不在。
5. **`contracts/src/run.ts`、`connection-directory.ts` 与 docs/18、docs/55 的注释里还写着 `agent-presets` 目录**。
   契约注释不在本单改（改了要重出 SDK），文档是历史记录；dsh-adapter 自己的 README / AGENT-LAYER / presets/README 已加 WP132 修订注。
