/**
 * 36 §3：数据源接没接从真实连接算，不是写死的一张表（WP20）。
 */
import { describe, expect, it } from 'vitest'
import {
  ALL_DATA_SOURCES,
  dataSourcesFromConnections,
  dataSourcesOfService,
  mergeDataSources,
} from '../src/index.js'

describe('service → 数据源', () => {
  it('我们的 provider id 与上游 service 名都认得', () => {
    expect(dataSourcesOfService('shopify_admin')).toEqual(['shop'])
    expect(dataSourcesOfService('ga4')).toEqual(['ga4'])
    expect(dataSourcesOfService('google_analytics')).toEqual(['ga4'])
    expect(dataSourcesOfService('gsc')).toEqual(['gsc'])
    expect(dataSourcesOfService('google_search_console')).toEqual(['gsc'])
    expect(dataSourcesOfService('meta_ads')).toEqual(['ads'])
    // 邮箱不喂任何工作台数据源
    expect(dataSourcesOfService('imap_smtp')).toEqual([])
    expect(dataSourcesOfService('随便什么')).toEqual([])
  })
})

describe('dataSourcesFromConnections', () => {
  it('一条都没连：只有我们自己的那几个库是连上的，其余全「去连接」', () => {
    const rows = dataSourcesFromConnections([])
    expect(rows.map((r) => r.id)).toEqual([...ALL_DATA_SOURCES])
    // WP67：红人库也在这台机器上（六张表），跟工作队列一样没有"去连接"这回事。
    // WP72：社媒库同理（四张表）——内容日历上那几条是我们自己排的，
    // 一个平台都没连也照样在那儿摆着；渠道那八个源才是"连没连"的事。
    // WP76：设计库同理（三张表）。而且设计岗位**一个渠道源都没有**——
    // 出图走模型网关的图片槽，连接页上根本没有一张"图片模型"的卡可以点。
    expect(rows.filter((r) => r.connected).map((r) => r.id)).toEqual([
      'approvals',
      'kol',
      'social',
      'design',
    ])
    // 没连上就别给「查看完整报告」外链
    expect(rows.find((r) => r.id === 'shop')?.report_url).toBeUndefined()
  })

  // WP62（51 §1 N0 ③）：「没连」与「还没做」是两回事
  it('平台我们还没接：店铺后台永远算没连、带一句人话、不给外链', () => {
    const rows = dataSourcesFromConnections([{ service: 'shopify_admin', status: 'active' }], {
      storefrontNote: '这个平台还没接：你们的网站是用 WooCommerce 搭的。',
    })
    const shop = rows.find((r) => r.id === 'shop')
    // 库里明明连着一条 Shopify，但这个工作区的网站不是它搭的
    expect(shop?.connected).toBe(false)
    expect(shop?.note).toContain('还没接')
    // 「还没做」不给「查看完整报告」：点进去也不是他们的后台
    expect(shop?.report_url).toBeUndefined()
    // 别的数据源一个字都不变
    expect(rows.find((r) => r.id === 'approvals')?.connected).toBe(true)
    expect(rows.find((r) => r.id === 'ga4')?.note).toBeUndefined()
  })

  it('连上 Shopify：店铺后台亮起来并带上外链', () => {
    const rows = dataSourcesFromConnections([{ service: 'shopify_admin', status: 'active' }])
    expect(rows.find((r) => r.id === 'shop')?.connected).toBe(true)
    expect(rows.find((r) => r.id === 'shop')?.report_url).toContain('shopify')
    expect(rows.find((r) => r.id === 'ga4')?.connected).toBe(false)
  })

  it('要重新授权的连接算没连——不出一个永远是 0 的数字块', () => {
    expect(
      dataSourcesFromConnections([{ service: 'shopify_admin', status: 'reauth_required' }]).find(
        (r) => r.id === 'shop',
      )?.connected,
    ).toBe(false)
    expect(
      dataSourcesFromConnections([{ service: 'shopify_admin', status: 'disabled' }]).find(
        (r) => r.id === 'shop',
      )?.connected,
    ).toBe(false)
    // 没给 status 的按连上算（上游只给了 service 的场合）
    expect(
      dataSourcesFromConnections([{ service: 'shopify_admin' }]).find((r) => r.id === 'shop')
        ?.connected,
    ).toBe(true)
  })

  it('只要某几个源时按传进来的顺序出', () => {
    const rows = dataSourcesFromConnections([{ service: 'ga4' }], { sources: ['ga4', 'gsc'] })
    expect(rows.map((r) => [r.id, r.connected])).toEqual([
      ['ga4', true],
      ['gsc', false],
    ])
  })
})

describe('mergeDataSources：只加不减', () => {
  const base = [
    { id: 'shop' as const, label: '店铺后台', connected: true },
    { id: 'ga4' as const, label: 'GA4', connected: false },
    { id: 'csat' as const, label: '满意度调查', connected: false },
  ]

  it('底表里已经连上的不会被真实连接打没（demo 的合成世界照常有数）', () => {
    const merged = mergeDataSources(base, [])
    expect(merged.find((s) => s.id === 'shop')?.connected).toBe(true)
  })

  it('真实连接把别的源点亮', () => {
    const merged = mergeDataSources(base, [{ service: 'ga4', status: 'active' }])
    expect(merged.find((s) => s.id === 'ga4')?.connected).toBe(true)
    expect(merged.find((s) => s.id === 'ga4')?.report_url).toContain('analytics')
    expect(merged.find((s) => s.id === 'csat')?.connected).toBe(false)
  })

  it('底表里没有的源不会凭空冒出来', () => {
    const merged = mergeDataSources(base, [{ service: 'meta_ads' }])
    expect(merged.map((s) => s.id)).toEqual(['shop', 'ga4', 'csat'])
  })
})
