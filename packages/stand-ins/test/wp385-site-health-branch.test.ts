/**
 * WP385：stub 剧本——工具面里有 `query_site_health` 时，话里给了 feed / 平台上架页网址 → 要一张体检设置卡
 * （`request_setup` + `site.health` + 建议值）；问体检 → 读结论；别的话一个字节不变（不进这个岔口）。
 */
import type { RunRequest } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { renderSiteHealthAnswer, siteHealthBranch } from '../src/runtime/site-health.js'

const req = (allow: string[]): RunRequest => ({ tools: { allow } }) as unknown as RunRequest
const BOTH = ['query_site_health', 'request_setup']

describe('WP385 stub 剧本：网站体检', () => {
  it('feed 地址 → 体检设置卡（feed_url）', () => {
    expect(
      siteHealthBranch(req(BOTH), '我们的 Google 商品 feed 是 https://feeds.a.example/g.xml。'),
    ).toEqual({
      kind: 'setup',
      tool: 'request_setup',
      input: {
        setting: 'site.health',
        why: '按你说的记进体检设置。',
        suggestions: [
          { key: 'feed_url', value: 'https://feeds.a.example/g.xml', why: '你刚才说的' },
        ],
      },
    })
  })
  it('Amazon 上架页 → 加一条上架页（商品从店里商品网址或「商品是 …」认）', () => {
    const a = siteHealthBranch(
      req(BOTH),
      'Amazon 上架页是 https://www.amazon.com/dp/B0TEST01，对应 https://a.example/products/power-bank-20000',
    )
    expect(a?.input).toMatchObject({
      suggestions: [
        {
          key: 'listings_add',
          value: 'Amazon | power-bank-20000 | https://www.amazon.com/dp/B0TEST01',
        },
      ],
    })
    const b = siteHealthBranch(
      req(BOTH),
      '沃尔玛上架页 https://www.walmart.com/ip/1 商品是 cable-c',
    )
    expect(b?.input).toMatchObject({
      suggestions: [
        { key: 'listings_add', value: 'Walmart | cable-c | https://www.walmart.com/ip/1' },
      ],
    })
  })
  it('问体检 → 读结论；工具面里没有它 / 别的话 → 不进岔口', () => {
    expect(siteHealthBranch(req(BOTH), '我们站 AI 爬虫进得来吗？')).toMatchObject({
      kind: 'query',
      tool: 'query_site_health',
    })
    expect(siteHealthBranch(req(['request_setup']), '我们站 AI 爬虫进得来吗？')).toBeUndefined()
    expect(siteHealthBranch(req(BOTH), '帮我写一篇博客')).toBeUndefined()
  })
  it('回话：结论一句 + 被挡的爬虫 + 对不上的几条 + AI 带来的成交（实测）', () => {
    const text = renderSiteHealthAnswer({
      ok: true,
      message: '2026-10-18 体检：1 个 AI 爬虫被挡。',
      crawlers: {
        blocked: [{ token: 'PerplexityBot', purpose: 'search', state: 'partial' }],
        training_blocked: [],
        allowed: 17,
      },
      products: {
        checked: 5,
        issues: [{ line: '「A」结构化数据的价格写的是 1，后台是 2', severity: 'high' }],
      },
      ai_traffic: {
        measured: true,
        since: 'a',
        until: 'b',
        currency: 'USD',
        ai_orders: 3,
        ai_revenue: 99.7,
        total_orders: 5,
        visits: 'no_scope',
        rows: [],
      },
    })
    expect(text).toContain('PerplexityBot（AI 搜索，挡了一部分）')
    expect(text).toContain('商品信息对不上 1 处')
    expect(text).toContain('AI 带来 3 单 / USD 99.70（实测）')
    expect(renderSiteHealthAnswer(undefined, '没接')).toBe('没读到体检结论：没接。')
  })
})
