# dsh 官方 Agent 层（WP81 设计记录）

| | |
|---|---|
| 状态 | 已实现，待审 |
| 日期 | 2026-09-16 |
| 依据 | `docs/54-按dsh官方方案对齐-…-v1.md`（**将改号 55**）§2 的 Q2；`docs/17` §2 / §5.1 / §6；`docs/26` §6；`docs/42` ①④ |
| 上游 | `@deepseek-ai/dsh-* 0.1.6-alpha.1`（`packages/core/agent`、`packages/core/agent-loop`、`packages/bundle/headless`） |

## 0. 一句话

`packages/dsh-adapter` 的两档运行时（进程内 / 子进程）**不再自己排模型回合**：
一次 `run()` = `ctx.agents.create` → `agent.followup(createUserMessage(...))` → `agent.whenIdle()` →
把 dsh 的 `session/event` 投影成 17 §2 的 `RunEvent` → `handle.dispose()`。
调哪个工具、调几轮，从此是模型 + 官方 agent-loop 的事。
我们的五个门禁一个不少，仍然是插件。

---

## 1. 挂了哪些包，以及为什么

`harness.ts` 的 `createHarness()` 一次运行起一棵全新的 `new Context()`。**不挂 `dsh-base`、
不起 web server、不读 `DSH_HOME`、不落 dsh 的 JSONL。**

| 包 | 为什么非它不可 |
|---|---|
| `@deepseek-ai/dsh-session` | `Session` 是 Agent 的真源（回合、步、消息、工具调用都记在它上面），`dsh-agent-loop` 的 `inject` 之一。**不挂 `session-persistence-jsonl`** → 纯内存会话，一次运行一棵树，17 §5.1 的无状态因此成立 |
| `@deepseek-ai/dsh-session-projection` | `dsh-agent-loop` 的 `inject` 之一。它自己注册 `inbox` 与 `turn-boundary` 两个投影；没有它 `AgentLoop` 服务起不来 |
| `@deepseek-ai/dsh-agent` | `ctx.agents` 与 `Agent` 句柄（`followup` / `whenIdle` / `cancel` / `agent.ctx`）。官方浏览器、MCP-by-preset、子代理都挂在它的 `agent/created` 上——WP82 的入口 |
| `@deepseek-ai/dsh-agent-loop` | **唯一的官方驱动**：它把自己注册成 `ctx.agents` 的 factory，回合就是它排的。配 `maxParallelToolCalls: 1`（串行）—— 并行工具调用会让两档的事件顺序不可比，而 17 §4 要求"换宿主进程不换语义" |
| `@deepseek-ai/dsh-system-prompt` | 门禁的 `systemPrompt.section({ complete: true })` 与 `.context()` 挂这里（WP30 起就在） |
| `@deepseek-ai/dsh-tools` | `tools/pre-execute` / `post-execute` waterfall、`tools.restrict`、`tools.register`（WP30 起就在） |
| `@deepseek-ai/dsh-user-approval` | `approval/request` answerer waterfall；无 answerer 时官方自己 fail-closed（WP30 起就在） |
| `@deepseek-ai/dsh-llm` | `ctx.llm.registerAdapter` 挂我们的模型网关（`llm.ts`）（WP30 起就在） |

**没挂、且解释清楚为什么不挂的：**

| 没挂 | 理由 |
|---|---|
| `cordis-plugin-timer` | 派工单里列了它，实测**不需要**：`dsh-agent-loop` / `dsh-session` / `dsh-session-projection` 三个包的发行产物里没有一处 `ctx.setTimeout` 或 `inject: ['timer']`（`grep -rn` 过 `lib/*.js`，零命中）。挂一个用不到的插件只会让模块图与"最小挂载"这条纪律对不上 |
| `dsh-agent-default-model` | 官方 headless 用它取默认模型；我们的模型路由来自 `RunRequest.runtime.model`，`agentOptions` 直接给 `{ provider, model }` |
| `installModelSelection`（`dsh-agent` 的导出） | 它的作用是在换模型时往历史里插一句"模型换了"的提示。我们一次运行一个 Agent、模型不会中途换，插进去只会让静态前缀不稳定（17 §6） |
| `dsh-session-persistence-jsonl` / `dsh-session-query*` | 会话不落盘（17 §5.1 / 54 §2.2 第二条）。将来要"回放 dsh 轨迹"再实现官方 `SessionPersistence` 接口写进**我们的**事件库 |
| `dsh-session-log-deepseek` | 见 §7（Q1 的查证结论） |
| `dsh-base` / `dsh-host-webserver` / `dsh-fs*` / `dsh-settings` | 发行版级的东西，跟一次 headless run 无关；31 §3.5「执行器不装第三方代码」 |

依赖版本锁死 `0.1.6-alpha.1`（精确版本，不带 `^`）。三个新增包（`dsh-agent` / `dsh-agent-loop` /
`dsh-session-projection`）在 `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 里**本来就有**
（WP70 把整棵 dsh 传递依赖树逐包写死了），无需新增行。没有给任何原生依赖开构建（16 §3）。

---

## 2. 一次运行的形状

```
run(req, sink, signal)
  ├─ emit run.started
  ├─ 读上下文事实（订单 / 退货窗口 / 线程）——stage 意图靠它补全
  ├─ createHarness()
  │    ├─ new Context() + 上面那 8 个插件
  │    ├─ ctx.llm.registerAdapter([agentsws-gateway], GatewayLlmAdapter)
  │    └─ ctx.agents.create({ sessionId, meta:{cwd}, agentOptions, setup })
  │         └─ setup(agentCtx, agent) → installGate(hostCtx, { agent, agentCtx })
  │              ├─ ctx.tools.register(...)            ← 工具面（47 J3 三组顺序）
  │              ├─ agentCtx.tools.restrict({ allow }) ← **必须在 Agent 的 scoped ctx 上**
  │              ├─ ctx.on('tools/pre-execute' | 'tools/post-execute' | 'approval/request')
  │              ├─ ctx.systemPrompt.section({ complete: true })   ← persona + 登记表
  │              └─ ctx.systemPrompt.context(...) × N + emit context.injected × N
  ├─ emit prompt.assembled（哈希按 assemblePrompt(req) 算 —— 回放重组的那一份）
  ├─ ctx.on('session/event', project)          ← 事件投影，见 §3
  ├─ agent.followup(createUserMessage(TASK_MESSAGE)); await agent.whenIdle()
  ├─ gate.askBoundaries()                      ← 36 §2.2 的选择题卡
  ├─ emit run.completed
  └─ handle.dispose() + root.fiber.dispose()   ← 17 §5.1：结束即销毁
```

`TASK_MESSAGE` 是一个**常量**（`runtime.ts` 导出）：事项的材料全在 `systemPrompt.context` 的分节里，
这一条只说"干什么"。常量 = 静态前缀字节稳定（17 §6 / 22 §2 的缓存纪律）。

---

## 3. 事件映射表（17 §2）

`ctx.on('session/event', …)` 按 session id 过滤，只投影属于这次运行的那些。

| dsh `session/event` | → `RunEvent` | 说明 |
|---|---|---|
| `turn/start` | `turn.started{turn}` | **新增契约**（`contracts/src/run.ts`）。一次 `run()` 可能多回合，17 §2 以前只有"一次运行"一个粒度 |
| `turn/end` | `turn.ended{turn, reason}` | **新增契约**。`reason` 是底座报的（`completed` / `aborted` / `error`） |
| `step/start` / `step/end` | —— | 步边界由 `progress{step:'model_request'}` 体现（每步一条），不重复投 |
| `assistant/message` | `text.delta{text}` | 只投有文本的那些。回合由模型驱动之后，它通常落在**最后一步**（模型先调工具、最后才说话）——这与 WP70 之前"先说一句再按规则调工具"正好相反 |
| `assistant/attempt` | —— | 失败 / 重试 / 取消的尝试，没进模型可见历史；失败那条由 `run.failed` 承担 |
| `tool/call` | `tool.call{call_id, tool, input}` | `arguments` 是模型产的原始 JSON 串，投影时解析；解析不了就原样放进 `input` |
| `tool/result` | —— | **不从这里投**。门禁的 `tools/post-execute` 才知道这次调用的判定（ok / error / blocked）与 provenance，它发的那一条才是 17 §2 要的；pre-execute 拒掉的调用也在那里补齐 |
| `user/message`（`source.kind === 'user'`） | —— | 就是我们自己投进去的 `TASK_MESSAGE` |
| `user/message`（其它 source） | `progress{step:'model_context', note:<source.kind>}` | dsh 自己往模型面前放的段（审批口径、运行时上下文快照）。**Model-visible ⟺ logged**：它是模型看得见的一段，所以必须有事件可查 |
| `system/message` / `request/header` / `request/context` | —— | 真正送模型的那一份由 `progress{step:'model_request'}` 记（见下） |
| `session/end-seed` | —— | 构造种子边界，与一次运行无关 |

**不经 `session/event`、由我们自己发的：**

| RunEvent | 从哪来 |
|---|---|
| `run.started` / `run.completed` / `run.failed` / `run.cancelled` | `runtime.ts` |
| `context.injected` | 门禁注册 `systemPrompt.context` 的同一跳（注册 ⟺ 事件） |
| `prompt.assembled` | `runtime.ts`，哈希按 `assemblePrompt(req)` 算 —— 17 §6.1 回放重组的那一份 |
| `progress{step:'grounding'}` | grounding 规则命中了哪几条（**只记，不再代替模型决定调什么**） |
| `progress{step:'model_request', note}` | `GatewayLlmAdapter.onRequest`：这一步模型看见了几段、哪些工具。**Model-visible ⟺ logged** 的第二半 |
| `progress{step:'channel_guard_rewrite'}` | 出站硬闸把草稿打回重写（WP55，未变） |
| `tool.result` | 门禁 `tools/post-execute`（含 pre-execute 拒掉时的补齐） |
| `change.staged` / `proposal.created` | 门禁的审批 answerer 拿到结果的那一跳 |
| `budget.warning` / `budget.exhausted` | 门禁（工具调用数）与 LlmAdapter（token / 步数） |

**一条实测的事件序列**（`aftersales/return-within-window`，进程内档；省略模拟世界自己发的
`model.usage` / `guardrail.*` / `approval.*` / `knowledge.*`，那些不是运行时产的）：

```
run.started → context.injected ×8 → prompt.assembled → progress(grounding)
→ turn.started → progress(model_context) → progress(model_request)
→ tool.call(get_order) → tool.result
→ progress(model_request) → tool.call(search_policies) → tool.result
→ progress(model_request) → tool.call(stage_refund) → change.staged → tool.result
→ progress(model_request) → tool.call(draft_reply) → proposal.created → tool.result
→ progress(model_request) → text.delta → turn.ended → run.completed
```

对照 WP70（自排回合）的同一条：`… prompt.assembled → text.delta → tool.call ×4 …`。
**摘要那句人话一个字都没变**（升级指纹里 `summaries` 逐条相同）。

---

## 4. 五个门禁在新形状下怎么落地

| 门禁 | 位置 | WP81 的变化 |
|---|---|---|
| `tools/pre-execute` | `gate.ts`，装在宿主 ctx 上（scope-filtered dispatch 按 `exec.agent` 路由） | 多了三道：**工具调用预算**（超了拒 + 停 Agent）、**15 §6 先读后写**（`stage_refund` 的 `order_id` 没在 provenance 里就拒）、原有的 allowlist / 边界 / 副作用分类不变 |
| `tools/post-execute` | 同上 | 不变：围栏 + provenance + 发 `tool.result`。多记一条"这是读工具"用于摘要 |
| `approval/request` answerer | 同上 | 不变（无 answerer → `unavailable` → 工具 fail-closed）。多担一件：批下来之后**登记产物**（`change.staged` / `proposal.created` 与 `RunResult.outputs`）——以前这件事在 `runtime.ts` 自排回合时做 |
| `tools.restrict({ allow })` | **`agentCtx`（Agent 的 scoped ctx）** | 以前是 `createScope(ctx, 占位对象).ctx`，现在是官方 Agent 自己的 scope。全局 ctx 上调仍然抛（seam 测试钉着） |
| `systemPrompt.section({ complete: true })` | 宿主 ctx | 不变，但**这一份现在真的送模型**（54 §2.2 第三条）：dsh 的 `systemPrompt.assemble()` 就是 agent-loop 每一步的系统提示词 |

### 回归证据（用例名）

| 门禁 | 用例 |
|---|---|
| pre-execute（allowlist） | `seams.test.ts` → `门禁：不在 allowlist 的工具 → tool.result{blocked}，不到达工具（17 §6.3）` |
| pre-execute（副作用分类） | `seams.test.ts` → `门禁：executor 策略下写外部工具一律拒（16 §3）` / `门禁：personal 策略下同一个写工具放行到出口` |
| pre-execute（预算） | `runtime.test.ts` → `max_tool_calls 用尽 → budget.exhausted 并补齐未闭合的调用（17 §6.4）`（两档各一遍） |
| pre-execute（边界） | `fixture.test.ts` → `不自作主张：一条变更都不提，另外发一张 policy_change 选择题卡`（两档各一遍） |
| post-execute（围栏 + provenance） | `seams.test.ts` → `门禁：成功结果过 EXTERNAL_FENCE，实体 id 进 provenance 并发 tool.result` |
| approval answerer（fail-closed） | `seams.test.ts` → `没有 answerer → unavailable（fail-closed），我们据此拒绝调用` / `我们的 answerer：stage 出口返回 undefined → rejected → 工具 fail-closed` / `我们的 answerer：没有注入 createDraft → unavailable → 工具 fail-closed` |
| `tools.restrict` | `seams.test.ts` → `非 scoped context 上 restrict 直接抛（这是 dsh 的硬要求）` / `scoped restrict 默认拒绝：scope 里看不到、也调不到被排除的工具` / `门禁：restrict 按 RunRequest.tools.allow 装（含我们自己的 staging 工具）` |
| `systemPrompt` 遮蔽 | `seams.test.ts` → `complete 段是唯一有效段：persona 遮蔽 dsh 自带的 identity / persona 前后缀` / `每个 ContextItem 一段，顺序与 RunRequest.context 一致，且都发了 context.injected` |
| `ctx.llm.registerAdapter` | `telemetry.test.ts` 三条（模块图里没有官方 provider，模型只能走我们的适配器）+ 所有 `runtime.test.ts` / `fixture.test.ts` 用例（模型输出全部经网关） |

`test/seams.test.ts` 的 30 条**一条没删**，另在两处把断言改成了新事实（不是删，是记下差异）：
`contextSections()` 现在还会返回 dsh 自己的 `approval:policy` 段（Agent 层在场才有），
`browser-seam.test.ts` 的 (c) 从"我们没有 `agents`"改成"只差 `browserUse` 了"。

---

## 5. 模拟 parity 与指标变动

### 5.1 parity 的新定义（54 §2.2 第一条）

| 比什么 | 在谁之间比 | 在哪 |
|---|---|---|
| **结果一致**：六条不变量 + 场景 `expectations` + 卡片 / `staged_changes` / 对外发件逐条相等 | 四个运行时之间（stub / direct / dsh 两档） | `simulation/test/runtime-parity.test.ts` → `WP81 B：四个运行时**结果一致**（不再比事件序列）` |
| **事件序列逐条相等** | 只在 dsh 两档之间 | 同文件 → `WP30 A：dsh 两档（进程内 / 子进程）逐条一致` |

为什么必须改：回合由 dsh 排之后，调几次工具、分几轮调是模型 + 底座的事，
stub / direct 两条自排回合的路不可能自然产生同一条事件序列。**结果**才是契约要的东西。

### 5.2 模拟档的模型替身也跟着换

`packages/simulation/src/world.ts`：dsh 两档与 `direct` 一样换成 `aftersalesBrainProvider`
（`@agentsws/runtime-direct` 的售后"规则脑"）。理由写在代码注释里：22 的 `stubProvider`
**只出文本、不出 `tool_calls`**——agent-loop 一轮就 idle，一个工具都不会跑。
换成规则脑之后 direct 与 dsh 对着**同一个"模型"**跑，parity 比的才是运行时本身。
`stub` 运行时不受影响（它自己就是规则脑，不打模型）。

### 5.3 四运行时 × 两个 pack

```
for rt in stub direct dsh-in-process dsh-subprocess; do
  for pk in dtc-3c-3p dtc-15p; do
    pnpm -s simulate --tier fast --pack packs/$pk --scenario 'scenarios/**/*.yml' --runtime $rt --seed 42
  done
done
```

八种组合**退出码全 0**：`dtc-3c-3p` 30/30、`dtc-15p` 16/16。

### 5.4 每个变动的指标及解释（docs/42 红线）

`packs/*/baseline.json` 里 **`stub` 与 `direct` 两档一个数都没动**。变的全在 `dsh` 档：

| 指标 | 变化 | 为什么 |
|---|---|---|
| `tokens_per_item` | ×4.6 – ×6.4（如 `ops/escalation-chain` 1530 → 9440） | WP70 是"一次补全 + 按规则调工具"，**只打一次模型**；现在是 agent-loop 排回合，一次运行 4–5 步，**每一步都把当时的完整历史（系统提示词 + 工具结果）重发一遍**。同一条场景在 `direct` 档上是 7659——dsh 比它再高一档，多出来的是 dsh 自己那段运行时上下文（审批口径快照）与每一步重发的登记表 |
| `cost_base` | 同比例上涨 | 价目表没动，涨的是 token |
| `tool_calls` | 只有 `digital-vertical/account-issue` 1 → 2 | WP70 的规则是"grounding 没命中就只 `get_order`"；现在是模型自己决定——虚拟产品那条它先查单、再查政策，两次。`direct` 档上本来就是 2，**这一条是往 direct 对齐，不是劣化** |
| `chat/faq-answer-and-money-handoff` 的 `cost_base` | 5.9e-05 → 4.3e-05（**降**） | 这条场景走的是秘书/对话那条路，运行时只跑一次很短的运行；换成规则脑 provider 之后输出比 `stubProvider` 的随机词表短 |
| `kol/*` 三条 | 从"没有 dsh 基线"变成"有" | 它们以前在 dsh 档没跑出数（旧基线里没有这三条目），这次矩阵全跑，基线补齐。三条的 `tokens_per_item` 都是 0（不打模型的编排型场景） |

**没有变的**（这几样正是"结果一致"的证据）：`adoption_rate`、`intervention_rate`、
`guardrail_hits`、`queue_latency_ms`、`staged_changes`、`applied_changes`、`outbound_sent`、
`blocked_proposals`、`runs_failed`、`knowledge_gaps`、`escalations`、`expired_approvals`、
`sampling_reviews`、`judge_rule_score`——**每一条场景的每一个业务指标一个数都没动**。

---

## 6. 升级基线（`test/upgrade-baseline/`）

本棒改的是**我们自己的回合逻辑**，不是 dsh 的版本，指纹必然全变——拿 `0.1.5-rc.1-wp70.json`
当 FROM 比出来的全是本棒的改动，一条也说明不了上游。做法：

- 在当前代码树上重采一份 `0.1.6-alpha.1-wp81.json`；
- `upgrade.test.ts` 的 `FROM_FILE` / `TO_FILE` 都指向它（**自比**），比对退化成
  "采集器是确定的、两档仍然逐条相等"两条；
- 旧的三份（`0.1.3-alpha.2` / `0.1.5-rc.1` / `0.1.5-rc.1-wp70` / `0.1.6-alpha.1`）**一个不删**——
  它们是历史刻度；
- 下一次 dsh 升级时，`FROM_FILE` 改成 `0.1.6-alpha.1-wp81`、`TO_FILE` 改成新版本，
  docs/42 的流程一步不变。

采集器加记了三个新包的版本（`dsh-agent` / `dsh-agent-loop` / `dsh-session-projection`）。

---

## 7. Q1（会话日志上报）的查证结论

**结论：`@deepseek-ai/dsh-session-log-deepseek` 的"请求字段"只对官方 `dsh-llm-deepseek`
适配器生效；我们用自己的 `LlmAdapter`，上传通路根本不存在。**

证据链（上游 0.1.6-alpha.1 源码）：

1. `packages/session/session-log-deepseek/src/index.ts` 的 `inject = ['deepseekLlmApiExtensions', 'sessions']`，
   `apply()` 里唯一的动作是 `ctx.deepseekLlmApiExtensions.register('dsh_session_log', …)`。
2. `deepseekLlmApiExtensions` 这个服务**只由** `@deepseek-ai/dsh-deepseek-llm-api-extensions` 提供。
3. 全仓（除它自己与测试外）读这个服务的地方**只有一处**：
   `packages/llm/llm-deepseek/src/index.ts:123`，在 `new DeepSeekAdapter({ …, prepareExtensions })` 里，
   也就是**官方 DeepSeek 适配器自己发请求的那一跳**。
4. 我们的 `GatewayLlmAdapter extends LlmAdapter`（`src/llm.ts`）自己拼请求、自己调
   `ModelGateway.complete`，从头到尾没有碰过 `ctx.deepseekLlmApiExtensions`。

所以：

- **不做** RunRequest 级的 `share_session_log` 开关——那会是一个没有效果的开关，
  比没有开关更糟（用户以为关上了什么）；
- `profiles/agentsws/cordis.patch.yml` 的 `enabled: false` 与
  `test/telemetry.test.ts` 三条**原样保留**：它们守的是"哪天真的起了完整 profile 也不上报"，
  与本结论不冲突，是同一件事的另一道保险；
- 将来如果要接官方 `llm-deepseek`（个人端直连 DeepSeek 官方端点），这个开关才有意义，
  到那时再按 54 §1 Q1 的两档默认值做。

---

## 8. 给 WP82（浏览器 provider）的接口

WP70 的 spike 结论是"我们的组合里没有 `agents`，官方 Playwright provider 挂不进来"。
**这一条已经不成立了。** 现在的差量只剩一个 `browserUse` 服务。

### 8.1 怎么挂

provider 的 `inject` 是 `['browserUse', 'agents', 'tools', 'systemPrompt']`，
它把自己整个挂在 `ctx.on('agent/created')` 上、按 `Agent` 分配资源。两条路：

1. **全局挂**（推荐，与官方一致）：在 `createHarness()` 的插件列表里加
   `root.plugin(BrowserUseRegistry)` 与 provider 插件；provider 自己会在
   `agent/created` 时为这个 Agent 建一个 MCP 客户端，`handle.dispose()` 时跟着走。
2. **按职责挂**：在 `ctx.agents.create({ setup })` 的 `setup(agentCtx, agent)` 里
   `agentCtx.plugin(...)`——只有这个 Agent 看得见。职责模板要不要浏览器（`browser_scope`）
   就在这一跳判。`setup` 是**只装配**的：不要在里面 `await agent.whenIdle()`，
   也不要驱动 Agent（官方 `dsh-agent` README 的 Known Limitations 明写）。

`harness.ts` 里已经预留的位置：`createHarness()` 的插件段（全局）与 `setup` 回调（按 Agent）。

### 8.2 工具名前缀

上游 `packages/experimental/browser-use-runtime/src/mcp.ts` 的规则是
`const toolPrefix = \`mcp__${options.name}__\``，提示词段名是 `mcp:<name>`。
Playwright provider 的 `name` 是 `playwright-mcp`，所以工具名长这样：

```
mcp__playwright-mcp__browser_navigate
mcp__playwright-mcp__browser_click
```

段名 `mcp:playwright-mcp` —— WP70 已实测被我们的
`systemPrompt.section({ complete: true })` **遮蔽掉**（`browser-seam.test.ts` 里那两条）。

### 8.3 `tools/pre-execute` 里能看到什么

hook 的入参是 `exec`，字段：

| 字段 | 内容 |
|---|---|
| `exec.name` | 全名，**带前缀**（`mcp__playwright-mcp__browser_navigate`） |
| `exec.arguments` | 已按工具 schema 解析好的对象（`browser_navigate` 的 `url` 就在这里） |
| `exec.callId` | 与 `tool/call` / `tool.result` 一一对应 |
| `exec.agent` | 这次调用属于哪个 Agent（scope 路由键） |

**官方浏览器工具对 hook 不透明**（没有读写标注），所以 54 §3 的两条策略都得按名判，
落点在 `src/tools.ts` 的 `classifySideEffect()`：

- 现在的兜底是 `write_external`（16 §3 最严），所以**什么都不做的话，浏览器工具在
  `executor` 策略下一调就拒**——WP82 要做的第一件事是把只读的那几个名字加进
  `READ_PREFIXES` 之外的显式表（和 WP44 给 Shopify Dev MCP 的三个工具同样的做法，
  见 `isMcpReadTool`）。
- 域名白名单只看 `browser_navigate` 的 `url` 入参，越界 `return { kind: 'deny', reason }`
  —— 门禁会自动把它物化成 `tool.result{blocked}` 并进事件日志。

### 8.4 别忘了

- `maxParallelToolCalls: 1` 是我们定的（事件顺序可比）。浏览器工具如果要并行，
  得先想清楚两档的事件序列还相不相等。
- 一次运行一棵树、一个 Agent：attach 模式"一个 Session 独占用户的 Chrome"与
  17 §5.1 天然一致，收尾只断连不关浏览器。

---

## 9. 浏览器（WP82，55 §3）

§8 写的是"怎么挂"，这一节记**挂上之后长什么样**。

### 9.1 一次带浏览器的运行

```
run(req)  —— req.browser 给了才有这一层
  └─ createHarness
       ├─ root.plugin(BrowserUseRegistry)                 ← 只在 req.browser 在场时挂
       └─ ctx.agents.create({ setup: async (agentCtx, agent) => {
            installGate(ctx, { …, agent, agentCtx })       ← 五个门禁照旧
            await agentCtx.plugin(PlaywrightMcpProvider, browserProviderConfig(req.browser))
          }})
              └─ agent/created（比 setup 晚一步）→ provider 起一个 @playwright/mcp 子进程
                 → 24 个 mcp__playwright-mcp__browser_* 进这个 Agent 的 scope
  …
  └─ handle.dispose() → MCP 子进程与 provider 槽一起走（attach 只断连，不关用户的浏览器）
```

`setup` 里必须 `await` 那一跳：provider 整个挂在 `agent/created` 上，而 `agent/created`
在 setup **之后**才广播（官方 `dsh-agent` 的 `announce`）——晚一步这个 Agent 就拿不到工具。

### 9.2 工具名与读写分类

上游 `@playwright/mcp@0.0.80`，provider 不传 `--caps`，所以默认只有 Core automation
（23 个）+ Tab management（1 个）共 **24 个**。`BROWSER_DEFAULT_TOOLS`（`tools.ts`）是
实测出来的那一份，`browser-seam.test.ts` 用真 provider 逐条比对——上游改了名字当场红。

| 我们的判定 | 工具 |
|---|---|
| `read_external` | `browser_navigate` / `browser_snapshot` / `browser_take_screenshot` / `browser_find` / `browser_console_messages` / `browser_network_requests` / `browser_network_request` / `browser_wait_for` / `browser_resize`，外加 `browser_tabs` 的 `action: list` / `select` |
| `write_external` | `browser_click` / `browser_type` / `browser_fill_form` / `browser_select_option` / `browser_press_key` / `browser_hover` / `browser_drag` / `browser_drop` / `browser_file_upload` / `browser_handle_dialog` / `browser_navigate_back` / `browser_close` / `browser_evaluate` / `browser_run_code_unsafe`，`browser_tabs` 的 `new` / `close`，**以及任何不在表里的名字** |

两处与上游 README 的 `Read-only` 标注**有意不同**，理由写在 `tools.ts` 的注释里：
`browser_navigate` 上游标 false（它换了页面），对我们它是"去外面读一份东西"（55 §3
原话），真正管住它的是域名白名单；`browser_wait_for` / `browser_resize` 上游标 false，
但它们改的是浏览器自己的状态，碰不到外面。

`browser_navigate_back` 我们判**写**，理由是它没有 URL 可查——白名单看不见的导航，
在公司端一律不放行。

### 9.3 四道门的顺序（`gate.ts` 的 `tools/pre-execute`）

```
预算 → allowlist（浏览器整个命名空间在 req.browser 在场时放行）
     → 注 JS 硬拒（executor 档）
     → 域名白名单（只看 browser_navigate.url 与 browser_tabs{action:new}.url）
     → 读写分类（write_external + executor → 拒；personal → 放行并发 progress{step:'browser_write'}）
```

拒绝理由是**人话**（"这个岗位只能打开 youtube.com、*.youtube.com，www.amazon.com 不在
里面"），门禁把它物化成 `tool.result{blocked}` 进事件日志——模型看得见，人也查得到。

### 9.4 两条容易踩的上游语义

1. **别把浏览器工具列进 `ctx.tools.restrict({ allow })`。** 上游："Restrictions
   intersect; scoped registrations remain visible" —— provider 在它自己的 agent scope 里
   注册，本来就不受职责白名单影响；列进去还会抛（restrict 只认调用当刻已全局注册的名字）。
2. **官方自己那段提示词（`mcp:playwright-mcp`）被我们的 `complete` 段遮掉。** 所以
   "能打开哪些站 / 遇到登录页怎么办"必须由 `browserBrief()` 写进 persona 段——
   不写的话模型对这两件事一无所知。

### 9.5 依赖与构建

`@deepseek-ai/dsh-browser-use` 从 devDependency 升为 dependency；新增
`dsh-experimental-browser-use-runtime` 与 `-playwright-mcp`，都锁 `0.1.6-alpha.1`。
它们拖来 `@playwright/mcp@0.0.80` → `playwright` → `playwright-core`，后者的 postinstall
会下载浏览器：`pnpm-workspace.yaml` 的 `allowBuilds` 里写死 `playwright: false` /
`playwright-core: false`。**实测在不开构建的情况下 `pnpm install --frozen-lockfile` 通过、
provider 照常起**——attach 接用户自己的 Chrome，`launch` 一律带 `executable_path`，
两条路都不需要它下载的那份 Chromium（16 §3 一行没破）。

### 9.6 本机实测（手工，2026-09-16）

CI 里那 23 条用的是"真 provider + 死 endpoint"，证明的是装配与策略；**真的连上一个
Chrome、真的打开一个网页**这一段只能手工（步骤见 `scripts/dev-browser.md`）。这次实测：

- Chrome `152.0.7977.83`，`--headless=new` + 单独 `--user-data-dir` + `--remote-debugging-port`；
- provider `mode: 'attach'` 接上去 → `ctx.tools.schemas(agent)` 里 **24 个**
  `mcp__playwright-mcp__*`，与 `BROWSER_DEFAULT_TOOLS` 逐条相同；
- `browser_navigate` → `isError: false`，页面真的跳了（返回里带 Page URL / Title）；
- `browser_snapshot` → 一棵可读的无障碍树；
- `handle.dispose()` 之后浏览器**还开着**（attach 只断连）。

一个副作用值得记：官方 MCP 服务器把截图 / 快照落在 **Agent 的 `cwd` 下的
`.playwright-mcp/`**（`--output-dir` 的默认值，上游薄壳没透出这个参数）。已进 `.gitignore`。

---

## 10. 职责 preset 与凭据（WP86，55 §4）

§9 是"这次运行开不开浏览器"，这一节是"**这条职责有哪些连接**"。两件事共用同一条纪律：
**不用的东西不挂**——没有连接的运行里连 Loader / AgentPresets 都不装。

### 10.1 一次带 preset 的运行

```
run(req)  —— req.connections 非空才有这一层
  ├─ writePreset(req, options.presetRoot)
  │    → <root>/<workspace>/<preset_id>/{agent,host}.cordis.yml + preset.yml
  │    → 内容没变就一个字节不写（见 10.4）
  ├─ emit progress{step:'preset.generated', note:'<id> <digest> written|reused conns=N'}
  └─ createHarness
       ├─ ctx.baseUrl = <dsh-adapter 的 src 目录>      ← 包名从这里解析
       ├─ root.plugin(Loader); loader.builtins.include = Include
       ├─ root.plugin(<options.credentials>)            ← 官方 ctx.credentials 的那一个
       ├─ root.plugin(AgentPresets, { default, roots:[{path, trust:'system'}],
       │                              includeShippedRoot:false, includeUserRoot:false })
       └─ ctx.agents.create({ setup: async (agentCtx, agent) => {
            ① await withPresetCredentials(… ctx.agentPresets.mount(agentCtx, presetId))
            ② installGate(ctx, { …, agent, agentCtx })   ← 它里面调 restrict
            ③ await agentCtx.plugin(PlaywrightMcpProvider, …)  ← WP82，不变
          }})
```

**①②③ 的顺序是硬的**，两条实测：

- preset 挂上来的 `mcp__*` 工具**受** `ctx.tools.restrict({ allow })` 管（与 §9.4 第 1 条
  说的浏览器**正好相反**）。不列进白名单，整组被挡掉。
- `restrict` 只认调用当刻**已经注册**的名字。先 restrict 后 mount 会抛
  `tools.restrict() names unknown global tools`，而且抛完**整张白名单都没装上**——
  比不装还松。所以必须 mount 在前。

白名单的来源是那台服务器**探测出来的**工具清单（`RunConnection.tools`，由连接目录
在保存时探测一次存下来）：清单里没有的那个，即使服务器真的报了，也到不了模型面前。

### 10.2 preset 目录里有什么

| 文件 | 谁读它 | 内容 |
|---|---|---|
| `agent.cordis.yml` | 官方 `mount()` | 一条连接一行 `@deepseek-ai/dsh-mcp-client` |
| `host.cordis.yml` | 跨进程宿主（`dsh --profile agentsws-executor`） | 门禁与模型网关那两行 |
| `preset.yml` | 官方 roster | `name` / `description`，外加一段给排障看的 `agentsws` |

**为什么分两份**：`mount()` 会把组合里每一行真的 import 起来，一行起不来整份 preset 就是
broken。门禁那一行（`@agentsws/dsh-adapter/preset-gate`）是"这份组合在另一个进程里长什么样"
的**描述**，同进程里它是直接 `installGate` 装的，没有可 import 的模块名。
WP81 之前这两份在同一个文件里（那时候没人挂它），`seams.test.ts` 的两条断言因此改了落点
——**不是删用例，是记下差异**。

**浏览器 provider 不在 preset 里**，`preset.yml` 的 `agentsws.browser` 只是记一笔它去哪了：
`browserUse` 是一棵树一个的独占槽、provider 自己挂在 `agent/created` 上（§8.1 / §9.1），
写成 preset 的一行既过不了 mount 那道"不许往 root realm 发服务"的审计，也拿不到只有宿主
知道的 CDP 地址。

### 10.3 凭据：文件里只有名字

生成的行里，请求头与 stdio 子进程的环境变量写成 `!!js process.env.<REF> ?? ''`
（官方 `mcp-client` README 的写法）。链条：

```
ctx.credentials.resolve(credentialRef(REF))
  → （只在 mount 那一跳里）process.env[REF]
  → MCP 子进程的 env / HTTP 请求头
  → finally 里逐个还原
```

三条纪律写在 `harness.ts` 的 `withPresetCredentials` 上：只在这一跳里存在、
不覆盖启动环境已有的同名变量、不发任何事件也不记日志。
**`?? ''` 不能省**：求值成 `undefined` 时上游 config 校验直接拒（`env` 要
`{ [key: string]: string }`），`mount()` 抛，整次运行失败。补上空串之后，没配凭据的后果
退回它该有的样子：那台服务器连不上、它的工具不出现，运行照常。

`options.credentials` 的类型是 `unknown`（一个 cordis 插件）：这一层不该知道它是本机的、
OpenConnector 的，还是两者的组合。实现见 `@agentsws/credentials-openconnector`——
官方这个 seam 是**单 provider**（一棵树上第二个 `CredentialProvider` 当场抛），所以
"分层"只能在一个 provider 内部做。

### 10.4 幂等：为什么"内容没变就不写"是硬要求

上游 `agent-presets` 把"代"（generation）钉在组合文件的 **mtime + size** 上，而
**被顶掉的那一代永远不回收**（上游 Known Limitations 原话：superseded generation is
never reclaimed）。每次运行重写一遍文件 = 每次多挂一棵永不释放的子树，外加把上一代的
MCP 子进程晾在那儿。所以 `writePreset()` 先读再比，一样就**一个字节都不写**，
`PresetPaths.written` 把这件事报上来，事件里记 `written` / `reused`。

同理，`preset_id` = 目录名必须稳定且过得了上游的 `[a-z0-9][a-z0-9-]*`：职责 id 带点
（`dtc.support`），换成短横线；**凡是换过字符的**都挂一段职责 id 的哈希，免得 `a.b`
与 `a_b` 共用一个 preset（那等于把 A 的连接挂给 B）。

### 10.5 读写分类：`read_tools`

MCP 协议**没有**读写标注，名字前缀也不可信（一台服务器叫 `get_everything` 的工具照样
能下单）。所以 `classifySideEffect` 对 `mcp__<server>__<tool>` 只认连接目录里那张
**人勾出来的**只读清单（`McpServerRecord.read_tools` → `RunConnection.read_tools`）：
勾了的 `read_external`，**其余一律 `write_external`**，公司端（`executor`）一调就拒。
不勾 = 这台服务器在公司端一个工具都调不动——有意的最严默认（16 §3）。

### 10.6 回归证据（用例名）

| 事 | 用例 |
|---|---|
| 幂等（两次生成逐字节相同、mtime 没动） | `preset-seam.test.ts` → `(a) …同一条职责两次生成…` |
| 连接变了才变 | 同上 → `连接变了才变：加一台服务器 → 内容变、这次真的写了` |
| 凭据只有名字 | 同上 → `(b) 请求头与环境变量的值一个字节都不在生成的文件里，只有引用名` |
| 按职责隔离 | 同上 → `(c) 两条职责各挂各的：另一条的 Agent 看不到这个 serverName` |
| `read_tools` 判定 + 公司端拒 | 同上 → `(d) …公司端（executor）一调没勾的那个就被门禁拒…` |
| restrict 与探测清单 | 同上 → `(e) 探测清单里没有的那个到不了模型面前` |
| 凭据真的送到子进程、挂完即还原 | 同上 → `(f) 引用解析出来的值到得了 MCP 子进程…` |
| 两档 headless 各跑一遍 | `runtime.test.ts` → `dsh 运行时（%s）：带职责 preset 的运行（WP86）` ×2 |
| provider 边界（单 provider / 跨工作区 / refresh 不出境） | `packages/credentials-openconnector/test/provider.test.ts` 12 条 |
| 职责模板说了算 | `apps/server/test/role-connections.test.ts` 5 条 |
| 只读清单端到端 | `apps/server/test/connection-directory.test.ts` → `WP86（55 §4 第三层）…` |

`test/seams.test.ts` 的 30 条**一条没删**，两条断言改了落点（见 §10.2）。
`browser-seam.test.ts` 23 条一条没动。

---

## 11. 终端与沙箱（WP89，55 §8 Q7）

`site.shopify-theme`（别名 `site.builder`）这条职责能在一个**只写得了主题工作副本目录**的
沙箱里跑 `shopify theme …`。工具面一个字不是我们写的——与 §9 的浏览器同一条纪律：
**官方给面，我们只留策略**。

### 11.1 挂什么，什么时候挂

只在**两道都过**时挂（`harness.ts`；`runShell()`）：
① `RunRequest.shell` 给了；② 职责在 `SHELL_ROLE_IDS` 里。第二道是有意的冗余——
契约说的是"怎么跑"，"谁能跑"不该由请求方说了算。不挂时整层不存在：
没有 `ctx.shell` / `ctx.sandbox`，工具面里一个 `bash` 都没有。

| 包 | 给什么 | 配置 |
|---|---|---|
| `dsh-subprocess-local` | `ctx.subprocess`：真 fork | — |
| `dsh-sandbox-local` | `ctx.sandbox`：按平台选笼子 | — |
| `dsh-sandbox-policy` | `ctx.sandboxPolicy`：档位与可写根 | `{ mode, workspaceRoot }` |
| `AgentswsBashExecutor`（`dsh-bash-sandbox` 的子类） | `ctx.shell`：一条命令 = 一个经沙箱包起来的 `bash -c` | `{ cwd: workspace_root }` |
| `dsh-shell-env` | `ctx.shellEnv`：管理的 `DSH_*` | — |
| `dsh-tool-bash` | 模型面的 `bash` | `{ enableRunInBackground: false }` |

**为什么不写进职责 preset**（实测过，不是猜的）：把这六行写进 `agent.cordis.yml`
再 `mount()`，上游当场拒——

> agent-presets: preset "…" failed to mount: row(s) published process-global service(s)
> [sandbox, sandboxPolicy, shell, shellEnv, subprocess]; a preset service must sit behind
> an `isolate` realm or move to the host composition

与 §9 的浏览器 provider 同一条纪律（`preset.ts` 的 manifest 注释早写过"不许往 root realm
发服务"，只是那次没撞上）。上游给的两条路里选"搬到宿主组合"而不是 `isolate` realm，
还有第二个独立理由：沙箱根是**一次运行一个值**（这家店的副本目录），写进 preset 文件
等于每次运行重写它，而上游把"代"钉在组合文件的 mtime + size 上、被顶掉的那一代
永不回收（§10.1）。

**顺序是硬的**（与 §10.1 preset 同一条实测）：`dsh-tool-bash` 必须在
`ctx.agents.create` **之前**挂完，因为 `installGate` 里的 `tools.restrict({ allow })`
只认调用当刻**已经全局注册**的名字。晚一步 `bash` 就被职责白名单挡在 Agent 的 scope 外。

### 11.2 三件实测到的、与预判不同的事

**① 档位的真源不是 config，是会话的 `cwd`。**
`sandbox-policy` 的 `workspaceRoot` 只是"没有会话时的兜底"；管着 Agent 那次调用的是
`SessionHeader.cwd`（上游原话：normal agent calls use their session cwd instead）。
所以 `agents.create({ meta: { cwd } })` 必须与 `workspaceRoot` 是同一个目录——
少改一处，命令就在别的地方写文件，而且不会报错。

**② `bash` 按工具名判不出读写。**
一个名字底下几十条命令。落到 `classifySideEffect` 的兜底会被整个当成 `write_external`，
公司端连 `shopify theme list` 都跑不了。所以命令 allowlist 那一关**排在读写分类之前**，
判完直接给出分类，不再往下走。

**③ 凭据不能走 `process.env`。**
官方 `dsh-subprocess` 对**继承来的**环境有一道自己的清洗：`/KEY|PASSWORD|SECRET|TOKEN/i`
的名字一律不往子进程传（上游原话：the harness's own `DEEPSEEK_API_KEY`/secrets must not
leak into a spawned process implicitly）。`SHOPIFY_CLI_THEME_TOKEN` 正好撞这条，
所以 §10.3（WP86）那条"放进 `process.env` 再还原"在这里**到不了 CLI 手里**。

上游给的路是"显式 env 在清洗之后合进去"，而显式 env 来自 `ShellExecSpec.env`——
官方 `tool-bash` 有意不把 `env` 开给模型。于是我们继承执行器（`AgentswsBashExecutor`），
在 `resolve()` 里把这一跳要用的几个名字合进去。结果比 preset 那条路**更紧**：

- 令牌**一次都不进这个进程的环境**；
- 它只在"这一条命令"里活着（`tools/pre-execute` 放、`tools/post-execute` 清，`dispose()` 兜底）；
- 事件日志、模型面两处都只看得见名字。

### 11.3 我们这一侧的策略（`src/shell.ts`）

| 策略 | 怎么做 |
|---|---|
| 命令 allowlist | 五个前缀（`shopify` / `git` / `node` / `npx` / `pnpm`）各带子命令表，表外拒。整表见 docs/43 §5b |
| 写法 | 管道、命令替换、进程替换、后台一律拒（它们能把没过表的命令接进来）；`;` / `&&` / `\|\|` 放行，但**每段各自再判一次** |
| 路径 | 重定向目标、看着像路径的参数、`workdir`，落到副本目录外一律拒 |
| 发布 | `theme publish` / `--live` / `push` 不带 `--unpublished` → 物化成 `publish_theme` 的 staged change（永远 L1），然后拒掉这次调用 |
| 升档 / 后台 | `sandbox_permissions` 与 `run_in_background` 一律拒 |
| 提示词 | `shellBrief()` 进 persona 的 **complete 段**（官方 `tool:bash` 那一句是独立段，不受遮蔽，留着） |

**拒绝物化成 `tool.result{blocked}`** 进事件日志（17 §2），与浏览器策略同一套。

### 11.4 回归证据（用例名）

| 事 | 用例（`test/shell-seam.test.ts`） |
|---|---|
| allowlist 放行 / 拒 / 归到卡，逐条 | `(a)` 组 8 条 |
| 只有建站职责有终端；客服带了 `shell` 也不挂 | `(d)` 组 4 条 |
| 沙箱真起一次：命令真跑、副本内写得进、越界写被内核挡 | `(b)` 组 2 条 |
| 发布物化成 `publish_theme`，`before` 留空不编 | `(e)` 组 1 条 |
| 令牌到得了 CLI，但不进事件、不进 `process.env` | `(c)` 组 2 条 |
| 两档 headless 各跑一条带终端的运行 | `(f)` 组 2 条 |

`test/seams.test.ts` 的 30 条**一条没删**；`browser-seam.test.ts` / `preset-seam.test.ts`
一条没动。3 人 pack 新增 `site/theme-edit-then-publish`（stub / dsh-in-process /
dsh-subprocess 三档同一份指标，基线只写了它这一条）。

### 11.5 平台

macOS（Seatbelt）**本机实测**：`workspace-write` 起得来、上游报 `enforcement: 'full'`、
副本目录外的写回 `Operation not permitted`。Linux（bwrap→Landlock）与 Windows
（受限令牌）按上游文档，未在本机实测。选不出 runner 时上游 `SANDBOX_UNAVAILABLE`
**fail-closed**——命令不会"没关笼子就跑"，这正是我们要的。
