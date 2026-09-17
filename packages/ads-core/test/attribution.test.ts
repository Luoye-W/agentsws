/**
 * WP75（57 §1）：归因两列**永不合并**。
 *
 * 这个文件里最要紧的一条是"平台报了、订单一单都找不到"那一行**照样出现在表里**：
 * 把它筛掉，UTM 没挂对这件事就永远不会被发现。
 */
import { describe, expect, it } from 'vitest'
import {
  ADS_UTM_MEDIUM,
  adsPlatformOfUrl,
  attributeAds,
  attributionGapPct,
  roasBothViews,
} from '../src/index.js'

const OBSERVED = '2026-09-17T10:00:00Z'
const url = (source: string, campaign: string, medium = ADS_UTM_MEDIUM) =>
  `https://nordvolt.example/desk?utm_source=${source}&utm_medium=${medium}&utm_campaign=${campaign}`

describe('adsPlatformOfUrl', () => {
  it('认得出四个平台（facebook / instagram 都算 meta）', () => {
    expect(adsPlatformOfUrl(url('meta', 'sep'))).toBe('meta')
    expect(adsPlatformOfUrl(url('instagram', 'sep'))).toBe('meta')
    expect(adsPlatformOfUrl(url('google', 'sep'))).toBe('google')
    expect(adsPlatformOfUrl(url('tiktok', 'sep'))).toBe('tiktok')
  })

  it('**不认**红人那条口径（`utm_medium=kol`）—— 认了就把别人带来的单算到广告头上', () => {
    expect(adsPlatformOfUrl(url('youtube', 'sep', 'kol'))).toBeUndefined()
  })

  it('半份 UTM 归不了因', () => {
    expect(adsPlatformOfUrl('https://nordvolt.example/desk?utm_source=meta')).toBeUndefined()
    expect(adsPlatformOfUrl('不是个链接')).toBeUndefined()
  })
})

describe('attributeAds', () => {
  const platform_rows = [
    {
      platform: 'meta' as const,
      campaign: 'sep-desk',
      spend: 400,
      conversions: 18,
      conversion_value: 3600,
    },
    {
      platform: 'google' as const,
      campaign: 'brand',
      spend: 100,
      conversions: 6,
      conversion_value: 900,
    },
  ]

  it('两列并排，谁也不改谁（平台 18 / 订单 11 都留着）', () => {
    const orders = Array.from({ length: 11 }, (_, i) => ({
      order_id: `ord_${i}`,
      landing_url: url('meta', 'sep-desk'),
      amount: 200,
      created_at: OBSERVED,
    }))
    const out = attributeAds({ platform_rows, orders, observed_at: OBSERVED })
    const row = out.rows.find((r) => r.campaign === 'sep-desk')
    expect(row?.platform_conversions).toBe(18)
    expect(row?.order_conversions).toBe(11)
    expect(row?.order_value).toBe(2200)
    // 没有任何一格叫"真实转化数"
    expect(Object.keys(row ?? {})).not.toContain('conversions')
  })

  it('平台报了、订单一单都没找到的那一行**照样出**（0 不是"筛掉"）', () => {
    const out = attributeAds({ platform_rows, orders: [], observed_at: OBSERVED })
    expect(out.rows).toHaveLength(2)
    expect(out.rows.every((r) => r.order_conversions === 0)).toBe(true)
  })

  it('订单那一侧有、平台那一侧没报的 campaign 也出一行（多半是改了名）', () => {
    const out = attributeAds({
      platform_rows,
      orders: [
        { order_id: 'o1', landing_url: url('meta', 'old-name'), amount: 99, created_at: OBSERVED },
      ],
      observed_at: OBSERVED,
    })
    expect(out.rows.map((r) => r.campaign)).toContain('old-name')
  })

  it('归不上的订单进 `unmatched`，而且各有各的原因 —— **绝不按时间窗口猜**', () => {
    const out = attributeAds({
      platform_rows,
      orders: [
        { order_id: 'o1', amount: 99, created_at: OBSERVED },
        {
          order_id: 'o2',
          landing_url: 'https://nordvolt.example/desk',
          amount: 99,
          created_at: OBSERVED,
        },
        {
          order_id: 'o3',
          landing_url: url('youtube', 'sep', 'kol'),
          amount: 99,
          created_at: OBSERVED,
        },
      ],
      observed_at: OBSERVED,
    })
    expect(out.unmatched).toHaveLength(3)
    expect(out.unmatched[0]?.reason).toContain('没有落地页链接')
    expect(out.unmatched[1]?.reason).toContain('UTM')
    expect(out.unmatched[2]?.reason).toContain('不是广告投放的口径')
    // 一张都没被分摊到 campaign 上
    expect(out.rows.every((r) => r.order_conversions === 0)).toBe(true)
  })

  it('campaign 名大小写不一致照样对得上（平台那边与 UTM 那边常常不一样）', () => {
    const out = attributeAds({
      platform_rows: [{ platform: 'meta', campaign: 'Sep-Desk', conversions: 3 }],
      orders: [
        { order_id: 'o1', landing_url: url('meta', 'sep-desk'), amount: 50, created_at: OBSERVED },
      ],
      observed_at: OBSERVED,
    })
    expect(out.rows).toHaveLength(1)
    expect(out.rows[0]?.order_conversions).toBe(1)
  })
})

describe('两个数差多少 / 两个 ROAS', () => {
  const row = {
    platform: 'meta' as const,
    campaign: 'sep',
    platform_conversions: 18,
    platform_value: 3600,
    order_conversions: 11,
    order_value: 2200,
    spend: 400,
    observed_at: OBSERVED,
  }

  it('差多少只是给人看的一个数，两列一格都没动', () => {
    expect(attributionGapPct(row)).toBeCloseTo(63.6, 1)
    expect(row.platform_conversions).toBe(18)
  })

  it('两边都没数 → undefined（"一样多"与"都没数"要分得开）', () => {
    expect(
      attributionGapPct({ platform: 'x', campaign: 'c', observed_at: OBSERVED }),
    ).toBeUndefined()
  })

  it('ROAS 也是两个数，不合并', () => {
    expect(roasBothViews(row)).toEqual({ platform: 9, order: 5.5 })
  })

  it('没花钱就不除（`Infinity` 摆在面板上没有意义）', () => {
    expect(roasBothViews({ ...row, spend: 0 })).toEqual({})
  })
})
