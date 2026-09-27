/**
 * WP166：SERP / AI 问答探测按用户产品的**目标市场**来，每个市场分别探。
 *
 * 钉住：只选了美国就只探美国；选了多个就每个都探（问题 × 平台 × 市场），每周估算跟着乘、明示几个市场；
 * 面板上关掉某个市场只关探测、不改档案；结果按市场分开算可见度；档案里没写才按品牌 `country`。
 */
import type { AiAnswerProbe, AiAnswerResult, EventEnvelope } from '@agentsws/contracts'
import { DEMO_GSC_ROWS, DEMO_PAGES, standInSearchConsole } from '@agentsws/seo-core'
import { createTxn } from '@agentsws/txn'
import { describe, expect, it } from 'vitest'
import { createSeoService, type SeoServiceOptions } from '../src/seo-service.js'

const NOW = '2026-09-28T00:00:00.000Z'
const CONTENT = {
  workspace_id: 'ws_1',
  person_id: 'p_li',
  assignment_id: 'asg_content',
  role_id: 'dtc.content',
}

function seeded(seed = 7): () => number {
  let a = seed >>> 0
  return () => {
    a = (a * 1664525 + 1013904223) >>> 0
    return a / 0x100000000
  }
}

/** 官方数据接口的替身：英国的 ChatGPT 提到我们，其余都没提。 */
function official() {
  const probes: AiAnswerProbe[] = []
  const port = {
    status: async () => ({
      configured: true,
      route: 'official' as const,
      platforms: ['chatgpt', 'gemini', 'google_ai_overview'] as const,
      prices: { serp: 0.2, ai_answer: 0.2 },
    }),
    serp: async () => {
      throw new Error('这一组不查 SERP')
    },
    aiAnswers: async (p: AiAnswerProbe): Promise<AiAnswerResult[]> => {
      probes.push(p)
      return p.platforms.map((platform) => ({
        platform,
        answer_excerpt: '',
        brand_mentioned: p.country === 'gb' && platform === 'chatgpt',
        our_domain_cited: false,
        cited_urls: ['https://review.example/x'],
        competitors_mentioned: [],
        fetched_at: NOW,
        source: 'official',
      }))
    },
  }
  return { port, probes }
}

function setup(markets: string[] | undefined, over: Partial<SeoServiceOptions> = {}) {
  const events: EventEnvelope[] = []
  const txn = createTxn({
    clock: { now: () => NOW },
    random: seeded(),
    eventSink: (e) => events.push(e),
    readRecord: () => ({}),
    backendApply: () => ({ status: 'ok', execution_id: 'exec_1' }),
    deliverOutbound: () => ({ status: 'ok', execution_id: 'exec_1' }),
  })
  const o = official()
  const service = createSeoService({
    workspace_id: 'ws_1',
    clock: { now: () => NOW },
    random: seeded(3),
    approvals: txn.approvals,
    ledger: txn.ledger,
    actionOf: () => ({ mandate: { caps: {} }, level: 'L1' }),
    holderOf: (role) => (role === 'dtc.content' ? CONTENT : undefined),
    thresholds: () => ({}),
    searchConsole: () => standInSearchConsole({ rows: DEMO_GSC_ROWS, pages: DEMO_PAGES }),
    searchData: () => o.port as never,
    orders: () => [],
    brand: () => ({
      name: 'NordVolt',
      language: 'en',
      domains: ['nordvolt.example'],
      shop_host: 'nordvolt.example',
      currency: 'USD',
      country: 'us',
      ...(markets === undefined ? {} : { markets }),
    }),
    appendEvent: (e) => events.push(e as EventEnvelope),
    ...over,
  })
  // 每周只问 2 个（估算好算：2 问 × 3 平台 × 市场数 × 0.2）
  service.setGeoSettings({ max_questions: 2 })
  return { service, txn, probes: o.probes }
}

describe('WP166 · 每个目标市场分别探', () => {
  it('只选了美国：只探美国；估算 = 问题 × 平台 × 1', async () => {
    const { service, probes } = setup(['US'])
    const view = await service.geoView()
    expect(view.markets).toEqual([{ code: 'US', probing: true }])
    expect(view.markets_from).toBe('brand_profile')
    expect(view.estimate).toMatchObject({ questions: 2, platforms: 3, markets: 1 })
    expect(view.estimate.credits_per_week).toBe(1.2)
    await service.weeklyGeo()
    expect(new Set(probes.map((p) => p.country))).toEqual(new Set(['us']))
  })

  it('美国 + 英国：每个市场各问一遍、估算乘 2；结果按市场分开算可见度', async () => {
    const { service, txn, probes } = setup(['US', 'GB'])
    const view = await service.geoView()
    expect(view.estimate).toMatchObject({ markets: 2, market_codes: ['US', 'GB'] })
    expect(view.estimate.credits_per_week).toBe(2.4)
    const out = await service.weeklyGeo()
    expect(probes.map((p) => p.country)).toEqual(['us', 'us', 'gb', 'gb'])
    expect(probes[0]?.question).toBe(probes[2]?.question)
    const card = await txn.approvals.get(out.approval_item_id ?? '')
    const payload = card?.payload as {
      rows: { market?: string }[]
      gaps: { market?: string; platforms: string[] }[]
      markets: { market: string; questions: number; seen: number; gaps: number }[]
    }
    expect(payload.rows.every((r) => r.market === 'US' || r.market === 'GB')).toBe(true)
    expect(payload.markets).toEqual([
      { market: 'US', questions: 2, seen: 0, gaps: 2 },
      { market: 'GB', questions: 2, seen: 2, gaps: 2 },
    ])
    // 缺位按市场分开：英国的缺位里没有 ChatGPT（它提到我们了），美国的有
    expect(payload.gaps.find((g) => g.market === 'GB')?.platforms).not.toContain('chatgpt')
    expect(payload.gaps.find((g) => g.market === 'US')?.platforms).toContain('chatgpt')
    expect(card?.summary).toContain('美国：2 问里 0 个')
    expect(card?.summary).toContain('英国：2 问里 2 个')
    expect(card?.summary).toContain('× 2 个市场')
  })

  it('面板上关掉英国：只探美国、估算跟着降；档案里的市场不动', async () => {
    const { service, probes } = setup(['US', 'GB'])
    const settings = service.setGeoSettings({ markets_off: ['gb'] })
    expect(settings.markets_off).toEqual(['GB'])
    const view = await service.geoView()
    expect(view.markets).toEqual([
      { code: 'US', probing: true },
      { code: 'GB', probing: false },
    ])
    expect(view.estimate.credits_per_week).toBe(1.2)
    await service.weeklyGeo()
    expect(new Set(probes.map((p) => p.country))).toEqual(new Set(['us']))
    // 再打开：空数组 = 都探
    expect(service.setGeoSettings({ markets_off: [] }).markets_off).toBeUndefined()
  })

  it('档案里没写市场：按品牌 country 那一个，界面写明按默认', async () => {
    const { service, probes } = setup(undefined)
    const view = await service.geoView()
    expect(view.markets).toEqual([{ code: 'US', probing: true }])
    expect(view.markets_from).toBe('default')
    await service.weeklyGeo()
    expect(new Set(probes.map((p) => p.country))).toEqual(new Set(['us']))
  })

  it('每日判断的人群核对也按市场：两个市场各查一次', async () => {
    const serpCountries: string[] = []
    const { service } = setup(['US', 'DE'], {
      searchData: () =>
        ({
          status: async () => ({ configured: true, route: 'official' }),
          serp: async (q: { country: string; query: string }) => {
            serpCountries.push(q.country)
            return { query: q, items: [], fetched_at: NOW, source: 'official' }
          },
          aiAnswers: async () => [],
        }) as never,
    })
    await service.daily()
    expect(new Set(serpCountries)).toEqual(new Set(['us', 'de']))
  })
})
