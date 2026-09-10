/** 与 28 §2 统一错误码对齐的包内错误（网关照着 `code` 映射 HTTP 状态）。 */
export type SecretaryErrorCode =
  | 'not_found'
  | 'forbidden'
  | 'conflict'
  | 'invalid_input'
  | 'not_implemented'

export class SecretaryError extends Error {
  readonly code: SecretaryErrorCode
  readonly details: unknown

  constructor(code: SecretaryErrorCode, message: string, details?: unknown) {
    super(message)
    this.name = 'SecretaryError'
    this.code = code
    this.details = details
  }
}

export const notFound = (what: string, id: string): SecretaryError =>
  new SecretaryError('not_found', `${what}不存在：${id}`)
