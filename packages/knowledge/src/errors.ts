import type { AppError, ErrorCode } from '@agentsws/contracts'

/** 统一错误码来自 common.ts（28 §2），本包不自造同义码。 */
export class KnowledgeError extends Error implements AppError {
  readonly code: ErrorCode
  readonly details?: unknown

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message)
    this.name = 'KnowledgeError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

export const forbidden = (message: string, details?: unknown): KnowledgeError =>
  new KnowledgeError('forbidden', message, details)
export const notFound = (message: string, details?: unknown): KnowledgeError =>
  new KnowledgeError('not_found', message, details)
export const invalidInput = (message: string, details?: unknown): KnowledgeError =>
  new KnowledgeError('invalid_input', message, details)
