# @agentsws/dsh-adapter

`RuntimeAdapter`（`name='dsh'`，17 §4）。
**唯一允许 import `@deepseek-ai/dsh-*` 的包**：业务代码只见 `RuntimeAdapter`，
升级 dsh 只看这里的 seam 契约测试红不红。

## 一次运行做了什么

```
RunRequest
  → writePreset()            一职责一目录：presets/<role_id>/agent.cordis.yml
  → createHarness()          一棵全新的 Cordis 树（headless、无状态，结束即 dispose）
       systemPrompt.section  persona（complete 段，遮蔽 dsh 自带的 persona 前后缀）
       systemPrompt.context  每个 ContextItem 一段 → 发 context.injected
       tools.register        allowlist 的读工具 + stage_refund / draft_reply
       tools.restrict        在 preset 的 agent scope 里按 tools.allow 收窄（默认拒绝）
       tools/pre-execute     不在 allow → deny；executor 下 write_external → deny
       tools/post-execute    结果过 EXTERNAL_FENCE、实体 id 进 Provenance → 发 tool.result
       approval/request      answerer：把 dsh 的审批请求转成我们的审批项，fail-closed
       llm.registerAdapter   LlmAdapter → ModelGateway.complete
  → 装配 prompt → prompt.assembled → 经 ctx.llm 补全 → grounding 工具 → stage → draft
  → RunResult
```

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

SDK 那组用 `test/fake-runtime.mjs`（只说线协议、不跑模型）——我们要钉的是协议，不是模型。

## 与 dsh 0.1.3-alpha.2 的已知差异

见 `test/seams.test.ts` 里带「已知差异」的用例：

1. 可遮蔽的 persona 段名是 `deployment:persona-prefix` / `deployment:persona-suffix`
   （不是文档里的 `deployment:persona`）；我们用 `complete: true` 段整段接管。
2. `tools/post-execute` 不允许替换**失败**结果的 `value`（会把调用变成 pipeline 错误）。
3. `@deepseek-ai/dsh-sdk-client` 的类型声明导出 `createProcessDeepSeekHarness` /
   `createProcessHarnessClient`，但运行时入口没有导出它们。
4. 本适配器跑的是**同进程** headless 组合，不是 `dsh --profile headless` 子进程：
   `stage` / `createDraft` / 合成时钟都是进程内回调，跨进程要先有一层 IPC。
   跨进程形态的组合由 `writePreset()` 生成，两边是同一份定义。
