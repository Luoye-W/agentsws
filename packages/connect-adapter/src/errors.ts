import type { AppError, ErrorCode } from '@agentsws/contracts'

/** 28 §2 的统一错误码 → HTTP 状态；与 stand-ins 的表保持一致，方便契约一致性套件两边断言同一组 code。 */
const STATUS: Record<ErrorCode, number> = {
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
  unauthenticated: 401,
  internal: 500,
}

/** 适配器统一错误。`details` 里只放脱敏后的上游线索，永远不含凭据。 */
export class ConnectAdapterError extends Error implements AppError {
  readonly status: number

  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'ConnectAdapterError'
    this.status = STATUS[code]
  }
}

export function isConnectAdapterError(e: unknown): e is ConnectAdapterError {
  return e instanceof ConnectAdapterError
}

/**
 * OpenConnector 的 `errorCode` → 我们的 `ErrorCode`。
 *
 * 09-09 实测（`open-connector:latest`）：**必须先看 errorCode 再看 HTTP 状态**——
 * 上游 provider 返回 401 时 runtime 给的是 `403 authorization_failed`，
 * `action_not_allowed` 给的是 `400`，只按状态映射会把两者都归错。
 */
const CODE_MAP: Readonly<Record<string, ErrorCode>> = {
  // 鉴权（我们这一侧的 bearer 不对）
  unauthorized: 'unauthenticated',
  // 策略
  connection_not_allowed: 'connection_not_allowed',
  action_not_allowed: 'forbidden',
  proxy_blocked: 'forbidden',
  proxy_not_supported: 'forbidden',
  // 目录
  unknown_action: 'not_found',
  not_found: 'not_found',
  unknown_service: 'not_found',
  provider_not_found: 'not_found',
  app_not_found: 'not_found',
  connection_not_found: 'not_found',
  connected_account_not_found: 'not_found',
  connection_request_not_found: 'not_found',
  provider_config_not_found: 'not_found',
  // 入参
  invalid_input: 'invalid_input',
  invalid_json: 'invalid_input',
  invalid_connection_name: 'invalid_input',
  invalid_request_payload: 'invalid_input',
  oauth_client_config_required: 'invalid_input',
  // 幂等
  idempotency_key_conflict: 'idempotency_conflict',
  idempotency_request_in_progress: 'idempotency_conflict',
  request_key_conflict: 'idempotency_conflict',
  request_key_used: 'idempotency_conflict',
  request_in_progress: 'idempotency_conflict',
  // 限流 / 上游
  rate_limited: 'rate_limited',
  provider_error: 'provider_error',
  proxy_upstream_error: 'provider_error',
  proxy_response_too_large: 'provider_error',
  executor_unavailable: 'provider_unavailable',
  provider_not_configured: 'provider_error',
  credential_verification_failed: 'provider_error',
  // 连接侧凭据坏了：不是"我们没鉴权"，是上游拒绝这条连接
  authorization_failed: 'provider_error',
  credential_expired: 'provider_error',
  oauth_token_expired: 'provider_error',
  oauth_refresh_unavailable: 'provider_error',
  scope_missing: 'forbidden',
  // 超时
  proxy_upstream_timeout: 'timeout',
  client_timeout: 'timeout',
  client_wait_timeout: 'timeout',
  client_network_error: 'provider_unavailable',
  internal_error: 'internal',
}

function fromStatus(status: number): ErrorCode {
  if (status === 401) return 'unauthenticated'
  if (status === 403) return 'forbidden'
  if (status === 404) return 'not_found'
  if (status === 409) return 'idempotency_conflict'
  if (status === 429) return 'rate_limited'
  if (status === 408 || status === 504) return 'timeout'
  if (status === 400 || status === 422) return 'invalid_input'
  if (status >= 500) return 'provider_error'
  if (status === 0) return 'provider_unavailable'
  return 'internal'
}

export interface RuntimeFailure {
  status: number
  errorCode?: string | undefined
  message?: string | undefined
  details?: unknown
}

/** 上游失败 → 契约错误。`errorCode` 优先，其次 HTTP 状态。 */
export function mapRuntimeError(f: RuntimeFailure): ConnectAdapterError {
  const mapped = f.errorCode === undefined ? undefined : CODE_MAP[f.errorCode]
  const code = mapped ?? fromStatus(f.status)
  const details: Record<string, unknown> = { http_status: f.status }
  if (f.errorCode !== undefined) details.runtime_error_code = f.errorCode
  if (f.details !== undefined) details.runtime_details = f.details
  return new ConnectAdapterError(
    code,
    f.message ?? `OpenConnector 失败：${f.errorCode ?? f.status}`,
    details,
  )
}
