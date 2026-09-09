/**
 * 宿主 ↔ headless 子进程的桥协议（WP30）。
 *
 * 传输用 dsh 官方 SDK 自己的那一条线：`@deepseek-ai/dsh-sdk-protocol` 的
 * `JsonRpcLineTransport`（NDJSON JSON-RPC 2.0 over stdio）。用它而不是自造，
 * 有两条理由：① 它是 dsh 生态里"宿主驱动 headless runtime"的既定形态（`dsh --profile sdk`
 * 就是这条线）；② 它的**两端都能发请求**，而 dsh 的 `sdk-jsonrpc-server` 目前只实现了
 * client→server 一个方向（README「Known Limitations」：server→client requests are
 * unimplemented ... for future approval flows）——我们的审批 answerer、工具出口与模型网关
 * 全都要从子进程回调宿主，所以方法集是我们自己的，传输是它的。
 *
 * 只走 stdio：子进程不监听任何端口（比"只绑 127.0.0.1"更严）。
 * 每一帧都带一次性 run token（`AGENTSWS_DSH_RUN_TOKEN`），token 不对一律拒。
 *
 * ── 为什么不直接用 `dsh --profile sdk` + `dsh-sdk-client`（09-10 实测 0.1.3-alpha.2）──
 *
 * 1. **它能起，但要开一个原生构建**：`dsh --profile sdk` 的插件树里有
 *    `@deepseek-ai/dsh-session-persistence-jsonl`，它 require 原生模块 `fs-ext`（文件建议锁）。
 *    仓库的 `pnpm-workspace.yaml` 把 dsh 拖进来的原生依赖一律 `allowBuilds: false`（16 §3 最严解释），
 *    于是 boot 直接死在 `Cannot find module './build/Release/fs_ext.node'`。
 *    手工 `node-gyp rebuild fs-ext` 之后 `initialize` 握手就通了（回 `deepseek-harness-sdk-runtime`）——
 *    也就是说这条路的唯一硬门槛是那一个原生模块。我们没为它开构建：见第 2、3 条，开了也用不上。
 * 2. **官方 server 没有 server→client 请求**：`dsh-sdk-jsonrpc-server` 的
 *    「Known Limitations」写明 server→client requests 尚未实现（transport 留着位子给未来的审批流）。
 *    我们的五个 seam 有四个要从子进程回调宿主（工具出口、模型网关、stage / 起草、边界卡），
 *    走官方 server 就得另开一条我们自己的旁路（socket 或额外 fd），并不比现在这条干净。
 * 3. **语义会变**：官方 `sdk` 档由 dsh 自己的 agent loop 驱动 turn，而 17 §4 要求
 *    `run()` 的事件序列与进程内档逐条一致（同一份契约测试跑两遍）。模拟档的 stub provider
 *    不产 tool_calls，dsh 的 loop 一轮就 idle，事件序列必然对不上。
 *
 * 所以这一档的形态是：**dsh 的 Cordis 树整棵跑在子进程里**（`SystemPrompt` / `ToolRuntime` /
 * `ApprovalService` / `LlmRuntime` + 我们的门禁插件），宿主用 dsh 官方的传输驱动它。
 * 组合与进程内档共用 `harness.ts` + `gate.ts` 一份代码，preset 也仍然按 `preset.ts` 生成——
 * 换的是宿主进程，不是组合。等上游把 server→client 请求补上、且 headless 的 loop 能被
 * 我们的 seam 完全接管时，这一层可以整块换成官方 SDK client，方法集不用动。
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
