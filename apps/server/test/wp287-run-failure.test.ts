/**
 * WP287：没跑成时给人看的那一句——内部错一句通用人话，登录 / 余额这类上游原话照用，不露原始错误。
 */
import { describe, expect, it } from 'vitest'
import { INTERNAL_FAILURE_TEXT, runFailureLine, runFailureText } from '../src/run-failure.js'

describe('WP287 runFailureText', () => {
  it('内部错 / 参数表不认 → 通用人话，不带原文', () => {
    const text = runFailureText({ code: 'internal', message: 'tools[3].input_schema: bad' })
    expect(text).toBe(INTERNAL_FAILURE_TEXT)
    expect(runFailureLine({ code: 'invalid_input', message: 'x' })).toBe(
      `没跑成：${INTERNAL_FAILURE_TEXT}`,
    )
  })
  it('登录过期：上游那句本来就是给人看的', () => {
    expect(
      runFailureText({ code: 'unauthenticated', message: 'DeepSeek 账号的登录过期了，去重新登录' }),
    ).toBe('DeepSeek 账号的登录过期了，去重新登录')
  })
  it('模型忙 / 超时 / 格式异常 / 额度', () => {
    expect(runFailureText({ code: 'rate_limited', message: '429' })).toContain('稍后再试')
    expect(runFailureText({ code: 'timeout', message: 'ETIMEDOUT' })).toContain('稍后再试')
    expect(runFailureText({ code: 'provider_error', message: 'x' })).toContain('重试')
    expect(runFailureText({ code: 'budget_exhausted', message: 'x' })).toContain('额度')
  })
})
