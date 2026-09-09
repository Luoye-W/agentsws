/** 本包的错误一律用契约的 `ErrorCode`（28 §2「各模块不许自造同义码」）。 */
import type { ErrorCode } from '@agentsws/contracts'

export class WorkError extends Error {
  readonly code: ErrorCode
  readonly details?: unknown

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message)
    this.name = 'WorkError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

export function notFound(what: string, id: string): WorkError {
  return new WorkError('not_found', `没有这个${what}：${id}`, { id })
}
