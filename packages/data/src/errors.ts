import type { AppError, ErrorCode } from '@agentsws/contracts'

/** 28 §2 统一错误码；数据层不自造同义码。 */
export class DataError extends Error implements AppError {
  readonly code: ErrorCode
  readonly details?: unknown

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message)
    this.name = 'DataError'
    this.code = code
    this.details = details
  }
}

export const invalidInput = (message: string, details?: unknown): DataError =>
  new DataError('invalid_input', message, details)

export const forbidden = (message: string, details?: unknown): DataError =>
  new DataError('forbidden', message, details)

export const conflict = (message: string, details?: unknown): DataError =>
  new DataError('conflict', message, details)

export const notFound = (message: string, details?: unknown): DataError =>
  new DataError('not_found', message, details)
