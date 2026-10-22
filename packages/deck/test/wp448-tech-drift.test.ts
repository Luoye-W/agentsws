/**
 * WP448（docs/109 §4.4、§5.1 #1–4）：技术体检、改版回归、抢词三块——只列有问题的；全好一行「都没问题」；
 * 没体检过一行「还没体检」；「今天值得动的 5 件事」里合并车道与分诊的标签。
 */
import type { ApprovalItem, DriftRun, SiteHealthRun } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { blocksForRole, computeReport, DEFAULT_REPORTS, runQuery } from '../src/index.js'
import type { TableResult } from '../src/types.js'
import { queryContext, SOURCES } from './fixtures.js'

const BASE_RUN: SiteHealthRun = {
  id: 'shr_1',
  started_at: '2026-10-22T08:00:00.000Z',
  finished_at: '2026-10-22T08:01:00.000Z',
  status: 'ok',
  origin: 'https://nordvolt.example',
  robots: { state: 'found', crawler_list_version: '2026-10-17' },
  crawlers: [],
  render: 'off',
  raw_html: [],
  products: { checked: 0, issues: [], dating: [] },
  notes: [],
}

const TECH_RUN: SiteHealthRun = {
  ...BASE_RUN,
  tech: {
    checked_at: '2026-10-22T08:01:00.000Z',
    pages: 5,
    indexing: 'not_connected',
    sitemap: 'found',
    hreflang: 'single_market',
    speed: 'lab',
    issues: [
      {
        rule: 'redirect.chain',
        area: 'redirect',
        severity: 'medium',
        owner: 'site.shopify-build',
        url: 'https://nordvolt.example/collections/old-sale',
        detail: '2 跳：/collections/old-sale → /collections/sale-2024 → /collections/sale',
        redirect: { path: '/collections/old-sale', target: '/collections/sale' },
      },
      {
        rule: 'canonical.multiple',
        area: 'canonical',
        severity: 'high',
        owner: 'site.shopify-theme',
        url: 'https://nordvolt.example/products/usb-c-charger',
        detail: '/products/usb-c-charger：写了 2 个',
      },
    ],
    dispatched: [
      {
        owner: 'site.shopify-build',
        matter_id: 'mat_b',
        at: '2026-10-22T08:01:00.000Z',
        issues: 1,
      },
      {
        owner: 'site.shopify-theme',
        matter_id: 'mat_t',
        at: '2026-10-22T08:01:00.000Z',
        issues: 1,
      },
    ],
  },
}

const DRIFT: DriftRun = {
  id: 'drift_1',
  trigger: {
    kind: 'theme_publish',
    change_id: 'chg_9',
    label: '主题发布',
    at: '2026-10-22T09:00:00.000Z',
  },
  started_at: '2026-10-22T09:00:00.000Z',
  finished_at: '2026-10-22T09:00:30.000Z',
  status: 'ok',
  pages: 5,
  findings: [
    {
      rule: 'noindex_added',
      severity: 'critical',
      url: 'https://nordvolt.example/',
      kind: 'home',
      before: 'index, follow',
      after: 'noindex',
      detail: '被设成了不让收录（noindex）',
    },
    {
      rule: 'title_changed',
      severity: 'warning',
      url: 'https://nordvolt.example/products/pb',
      kind: 'product',
      before: 'Power Bank',
      after: 'Power Bank – NordVolt',
      detail: '标题改了',
    },
  ],
  notes: [],
  dispatched: { matter_id: 'mat_d', at: '2026-10-22T09:00:30.000Z' },
}

const table = (name: string, over = {}): TableResult => {
  const r = runQuery(
    name,
    queryContext({
      sources: [
        { id: 'site', label: '建站', connected: true },
        { id: 'gsc', label: 'Search Console', connected: true },
        ...SOURCES,
      ],
      ...over,
    }),
    'last_7d',
  )
  if (r.status !== 'ok') throw new Error(r.status)
  return r.data as TableResult
}

const seoReport = (payload: Record<string, unknown>): ApprovalItem =>
  ({
    id: `apv_${String(payload.variant)}`,
    kind: 'seo_report',
    payload,
    created_at: '2026-10-22T08:00:00.000Z',
    updated_at: '2026-10-22T08:00:00.000Z',
  }) as unknown as ApprovalItem

describe('WP448 面板块', () => {
  it('SEO 与 GEO 多三块；建站两条看技术体检；体检块头带「现在体检」', () => {
    const ids = (role: string) => blocksForRole(role as never).map((b) => b.id)
    expect(ids('dtc.seo')).toEqual(
      expect.arrayContaining(['seo.tech_audit', 'seo.drift', 'seo.cannibalization']),
    )
    expect(ids('site.shopify-build')).toContain('site.health.tech')
    expect(ids('site.shopify-theme')).toContain('site.theme.tech')
    expect(ids('dtc.content')).not.toContain('seo.tech_audit')
    const b = blocksForRole('dtc.seo' as never).find((x) => x.id === 'seo.tech_audit')
    expect(b?.rerun).toEqual({ path: '/v1/site-health/run', label: '现在体检' })
  })

  it('没体检过一行「还没体检」；没比过一行「还没比过」；抢词没查过说每周一次', () => {
    expect(table('site.tech_audit').rows).toEqual([{ issue: '还没体检' }])
    expect(table('site.drift').rows).toEqual([{ page: '还没比过' }])
    expect(table('seo.cannibalization').rows[0]?.queries).toBe('还没查过（每周一次）')
  })

  it('技术体检：只列有问题的，交给谁写明；收录要接 Search Console；已交建站带「看那件事」', () => {
    const t = table('site.tech_audit', { site_health: { run: TECH_RUN } })
    expect(t.rows).toEqual([
      {
        issue: '中 · 跳转与死链',
        where: '2 跳：/collections/old-sale → /collections/sale-2024 → /collections/sale',
        owner: '整站搭建',
      },
      { issue: '高 · 规范网址', where: '/products/usb-c-charger：写了 2 个', owner: '主题' },
    ])
    expect(t.footer?.text).toBe(
      '体检于 2026-10-22 · 收录要 Search Console 接上才看得到 · 速度是实验室数 · 已交给建站（2 条）',
    )
    expect(t.footer?.href).toBe('/matters/mat_b')
    const clean = table('site.tech_audit', {
      site_health: { run: { ...TECH_RUN, tech: { ...TECH_RUN.tech, issues: [], dispatched: [] } } },
    })
    expect(clean.rows).toEqual([{ issue: '都没问题', where: '', owner: '' }])
  })

  it('改版回归：三级逐条、指到是哪次改版；基线那一次照实说；后来没变也把 7 天内那一轮列出来', () => {
    const t = table('site.drift', {
      site_health: { drift: { last: DRIFT, last_with_findings: DRIFT } },
    })
    expect(t.rows).toEqual([
      {
        page: '严重 · 首页 /',
        change: '被设成了不让收录（noindex）：index, follow → noindex',
      },
      {
        page: '注意 · 商品页 /products/pb',
        change: '标题改了：Power Bank → Power Bank – NordVolt',
      },
    ])
    expect(t.footer).toMatchObject({
      text: '主题发布 · 2026-10-22 · 严重的已交给建站',
      href: '/matters/mat_d',
    })
    const base = table('site.drift', {
      site_health: { drift: { last: { ...DRIFT, status: 'baseline', findings: [] } } },
    })
    expect(base.rows).toEqual([{ page: '第一次：存好了基线，下次改版后比' }])
    const later: DriftRun = {
      ...DRIFT,
      id: 'drift_2',
      trigger: { kind: 'weekly', at: '2026-10-24T08:00:00.000Z' },
      started_at: '2026-10-24T08:00:00.000Z',
      finished_at: '2026-10-24T08:00:10.000Z',
      findings: [],
    }
    expect(
      table('site.drift', { site_health: { drift: { last: later, last_with_findings: DRIFT } } })
        .rows,
    ).toHaveLength(2)
    expect(table('site.drift', { site_health: { drift: { last: later } } }).rows).toEqual([
      { page: '都没问题', change: '' },
    ])
  })

  it('抢词：保留哪页、另一页怎么处理；今天 5 件里合并车道与分诊标签', () => {
    const approvals = [
      seoReport({
        variant: 'weekly_cannibalization',
        week_of: '2026-10-22',
        gsc: 'connected',
        notes: [],
        groups: [
          {
            key: 'best power bank for iphone',
            severity: 'critical',
            queries: ['best power bank for iphone', 'power bank for iphone 16'],
            pages: [
              {
                url: 'https://nordvolt.example/blogs/news/a',
                clicks: 49,
                impressions: 1200,
                position: 6.7,
              },
              {
                url: 'https://nordvolt.example/blogs/news/b',
                clicks: 18,
                impressions: 960,
                position: 10.1,
              },
            ],
            keep: 'https://nordvolt.example/blogs/news/a',
            action: 'redirect',
            suggestion: '…',
          },
        ],
      }),
      seoReport({
        variant: 'daily',
        date: '2026-10-22',
        gsc: 'connected',
        search_data: 'not_configured',
        notes: [],
        signal_counts: {},
        picks: [
          {
            rank: 1,
            signal: 'decaying',
            query: 'braided cable care',
            page: 'https://nordvolt.example/blogs/news/cable-care',
            evidence: { clicks: 6, impressions: 500, ctr: 0.012, position: 9, words: 3 },
            lane: 'fix_page',
            fix: 'page_seo_edit',
            suggestion: '查询变了',
            triage: { verdict: 'query_shift', reason: '…', evidence: {} },
          },
          {
            rank: 2,
            signal: 'cannibalization',
            query: 'best power bank for iphone',
            evidence: { clicks: 18, impressions: 960, ctr: 0.019, position: 10.1, words: 5 },
            lane: 'merge',
            suggestion: '合并',
          },
        ],
      }),
    ]
    const c = table('seo.cannibalization', { approvals })
    expect(c.rows).toEqual([
      {
        queries: '严重 · best power bank for iphone 等 2 个',
        keep: '/blogs/news/a',
        other: '/blogs/news/b → 并过去再跳转',
      },
    ])
    const today = table('seo.today', { approvals })
    expect(today.rows.map((r) => r.lane)).toEqual([
      '改这页（本职责） · 查询变了',
      '合并（本职责定）',
    ])
    expect(today.rows[1]?.what).toBe('抢词 · best power bank for iphone')
  })

  it('报表「SEO 与 AI 搜索」里多三块（WP438 起看数都在报表里）：数据集读的就是上面这三张表', () => {
    const spec = DEFAULT_REPORTS.find((r) => r.id === 'web-ops.seo')
    if (spec === undefined) throw new Error('没有 web-ops.seo')
    const data = computeReport(
      spec,
      queryContext({
        role_id: 'dtc.seo',
        sources: [
          { id: 'site', label: '建站', connected: true },
          { id: 'gsc', label: 'Search Console', connected: true },
          ...SOURCES,
        ],
        site_health: { run: TECH_RUN, drift: { last: DRIFT, last_with_findings: DRIFT } },
      }),
    )
    const by = (id: string) => data.blocks.find((b) => b.id === id)
    expect(by('tech')).toMatchObject({ status: 'ok' })
    expect(JSON.stringify(by('tech'))).toContain('跳转与死链')
    expect(JSON.stringify(by('drift'))).toContain('被设成了不让收录')
    expect(by('cannibalization')).toMatchObject({ status: 'ok' })
  })
})
