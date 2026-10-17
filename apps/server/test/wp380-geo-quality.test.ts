/**
 * WP380（决策 1066）：内容与搜索里 GEO 的第二层——服务端整条路。
 *
 * 上游全是替身：搜索数据口按「自带 key」那一档即时答（回答原文是录好的样本）、模型口回录好的判断回文、
 * 取网页口回夹具。不联网、不花钱。
 */
import type {
  AiAnswerProbe,
  AiAnswerResult,
  AiPlatform,
  EventEnvelope,
  GeoWatchCardPayload,
  SeoWeeklyGeoPayload,
} from '@agentsws/contracts'
import {
  GEO_SAMPLE_ANSWERS,
  GEO_SAMPLE_PAGES,
  promptId,
  standInSearchConsole,
} from '@agentsws/seo-core'
import { createTxn } from '@agentsws/txn'
import { describe, expect, it } from 'vitest'
import { createSeoService, type SeoServiceOptions } from '../src/seo-service.js'

const DAY = 86_400_000
const CONTENT = {
  workspace_id: 'ws_1',
  person_id: 'p_li',
  assignment_id: 'asg_content',
  role_id: 'dtc.content',
}
const holders: Record<string, typeof CONTENT> = {
  'dtc.content': CONTENT,
  'site.shopify-theme': {
    ...CONTENT,
    person_id: 'p_qian',
    assignment_id: 'asg_site',
    role_id: 'site.shopify-theme',
  },
  'dtc.store': { ...CONTENT, person_id: 'p_sun', assignment_id: 'asg_store', role_id: 'dtc.store' },
  'pr.press': { ...CONTENT, person_id: 'p_zhao', assignment_id: 'asg_pr', role_id: 'pr.press' },
}

const PROMPTS = [...new Set(GEO_SAMPLE_ANSWERS.map((s) => s.prompt))]
const NO_MENTION = 'Anker and Belkin are the usual picks.'

/** 品牌档案（测试里会改价格带）。 */
const profile = {
  price_band: '$39–$59',
}

function world() {
  let now = '2026-10-05T08:30:00.000Z'
  /** 某一问某个 AI 怎么答（默认录好的样本；没录的 = 没提我们）。 */
  let say = (p: AiPlatform, q: string): string =>
    GEO_SAMPLE_ANSWERS.find((s) => s.platform === p && s.prompt === q)?.text ?? NO_MENTION
  const result = (platform: AiPlatform, q: string): AiAnswerResult => ({
    platform,
    answer_excerpt: '',
    answer_markdown: say(platform, q),
    citations: [
      {
        position: 1,
        url: 'https://travelgear.example/reviews/nordvolt-air',
        domain: 'travelgear.example',
        where: 'inline',
      },
      {
        position: 2,
        url: 'https://www.reddit.com/r/onebag/x',
        domain: 'reddit.com',
        where: 'listed',
      },
    ],
    brand_mentioned: false,
    our_domain_cited: false,
    cited_urls: [],
    competitors_mentioned: [],
    fetched_at: now,
    source: 'byo',
    credits: 0,
  })
  const probes: AiAnswerProbe[] = []
  const search = {
    status: async () => ({
      configured: true,
      route: 'byo' as const,
      platforms: ['chatgpt', 'gemini', 'google_ai_overview', 'claude'] as AiPlatform[],
      prices: { serp: 0, ai_answer: 0 },
    }),
    serp: async (q: { query: string }) => ({ query: q, items: [], fetched_at: now, source: 'byo' }),
    aiAnswers: async (p: AiAnswerProbe) => {
      probes.push(p)
      return p.platforms.map((pl) => result(pl, p.question))
    },
  }
  const prompts: string[] = []
  /** 模型口：判断回文按回答原文对上录好的那条；读页面按网址对上录好的那条。 */
  const model = async ({ prompt }: { prompt: string }) => {
    prompts.push(prompt)
    if (prompt.includes('Classify each website domain'))
      return { text: JSON.stringify({ 'travelgear.example': 'media' }) }
    const page = GEO_SAMPLE_PAGES.find((p) => prompt.includes(`<<<PAGE ${p.url}`))
    if (page !== undefined) return { text: page.reply }
    const body = prompt.split('<<<ANSWER\n')[1]?.split('\nANSWER>>>')[0] ?? ''
    const s = GEO_SAMPLE_ANSWERS.find((x) => x.text === body)
    if (s !== undefined) return { text: s.reply }
    const quote = body.split(/(?<=\.)\s/).find((x) => x.includes('NordVolt'))
    return {
      text: JSON.stringify({
        sentiment: quote === undefined ? null : 'positive',
        quote: quote ?? null,
        brands: [],
        claims: [],
      }),
    }
  }
  /** 取网页：两张夹具页（HTML 里带 JSON-LD）；其余取不到。 */
  const fetched: string[] = []
  const pageFetch = async (url: string) => {
    fetched.push(url)
    const p = GEO_SAMPLE_PAGES.find((x) => x.url === url)
    if (p === undefined) return undefined
    const ld = p.jsonld.map(
      (n) => `<script type="application/ld+json">${JSON.stringify(n)}</script>`,
    )
    return { html: `<html><head>${ld.join('')}</head><body><p>${p.text}</p></body></html>` }
  }
  return {
    clock: { now: () => now },
    add: (days: number) => {
      now = new Date(Date.parse(now) + days * DAY).toISOString()
    },
    setSay: (f: typeof say) => {
      say = f
    },
    search,
    probes,
    model,
    prompts,
    pageFetch,
    fetched,
  }
}

function setup(w: ReturnType<typeof world>, over: Partial<SeoServiceOptions> = {}) {
  const events: EventEnvelope[] = []
  const txn = createTxn({
    clock: w.clock,
    random: () => 0.5,
    eventSink: (e) => events.push(e),
    readRecord: () => ({}),
    backendApply: () => ({ status: 'ok', execution_id: 'exec_1' }),
    deliverOutbound: () => ({ status: 'ok', execution_id: 'exec_1' }),
  })
  const matters: Record<string, unknown>[] = []
  let r = 0
  const service = createSeoService({
    workspace_id: 'ws_1',
    clock: w.clock,
    random: () => {
      r = (r + 0.137) % 1
      return r
    },
    approvals: txn.approvals,
    ledger: txn.ledger,
    actionOf: () => ({ mandate: { caps: {} }, level: 'L1' }),
    holderOf: (role) => holders[role],
    thresholds: () => ({}),
    work: {
      createMatter: (input) => {
        const m = { id: `mat_${matters.length + 1}`, ...input }
        matters.push(m)
        return m
      },
    },
    searchConsole: () => standInSearchConsole({ rows: [], pages: [] }),
    searchData: () => w.search as never,
    orders: () => [],
    brand: () => ({
      name: 'NordVolt',
      language: 'en',
      domains: ['nordvolt.example'],
      shop_host: 'nordvolt.example',
      currency: 'USD',
      country: 'us',
      markets: ['US'],
      category: 'travel power bank',
      price_band: profile.price_band,
      positioning: 'flight-safe 10000mAh, charges a phone three times, 180 g',
    }),
    appendEvent: (e) => events.push(e as EventEnvelope),
    watchModel: () => w.model,
    watchSleep: async () => undefined,
    watchWaitBudgetMs: 0,
    pageFetch: w.pageFetch,
    ...over,
  })
  const cards = (form: GeoWatchCardPayload['form']) =>
    txn.approvals
      .queue({ workspace_id: 'ws_1', person_id: 'p_li', lane: 'mine', kind: 'geo_watch' })
      .then((xs) => xs.filter((x) => (x.payload as GeoWatchCardPayload).form === form))
  const decide = async (id: string, action: 'approve' | 'reject') => {
    const card = await txn.approvals.get(id)
    const token = card?.deliveries.find((d) => d.to === 'p_li')?.decision_token ?? ''
    const decided = await txn.approvals.decide(id, 'p_li', {
      action,
      decision_token: token,
      via: 'web',
      ...(action === 'reject' ? { reason: '先不要' } : {}),
    })
    await service.onDecided(decided)
  }
  return { service, txn, matters, events, cards, decide }
}

/** 先把官方事实同步一次（旧价），再改价、过几天——这样「$39」算过时；关注那四问与两个竞品。 */
async function prepare(service: ReturnType<typeof setup>['service'], w: ReturnType<typeof world>) {
  w.add(-30)
  profile.price_band = '$39–$59'
  await service.watchFacts()
  w.add(30)
  profile.price_band = '$45–$69'
  await service.watchApply({
    competitors: [
      { id: 'c_anker', name: 'Anker', aliases: [], domains: ['anker.com'] },
      { id: 'c_belkin', name: 'Belkin', aliases: [], domains: ['belkin.com'] },
    ],
    add_prompts: PROMPTS.map((text) => ({ text, selected: true })),
    prompt_limit: 5,
    select: PROMPTS.map((t) => promptId(t)),
    platforms: ['chatgpt', 'gemini', 'claude', 'google_ai_overview'],
  })
}

describe('WP380 比较胜率 / 描述准确度进监测与周报', () => {
  it('一轮问完：提到我们的回答顺带判比较与说法（附原话），周报每个数标来路、缺位带主因与复查日期', async () => {
    const w = world()
    const { service, txn } = setup(w)
    await prepare(service, w)
    const facts = await service.watchFacts()
    expect(facts.find((f) => f.key === 'price')).toMatchObject({
      value: '$45–$69',
      previous: [{ value: '$39–$59' }],
    })
    const out = await service.weeklyGeo('manual')
    // 判断那一问带上了官方事实与竞品（同一次调用，不多花一次）
    const judged = w.prompts.filter((p) => p.includes('<<<ANSWER'))
    expect(judged.some((p) => p.includes('"compare"') && p.includes('<<<FACTS'))).toBe(true)
    const view = await service.watchMetrics()
    const point = view.trends.find((l) => l.kind === 'all')?.points.at(-1)
    expect(point).toMatchObject({ compared: 2, wins: 1, win_rate: 0.5 })
    expect(point).toMatchObject({
      claims: 6,
      claims_correct: 3,
      claims_wrong: 2,
      claims_outdated: 1,
    })
    expect(view.quality?.bad_claims.map((b) => [b.field, b.verdict])).toEqual(
      expect.arrayContaining([
        ['price', 'outdated'],
        ['category', 'wrong'],
        ['markets', 'wrong'],
      ]),
    )
    expect(view.quality?.facts.map((f) => f.key)).toEqual([
      'name',
      'category',
      'price',
      'selling_points',
      'markets',
    ])
    const report = await txn.approvals.get(out.approval_item_id ?? '')
    const payload = report?.payload as SeoWeeklyGeoPayload
    expect(payload.figures?.map((f) => [f.key, f.basis])).toEqual(
      expect.arrayContaining([
        ['mention_rate', 'measured'],
        ['win_rate', 'derived'],
        ['accuracy', 'derived'],
      ]),
    )
    expect(payload.figures?.every((f) => f.as_of === payload.week_of)).toBe(true)
    expect(payload.gaps.length).toBeGreaterThan(0)
    expect(payload.gaps.every((g) => g.cause !== undefined && g.recheck_on !== undefined)).toBe(
      true,
    )
    expect(payload.source_map?.map((m) => m.group)).toEqual(
      expect.arrayContaining(['media', 'community']),
    )
    expect(report?.summary).toContain('比较胜率 50%（推算，n=2）')
    expect(report?.summary).toContain('先做：')
    expect(report?.summary).not.toMatch(/DataForSEO/i)
    // 每周那一轮顺手查了一次对外说法（第一次）
    expect(payload.consistency?.findings).toBeGreaterThan(0)
  })

  it('WP381 的位置：给了就进周报与摘要，没给不出现', async () => {
    const w = world()
    const { service, txn } = setup(w, {
      geoReportExtras: async () => ({
        slots: {
          ai_traffic: { title: 'AI 来源流量', lines: ['上周 42 次访问'], basis: 'measured' },
        },
      }),
    })
    await prepare(service, w)
    const out = await service.weeklyGeo('manual')
    const report = await txn.approvals.get(out.approval_item_id ?? '')
    const slots = (report?.payload as SeoWeeklyGeoPayload | undefined)?.slots
    expect(slots?.ai_traffic?.lines).toEqual(['上周 42 次访问'])
    expect(report?.summary).toContain('AI 来源流量：上周 42 次访问')
    expect(slots?.site_check).toBeUndefined()
  })

  it('合并 WP380 × WP381：AI 来源流量（实测）进 ai_traffic 的位置，摘要里只出一次', async () => {
    const w = world()
    const traffic = {
      measured: true as const,
      since: '2026-10-05',
      until: '2026-10-11',
      currency: 'USD',
      rows: [],
      total_orders: 10,
      ai_orders: 2,
      ai_revenue: 99.98,
      visits: 'no_scope' as const,
      computed_at: '2026-10-12T00:00:00.000Z',
    }
    const { service, txn } = setup(w, { aiTraffic: async () => traffic })
    await prepare(service, w)
    const out = await service.weeklyGeo('manual')
    const report = await txn.approvals.get(out.approval_item_id ?? '')
    const payload = report?.payload as SeoWeeklyGeoPayload | undefined
    expect(payload?.ai_traffic).toEqual(traffic)
    expect(payload?.slots?.ai_traffic?.basis).toBe('measured')
    expect(payload?.slots?.ai_traffic?.lines[0]).toContain('AI 带来 2 单 / USD 99.98（实测）')
    expect(report?.summary.split('AI 带来 2 单').length).toBe(2)
  })
})

describe('WP380 对外说法一致性', () => {
  it('对官网 / 商品页 / 结构化数据 / 评测页：按岗位分好出一张卡；批了每个岗位各开一件事（同一来源批次），记一条四周后的复查', async () => {
    const w = world()
    const { service, cards, decide, matters } = setup(w)
    await prepare(service, w)
    await service.weeklyGeo('manual')
    const run = await service.watchConsistency({
      urls: [GEO_SAMPLE_PAGES[0].url, GEO_SAMPLE_PAGES[1].url],
    })
    expect(run?.pages.map((p) => [p.surface, p.status])).toEqual(
      expect.arrayContaining([
        ['product_page', 'ok'],
        ['review', 'ok'],
        ['site', 'failed'],
      ]),
    )
    expect(run?.findings.map((f) => [f.owner, f.field, f.verdict, f.by])).toEqual(
      expect.arrayContaining([
        ['web-ops', 'price', 'outdated', 'rules'],
        ['site', 'price', 'wrong', 'rules'],
        ['pr', 'markets', 'wrong', 'ai'],
        ['pr', 'selling_points', 'wrong', 'ai'],
      ]),
    )
    // 模型摘的那句页面上没有：不算
    expect(run?.findings.some((f) => f.said === 'made up')).toBe(false)
    const card = (await cards('geo_consistency')).find((c) => c.id === run?.card_id)
    if (card === undefined) throw new Error('没出一致性卡')
    const p = card.payload as Extract<GeoWatchCardPayload, { form: 'geo_consistency' }>
    expect(p.groups.map((g) => g.owner)).toEqual(['site', 'web-ops', 'pr'])
    expect(card.summary).toContain('建站')
    const before = matters.length
    await decide(card.id, 'approve')
    const opened = matters.slice(before)
    expect(opened.map((m) => m.position_template_id)).toEqual(['site', 'web-ops', 'pr'])
    expect(opened.map((m) => m.position_id)).toEqual(['asg_site', 'asg_store', 'asg_pr'])
    expect(opened.every((m) => String(m.summary).includes(p.batch_id))).toBe(true)
    expect(String(opened[2]?.summary)).toContain('官方是「US」')
    expect(String(opened[0]?.summary)).toContain('复查：')
    const view = await service.watchMetrics()
    const rc = view.quality?.rechecks.find((r) => r.source === 'consistency')
    expect(rc).toMatchObject({ metric: 'accuracy', status: 'waiting', due: p.recheck_on })
    expect(rc?.before.n).toBeGreaterThan(0)
  })

  it('没装取网页口：照实写「取不了网页」，不出卡', async () => {
    const w = world()
    const { service, cards } = setup(w, { pageFetch: undefined })
    await prepare(service, w)
    const run = await service.watchConsistency({ urls: [GEO_SAMPLE_PAGES[0].url] })
    expect(run?.pages.every((p) => p.status === 'skipped')).toBe(true)
    expect(run?.findings).toEqual([])
    expect(await cards('geo_consistency')).toHaveLength(0)
  })
})

describe('WP380 改完自动复查', () => {
  it('登记 → 到期即时重问那组问题 → 前后一比出「扩大」卡（复查那一轮不进每周指标）→ 批了开一件跟进的事', async () => {
    const w = world()
    const { service, cards, decide, matters } = setup(w)
    await prepare(service, w)
    await service.weeklyGeo('manual')
    const target = promptId('Cheapest reliable power bank?')
    const r = await service.watchRecheck({
      change: '「最便宜靠谱的充电宝」那页加了价格对比小节',
      metric: 'mention_rate',
      prompt_ids: [target],
      due_days: 14,
    })
    expect(r).toMatchObject({ status: 'waiting', due: '2026-10-19', before: { value: 0, n: 4 } })
    // 没到期：不跑
    expect(await service.watchRecheckDue()).toEqual([])
    const weekly = (await service.watchMetrics()).trends.find((l) => l.kind === 'all')?.points
    w.add(14)
    w.setSay((_p, q) =>
      q === 'Cheapest reliable power bank?'
        ? 'NordVolt Air is the cheapest reliable pick; Anker costs more.'
        : NO_MENTION,
    )
    const asked = w.probes.length
    const [done] = await service.watchRecheckDue()
    // 只问了那一问（三家一次、Claude 单问一次，都是即时问）
    expect([...new Set(w.probes.slice(asked).map((p) => p.question))]).toEqual([
      'Cheapest reliable power bank?',
    ])
    expect(done).toMatchObject({
      status: 'done',
      advice: 'expand',
      delta_pp: 100,
      after: { value: 1, n: 4 },
    })
    // 复查那一轮不进每周指标
    expect((await service.watchMetrics()).trends.find((l) => l.kind === 'all')?.points).toEqual(
      weekly,
    )
    const [card] = await cards('geo_recheck')
    expect(card?.title).toContain('扩大')
    expect(card?.summary).toContain('0%（n=4）→ 100%（n=4）')
    const before = matters.length
    await decide(card?.id ?? '', 'approve')
    expect(matters.slice(before).map((m) => m.title)).toEqual([
      '扩大：「最便宜靠谱的充电宝」那页加了价格对比小节',
    ])
  })

  it('到期没拿到回答：再等一周；两次都没拿到就放弃', async () => {
    const w = world()
    const { service } = setup(w)
    await prepare(service, w)
    await service.weeklyGeo('manual')
    await service.watchRecheck({
      change: 'x 页改了标题',
      metric: 'mention_rate',
      prompt_ids: [promptId('Best power bank for long flights?')],
      due_days: 7,
    })
    await service.watchApply({ enabled: false })
    w.add(7)
    const [first] = await service.watchRecheckDue()
    expect(first).toMatchObject({ status: 'waiting', tries: 1 })
    w.add(7)
    const [second] = await service.watchRecheckDue()
    expect(second).toMatchObject({ status: 'skipped', tries: 2 })
  })
})
