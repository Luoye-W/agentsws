import type { ErrorCode } from '@agentsws/contracts'

/** 会议包统一错误；错误码只用 28 §2 契约里的那张表，不自造同义码。 */
export class MeetingError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'MeetingError'
  }
}

export function isMeetingError(e: unknown): e is MeetingError {
  return e instanceof MeetingError
}
