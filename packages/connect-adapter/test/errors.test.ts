import { describe, expect, it } from 'vitest'
import { ConnectAdapterError, isConnectAdapterError, mapRuntimeError } from '../src/index.js'

/**
 * 错误码映射。表里的每一条 errorCode / HTTP 状态都是 09-09 对真
 * `ghcr.io/oomol-lab/open-connector` 容器实测出来的，不是照文档抄的。
 */
describe('OpenConnector 错误 → 契约 ErrorCode', () => {
  it('实测过的真实组合', () => {
    const cases: [{ status: number; errorCode?: string }, string][] = [
      // 无 bearer / bearer 不对：`{"error":{"code":"unauthorized"}}` + 401
      [{ status: 401, errorCode: 'unauthorized' }, 'unauthenticated'],
      // token 的 allowedConnections 没有这条连接：403
      [{ status: 403, errorCode: 'connection_not_allowed' }, 'connection_not_allowed'],
      // 不在 allowedActions：**上游给的是 400**，只看状态会误判成 invalid_input
      [{ status: 400, errorCode: 'action_not_allowed' }, 'forbidden'],
      // 目录里没有这个 Action：404
      [{ status: 404, errorCode: 'unknown_action' }, 'not_found'],
      // 幂等键换了请求：409
      [{ status: 409, errorCode: 'idempotency_key_conflict' }, 'idempotency_conflict'],
      [{ status: 409, errorCode: 'idempotency_request_in_progress' }, 'idempotency_conflict'],
      // 上游限流：429
      [{ status: 429, errorCode: 'rate_limited' }, 'rate_limited'],
      // 上游 5xx：runtime 给 500 + provider_error
      [{ status: 500, errorCode: 'provider_error' }, 'provider_error'],
      // 上游 401（连接的凭据坏了）：runtime 给的是 **403 authorization_failed**，
      // 这不是"我们没鉴权"，所以不能映射成 unauthenticated
      [{ status: 403, errorCode: 'authorization_failed' }, 'provider_error'],
      // 输入不合 schema：400
      [{ status: 400, errorCode: 'invalid_input' }, 'invalid_input'],
      // BLOCKED_PROXIES=* 时：403 proxy_blocked
      [{ status: 403, errorCode: 'proxy_blocked' }, 'forbidden'],
    ]
    for (const [failure, expected] of cases) {
      expect(mapRuntimeError(failure).code, JSON.stringify(failure)).toBe(expected)
    }
  })

  it('没有 errorCode 时退回按 HTTP 状态映射', () => {
    const byStatus: [number, string][] = [
      [401, 'unauthenticated'],
      [403, 'forbidden'],
      [404, 'not_found'],
      [409, 'idempotency_conflict'],
      [429, 'rate_limited'],
      [504, 'timeout'],
      [502, 'provider_error'],
      [400, 'invalid_input'],
      [0, 'provider_unavailable'],
      [302, 'internal'],
    ]
    for (const [status, expected] of byStatus) {
      expect(mapRuntimeError({ status }).code, String(status)).toBe(expected)
    }
  })

  it('未知的上游 errorCode 退回状态码，并把原码放进 details', () => {
    const err = mapRuntimeError({ status: 418, errorCode: 'brand_new_upstream_code', message: 'x' })
    expect(err.code).toBe('internal')
    expect(err.details).toMatchObject({
      http_status: 418,
      runtime_error_code: 'brand_new_upstream_code',
    })
  })

  it('ConnectAdapterError 带 status，isConnectAdapterError 认得出来', () => {
    const e = new ConnectAdapterError('rate_limited', '慢点')
    expect(e.status).toBe(429)
    expect(isConnectAdapterError(e)).toBe(true)
    expect(isConnectAdapterError(new Error('x'))).toBe(false)
  })
})
