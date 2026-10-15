/**
 * WP346（决策 872）：品牌分析第二版——AI 归纳人群 / 关键词 / 价格带 / 子品类 / 定位 / 竞品、商品规格与原价售价。
 * 全用本地夹具 + 替身模型（不联网、不花钱）。
 */
import {
  BRAND_INTAKE_INSIGHTS_CREDITS,
  DEFAULT_BRAND_INTAKE_CAP_CREDITS,
} from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  amazonListPrice,
  amazonSpecs,
  analyzeBrand,
  estimateCredits,
  needsConfirm,
  parseInsightsReply,
} from '../src/index.js'
import { fixture, replayFetch, SHOP, SHOP_PAGES } from './fixtures.js'

const TRAIL = 'https://trailmark.example'
const TRAIL_PAGES: Record<string, string> = {
  [`${TRAIL}/robots.txt`]: 'robots.txt',
  [`${TRAIL}/`]: 'specs-home.html',
  // 关于 / 联系各给一页（不然固定路径的探测把 12 页的额度先吃光了）
  [`${TRAIL}/pages/about`]: 'specs-home.html',
  [`${TRAIL}/pages/contact`]: 'shop-contact.html',
  [`${TRAIL}/products/ridge-28`]: 'specs-ridge.html',
  [`${TRAIL}/products/summit-40`]: 'specs-summit.html',
}

const REPLY = JSON.stringify({
  category: 'hiking backpacks',
  subcategory: 'daypacks',
  positioning: '给带娃徒步的家长做的轻量背包。',
  price_band: '$119-$189',
  audience: {
    buyers: '30–45 岁、周末带孩子徒步的家长。',
    payer: '家长本人',
    concerns: ['背着累不累', '装不装得下孩子的东西'],
  },
  keywords: {
    brand: ['Trailmark', 'Ridge 28'],
    category: ['hiking daypack', 'hiking backpack'],
    scenario: ['family day hike', 'hiking with kids'],
  },
  competitors: [
    { name: 'Osprey', reason: '同价位徒步背包的老牌子', url: 'https://www.osprey.com' },
    { name: 'Trailmark', reason: '自己' },
    { name: 'Deuter', reason: '亲子背负系列', url: 'not a url' },
  ],
  products: [
    { n: 1, specs: { Capacity: '30 L' }, list_price: '$999', sale_price: '$1' },
    {
      n: 2,
      specs: { Capacity: '40 L', 'Frame sheet': 'aluminium' },
      list_price: '$219.00',
      sale_price: '$189.00',
    },
  ],
})

function stub(reply: string | (() => never)) {
  const prompts: string[] = []
  return {
    prompts,
    model: async ({ prompt }: { prompt: string }) => {
      prompts.push(prompt)
      if (typeof reply === 'function') reply()
      return { text: typeof reply === 'string' ? `好的：\n${reply}` : '' }
    },
  }
}

describe('WP346 商品卡：规格、原价 / 售价分开（结构化数据）', () => {
  it('官网 JSON-LD：additionalProperty / 材质 / 重量进规格，StrikethroughPrice 是原价', async () => {
    const out = await analyzeBrand(replayFetch(TRAIL_PAGES).fetch, [`${TRAIL}/`])
    const ridge = out.profile.products?.value.find((p) => p.title === 'Ridge 28 Daypack')
    expect(ridge?.list_price_snapshot).toBe('149.00')
    expect(ridge?.sale_price_snapshot).toBe('119.00')
    expect(ridge?.price_snapshot).toBe('119.00')
    expect(ridge?.specs).toEqual(
      expect.arrayContaining([
        { name: 'Capacity', value: '28 L' },
        { name: 'material', value: 'Recycled ripstop nylon' },
        { name: 'weight', value: '820 g' },
      ]),
    )
    // 没写原价的那张不出原价 / 售价（只有 price_snapshot）
    const summit = out.profile.products?.value.find((p) => p.title === 'Summit 40')
    expect(summit?.list_price_snapshot).toBeUndefined()
    expect(summit?.specs).toBeUndefined()
    // 没接模型：AI 那几格一格都没有
    expect(out.insights).toBe('no_model')
    expect(out.profile.audience).toBeUndefined()
  })

  it('Amazon：划线价与规格表', () => {
    const html = fixture('amazon-listing-specs.html')
    expect(amazonListPrice(html)).toBe('$149.00')
    expect(amazonSpecs(html)).toEqual([
      { name: 'Brand', value: 'Trailmark' },
      { name: 'Capacity', value: '28 Liters' },
      { name: 'Material', value: 'Nylon' },
      { name: 'Item Weight', value: '1.8 Pounds' },
    ])
  })
})

describe('WP346 AI 归纳：一次调用、只喂抓到的页面文字', () => {
  it('新格子落成「请确认」（模型层），竞品剔掉自己与坏网址；商品只补空、价格要在页面上原样出现', async () => {
    const m = stub(REPLY)
    const out = await analyzeBrand(replayFetch(TRAIL_PAGES).fetch, [`${TRAIL}/`], {
      insights: { model: m.model },
    })
    expect(m.prompts).toHaveLength(1)
    // 只喂我们抓到的页面文字 + 已读到的几格
    expect(m.prompts[0]).toContain("a toddler's spare socks")
    expect(m.prompts[0]).toContain('brand: Trailmark')
    expect(out.insights).toBe('done')
    const p = out.profile
    expect(p.audience?.value.buyers).toContain('家长')
    expect(p.audience?.value.concerns).toHaveLength(2)
    expect(p.keywords?.value.scenario).toContain('hiking with kids')
    expect(p.price_band?.value).toBe('$119-$189')
    expect(p.subcategory?.value).toBe('daypacks')
    expect(p.positioning?.value).toContain('家长')
    expect(p.category?.value).toBe('hiking backpacks')
    expect(p.competitors?.value.map((c) => c.name)).toEqual(['Osprey', 'Deuter'])
    expect(p.competitors?.value[1]?.url).toBeUndefined()
    for (const key of ['audience', 'keywords', 'competitors', 'positioning'] as const) {
      expect(p[key]?.confidence).toBe('low')
      expect(p[key]?.evidence[0]?.locator).toBe('model')
      expect(needsConfirm(p[key])).toBe(true)
    }
    const [ridge, summit] = p.products?.value ?? []
    // 结构化读到的规格 / 原价不让模型盖；模型编的价（$999 / $1）进不来
    expect(ridge?.list_price_snapshot).toBe('149.00')
    expect(ridge?.specs?.find((s) => s.name === 'Capacity')?.value).toBe('28 L')
    expect(ridge?.model_filled).toBeUndefined()
    // 空的那张补上：规格 + 页面上原样写着的原价 / 售价，记在 model_filled
    expect(summit?.specs).toEqual([
      { name: 'Capacity', value: '40 L' },
      { name: 'Frame sheet', value: 'aluminium' },
    ])
    expect(summit?.list_price_snapshot).toBe('$219.00')
    expect(summit?.sale_price_snapshot).toBe('$189.00')
    expect(summit?.model_filled).toEqual(['specs', 'list_price_snapshot', 'sale_price_snapshot'])
  })

  it('计入积分、沿用封顶：官网整轮 + AI 一次仍压在 2 下面，不算撞顶', async () => {
    const m = stub(REPLY)
    const out = await analyzeBrand(replayFetch(SHOP_PAGES).fetch, [`${SHOP}/`], {
      insights: { model: m.model },
    })
    const ok = out.pages.filter((p) => p.ok).length
    expect(out.budget.spent_credits).toBeCloseTo(ok * 0.15 + BRAND_INTAKE_INSIGHTS_CREDITS, 5)
    expect(out.budget.spent_credits).toBeLessThanOrEqual(DEFAULT_BRAND_INTAKE_CAP_CREDITS)
    expect(out.stopped_for_budget).toBe(false)
    expect(out.budget.estimated_credits).toBe(
      estimateCredits([`${SHOP}/`]) + BRAND_INTAKE_INSIGHTS_CREDITS,
    )
  })

  it('封顶容不下 AI 那一次：不问模型，照旧交解析结果；小封顶时先给 AI 留出那一份', async () => {
    const tight = stub(REPLY)
    const a = await analyzeBrand(replayFetch(TRAIL_PAGES).fetch, [`${TRAIL}/`], {
      capCredits: 0.2,
      insights: { model: tight.model },
    })
    expect(tight.prompts).toHaveLength(0)
    expect(a.insights).toBe('budget')
    expect(a.profile.brand_name?.value).toBe('Trailmark')

    const room = stub(REPLY)
    const b = await analyzeBrand(replayFetch(TRAIL_PAGES).fetch, [`${TRAIL}/`], {
      capCredits: 0.3,
      insights: { model: room.model },
    })
    expect(b.pages.filter((p) => p.ok)).toHaveLength(1)
    expect(b.insights).toBe('done')
    expect(b.budget.spent_credits).toBeLessThanOrEqual(0.3)
  })

  it('模型出错 / 答不像样：解析结果照给，AI 格子空着', async () => {
    const boom = stub(() => {
      throw new Error('gateway 500')
    })
    const a = await analyzeBrand(replayFetch(TRAIL_PAGES).fetch, [`${TRAIL}/`], {
      insights: { model: boom.model },
    })
    expect(a.insights).toBe('failed')
    expect(a.profile.products?.value.length).toBe(2)
    expect(a.profile.audience).toBeUndefined()

    const vague = stub('I think they sell backpacks.')
    const b = await analyzeBrand(replayFetch(TRAIL_PAGES).fetch, [`${TRAIL}/`], {
      insights: { model: vague.model },
    })
    expect(b.insights).toBe('failed')
  })

  it('读回复：每格各自验，不像样的丢掉；多给的竞品截到 6 个', () => {
    expect(parseInsightsReply('no json here')).toBeUndefined()
    const r = parseInsightsReply(
      JSON.stringify({
        price_band: 'affordable',
        audience: { payer: '家长' },
        keywords: { brand: ['A', 'a', ''], category: 'x' },
        competitors: Array.from({ length: 9 }, (_, i) => ({ name: `C${i}`, reason: 'r' })),
      }),
    )
    expect(r?.price_band).toBeUndefined()
    expect(r?.audience).toBeUndefined()
    expect(r?.keywords).toEqual({ brand: ['A'], category: [], scenario: [] })
    expect(r?.competitors).toHaveLength(6)
  })
})
