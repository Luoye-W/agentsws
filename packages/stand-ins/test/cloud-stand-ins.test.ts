/**
 * WP165：云端契约替身——钱包与公共红人库的几条口径（docs/49 §3、docs/48 §5.3、docs/77）。
 */
import { catalogCreditsFor, isPricingCatalog } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  bonusExpiresAtOf,
  KolPublicStandIn,
  SAMPLE_PRICING_CATALOG,
  SAMPLE_SIGNUP_BONUS,
  StandInWallet,
} from '../src/index.js'

const T0 = '2026-09-27T01:00:00.000Z'
let seq = 0
const newId = (p: string): string => `${p}_${String(++seq)}`
const principal = {
  account_id: 'acc_1',
  org_id: 'org_1',
  workspace_id: 'ws_1',
  scopes: ['data'],
  region: 'global' as const,
}

describe('价目样例', () => {
  it('长得像一份价目：三块都有、四个充值档、1 美元 7 积分', () => {
    expect(isPricingCatalog(SAMPLE_PRICING_CATALOG)).toBe(true)
    expect(SAMPLE_PRICING_CATALOG.topup_tiers.tiers).toHaveLength(4)
    expect(SAMPLE_PRICING_CATALOG.topup_tiers.credits_per_usd).toBe(7)
    expect(catalogCreditsFor(SAMPLE_PRICING_CATALOG.pricing, 'data.kol.lookup')).toBeGreaterThan(0)
    expect(catalogCreditsFor(SAMPLE_PRICING_CATALOG.pricing, 'no.such')).toBeUndefined()
  })
})

describe('钱包替身', () => {
  it('先扣有期限的；到期清零；余额不够只拒这一次、一分不扣', () => {
    let now = T0
    const w = new StandInWallet({ now: () => now, newId })
    const expires_at = bonusExpiresAtOf(SAMPLE_SIGNUP_BONUS, T0)
    w.topup({ org_id: 'o', credits: 10, kind: 'granted', expires_at, source_ref: 'b:1' })
    w.topup({ org_id: 'o', credits: 10, kind: 'granted', expires_at, source_ref: 'b:1' })
    w.topup({ org_id: 'o', credits: 5, kind: 'purchased' })
    expect(w.balance('o').available).toBe(15)
    const r = w.reserve({
      org_id: 'o',
      workspace_id: 'w',
      capability: 'x',
      unit: 'call',
      quantity: 1,
      credits: 3,
      request_id: 'r1',
    })
    expect(w.balance('o').reserved).toBe(3)
    w.settle(r, { quantity: 1, credits: 3 })
    expect(w.balance('o')).toMatchObject({ granted: 7, purchased: 5, available: 12 })
    expect(() =>
      w.reserve({
        org_id: 'o',
        workspace_id: 'w',
        capability: 'x',
        unit: 'call',
        quantity: 1,
        credits: 100,
        request_id: 'r2',
      }),
    ).toThrow(/积分不够了/)
    expect(w.balance('o').available).toBe(12)
    now = '2027-01-01T00:00:00.000Z'
    expect(w.balance('o')).toMatchObject({ granted: 0, purchased: 5 })
  })
})

describe('公共红人库替身', () => {
  it('浏览按次收、取回联系方式另收；账上 0 就被拦、一分不扣', () => {
    const wallet = new StandInWallet({ now: () => T0, newId })
    const kol = new KolPublicStandIn({ wallet, now: () => T0, newId })
    kol.contributeAs(principal, [
      { channel: 'youtube', handle: 'Kevin', followers: 1000, observed_at: T0 },
    ])
    expect(() => kol.browse(principal, { channel: 'youtube' })).toThrow(/积分不够了/)
    kol.saveContact({}, { channel: 'youtube', handle: 'kevin' }, { email: 'k@example.test' })
    wallet.topup({ org_id: 'org_1', credits: 100, kind: 'purchased' })
    const browsed = kol.browse(principal, { channel: 'youtube' })
    expect(browsed.creators[0]?.has_contact).toBe(true)
    expect(browsed.credits).toBe(
      catalogCreditsFor(SAMPLE_PRICING_CATALOG.pricing, 'data.kol.lookup'),
    )
    const revealed = kol.reveal(principal, { channel: 'youtube', handle: 'kevin' })
    expect(revealed.email).toBe('k@example.test')
    expect(revealed.credits).toBe(
      catalogCreditsFor(SAMPLE_PRICING_CATALOG.pricing, 'data.kol.reveal'),
    )
  })

  it('搜到 0 条不收；没联系方式不收；同一查询 10 分钟内翻页不重复收', () => {
    const wallet = new StandInWallet({ now: () => T0, newId })
    wallet.topup({ org_id: 'org_1', credits: 10, kind: 'purchased' })
    const kol = new KolPublicStandIn({ wallet, now: () => T0, newId })
    expect(kol.browse(principal, { q: 'nobody' }).credits).toBe(0)
    kol.contributeAs(principal, [{ channel: 'x', handle: 'amy', followers: 5, observed_at: T0 }])
    expect(() => kol.reveal(principal, { channel: 'x', handle: 'amy' })).toThrow(/不收钱/)
    expect(kol.browse(principal, { q: 'amy' }).credits).toBeGreaterThan(0)
    expect(kol.browse(principal, { q: 'amy', limit: 5 }).credits).toBe(0)
    expect(wallet.balance('org_1').available).toBe(
      10 - (catalogCreditsFor(SAMPLE_PRICING_CATALOG.pricing, 'data.kol.lookup') ?? 0),
    )
  })
})
