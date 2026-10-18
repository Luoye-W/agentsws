import { describe, expect, it } from 'vitest'
import {
  COMPETITOR_STORE_ROUTE_TEXT,
  COMPETITOR_STORE_TARGET,
  type CompetitorStorePlan,
  type CompetitorStoreRoute,
} from '../src/index.js'

describe('WP393 店铺管理「竞品动向」契约', () => {
  it('每条路都有一句中英文人话，不提任何实现名 / 供应商名', () => {
    const routes: CompetitorStoreRoute[] = [
      'direct',
      'browser',
      'unsupported',
      'blocked',
      'unreachable',
    ]
    for (const r of routes) {
      const t = COMPETITOR_STORE_ROUTE_TEXT[r]
      expect(t.zh).not.toBe('')
      expect(t.en).not.toBe('')
      expect(`${t.zh} ${t.en}`).not.toMatch(/feedsmith|shopify|woocommerce|apify|keepa/i)
    }
    expect(COMPETITOR_STORE_ROUTE_TEXT.unsupported.zh).toBe('这家网站暂时读不了商品数据')
  })

  it('方案卡的设置目标 id 固定；规则全是可选（不预设）', () => {
    expect(COMPETITOR_STORE_TARGET).toBe('store.competitor_watch')
    const plan: CompetitorStorePlan = {
      rules: {},
      pairs: [],
      confirmed_at: '2026-10-18T00:00:00.000Z',
    }
    expect(Object.keys(plan.rules)).toHaveLength(0)
  })
})
