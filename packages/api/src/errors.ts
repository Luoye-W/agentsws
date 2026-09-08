/**
 * 28 §2 统一错误：`{ code, message, details, trace_id }`，错误码跨模块复用。
 *
 * 网关在契约的 `ErrorCode` 之外只加两个码，且都在交付报告里作为契约建议提出：
 * - `unauthenticated`：缺 / 无效 Bearer（契约里没有对应码，但 20 §3 要求 401）
 * - `internal`：未归类的实现错误（不泄漏细节）
 */
import type { ErrorCode } from '@agentsws/contracts'

export type GatewayErrorCode = ErrorCode | 'unauthenticated' | 'internal'

export interface ErrorBody {
  code: GatewayErrorCode
  message: string
  details?: unknown
  trace_id: string
}

/** 28 §2 错误码 → HTTP 状态。未列出的一律 500。 */
export const STATUS_BY_CODE: Record<GatewayErrorCode, number> = {
  invalid_input: 400,
  unauthenticated: 401,
  forbidden: 403,
  sod_violation: 403,
  not_found: 404,
  conflict: 409,
  idempotency_conflict: 409,
  stale_record: 409,
  snapshot_mismatch: 409,
  budget_exhausted: 429,
  halted: 503,
  not_approved: 500,
  connection_not_allowed: 500,
  policy_tightened: 500,
  authorization_check_failed: 500,
  provenance_missing: 500,
  unknown_outcome: 500,
  provider_unavailable: 503,
  residency_blocked: 403,
  rate_limited: 429,
  timeout: 504,
  provider_error: 502,
  internal: 500,
  not_implemented: 501,
}

export function statusFor(code: GatewayErrorCode): number {
  return STATUS_BY_CODE[code] ?? 500
}

export interface ApiErrorOptions {
  details?: unknown
  /** 覆盖状态码（只用于 401：码是 forbidden 语义但状态必须是 401）。 */
  status?: number
  headers?: Record<string, string>
  cause?: unknown
}

export class ApiError extends Error {
  readonly code: GatewayErrorCode
  readonly details?: unknown
  readonly status: number
  readonly headers: Record<string, string>

  constructor(code: GatewayErrorCode, message: string, options: ApiErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'ApiError'
    this.code = code
    this.status = options.status ?? statusFor(code)
    this.headers = options.headers ?? {}
    if (options.details !== undefined) this.details = options.details
  }
}

const KNOWN = new Set<string>(Object.keys(STATUS_BY_CODE))

function isGatewayCode(value: unknown): value is GatewayErrorCode {
  return typeof value === 'string' && KNOWN.has(value)
}

/**
 * 把任意下游错误（TxnError / KernelError / RoleError / KnowledgeError …）归一成网关错误。
 * 判据只有一个：带 `code` 且是契约里的错误码——各模块都照 28 §2 用同一张码表。
 */
export function normalizeError(err: unknown): ApiError {
  if (err instanceof ApiError) return err
  if (err !== null && typeof err === 'object') {
    const rec = err as { code?: unknown; message?: unknown; details?: unknown }
    if (isGatewayCode(rec.code)) {
      return new ApiError(rec.code, typeof rec.message === 'string' ? rec.message : rec.code, {
        ...(rec.details === undefined ? {} : { details: rec.details }),
        cause: err,
      })
    }
  }
  // 不把内部堆栈 / 消息泄漏给调用方（21 §5 秘密不出）。
  return new ApiError('internal', 'internal error', { cause: err })
}

export function errorBody(err: ApiError, trace_id: string): ErrorBody {
  return {
    code: err.code,
    message: err.message,
    ...(err.details === undefined ? {} : { details: err.details }),
    trace_id,
  }
}
