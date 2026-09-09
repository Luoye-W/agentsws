import type { AppError, ErrorCode } from '@agentsws/contracts'

/** 28 §2 统一错误码；本包不自造同义码。 */
export class LearningError extends Error implements AppError {
  readonly code: ErrorCode
  readonly details?: unknown

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message)
    this.name = 'LearningError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

export function invalidInput(message: string, details?: unknown): LearningError {
  return new LearningError('invalid_input', message, details)
}

export function notFound(message: string, details?: unknown): LearningError {
  return new LearningError('not_found', message, details)
}
