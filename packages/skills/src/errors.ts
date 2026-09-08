import type { AppError, ErrorCode } from '@agentsws/contracts'

/** 28 §2 统一错误码；本包不自造同义码。 */
export class SkillsError extends Error implements AppError {
  readonly code: ErrorCode
  readonly details?: unknown

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message)
    this.name = 'SkillsError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

export function invalidInput(message: string, details?: unknown): SkillsError {
  return new SkillsError('invalid_input', message, details)
}

export function notFound(message: string, details?: unknown): SkillsError {
  return new SkillsError('not_found', message, details)
}
