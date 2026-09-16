# @agentsws/dsh-adapter

`RuntimeAdapter`（`name='dsh'`，17 §4）。
**唯一允许 import `@deepseek-ai/dsh-*` 的包**：业务代码只见 `RuntimeAdapter`，
升级 dsh 只看这里的 seam 契约测试红不红。

## 一次运行做了什么

```
RunRequest
  → writePreset()            一职责一目录：<root>/<workspace>/<preset_id>/agent.cordis.yml
                             （WP86：里面是这条职责的 mcp-client 行；内容没变就不写）
  → createHarness()          一棵全新的 Cordis 树（headless、无状态，结束即 dispose）
       agentPresets.mount    WP86：这条职责的连接（**先挂它，再 restrict**）
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

WP86 之后 preset 这一层还有 `test/preset-seam.test.ts`（生成幂等、凭据只有名字、按职责隔离、
`read_tools` 判定、`restrict` 顺序），细节见 `AGENT-LAYER.md` §10。

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
   跨进程形态的组合由 `writePreset()` 生成到同目录的 `host.cordis.yml`，两边是同一份定义。
5. （WP86）官方 `ctx.credentials` 是**单 provider**：一棵树上挂第二个 `CredentialProvider`
   当场抛 `service "credentials" has been registered`。本机凭据与 OpenConnector 的分层
   只能在一个 provider 内部做（`@agentsws/credentials-openconnector`）。
6. （WP86）`agent-presets` 挂上来的工具**受** `ctx.tools.restrict` 管，且 `restrict` 必须
   在 `mount()` **之后**调——与官方浏览器 provider 的语义正好相反（AGENT-LAYER §9.4 / §10.1）。
