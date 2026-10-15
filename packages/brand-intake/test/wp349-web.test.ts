/**
 * WP349（Luoye 10-15 改决策 881）：品牌分析联网查——品牌评测 / 社区 / 媒体 + 竞品发现与核实，
 * 结果进同一次 AI 归纳；每格带来源；没来源的竞品不收；额度装不下按「竞品 → 品牌评测」取舍；
 * 没联网能力时竞品留空并照实说。搜索与模型全是替身（不联网、不花钱）。
 */
import { BRAND_INTAKE_SEARCH_CREDITS, DEFAULT_BRAND_INTAKE_CAP_CREDITS } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  analyzeBrand,
  competitorCandidates,
  type IntakeWebHit,
  WEB_OFF_REASON,
} from '../src/index.js'
import { replayFetch } from './fixtures.js'

const TRAIL = 'https://trailmark.example'
const TRAIL_PAGES: Record<string, string> = {
  [`${TRAIL}/robots.txt`]: 'robots.txt',
  [`${TRAIL}/`]: 'specs-home.html',
  [`${TRAIL}/pages/about`]: 'specs-home.html',
  [`${TRAIL}/pages/contact`]: 'shop-contact.html',
  [`${TRAIL}/products/ridge-28`]: 'specs-ridge.html',
  [`${TRAIL}/products/summit-40`]: 'specs-summit.html',
}

/** 搜索替身：按问句回写死的几条，记下问了什么。 */
function fakeSearch(fail = false) {
  const asked: string[] = []
  const table: [RegExp, IntakeWebHit[]][] = [
    [
      /alternatives/,
      [
        {
          url: 'https://outdoorgear.example/trailmark-alternatives',
          title: 'Best Trailmark alternatives: Osprey, Deuter and REI Co-op',
          snippet: 'Family daypacks compared on fit, weight and price.',
        },
      ],
    ],
    [
      / vs$/,
      [
        {
          url: 'https://forum.example/t/trailmark-vs-osprey',
          title: 'Trailmark vs Osprey for hiking with kids',
          snippet: 'Osprey has more sizes, Trailmark is lighter.',
        },
      ],
    ],
    [
      /^Osprey/,
      [
        {
          url: 'https://www.osprey.com/daypacks',
          title: 'Osprey daypacks | Official site',
          snippet: 'Daypacks from $90 to $180.',
        },
      ],
    ],
    [
      /^Deuter/,
      [{ url: 'https://www.deuter.com/', title: 'Deuter official', snippet: 'Kid comfort packs.' }],
    ],
    [/^REI Co-op/, [{ url: 'https://www.rei.com/c/daypacks', title: 'REI Co-op daypacks' }]],
    [
      /review/,
      [
        {
          url: 'https://gearlab.example/trailmark-ridge-28-review',
          title: 'Trailmark Ridge 28 review',
          snippet: 'Parents love the hip belt; $119 is fair.',
        },
      ],
    ],
    [
      /reddit/,
      [
        {
          url: 'https://www.reddit.com/r/hiking/comments/abc/trailmark',
          title: 'Anyone tried Trailmark with a toddler?',
        },
      ],
    ],
    [/news/, [{ url: 'https://news.example/trailmark-launch', title: 'Trailmark launches' }]],
  ]
  return {
    asked,
    search: async (query: string): Promise<IntakeWebHit[] | undefined> => {
      asked.push(query)
      if (fail) return undefined
      return table.find(([re]) => re.test(query))?.[1] ?? []
    },
  }
}

/** 模型替身：回写死的 JSON（编号按上面那张表的搜索顺序：发现 1–2、核实 3–5、品牌 6–8）。 */
const REPLY = JSON.stringify({
  subcategory: 'daypacks',
  positioning: '给带娃徒步的家长做的轻量背包。',
  price_band: '$119-$189',
  audience: { buyers: '30–45 岁、周末带孩子徒步的家长。', concerns: ['背着累不累'] },
  keywords: { brand: ['Trailmark'], category: ['hiking daypack'], scenario: ['hiking with kids'] },
  competitors: [
    { name: 'Osprey', reason: '同价位最常被拿来比', url: 'https://www.osprey.com', src: [2, 3] },
    // 引用的号不对，但搜到的网页里确有它：按搜到的认
    { name: 'Deuter', reason: '亲子背负系列', url: 'https://deuter-fake.example', src: [99] },
    // 没引用：在搜到的里找
    { name: 'REI Co-op', reason: '自有品牌价位更低' },
    // 只在模型记忆里：不收
    { name: 'Patagonia', reason: '户外大牌', src: [1] },
  ],
  sources: { positioning: [6], audience: [6, 7], price_band: [6, 3] },
  products: [],
})

function model(reply = REPLY) {
  const prompts: string[] = []
  return {
    prompts,
    model: async ({ prompt }: { prompt: string }) => {
      prompts.push(prompt)
      return { text: reply }
    },
  }
}

describe('WP349 品牌分析联网查', () => {
  it('联网结果进定位 / 人群 / 竞品并带来源；没来源的竞品被丢；官网要在搜到的网页里核对得上', async () => {
    const s = fakeSearch()
    const m = model()
    const out = await analyzeBrand(replayFetch(TRAIL_PAGES).fetch, [`${TRAIL}/`], {
      insights: { model: m.model },
      web: { search: s.search },
    })
    // 顺序：竞品发现 2 次 → 核实前几个候选 → 品牌评测 3 次；合计 ≤ 9
    expect(s.asked).toEqual([
      'Trailmark alternatives',
      'Trailmark vs',
      'Osprey official site price',
      'Deuter official site price',
      'REI Co-op official site price',
      'Trailmark review',
      'Trailmark reddit',
      'Trailmark brand news',
    ])
    expect(out.web).toEqual({
      status: 'done',
      searches: 8,
      credits: BRAND_INTAKE_SEARCH_CREDITS * 8,
    })
    // 同一次模型整理：页面 + 搜到的几条（编号）
    expect(m.prompts).toHaveLength(1)
    expect(m.prompts[0]).toContain('<<<WEB')
    expect(m.prompts[0]).toContain('[6] (brand) Trailmark Ridge 28 review')
    expect(m.prompts[0]).toContain('never from your own memory')

    const p = out.profile
    const comp = p.competitors?.value ?? []
    expect(comp.map((c) => c.name)).toEqual(['Osprey', 'Deuter', 'REI Co-op'])
    for (const c of comp) expect(c.sources?.length ?? 0).toBeGreaterThan(0)
    const osprey = comp[0]
    expect(osprey?.url).toBe('https://www.osprey.com/')
    expect(osprey?.sources?.map((x) => x.url)).toEqual([
      'https://forum.example/t/trailmark-vs-osprey',
      'https://www.osprey.com/daypacks',
    ])
    // 模型给的官网对不上：换成核实时搜到的、域名里带名字的那家
    expect(comp[1]?.url).toBe('https://www.deuter.com/')
    expect(comp[1]?.sources?.[0]?.url).toBe('https://www.deuter.com/')
    expect(comp[2]?.sources?.[0]?.url).toBe('https://www.rei.com/c/daypacks')
    // 「AI 建议」的认法不变（第一条证据仍是模型层），后面挂网页来源
    expect(p.competitors?.evidence[0]?.locator).toBe('model')
    expect(p.positioning?.evidence[0]?.locator).toBe('model')
    expect(p.positioning?.evidence.slice(1)).toEqual([
      {
        url: 'https://gearlab.example/trailmark-ridge-28-review',
        locator: 'web',
        quote: 'Trailmark Ridge 28 review',
      },
    ])
    expect(p.audience?.evidence.filter((e) => e.locator === 'web').map((e) => e.url)).toEqual([
      'https://gearlab.example/trailmark-ridge-28-review',
      'https://www.reddit.com/r/hiking/comments/abc/trailmark',
    ])
    expect(p.price_band?.evidence.filter((e) => e.locator === 'web')).toHaveLength(2)
  })

  it('没联网能力：一次不搜，竞品留空并照实说（模型给了也不收），提示词里不问竞品', async () => {
    const m = model()
    const out = await analyzeBrand(replayFetch(TRAIL_PAGES).fetch, [`${TRAIL}/`], {
      insights: { model: m.model },
      web: { reason: '联网搜索要先登录 DeepSeek 账号。' },
    })
    expect(out.web).toEqual({
      status: 'off',
      reason: '联网搜索要先登录 DeepSeek 账号。',
      searches: 0,
      credits: 0,
    })
    expect(out.profile.competitors).toBeUndefined()
    expect(out.profile.positioning?.evidence).toHaveLength(1)
    expect(m.prompts[0]).not.toContain('<<<WEB')
    expect(m.prompts[0]).toContain('Do NOT output "competitors"')

    // 完全没给联网选项：同样是「没联网」，用默认那一句
    const bare = await analyzeBrand(replayFetch(TRAIL_PAGES).fetch, [`${TRAIL}/`], {
      insights: { model: model().model },
    })
    expect(bare.web.status).toBe('off')
    expect(bare.web.reason).toBe(WEB_OFF_REASON)
  })

  it('搜了但一次都没搜成：照实记 failed，竞品空着', async () => {
    const s = fakeSearch(true)
    const out = await analyzeBrand(replayFetch(TRAIL_PAGES).fetch, [`${TRAIL}/`], {
      insights: { model: model().model },
      web: { search: s.search },
    })
    expect(out.web.status).toBe('failed')
    expect(out.web.searches).toBe(5) // 发现 2 + 品牌 3（没候选就不核实）
    expect(out.profile.competitors).toBeUndefined()
  })

  it('封顶装不下：先保官网解析，再竞品（发现 → 核实），最后品牌评测；照实说哪几部分没查', async () => {
    const base = await analyzeBrand(replayFetch(TRAIL_PAGES).fetch, [`${TRAIL}/`], {
      insights: { model: model().model },
    })
    const used = base.budget.spent_credits // 官网整轮 + AI 一次
    const pagesOk = base.pages.filter((p) => p.ok).length

    // 封顶照旧是 2；把每次搜索的价设成剩下的额度只够 3 次：竞品发现 2 + 核实 1，品牌评测与其余核实让掉
    const price = Math.floor(((DEFAULT_BRAND_INTAKE_CAP_CREDITS - used) / 3) * 100) / 100
    const s = fakeSearch()
    const tight = await analyzeBrand(replayFetch(TRAIL_PAGES).fetch, [`${TRAIL}/`], {
      insights: { model: model().model },
      web: { search: s.search, creditsPerSearch: price },
    })
    expect(tight.pages.filter((p) => p.ok)).toHaveLength(pagesOk)
    expect(s.asked).toEqual([
      'Trailmark alternatives',
      'Trailmark vs',
      'Osprey official site price',
    ])
    expect(tight.web.cut).toEqual(['verify', 'brand'])
    expect(tight.web.credits).toBeCloseTo(price * 3, 5)
    expect(tight.budget.spent_credits).toBeCloseTo(used + price * 3, 5)
    expect(tight.budget.spent_credits).toBeLessThanOrEqual(DEFAULT_BRAND_INTAKE_CAP_CREDITS)
    expect(tight.stopped_for_budget).toBe(false)
    expect(tight.profile.competitors?.value.map((c) => c.name)).toEqual([
      'Osprey',
      'Deuter',
      'REI Co-op',
    ])
    // 品牌评测没查：定位只挂得上搜到了的（编号 6 不存在 → 不挂）
    expect(tight.profile.positioning?.evidence).toHaveLength(1)

    // 一次都容不下：官网照旧、AI 照问，三部分都没查，竞品空着
    const none = fakeSearch()
    const zero = await analyzeBrand(replayFetch(TRAIL_PAGES).fetch, [`${TRAIL}/`], {
      insights: { model: model().model },
      web: { search: none.search, creditsPerSearch: DEFAULT_BRAND_INTAKE_CAP_CREDITS },
    })
    expect(zero.pages.filter((p) => p.ok)).toHaveLength(pagesOk)
    expect(none.asked).toHaveLength(0)
    expect(zero.insights).toBe('done')
    expect(zero.web).toMatchObject({ searches: 0, cut: ['competitors', 'verify', 'brand'] })
    expect(zero.profile.competitors).toBeUndefined()
    expect(zero.profile.brand_name?.value).toBe('Trailmark')
  })

  it('没接模型 / AI 那一步没跑：不联网（搜到的没人整理）', async () => {
    const s = fakeSearch()
    const out = await analyzeBrand(replayFetch(TRAIL_PAGES).fetch, [`${TRAIL}/`], {
      web: { search: s.search },
    })
    expect(s.asked).toHaveLength(0)
    expect(out.web.status).toBe('skipped')
  })

  it('竞品候选：认「A vs B」的另一边、「alternatives: …」「like / such as …」那一串，剔自己与泛词', () => {
    const got = competitorCandidates(
      [
        { url: 'https://a.example', title: 'Trailmark vs Osprey: which daypack?' },
        {
          url: 'https://b.example',
          title: 'Best Trailmark Alternatives: Deuter, Gregory and REI Co-op',
        },
        {
          url: 'https://c.example',
          snippet: 'Brands like Osprey, Kelty or Trailmark sell kid carriers.',
        },
        { url: 'https://d.example', title: 'Top 10 Daypacks 2026 Review vs Amazon Basics' },
      ],
      'Trailmark',
    )
    expect(got.slice(0, 5)).toEqual(['Osprey', 'Deuter', 'Gregory', 'REI Co-op', 'Kelty'])
    expect(got).not.toContain('Trailmark')
  })
})
