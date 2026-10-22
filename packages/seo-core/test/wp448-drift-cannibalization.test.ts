/**
 * WP448（docs/109 §5.1 #2–4）：改版回归的三级比对、抢词检测、掉量分诊——合成数据上判得对，数不经模型手。
 */
import type { DriftSnapshot, GscRow } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  buildDaily,
  compareDrift,
  DEMO_BRAND_TERMS,
  DEMO_GSC_ROWS,
  DEMO_OUR_DOMAINS,
  DEMO_PAGES,
  DRIFT_CHECKS,
  DRIFT_RULES,
  detectCannibalization,
  detectSignals,
  driftCounts,
  driftLine,
  LANE_ORDER,
  MAX_MERGE_PICKS,
  mergePick,
  rankDrafts,
  similarity,
  triageDecay,
  unconfiguredSearchData,
} from '../src/index.js'

const O = 'https://shop.example'
/** 取第一个（没有就让测试直接失败）。 */
const first = <T>(xs: readonly T[]): T => {
  const x = xs[0]
  if (x === undefined) throw new Error('空的')
  return x
}
const snap = (
  over: Partial<DriftSnapshot> & Pick<DriftSnapshot, 'url' | 'kind'>,
): DriftSnapshot => ({
  status: 200,
  title: 'T',
  description: 'D',
  canonical: over.url,
  robots: 'index, follow',
  h1: ['Heading'],
  schema: { types: ['Organization'], hash: 'aaaa0000' },
  captured_at: '2026-10-20T00:00:00Z',
  ...over,
})

/** 改版前（录好的基线）。 */
const BEFORE: DriftSnapshot[] = [
  snap({
    url: `${O}/`,
    kind: 'home',
    title: 'NordVolt — Power banks',
    h1: ['Power that keeps up'],
  }),
  snap({
    url: `${O}/products/magsafe-10k`,
    kind: 'product',
    title: 'MagSafe 10K Power Bank',
    description: '10,000 mAh magnetic power bank.',
    h1: ['MagSafe 10K'],
    schema: {
      types: ['BreadcrumbList', 'Product'],
      product_price: '39.90',
      product_currency: 'EUR',
      hash: 'p1',
    },
  }),
  snap({
    url: `${O}/products/usb-c-charger`,
    kind: 'product',
    title: 'USB-C 65W Charger',
    h1: ['USB-C 65W Charger'],
    schema: { types: ['Product'], product_price: '29.90', hash: 'p2' },
  }),
  snap({
    url: `${O}/collections/chargers`,
    kind: 'collection',
    title: 'Chargers',
    h1: ['Chargers'],
  }),
  snap({
    url: `${O}/blogs/news/pick-a-power-bank`,
    kind: 'article',
    title: 'How to pick a power bank',
    h1: ['How to pick a power bank'],
    schema: { types: ['BlogPosting'], hash: 'b1' },
  }),
]

/** 新主题发布之后（录好的这一次）。 */
const AFTER: DriftSnapshot[] = [
  // 首页：新主题把整站设成了 noindex，规范网址指去了 myshopify 域名
  snap({
    url: `${O}/`,
    kind: 'home',
    title: 'NordVolt — Power banks',
    h1: ['Power that keeps up'],
    robots: 'noindex, nofollow',
    canonical: 'https://nordvolt.myshopify.com/',
  }),
  // 商品页：Product 结构化数据没了（只剩面包屑），标题改了
  snap({
    url: `${O}/products/magsafe-10k`,
    kind: 'product',
    title: 'MagSafe 10K – NordVolt',
    description: '10,000 mAh magnetic power bank.',
    h1: ['MagSafe 10K'],
    schema: { types: ['BreadcrumbList'], hash: 'p1x' },
  }),
  // 另一件商品：价格变了（正常生意）、H1 小改
  snap({
    url: `${O}/products/usb-c-charger`,
    kind: 'product',
    title: 'USB-C 65W Charger',
    h1: ['USB-C 65W Charger (GaN)'],
    schema: { types: ['Product'], product_price: '27.90', hash: 'p2x' },
  }),
  // 合集：打不开了
  snap({ url: `${O}/collections/chargers`, kind: 'collection', status: 404 }),
  // 文章：没变
  snap({
    url: `${O}/blogs/news/pick-a-power-bank`,
    kind: 'article',
    title: 'How to pick a power bank',
    h1: ['How to pick a power bank'],
    schema: { types: ['BlogPosting'], hash: 'b1' },
  }),
]

describe('WP448 改版回归：改版前后两份样本比出三级结果', () => {
  it('严重 / 注意 / 知道一下各命中预期的规则', () => {
    const f = compareDrift(BEFORE, AFTER)
    const by = (sev: string) =>
      f
        .filter((x) => x.severity === sev)
        .map((x) => `${x.rule}|${new URL(x.url).pathname}`)
        .sort()
    expect(by('critical')).toEqual(
      [
        'canonical_changed|/',
        'noindex_added|/',
        'product_schema_removed|/products/magsafe-10k',
        'status_error|/collections/chargers',
      ].sort(),
    )
    expect(by('warning')).toEqual(['title_changed|/products/magsafe-10k'])
    expect(by('info')).toEqual(
      [
        'h1_reworded|/products/usb-c-charger',
        'product_price_changed|/products/usb-c-charger',
        'schema_modified|/products/usb-c-charger',
      ].sort(),
    )
    expect(driftCounts(f)).toEqual({ critical: 4, warning: 1, info: 3 })
    // 严重的排前面；打不开的页只报这一条
    expect(f[0]?.severity).toBe('critical')
    expect(f.filter((x) => x.url.endsWith('/collections/chargers'))).toHaveLength(1)
    const noindex = f.find((x) => x.rule === 'noindex_added')
    expect(driftLine(noindex ?? first(f))).toBe(
      '首页 / 被设成了不让收录（noindex）：index, follow → noindex, nofollow',
    )
  })

  it('同一份不比出东西；这次没抓到的页不比；严重度都来自规则表', () => {
    expect(compareDrift(BEFORE, BEFORE)).toEqual([])
    expect(compareDrift(BEFORE, AFTER.slice(0, 1)).every((x) => x.url === `${O}/`)).toBe(true)
    expect(compareDrift(BEFORE, [{ ...first(AFTER), status: 0 }])).toEqual([])
    for (const x of compareDrift(BEFORE, AFTER))
      expect(x.severity).toBe(DRIFT_RULES[x.rule as keyof typeof DRIFT_RULES].severity)
    expect(Object.keys(DRIFT_CHECKS).sort()).toEqual(Object.keys(DRIFT_RULES).sort())
  })

  it('H1 大改 vs 小改按字面相似度分（0.5 那条线）', () => {
    expect(similarity('MagSafe 10K', 'MagSafe 10K')).toBe(1)
    expect(similarity('USB-C 65W Charger', 'USB-C 65W Charger (GaN)')).toBeGreaterThan(0.5)
    expect(similarity('Power that keeps up', 'Summer sale is here')).toBeLessThan(0.5)
    const f = compareDrift(
      [snap({ url: `${O}/`, kind: 'home', h1: ['Power that keeps up'] })],
      [snap({ url: `${O}/`, kind: 'home', h1: ['Summer sale is here'] })],
    )
    expect(f.map((x) => x.rule)).toEqual(['h1_changed'])
  })
})

const row = (
  query: string,
  page: string,
  clicks: number,
  impressions: number,
  position: number,
  prev?: number,
): GscRow => ({
  query,
  page: `${O}${page}`,
  clicks,
  impressions,
  ctr: impressions === 0 ? 0 : clicks / impressions,
  position,
  ...(prev === undefined ? {} : { clicks_prev_week: prev }),
})

describe('WP448 抢词检测（每周）', () => {
  const rows: GscRow[] = [
    // 两篇文章抢同一组词，都在前 20、曝光够 → 严重，合并后跳过去
    row('best power bank for iphone', '/blogs/news/best-power-banks', 40, 900, 6.2),
    row('best power bank for iphone', '/blogs/news/iphone-power-bank-guide', 12, 700, 9.8),
    row('power bank for iphone 16', '/blogs/news/best-power-banks', 9, 300, 8.1),
    row('power bank for iphone 16', '/blogs/news/iphone-power-bank-guide', 6, 260, 11),
    // 商品页与文章抢一个词：商品页不跳，改写文章角度
    row('magsafe power bank', '/products/magsafe-10k', 30, 400, 4),
    row('magsafe power bank', '/blogs/news/magsafe-explained', 5, 120, 14),
    // 曝光少的重叠 → 中（只进周报）
    row('gan charger heat', '/blogs/news/gan-explained', 2, 60, 18),
    row('gan charger heat', '/pages/faq', 1, 55, 25),
    // 只有一页够格 → 不算
    row('usb c cable 2m', '/products/cable-2m', 10, 200, 5),
    row('usb c cable 2m', '/collections/cables', 0, 20, 30),
    // 品牌词不算（搜品牌名落在首页和商品页都正常）
    row('nordvolt charger', '/', 50, 800, 1.2),
    row('nordvolt charger', '/products/usb-c-charger', 20, 600, 2.4),
  ]

  it('按「哪几页在抢」归组，三级严重度，保留点击多的那页', () => {
    const g = detectCannibalization(rows, { brand_terms: ['nordvolt'] })
    expect(
      g.map((x) => `${x.severity}|${x.action}|${new URL(x.keep).pathname}|${x.queries.length}`),
    ).toEqual([
      'critical|redirect|/blogs/news/best-power-banks|2',
      'critical|differentiate|/products/magsafe-10k|1',
      'medium|redirect|/blogs/news/gan-explained|1',
    ])
    const top = first(g)
    // 数全从行里加出来：两个词的点击、曝光合计；排名按曝光加权
    expect(top.pages).toEqual([
      { url: `${O}/blogs/news/best-power-banks`, clicks: 49, impressions: 1200, position: 6.7 },
      {
        url: `${O}/blogs/news/iphone-power-bank-guide`,
        clicks: 18,
        impressions: 960,
        position: 10.1,
      },
    ])
    expect(top.suggestion).toContain('保留 /blogs/news/best-power-banks（点击 49）')
    expect(top.suggestion).toContain('跳转过去')
    expect(g[1]?.suggestion).toContain('改写成别的角度')
  })

  it('抢词那一组进 5 件事：merge 车道，排在改页面之后、交出去之前；每天最多两件；不算六个信号', async () => {
    const groups = detectCannibalization(rows, { brand_terms: ['nordvolt'] }).filter(
      (x) => x.severity === 'critical' && x.action === 'redirect',
    )
    const pick = mergePick(first(groups), 1)
    expect(pick).toMatchObject({
      signal: 'cannibalization',
      lane: 'merge',
      page: `${O}/blogs/news/iphone-power-bank-guide`,
      evidence: { clicks: 18, impressions: 960, position: 10.1 },
    })
    const daily = await buildDaily({
      rows: DEMO_GSC_ROWS,
      pages: DEMO_PAGES,
      signals: { brand_terms: DEMO_BRAND_TERMS },
      search: unconfiguredSearchData(),
      country: 'de',
      language: 'en',
      our_domains: DEMO_OUR_DOMAINS,
      date: '2026-10-22',
      merges: [
        ...groups,
        ...groups.map((x) => ({ ...x, key: `${x.key}-2`, pages: [...x.pages].reverse() })),
      ],
    })
    expect(daily.picks).toHaveLength(5)
    const lanes = daily.picks.map((p) => p.lane)
    expect(lanes.filter((l) => l === 'merge').length).toBeLessThanOrEqual(MAX_MERGE_PICKS)
    expect(lanes.filter((l) => l === 'merge').length).toBe(1)
    const idx = lanes.map((l) => LANE_ORDER[l])
    expect(idx).toEqual([...idx].sort((a, b) => a - b))
    expect(daily.picks.map((p) => p.rank)).toEqual([1, 2, 3, 4, 5])
    expect(Object.keys(daily.signal_counts)).not.toContain('cannibalization')
  })
})

describe('WP448 掉量分诊（decaying 加分诊提示）', () => {
  it('同一个词我们另一页在涨 → 该合并（走 merge 车道）', () => {
    const rows = [
      row('braided cable care', '/blogs/news/cable-care', 6, 500, 9, 20),
      row('braided cable care', '/blogs/news/cable-guide', 14, 400, 7, 3),
    ]
    const t = triageDecay(first(rows), rows)
    expect(t.verdict).toBe('merge')
    expect(t.evidence).toMatchObject({
      other_page: `${O}/blogs/news/cable-guide`,
      other_page_clicks: 14,
    })
    const drafts = rankDrafts(detectSignals(rows, [], { brand_terms: [] }), rows)
    const d = drafts.find((x) => x.signal === 'decaying')
    expect(d?.lane).toBe('merge')
    expect(d?.merge?.keep).toBe(`${O}/blogs/news/cable-guide`)
    expect(d?.merge?.action).toBe('redirect')
  })

  it('这页别的词在涨 → 查询变了（改标题与开头）', () => {
    const rows = [
      row('braided cable care', '/blogs/news/cable-care', 6, 500, 9, 20),
      row('how to clean usb cable', '/blogs/news/cable-care', 30, 900, 1.5, 18),
    ]
    const t = triageDecay(first(rows), rows)
    expect(t).toMatchObject({
      verdict: 'query_shift',
      evidence: { gaining_clicks: 12, page_clicks: 36, page_clicks_prev: 38 },
    })
    const d = rankDrafts(detectSignals(rows, [], { brand_terms: [] }), rows).find(
      (x) => x.signal === 'decaying',
    )
    expect(d).toMatchObject({ lane: 'fix_page', fix: 'page_seo_edit' })
    expect(d?.suggestion).toContain('查询变了')
  })

  it('整页几乎没人搜了 → 该下线（交建站）；还有需求 → 刷新（照旧加小节）', () => {
    const dead = [row('old cable promo', '/blogs/news/promo-2023', 1, 40, 22, 12)]
    expect(triageDecay(first(dead), dead).verdict).toBe('retire')
    const d = rankDrafts(detectSignals(dead, [], { brand_terms: [] }), dead).find(
      (x) => x.signal === 'decaying',
    )
    expect(d?.lane).toBe('site_handoff')
    const live = [row('braided cable care', '/blogs/news/cable-care', 9, 800, 8, 20)]
    const t = triageDecay(first(live), live)
    expect(t).toMatchObject({ verdict: 'refresh', evidence: { page_impressions: 800 } })
    const r = rankDrafts(detectSignals(live, [], { brand_terms: [] }), live).find(
      (x) => x.signal === 'decaying',
    )
    expect(r).toMatchObject({
      lane: 'fix_page',
      fix: 'page_section_add',
      triage: { verdict: 'refresh' },
    })
  })

  it('上周没拉到的行不当 0：不算涨也不算跌', () => {
    const rows = [
      row('braided cable care', '/blogs/news/cable-care', 6, 500, 9, 20),
      row('how to clean usb cable', '/blogs/news/cable-care', 30, 900, 5),
    ]
    expect(triageDecay(first(rows), rows).verdict).toBe('refresh')
  })
})
