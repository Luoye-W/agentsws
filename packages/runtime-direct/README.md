# @agentsws/runtime-direct

17 §4 的 `direct-llm` 运行时：**不经 dsh**，自己跑 turn loop，模型经 22 的模型网关。

它存在的意义是证明 dsh 可替换（31 §1 I6）——同一条场景在它上面跑通并过六条不变量。

## 一次运行

1. **装配**（17 §1）：静态前缀（persona 段 → skills 索引行 → 工具定义）→ 策略层 → 工作项上下文
   → `app_events` → 用户消息。顺序与哈希都复用 `@agentsws/stand-ins` 的 `assemblePrompt` /
   `assemblePromptHash`——定义只有一处，事件日志才回放得出同一个 prompt。
2. **grounding**（17 §5.4）：intent 与 cue 同时命中才算命中。网关支持 `tool_choice` 就强制第一轮工具；
   不支持就宿主预取，结果作为**第一条** `prefetch` ContextItem。
3. **工具循环**：每次调用先过两道门（`tools.allow`；`side_effect_policy: 'executor'` 下写外部一律 block），
   结果过 `EXTERNAL_FENCE` 再回给模型，认得出的实体进 Provenance。
4. **产出**：`draft_reply` / `stage_refund` 作为工具暴露给模型，落到注入的宿主回调
   （真实实现是 15 的变更账本与 14 的审批总线）。
5. **预算是硬的**（17 §5.3）：`max_tokens` / `max_tool_calls` / `max_seconds` 任一耗尽 → `budget.exhausted`
   → `close_open_tool_uses` 补齐未闭合调用 → `run.completed{budget_exhausted}`；AbortSignal → `run.cancelled`。
6. **compact_history**（Commerce Agents A9）：历史超阈值时把最早的工具结果换成占位，记 `progress{step:'compact'}`。
7. **幂等**（17 §5.7）：同 `idempotency_key` 24h 内返回原 RunResult，不重跑不重发事件。

## 模型替身

22 的 `stubProvider` 只出文本、不出 `tool_calls`，turn loop 跑不起来。本包提供两个确定性 provider：

- `scriptedProvider`：按轮次返回预设的 `tool_call` / 文本（轮次从对话里的 assistant 消息数推，纯函数）
- `aftersalesBrainProvider`：售后"规则脑"，判定逻辑与 stub 运行时同一套，只是用工具协议表达

模拟回路的 `runtime: 'direct'` 分支用后者。

## tool_choice

22 的 `ModelGateway.complete` 还没有 `tool_choice`（见 WP14 报告）。`withToolChoice(gateway)` 在网关外面
把它补上：强制轮里模型没调那个工具就替换成对它的一次调用。网关原生支持之后这个包装器可以整体删掉。
