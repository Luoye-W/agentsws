/**
 * WP75（57 §1）：投放契约那一份平台清单与五个对象的形状。
 *
 * 钉的是三件"写歪了不会报错、只会静悄悄错"的事：平台表与职责 id 对得上、
 * 57 §1 那两个别名指回仓里真有的那个 `ChangeKind`、额度默认值与 57 §6 一个数不差。
 */
import { describe, expect, it } from 'vitest'
import type { ChangeKind } from '../src/index.js'
import {
  AD_PAUSE_REASONS,
  ADS_CHANGE_KINDS,
  ADS_DEFAULT_CAPS,
  ADS_PLATFORM_IDS,
  ADS_PLATFORMS,
  ADS_ROLE_IDS,
  adsPlatformOfRole,
  adsPlatformSpec,
  resolveAdsChangeKind,
} from '../src/index.js'

describe('ADS_PLATFORMS', () => {
  it('四个平台，顺序 = 岗位模板里的摆法（默认勾的两条在前）', () => {
    expect(ADS_PLATFORM_IDS).toEqual(['meta', 'google', 'x', 'tiktok'])
  })

  it('职责 id 由表给，不由调用方现拼', () => {
    expect(ADS_ROLE_IDS).toEqual(['ads.meta', 'ads.google', 'ads.x', 'ads.tiktok'])
    expect(adsPlatformOfRole('ads.google')?.id).toBe('google')
    expect(adsPlatformOfRole('social.meta')).toBeUndefined()
  })

  it('不认识的平台回 undefined —— 不编造一条', () => {
    expect(adsPlatformSpec('pinterest')).toBeUndefined()
  })

  it('Meta 的投放连接器与社媒那张 `meta_graph` 是两张卡（要的权限不一样）', () => {
    expect(adsPlatformSpec('meta')?.connector_kind).toBe('meta_marketing')
  })

  it('WP75 只做 Meta / Google 真实现（57 §2）', () => {
    const done = ADS_PLATFORMS.filter((p) => p.implemented).map((p) => p.id)
    expect(done).toEqual(['meta', 'google'])
  })

  it('每个平台各有各的连接器 kind —— 没有两条共用一张卡', () => {
    const kinds = ADS_PLATFORMS.map((p) => p.connector_kind)
    expect(new Set(kinds).size).toBe(kinds.length)
  })
})

describe('五个 ChangeKind', () => {
  it('五条都是 `ChangeKind` 联合里真有的成员（四条沿用旧名字 + 一条新的）', () => {
    const kinds: readonly ChangeKind[] = ADS_CHANGE_KINDS
    expect(kinds).toEqual([
      'create_campaign',
      'budget_change',
      'bid_change',
      'pause_ad',
      'creative_swap',
    ])
  })

  it('57 §1 那两个写法指回仓里真有的那个名字（同一件事不给第二个名字）', () => {
    expect(resolveAdsChangeKind('campaign_create')).toBe('create_campaign')
    expect(resolveAdsChangeKind('ad_pause')).toBe('pause_ad')
    // 不是别名就原样返回
    expect(resolveAdsChangeKind('creative_swap')).toBe('creative_swap')
  })
})

describe('额度默认值（57 §6）', () => {
  it('六个数与 57 §6 一个字不差', () => {
    expect(ADS_DEFAULT_CAPS).toEqual({
      max_daily_spend: 1000,
      max_budget_delta_pct: 20,
      max_bid_delta_pct: 15,
      stop_loss_roas_below: 1,
      stop_loss_spend_pct: 30,
      max_changes_per_day: 20,
    })
  })

  it('暂停理由是封闭的，而且 `stop_loss` 在里面（只有它能到 L3）', () => {
    expect(AD_PAUSE_REASONS).toContain('stop_loss')
    expect(AD_PAUSE_REASONS).not.toContain('whatever')
  })
})
