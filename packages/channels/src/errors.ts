import type { ErrorCode } from '@agentsws/contracts'

/** 渠道包统一错误；错误码只用 28 §2 契约里的那张表，不自造同义码。 */
export class ChannelError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'ChannelError'
  }
}

export function isChannelError(e: unknown): e is ChannelError {
  return e instanceof ChannelError
}
