/** 统一错误（28 §2）：内核抛的每个错误都带 `ErrorCode`，不自造同义码。 */
import type { AppError, ErrorCode } from '@agentsws/contracts'

export interface KernelErrorOptions {
  details?: unknown
  trace_id?: string
  cause?: unknown
}

export class KernelError extends Error implements AppError {
  override readonly name = 'KernelError'
  readonly code: ErrorCode
  readonly details?: unknown
  readonly trace_id?: string

  constructor(code: ErrorCode, message: string, options: KernelErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.code = code
    if (options.details !== undefined) this.details = options.details
    if (options.trace_id !== undefined) this.trace_id = options.trace_id
  }

  /** 网关序列化形状（28 §2 `{ code, message, details, trace_id }`）。 */
  toJSON(): AppError {
    return {
      code: this.code,
      message: this.message,
      ...(this.details === undefined ? {} : { details: this.details }),
      ...(this.trace_id === undefined ? {} : { trace_id: this.trace_id }),
    }
  }
}

export function isKernelError(value: unknown): value is KernelError {
  return value instanceof KernelError
}
