import type { AppError, ErrorCode } from '@agentsws/contracts'

/** 本包的错误：带契约里的 `ErrorCode`，运行时把它翻成 `run.failed{error}`。 */
export class DirectRuntimeError extends Error implements AppError {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'DirectRuntimeError'
  }
}

const RETRYABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'provider_unavailable',
  'rate_limited',
  'timeout',
  'provider_error',
  'conflict',
  'internal',
])

/**
 * 任意异常 → `run.failed.error`。网关抛的 `GatewayError` / `ProviderError` 自带 `code`，
 * 没有 code 的按 `provider_unavailable`（模型这一路只可能是 provider 出事）。
 */
export function failureOf(err: unknown): { code: string; message: string; retryable: boolean } {
  const e = err as { code?: unknown; message?: unknown }
  const code = typeof e?.code === 'string' ? e.code : 'provider_unavailable'
  const message = typeof e?.message === 'string' ? e.message : String(err)
  return { code, message, retryable: RETRYABLE.has(code as ErrorCode) }
}
