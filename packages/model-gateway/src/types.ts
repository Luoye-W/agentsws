import type {
  AppError,
  AssignmentId,
  ChatMessage,
  Completion,
  CompletionHints,
  CompletionStream,
  ErrorCode,
  EventEnvelope,
  Iso8601,
  ModelMeta,
  ModelPurpose,
  ModelRef,
  ProviderNetTry,
  RoleId,
  ToolChoice,
  ToolDef,
  TranscriptionAudioDigest,
} from '@agentsws/contracts'

/**
 * 22 §2 工作区模型策略。`default` + 按 purpose 覆盖 + 降级备选 + 价格表 + 三级预算。
 * 价格表按 provider/model 键，单位是每 100 万 token 的基准货币金额。
 */
export interface PriceEntry {
  in: number
  out: number
  cached: number
}
export type PriceTable = Record<string, PriceEntry>

export interface BudgetPolicy {
  /** 工作区每日上限（基准货币）。 */
  workspace_daily_base?: number
  /** 工作区每月上限（基准货币）。 */
  workspace_monthly_base?: number
  /** 分配每日上限：统一值或按 assignment_id 覆盖。 */
  assignment_daily_base?: number
  assignment_daily_base_by_id?: Record<AssignmentId, number>
}

export interface EstimatePolicy {
  /** 估算输入 token 用的每 token 字符数（默认 4）。 */
  chars_per_token?: number
  /** 预留时预计的输出 token 数（默认 512）。 */
  expected_output_tokens?: number
}

export interface ModelGatewayPolicy {
  default: ModelRef
  by_purpose?: Partial<Record<ModelPurpose, ModelRef>>
  /** 同档备选：按 `provider/model` 键，或 `*` 兜底。provider 5xx / 超时时依次尝试。 */
  fallbacks?: Record<string, ModelRef[]>
  prices: PriceTable
  budget?: BudgetPolicy
  estimate?: EstimatePolicy
}

/** 22 §3 网关自己的事件类型（契约 KnownEventType 里目前只有 model.usage，见报告）。 */
export type ModelEventType =
  | 'model.usage'
  | 'model.provider_down'
  | 'model.budget_frozen'
  | 'budget.exhausted'

export interface ModelUsagePayload {
  model: ModelRef
  purpose: ModelPurpose
  assignment_id: AssignmentId
  role_id: RoleId
  input_tokens: number
  output_tokens: number
  cached_tokens: number
  cost_base: number
  static_prefix_hash: string
  duration_ms: number
  /** ASR 调用才有：音频摘要（哈希 / 时长 / 字节数）。**字节与转写正文永不进事件日志。** */
  audio?: TranscriptionAudioDigest
  /**
   * WP243：成功之前 provider 内部重发过的那几次失败（连接被掐 / 流式中途断）。没重发就没有这一格。
   * 「重发要看得见」：成了也知道中间断过几次、断在哪。
   */
  net_retries?: ProviderNetTry[]
}

export interface ProviderDownPayload {
  model: ModelRef
  /**
   * 每一次尝试一条。WP243：provider 内部重发的那一次也单独一条（同一个 `model`），
   * 带网络错误码 `code` 与这一次的耗时 `duration_ms`（provider 报得出时才有）。
   */
  attempts: {
    model: ModelRef
    status?: number
    message: string
    code?: string
    duration_ms?: number
  }[]
}

export interface BudgetFrozenPayload {
  scope: 'workspace_daily' | 'workspace_monthly' | 'assignment_daily'
  period: string
  assignment_id?: AssignmentId
  used_base: number
  cap_base: number
}

export interface BudgetExhaustedPayload {
  which: 'max_cost_base'
  used: number
  cap: number
  run_id: string
}

/** 事件信封去掉 id（网关用 Clock 盖 at）；宿主的 EventLog.append 再去掉 at 即可。 */
export type ModelGatewayEvent = Omit<EventEnvelope<ModelEventType, unknown>, 'id'>
export type ModelEventSink = (event: ModelGatewayEvent) => void

/**
 * 22 §1 complete 请求；在契约基础上加运行预算、EU 客户标记与输出估算（都可选）。
 * WP188：再加流式与停止（`on_delta` / `signal`，见契约 {@link CompletionStream}）。
 */
export interface CompleteRequest extends CompletionStream, CompletionHints {
  model?: ModelRef
  messages: ChatMessage[]
  tools?: ToolDef[]
  cache_breakpoints?: number[]
  meta: ModelMeta
  seed?: number
  /** 17 §5.4 强制工具选择；provider 未声明 `supports_tool_choice` 时网关剥掉它。 */
  tool_choice?: ToolChoice
  /** 运行预算（17 §1 RunRequest.budget.max_cost_base）。同一 run_id 内累计。 */
  max_cost_base?: number
  /** 覆盖预留时的预计输出 token 数。 */
  estimated_output_tokens?: number
  /**
   * WP127：这是一次**能力验证**（设置页 / 向导「测试」的带图那一步）。
   * 网关不按上一次的能力声明拦它——它问的正是"现在还看不看得了图"。
   */
  capability_probe?: boolean
}

export type { Completion }

export class GatewayError extends Error implements AppError {
  readonly code: ErrorCode
  readonly details: unknown
  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message)
    this.name = 'GatewayError'
    this.code = code
    this.details = details
  }
}

/** provider 抛的错；status >= 500 / 429 / 超时视为可降级。 */
export class ProviderError extends Error {
  readonly status: number | undefined
  readonly timeout: boolean
  /** WP243：网络错误码（挖得出才有）。 */
  readonly code: string | undefined
  /**
   * WP243：这一次调用里**每一次**尝试（含内部重发的那一次），最后一条就是这个错本身。
   * 网关把它们逐条记进 `provider_down.attempts`。
   */
  readonly tries: ProviderNetTry[] | undefined
  constructor(
    message: string,
    opts?: { status?: number; timeout?: boolean; code?: string; tries?: ProviderNetTry[] },
  ) {
    super(message)
    this.name = 'ProviderError'
    this.status = opts?.status
    this.timeout = opts?.timeout === true
    this.code = opts?.code
    this.tries = opts?.tries
  }
}

export function isRetryableProviderError(e: unknown): boolean {
  if (e instanceof ProviderError) return e.timeout || (e.status !== undefined && e.status >= 500)
  if (e instanceof Error) {
    return (
      e.name === 'TimeoutError' ||
      e.name === 'AbortError' ||
      (e as { code?: string }).code === 'ETIMEDOUT'
    )
  }
  return false
}

export interface UsageRecord {
  at: Iso8601
  workspace_id: string
  assignment_id: AssignmentId
  role_id: RoleId
  run_id: string
  purpose: ModelPurpose
  model: ModelRef
  input_tokens: number
  output_tokens: number
  cached_tokens: number
  cost_base: number
}
