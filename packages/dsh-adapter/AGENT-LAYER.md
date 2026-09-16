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
