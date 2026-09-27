/**
 * WP165（docs/83 §2）：公开价目 `GET /v1/pricing` 从入口 Worker 进。
 *
 * 钉三件事：不要令牌也拿得到；和带令牌的 `/v1/wallet/pricing` 是同一份；带公开缓存头。
 */
import { PRICING_CATALOG_PATH, type PricingCatalog } from '@agentsws/contracts'
import { buildPricing, TOPUP_TIERS_FILE } from '@agentsws/metering'
import { describe, expect, it } from 'vitest'
import { route } from '../src/index.js'
import { fakeCloud, req } from './helpers.js'

describe('WP165 公开价目', () => {
  it('不带令牌 200，价目表 + 充值档位一次给齐，和内置那一份同源；可缓存', async () => {
    const cloud = fakeCloud()
    const res = await route(req(PRICING_CATALOG_PATH), cloud.env)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toMatch(/^public, max-age=\d+$/)
    const { data } = (await res.json()) as { data: PricingCatalog }
    expect(data.version).toBe(1)
    expect(data.pricing).toEqual(buildPricing())
    expect(data.topup_tiers).toEqual(TOPUP_TIERS_FILE)
  })

  it('只认 GET；带着乱填的令牌也照样给（公开的就是公开的）', async () => {
    const cloud = fakeCloud()
    const withJunk = await route(
      req(PRICING_CATALOG_PATH, { headers: { Authorization: 'Bearer nope' } }),
      cloud.env,
    )
    expect(withJunk.status).toBe(200)
    const post = await route(req(PRICING_CATALOG_PATH, { method: 'POST' }), cloud.env)
    expect(post.status).not.toBe(200)
  })
})
