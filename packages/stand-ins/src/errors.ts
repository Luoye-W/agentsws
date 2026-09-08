import type { ErrorCode } from '@agentsws/contracts'

/**
 * 28 §2 的统一错误码没有覆盖三种"传输层"失败（上游限流、超时、上游 5xx），
 * 而 26 §3 的故障注入必须能表达 `429 | 500 | timeout`。这里只补这三个，不自造已有码的同义词。
 */
/** 09-09：传输层失败码已进契约 ErrorCode，这里只是别名 */
export type StandInErrorCode = ErrorCode

const STATUS: Record<StandInErrorCode, number> = {
  not_found: 404,
  forbidden: 403,
  sod_violation: 403,
  not_approved: 403,
  stale_record: 409,
  snapshot_mismatch: 409,
  budget_exhausted: 429,
  connection_not_allowed: 403,
  halted: 503,
  invalid_input: 400,
  conflict: 409,
  idempotency_conflict: 409,
  policy_tightened: 409,
  authorization_check_failed: 403,
  provenance_missing: 403,
  unknown_outcome: 500,
  provider_unavailable: 503,
  residency_blocked: 403,
  rate_limited: 429,
  timeout: 504,
  provider_error: 500,
}

/** 替身统一错误。`status` 让"注入 429 / 500 / timeout"这类断言不必比字符串。 */
export class StandInError extends Error {
  readonly status: number

  constructor(
    readonly code: StandInErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'StandInError'
    this.status = STATUS[code]
  }
}

export function isStandInError(e: unknown): e is StandInError {
  return e instanceof StandInError
}
