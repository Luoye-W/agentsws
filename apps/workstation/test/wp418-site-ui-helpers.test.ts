/**
 * WP418：几处界面小修的纯函数——「连上{name}」中文名不留空格（U11）、店铺授权一天内到期才提醒（C6）。
 */
import { describe, expect, it } from 'vitest'
import { zhAfterVerb } from '@/components/position/landing-actions'
import { shopAdminExpiringSoon } from '@/components/position/shop-admin-banner'
import type { ShopAdminView } from '@/lib/api'
import { translate } from '@/lib/i18n'

describe('U11 连上{name}', () => {
  it('中文名紧挨着，英文名隔一个空格', () => {
    expect(translate('zh', 'landing.connect', { name: zhAfterVerb('店铺后台') })).toBe(
      '连上店铺后台',
    )
    expect(translate('zh', 'landing.connect', { name: zhAfterVerb('Shopify') })).toBe(
      '连上 Shopify',
    )
  })
})

describe('C6 授权快到期', () => {
  const now = Date.parse('2026-10-19T00:00:00.000Z')
  const v = (extra: Partial<ShopAdminView>): ShopAdminView => ({
    applicable: true,
    state: 'authorized',
    scopes_needed: [],
    scopes_granted: [],
    missing: [],
    ...extra,
  })
  it('一天内到期、不续期才算；会续期 / 已过期 / 还早都不算', () => {
    expect(shopAdminExpiringSoon(v({ expires_at: '2026-10-19T20:00:00.000Z' }), now)).toBe(true)
    expect(
      shopAdminExpiringSoon(v({ expires_at: '2026-10-19T20:00:00.000Z', refreshable: true }), now),
    ).toBe(false)
    expect(shopAdminExpiringSoon(v({ expires_at: '2026-10-18T20:00:00.000Z' }), now)).toBe(false)
    expect(shopAdminExpiringSoon(v({ expires_at: '2026-10-21T00:00:00.000Z' }), now)).toBe(false)
    expect(
      shopAdminExpiringSoon(v({ state: 'expired', expires_at: '2026-10-19T20:00:00.000Z' }), now),
    ).toBe(false)
  })
})
