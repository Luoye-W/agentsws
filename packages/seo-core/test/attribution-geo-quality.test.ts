/**
 * WP154 §4 收入归因、§5 GEO、§6 发布前质检。
 */
import type { AiAnswerResult } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  checkContentQuality,
  DEFAULT_CLAIM_RULES,
  DEMO_PAGES,
  domainOf,
  GEO_PLATFORMS,
  generateGeoQuestions,
  geoGaps,
  landingKey,
  looksLikeQuestion,
  pageRevenue,
  probeRows,
  qualitySummary,
  ruleFromFact,
  splitSentences,
  standInSearchData,
  unconfiguredSearchData,
} from '../src/index.js'

const S = 'https://shop.example'

describe('收入归因：按页面并排点击 / 订单 / 收入（Shopify landing_site）', () => {
  const gsc = [
    {
      query: 'a',
      page: `${S}/blogs/guide/popular-post`,
      clicks: 400,
      impressions: 9000,
      ctr: 0.044,
      position: 3,
    },
    {
      query: 'b',
      page: `${S}/blogs/guide/boring-topic`,
      clicks: 40,
      impressions: 800,
      ctr: 0.05,
      position: 6,
    },
  ]
  const orders = [
    { id: 'o1', landing_site: '/blogs/guide/boring-topic', total: 129, currency: 'USD' },
    { id: 'o2', landing_site: '/blogs/guide/boring-topic?ref=x', total: 89, currency: 'USD' },
    {
      id: 'o3',
      landing_site: '/products/usb-c-65w-charger?utm_medium=cpc&utm_source=google',
      total: 129,
      currency: 'USD',
    },
    { id: 'o4', landing_site: '/?gclid=abc', total: 22.5, currency: 'USD' },
    { id: 'o5', total: 45, currency: 'USD' },
  ]
  const out = pageRevenue({ gsc, orders, options: { currency: 'USD', shop_host: 'shop.example' } })

  it('点击多没订单 = 漏；点击少出订单 = 宝', () => {
    const popular = out.rows.find((r) => r.page.endsWith('popular-post'))
    const boring = out.rows.find((r) => r.page.endsWith('boring-topic'))
    expect(popular).toMatchObject({ clicks: 400, orders: 0, revenue: 0, flag: 'leak' })
    expect(boring).toMatchObject({ clicks: 40, orders: 2, revenue: 218, flag: 'gem' })
    expect(out.rows[0]?.page).toContain('boring-topic')
  })

  it('广告 / 活动带来的不算给文章；没有落地页的照实报归不上', () => {
    expect(out.campaign_orders).toBe(2)
    expect(out.unmatched_orders).toBe(1)
    expect(landingKey('/p?utm_medium=email', 'shop.example')).toBeUndefined()
    expect(landingKey('https://www.shop.example/Blogs/X/', 'shop.example')).toBe(
      'shop.example/blogs/x',
    )
  })

  it('接了 GA4 才有转化率那一格', () => {
    const withGa4 = pageRevenue({
      gsc,
      orders: [],
      ga4: [{ page: `${S}/blogs/guide/popular-post`, conversion_rate: 0.001 }],
      options: { currency: 'USD', shop_host: 'shop.example' },
    })
    expect(withGa4.rows.find((r) => r.page.endsWith('popular-post'))?.conversion_rate).toBe(0.001)
    expect(out.rows.every((r) => r.conversion_rate === undefined)).toBe(true)
  })
})

describe('GEO：问题清单、探测小结、缺位建议', () => {
  const brand = {
    name: 'NordVolt',
    category: 'USB-C charger',
    products: ['USB-C 65W Charger'],
    language: 'en' as const,
  }

  it('从品牌档案与像问句的查询生成；人改过的永远赢', () => {
    const qs = generateGeoQuestions({
      brand,
      top_queries: ['what charger do i need for a macbook pro', 'usb c cable'],
    })
    expect(qs.map((q) => q.text)).toContain('What is the best USB-C charger?')
    expect(qs.map((q) => q.text)).toContain('What charger do i need for a macbook pro?')
    expect(qs.some((q) => q.text.toLowerCase().startsWith('usb c cable'))).toBe(false)
    // 人关掉一句、加一句：再生成一次，关掉的不回来、加的还在
    const off = qs.map((q) => (q.text === 'Is NordVolt worth it?' ? { ...q, enabled: false } : q))
    const mine = {
      id: 'gq_me',
      text: 'Which charger is safe for a Pixel?',
      origin: 'human' as const,
      enabled: true,
    }
    const again = generateGeoQuestions({ brand, top_queries: [], existing: [...off, mine] })
    expect(again.find((q) => q.text === 'Is NordVolt worth it?')?.enabled).toBe(false)
    expect(again.find((q) => q.id === 'gq_me')?.enabled).toBe(true)
    expect(looksLikeQuestion('充电头哪个牌子好用')).toBe(true)
  })

  it('没被提、没被引 → 有相关页就改那页，没有就交公关', async () => {
    const answers: AiAnswerResult[] = [
      {
        platform: 'chatgpt',
        answer_excerpt: '…',
        brand_mentioned: false,
        our_domain_cited: false,
        cited_urls: ['https://www.rtings.com/charger'],
        competitors_mentioned: ['Anker'],
        fetched_at: '2026-09-26T00:00:00Z',
        source: 'stand-in',
      },
      {
        platform: 'perplexity',
        answer_excerpt: '…',
        brand_mentioned: true,
        our_domain_cited: true,
        cited_urls: [`${S}/blogs/guide/best-magsafe-car-mount`],
        competitors_mentioned: [],
        fetched_at: '2026-09-26T00:00:00Z',
        source: 'stand-in',
      },
    ]
    const search = standInSearchData({
      answers: {
        'Best MagSafe car mount?': answers,
        'Which power bank for flights?': [answers[0] as AiAnswerResult],
      },
    })
    const q1 = await search.aiAnswers({
      question: 'Best MagSafe car mount?',
      platforms: [...GEO_PLATFORMS],
      country: 'de',
      language: 'en',
      brand: { name: 'NordVolt', domains: ['shop.example'] },
    })
    const q2 = await search.aiAnswers({
      question: 'Which power bank for flights?',
      platforms: [...GEO_PLATFORMS],
      country: 'de',
      language: 'en',
      brand: { name: 'NordVolt', domains: ['shop.example'] },
    })
    const rows = [
      ...probeRows('Best MagSafe car mount?', q1),
      ...probeRows('Which power bank for flights?', q2),
    ]
    expect(rows[0]?.cited_domains).toEqual(['rtings.com'])
    const gaps = geoGaps(rows, DEMO_PAGES, ['shop.example'])
    expect(gaps).toHaveLength(2)
    expect(gaps[0]).toMatchObject({
      lane: 'fix_page',
      page: `${S}/blogs/guide/best-magsafe-car-mount`,
      platforms: ['chatgpt'],
      competitors: ['Anker'],
    })
    expect(gaps[1]).toMatchObject({ lane: 'pr_handoff', cited_domains: ['rtings.com'] })
    expect(domainOf('https://www.Example.com/x')).toBe('example.com')
  })

  it('没接搜索数据接口：一次都不调，调了就拒', async () => {
    const port = unconfiguredSearchData()
    expect((await port.status()).configured).toBe(false)
    await expect(
      port.aiAnswers({
        question: 'x',
        platforms: ['chatgpt'],
        country: 'de',
        language: 'en',
        brand: { name: 'n', domains: [] },
      }),
    ).rejects.toThrow('搜索数据接口还没接')
  })
})

describe('发布前质检：事实对得上、数字有出处、没有违规宣称', () => {
  const facts = [
    {
      id: 'fc_warranty',
      statement: '充电类产品的保修期是 24 个月，从签收日算起。',
      terms: ['保修', 'warranty'],
    },
    { id: 'fc_watt', statement: 'USB-C 65W Charger 最大输出 65W。', terms: ['输出', 'output'] },
  ]
  const now = '2026-09-26T08:00:00Z'

  it('全对 → 通过', () => {
    const r = checkContentQuality({ body: '这款充电头最大输出 65W。保修 24 个月。', facts, now })
    expect(r).toMatchObject({ passed: true, issues: [], rules_from: 'default' })
    expect(qualitySummary(r)).toContain('通过')
  })

  it('三类问题各指到那一句', () => {
    const r = checkContentQuality({
      title: '全网最好的快充头',
      body: '保修 36 个月。续航提升 47%。它能治疗失眠。',
      facts,
      now,
    })
    expect(r.passed).toBe(false)
    const by = (rule: string) => r.issues.filter((i) => i.rule === rule)
    expect(by('banned_claim').map((i) => i.sentence)).toEqual([
      '全网最好的快充头',
      '它能治疗失眠。',
    ])
    expect(by('fact_mismatch')[0]).toMatchObject({ sentence: '保修 36 个月。' })
    expect(by('fact_mismatch')[0]?.detail).toContain('24 个月')
    expect(by('unsourced_figure')[0]).toMatchObject({ sentence: '续航提升 47%。' })
    expect(qualitySummary(r)).toContain('先留在草稿')
  })

  it('规则表放知识库：content_rule 卡 → 规则；有就用它，不用默认表', () => {
    const rule = ruleFromFact({
      id: 'fc_rule_1',
      subject: { type: 'content_rule', key: '军工级' },
      statement: '不许说「军工级」（没有认证）',
      structured: { category: 'other' },
    })
    expect(rule).toMatchObject({
      pattern: '军工级',
      category: 'other',
      reason: '不许说「军工级」（没有认证）',
    })
    expect(
      ruleFromFact({ id: 'x', subject: { type: 'warranty', key: 'w' }, statement: 's' }),
    ).toBeUndefined()
    const r = checkContentQuality({
      body: '军工级做工。全网最好。',
      facts,
      rules: rule === undefined ? [] : [rule],
      now,
    })
    expect(r.rules_from).toBe('knowledge')
    expect(r.issues.map((i) => i.sentence)).toEqual(['军工级做工。'])
    expect(DEFAULT_CLAIM_RULES.length).toBeGreaterThan(5)
  })

  it('分句', () => {
    expect(splitSentences('第一句。第二句！Third one. Fourth?\n第五')).toEqual([
      '第一句。',
      '第二句！',
      'Third one.',
      'Fourth?',
      '第五',
    ])
  })
})
