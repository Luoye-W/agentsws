/**
 * 宿主 ↔ headless 子进程的桥协议（WP30）。
 *
 * 传输用 dsh 官方 SDK 自己的那一条线：`@deepseek-ai/dsh-sdk-protocol` 的
 * `JsonRpcLineTransport`（NDJSON JSON-RPC 2.0 over stdio）。用它而不是自造，
 * 有两条理由：① 它是 dsh 生态里"宿主驱动 headless runtime"的既定形态（`dsh --profile sdk`
 * 就是这条线）；② 它的**两端都能发请求**，而 dsh 的 `sdk-jsonrpc-server` 至今只用了
 * client→server 一个方向——我们的审批 answerer、工具出口与模型网关全都要从子进程回调宿主，
 * 所以方法集是我们自己的，传输是它的。
 *
 * 只走 stdio：子进程不监听任何端口（比"只绑 127.0.0.1"更严）。
 * 每一帧都带一次性 run token（`AGENTSWS_DSH_RUN_TOKEN`），token 不对一律拒。
 *
 * ── 为什么仍然不直接用 `dsh --profile sdk` + `dsh-sdk-client` ──
 * （WP30 在 0.1.3-alpha.2 上判过一次；WP41 在 **0.1.5-rc.1** 上重判，三条里第 1 条已经不成立）
 *
 * 1. ~~它能起，但要开一个原生构建~~ —— **0.1.5-rc.1 已解决**。
 *    `@deepseek-ai/dsh-session-persistence-jsonl` 不再依赖原生模块 `fs-ext`（文件建议锁改到
 *    `@deepseek-ai/node-addon-system`：预编译平台包，不走 node-gyp）。实测在
 *    `allowBuilds` 一个都没开的情况下 `dsh --profile sdk` 直接起得来，
 *    `initialize{provider:'deepseek-official'}` 回 `deepseek-harness-sdk-runtime`。
 * 2. **官方 server 仍然没有 server→client 请求**：`HarnessSdkJsonRpcServer` 只 `onRequest`
 *    收 client 的调用、只 `notify` 往回发通知（`session.event` / `session.status` /
 *    `subagent.*`），全包一次 `transport.request(...)` 都没有，也没有审批 answerer 的位置。
 *    我们的五个 seam 有四个要从子进程回调宿主（工具出口、模型网关、stage / 起草、边界卡），
 *    走官方 server 就得另开一条我们自己的旁路（socket 或额外 fd），并不比现在这条干净。
 * 3. ~~**语义会变**：官方 `sdk` 档由 dsh 自己的 agent loop 驱动 turn~~ —— **WP81 已不成立**。
 *    我们现在就是用官方 agent-loop 驱动 turn 的（`harness.ts`），模拟档的模型替身也换成了
 *    会产 `tool_calls` 的规则脑。这一条剩下的只有"两档事件序列必须逐条一致"这个要求本身，
 *    而它由 `runtime-parity.test.ts` 的 `WP30 A` 守着，与走不走官方 SDK 无关。
 *
 * 所以这一档的形态是：**dsh 的 Cordis 树整棵跑在子进程里**（WP81 起还包含官方 Agent 层：
 * `SessionStore` / `SessionProjectionRegistry` / `AgentRegistry` / `AgentLoop`，
 * 加上 `SystemPrompt` / `ToolRuntime` / `ApprovalService` / `LlmRuntime` + 我们的门禁插件），
 * 宿主用 dsh 官方的传输驱动它。
 * 组合与进程内档共用 `harness.ts` + `gate.ts` 一份代码，preset 也仍然按 `preset.ts` 生成——
 * 换的是宿主进程，不是组合。等上游把 server→client 请求补上、且 headless 的 loop 能被
 * 我们的 seam 完全接管时，这一层可以整块换成官方 SDK client，方法集不用动。
 * 完整评估见 `packages/dsh-adapter/UPGRADE.md` §5。
 *
 * ── WP70（0.1.6-alpha.1）的重判：上面三条里第 2 / 3 条仍然成立 ──
 *
 * - 第 2 条：`@deepseek-ai/dsh-sdk-jsonrpc-server@0.1.6-alpha.1` 的 `lib/index.js` 里
 *   `transport.request(` 仍然是 **0 处**；往回只有四个 `transport.notify`
 *   （`session.event` / `session.status` / `subagent.started` / `subagent.finished`）。
 *   上游源码里 `packages/sdk/protocol/src` 与 0.1.5-rc.1 **逐字节相同**，
 *   `packages/sdk/server/src/server.ts` 只改了一行（`ctx.plugin(LlmDeepSeek, {})` → `ctx.plugin(LlmDeepSeek)`）。
 * - 第 3 条：`dsh-headless` 这一版新增了 `--json`（逐行 JSON 事件流）、
 *   `--session-id` 与 stdin 任务（`lib/types/{index,startup,json-stream}.d.ts`）。
 *   `--json` **替不了这一档**：`projectJsonRun(ctx, agent, sink)` 是对
 *   “一个 Agent 的持久 Session 事件”的**单向 stdout 投影**（`json-stream.d.ts` 首段：
 *   “Every projected event is a commit point”），没有任何回调宿主的方向。
 *   而我们这条桥上子进程→宿主的请求有五条（见下面 `M_HOST_*`），
 *   `--json` 一条都盖不了。
 */
import type { ObjectRef, RunEvent, RunRequest, RunResult } from '@agentsws/contracts'
import type { CreatePolicyQuestionFn, DraftPayload, StageIntent } from '@agentsws/stand-ins'
import type { ToolSideEffect } from '../types.js'

/** 桥协议版本；宿主与子进程对不上就拒绝握手。 */
export const BRIDGE_PROTOCOL_VERSION = 1

/** 子进程读一次性 run token 的环境变量名。 */
export const ENV_RUN_TOKEN = 'AGENTSWS_DSH_RUN_TOKEN'
/** 子进程的自我标记（子进程里 `mode` 永远是 in-process，不会再套一层）。 */
export const ENV_CHILD_MARKER = 'AGENTSWS_DSH_CHILD'

// ── 宿主 → 子进程 ────────────────────────────────────────────────────────
export const M_HELLO = 'agentsws/hello'
export const M_RUN = 'agentsws/run'
export const M_CANCEL = 'agentsws/cancel'
export const M_SHUTDOWN = 'agentsws/shutdown'

// ── 子进程 → 宿主 ────────────────────────────────────────────────────────
/** 通知：一条 RunEvent。 */
export const M_EVENT = 'agentsws/event'
/** 通知：子进程装好了，可以收 `agentsws/run`。 */
export const M_READY = 'agentsws/ready'
export const M_HOST_TOOL = 'agentsws/host/tool'
export const M_HOST_COMPLETE = 'agentsws/host/complete'
export const M_HOST_STAGE = 'agentsws/host/stage'
export const M_HOST_DRAFT = 'agentsws/host/draft'
export const M_HOST_BOUNDARY = 'agentsws/host/boundary'
/** WP144：电脑操控的授权卡 / 接手卡（`DshRuntimeOptions.requestComputerUse`）。 */
export const M_HOST_COMPUTER_USE = 'agentsws/host/computer-use'

/** 子进程档能透传的运行时选项（回调、时钟、网关都在宿主侧，不过线）。 */
export interface WireRuntimeOptions {
  seed?: number
  defaultReturnWindowDays?: number
  signature?: string
  presetRoot?: string
  sessionLogRoot?: string
  sideEffects?: Record<string, ToolSideEffect>
  /** 宿主侧是否接了这些回调；子进程据此决定 `options.stage` 之类给不给。 */
  has: {
    executeTool: boolean
    stage: boolean
    createDraft: boolean
    createPolicyQuestion: boolean
    /** WP144：老宿主不发这一格 = 没接。 */
    requestComputerUse?: boolean
  }
}

export interface HelloParams {
  token: string
  protocol: number
}
export interface HelloResult {
  protocol: number
  runtime: string
  capabilities: {
    tool_choice: boolean
    streaming: boolean
    followup: boolean
    seedable: boolean
  }
}

export interface RunParams {
  token: string
  request: RunRequest
  options: WireRuntimeOptions
  /** 宿主此刻的时间（子进程的 Clock 从它起步，之后每次回调应答再对表）。 */
  now: string
  /** 宿主的 AbortSignal 在发起时就已经是 aborted。 */
  aborted?: boolean
}

/** 每一条子进程 → 宿主的应答都带宿主此刻的时间，子进程据此对表（合成时钟可能被回调推进）。 */
export interface HostReply {
  now: string
}

export interface ToolCallParams {
  token: string
  name: string
  input: Record<string, unknown>
}
export interface ToolCallResult extends HostReply {
  status: 'ok' | 'error' | 'blocked'
  data?: unknown
  reason?: string
  provenance?: ObjectRef[]
}

export interface CompleteParams {
  token: string
  /** `ModelGatewayLike.complete` 的入参，`messages` / `tools` / `meta` 原样过线。 */
  request: unknown
}
export interface CompleteResult extends HostReply {
  completion: unknown
}

/** stage 意图去掉 `request`（宿主手里已经有那份 RunRequest，不重复过线）。 */
export type WireStageIntent = Omit<StageIntent, 'request'>
export interface StageParams {
  token: string
  intent: WireStageIntent
}
export interface StageResult extends HostReply {
  change_id?: string
}

export type WireDraftPayload = Omit<DraftPayload, 'request'>
export interface DraftParams {
  token: string
  payload: WireDraftPayload
}
export interface DraftResult extends HostReply {
  approval_item_id?: string
  /**
   * WP55 / 48 §4 L3 #2：出站硬闸把这一版打回重写了，里面是中文的违规原因。
   * 与 `approval_item_id` 互斥——打回意味着这一版**没有**建卡。
   */
  rewrite?: string
}

export type BoundaryInput = Parameters<CreatePolicyQuestionFn>[0]['boundary']
export interface BoundaryParams {
  token: string
  boundary: BoundaryInput
}
export interface BoundaryResult extends HostReply {
  approval_item_id?: string
}

export interface RunOk {
  ok: true
  result: RunResult
}
export interface RunErr {
  ok: false
  code: string
  message: string
  retryable: boolean
}
export type RunResponse = RunOk | RunErr

export interface EventParams {
  token: string
  event: RunEvent
}

/** WP144：子进程请宿主出一张电脑操控卡。 */
export interface ComputerUseCardParams {
  token: string
  stage: 'authorize' | 'handoff'
  reason: string
}
export interface ComputerUseCardResult extends HostReply {
  approval_item_id?: string
}
