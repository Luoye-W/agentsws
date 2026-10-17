/**
 * WP381：体检四块与 AI 来源流量那一块——只列有问题的行、没体检过一行「还没体检」、来源流量标「实测」。
 */
import type { AiTrafficSummary, SiteHealthRun } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { blocksForRole, runQuery } from '../src/index.js'
import type { TableResult } from '../src/types.js'
import { queryContext, SOURCES } from './fixtures.js'

const RUN: SiteHealthRun = {
  id: 'shr_1',
  started_at: '2026-10-17T08:00:00.000Z',
  finished_at: '2026-10-17T08:01:00.000Z',
  status: 'ok',
  origin: 'https://nordvolt.example',
  robots: { state: 'found', crawler_list_version: '2026-10-17' },
  crawlers: [
    {
      token: 'OAI-SearchBot',
      vendor: 'OpenAI',
      purpose: 'search',
      platform: 'ChatGPT',
      state: 'allowed',
    },
    {
      token: 'PerplexityBot',
      vendor: 'Perplexity',
      purpose: 'search',
      platform: 'Perplexity',
      state: 'partial',
      rule: '#19 Disallow: /products/',
      blocked_paths: ['/products/'],
    },
    {
      token: 'GPTBot',
      vendor: 'OpenAI',
      purpose: 'training',
      state: 'blocked',
      rule: '#15 Disallow: /',
    },
    { token: 'CCBot', vendor: 'Common Crawl', purpose: 'training', state: 'allowed' },
  ],
  render: 'done',
  raw_html: [
    {
      url: 'https://nordvolt.example/products/pb',
      page: 'product',
      fact: 'price',
      expected: '49.99',
      raw: 'absent',
      rendered: 'present',
      verdict: 'js_only',
    },
    {
      url: 'https://nordvolt.example/products/pb',
      page: 'product',
      fact: 'return_policy',
      expected: '30 days',
      raw: 'present',
      rendered: 'present',
      verdict: 'ok',
    },
  ],
  products: {
    checked: 1,
    issues: [
      {
        product_id: 'p1',
        product_title: 'Power Bank',
        handle: 'pb',
        field: 'price',
        source: 'jsonld',
        kind: 'mismatch',
        expected: '49.99',
        found: '44.99',
        severity: 'high',
      },
    ],
    dating: [],
  },
  chatgpt_shopping: {
    verdict: 'almost',
    spec_read_at: '2026-10-17',
    fields: [
      { field: 'title', requirement: 'required', covered: 1, total: 1, state: 'ok' },
      {
        field: 'seller_tos',
        requirement: 'conditional',
        covered: 0,
        total: 1,
        state: 'missing',
        fix: '后台补服务条款页',
      },
      {
        field: 'gtin',
        requirement: 'optional',
        covered: 0,
        total: 1,
        state: 'missing',
        fix: '条码',
      },
    ],
  },
  notes: [],
  dispatched: { matter_id: 'mat_9', at: '2026-10-17T08:01:00.000Z', issues: 1 },
}

const TRAFFIC: AiTrafficSummary = {
  measured: true,
  since: '2026-10-11T00:00:00.000Z',
  until: '2026-10-17T23:59:59.000Z',
  currency: 'USD',
  rows: [{ platform: 'ChatGPT', orders: 2, revenue: 99.98 }],
  total_orders: 10,
  ai_orders: 2,
  ai_revenue: 99.98,
  visits: 'no_scope',
  computed_at: '2026-10-17T08:00:00.000Z',
}

const table = (name: string, over = {}): TableResult => {
  const r = runQuery(
    name,
    queryContext({
      sources: [...SOURCES, { id: 'site', label: '建站', connected: true }],
      ...over,
    }),
    'last_7d',
  )
  if (r.status !== 'ok') throw new Error(r.status)
  return r.data as TableResult
}

describe('WP381 体检报表块', () => {
  it('网站运营四块、建站两块、内容与搜索多一块 AI 来源流量；体检块头带「现在体检」', () => {
    const ids = (role: string) => blocksForRole(role as never).map((b) => b.id)
    expect(ids('dtc.store')).toEqual(
      expect.arrayContaining([
        'site.health.products',
        'site.health.chatgpt',
        'site.health.crawlers',
        'site.health.raw_html',
      ]),
    )
    expect(ids('site.shopify-build')).toContain('site.health.crawlers')
    expect(ids('site.shopify-build')).not.toContain('site.health.products')
    expect(ids('dtc.content')).toContain('seo.ai_traffic')
    const b = blocksForRole('dtc.store' as never).find((x) => x.id === 'site.health.products')
    expect(b?.rerun).toEqual({ path: '/v1/site-health/run', label: '现在体检' })
  })

  it('没体检过：一行「还没体检」，不出空表', () => {
    for (const q of [
      'site.ai_crawlers',
      'site.raw_html',
      'site.product_facts',
      'site.chatgpt_shopping',
    ])
      expect(Object.values(table(q).rows[0] ?? {})[0]).toBe('还没体检')
    expect(table('seo.ai_traffic').rows[0]?.platform).toBe('还没算')
  })

  it('爬虫：搜索类全列、训练类只列挡了的；原始 HTML 只列有问题的', () => {
    const t = table('site.ai_crawlers', { site_health: { run: RUN } })
    expect(t.rows.map((r) => r.state)).toEqual(['放行', '挡了一部分', '挡了'])
    expect(t.rows[1]?.why).toBe('#19 Disallow: /products/')
    const raw = table('site.raw_html', { site_health: { run: RUN } })
    expect(raw.rows).toEqual([{ page: '/products/pb', fact: '价格 49.99', state: '只靠 JS' }])
  })

  it('商品不一致：一行一条，派出去了页脚给「看那件事」；ChatGPT 购物只列必填 / 条件项', () => {
    const t = table('site.product_facts', { site_health: { run: RUN } })
    expect(t.rows[0]).toEqual({
      product: 'Power Bank',
      where: '结构化数据',
      what: '价格不一致',
      found: '44.99',
      expected: '49.99',
    })
    expect(t.footer).toMatchObject({ href: '/matters/mat_9', link_label: '看那件事' })
    const c = table('site.chatgpt_shopping', { site_health: { run: RUN } })
    expect(c.rows.map((r) => r.field)).toEqual(['结论：差一点', 'seller_tos'])
  })

  it('AI 来源流量：标「实测」与占比；没连店就「去连接」', () => {
    const t = table('seo.ai_traffic', { site_health: { ai_traffic: TRAFFIC } })
    expect(t.rows).toEqual([{ platform: 'ChatGPT', visits: '', orders: 2, revenue: 99.98 }])
    expect(t.footer?.text).toContain('实测')
    expect(t.footer?.text).toContain('占全部成交 20%')
    const off = runQuery(
      'seo.ai_traffic',
      queryContext({
        sources: SOURCES.map((s) => (s.id === 'shop' ? { ...s, connected: false } : s)),
        site_health: { ai_traffic: TRAFFIC },
      }),
      'last_7d',
    )
    expect(off.status).toBe('not_connected')
  })
})
