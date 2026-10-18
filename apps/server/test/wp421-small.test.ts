/**
 * WP421（自查 general）：几处「照实说」的小修——云上没开通的服务不把路由原文给人看。
 */
import { describe, expect, it } from 'vitest'
import { SERVICES_NOT_LIVE, serviceCloudError } from '../src/workshop-services.js'

describe('工坊服务：云上还没这个入口', () => {
  it('404「没有这个入口」/ 501 → 还没上线（不露路由原文）；别的 404 照旧', () => {
    const missing = serviceCloudError(
      { ok: false, status: 404, message: '没有这个入口：GET /v1/services' } as never,
      '取目录',
    )
    expect(missing.message).toBe(SERVICES_NOT_LIVE)
    expect(serviceCloudError({ ok: false, status: 501 } as never, '下单').message).toBe(
      SERVICES_NOT_LIVE,
    )
    expect(
      serviceCloudError({ ok: false, status: 404, message: '没有这一单' } as never, '取单').message,
    ).toBe('没有这一单')
  })
})
