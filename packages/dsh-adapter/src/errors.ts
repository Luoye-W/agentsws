import type { AppError, ErrorCode } from '@agentsws/contracts'

/** 适配器自己的错误；code 用契约的 ErrorCode，保证跨包可路由。 */
export class DshAdapterError extends Error implements AppError {
  readonly retryable: boolean
  readonly details?: Record<string, unknown>

  constructor(
    readonly code: ErrorCode,
    message: string,
    options?: { retryable?: boolean; details?: Record<string, unknown> },
  ) {
    super(message)
    this.name = 'DshAdapterError'
    this.retryable = options?.retryable ?? false
    if (options?.details !== undefined) this.details = options.details
  }
}
