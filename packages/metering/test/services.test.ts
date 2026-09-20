/*
 * 增值服务的登记表（67 §3）。
 *
 * 两张表（`subscriptions.json` 与 `pricing.json`）写着同一件事，所以这里钉住的是
 * **它们不许分岔**：界面上显示 30 积分、实际扣 50 的那种错，在界面上一点都看不出来。
 */
import { KOL_SERVICE_ID, SUPPORT_SERVICE_ID } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { buildPricing } from '../src/pricing.js'
import {
  availableSubscriptionServices,
  subscriptionPricingGaps,
  subscriptionServiceById,
  subscriptionServices,
} from '../src/services.js'

describe('订阅服务登记表', () => {
  it('两个服务都登记上了，同价 30 积分 / 月（Luoye 2026-09-19 定）', () => {
    const ids = subscriptionServices().map((s) => s.id)
    expect(ids).toContain(KOL_SERVICE_ID)
    expect(ids).toContain(SUPPORT_SERVICE_ID)
    for (const id of ids) expect(subscriptionServiceById(id)?.credits_per_month).toBe(30)
  })

  it('客服那个只登记不接业务：available=false，不进「可开通」的列表', () => {
    expect(subscriptionServiceById(SUPPORT_SERVICE_ID)?.available).toBe(false)
    expect(availableSubscriptionServices().map((s) => s.id)).toEqual([KOL_SERVICE_ID])
  })

  it('认不出的 id 回 undefined，不退到某个默认服务', () => {
    expect(subscriptionServiceById('nope.monthly')).toBeUndefined()
  })

  it('登记表与价目表一条都不许分岔（同名 + 同价）', () => {
    expect(subscriptionPricingGaps(buildPricing())).toEqual([])
  })

  it('价目表里少一条 / 价钱对不上，自检要报出来（不是静默放过）', () => {
    const pricing = buildPricing()
    const short = {
      ...pricing,
      entries: pricing.entries
        .filter((e) => e.capability !== SUPPORT_SERVICE_ID)
        .map((e) => (e.capability === KOL_SERVICE_ID ? { ...e, credits_per_unit: 50 } : e)),
    }
    expect(subscriptionPricingGaps(short)).toEqual([
      { id: KOL_SERVICE_ID, kind: 'mismatch', expected: 30, got: 50 },
      { id: SUPPORT_SERVICE_ID, kind: 'missing', expected: 30 },
    ])
  })
})
