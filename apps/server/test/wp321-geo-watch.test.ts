/**
 * WP321（docs/99 §7 O2）：SEO 与 GEO里的 GEO / SEO 监测——策略设定卡、每周一轮写历史（排队档批量 /
 * Claude / 关注词排名 / 品牌词周数据）、指标、变化大才出卡、迁移（决策 532）、自带 key 查模型清单（534）。
 * 上游全是替身：搜索数据口、数据能力口、模型口都不联网、不花钱。
 */
import type {
  AiAnswerProbe,
  AiAnswerResult,
  AiPlatform,
  DataCapabilityView,
  DataTaskView,
  EventEnvelope,
  GeoWatchCardPayload,
  GscRow,
  SeoRankCheckItem,
  SeoWeeklyGeoPayload,
} from '@agentsws/contracts'
import { disconnectedSearchConsole, standInSearchConsole } from '@agentsws/seo-core'
import { createTxn } from '@agentsws/txn'
import { describe, expect, it } from 'vitest'
import type { WatchDataPort } from '../src/geo-monitor.js'
import { createGeoStore, SEO_STATE_IMPORTED_KEY } from '../src/geo-store.js'
import { createSeoService, type SeoServiceOptions } from '../src/seo-service.js'

const DAY = 86_400_000
const CONTENT = {
  workspace_id: 'ws_1',
  person_id: 'p_li',
  assignment_id: 'asg_content',
  role_id: 'dtc.seo',
}
const PR = { ...CONTENT, person_id: 'p_zhao', assignment_id: 'asg_pr', role_id: 'pr.forums' }

const STRATEGY_REPLY = JSON.stringify({
  category: 'power bank',
  stage: 'new',
  prompt_limit: 5,
  branded: 1,
  topic_mix: { category: 2, use_case: 1, comparison: 1, branded: 1 },
  prompts: [
    { text: 'Which power bank brand is best for long flights?', topic: 'category' },
    { text: 'What portable charger do travel bloggers recommend?', topic: 'category' },
    { text: 'Best power bank for camping trips?', topic: 'use_case' },
    { text: 'Anker or Belkin for a travel power bank?', topic: 'comparison' },
    { text: 'Is NordVolt a good power bank brand?', topic: 'branded' },
    { text: 'Cheapest reliable power bank?', topic: 'price_value' },
  ],
  competitors: [{ name: 'Anker', domains: ['anker.com'] }],
  keywords: [
    { keyword: 'nordvolt', branded: true },
    { keyword: 'travel power bank', branded: false },
  ],
  why: ['新品牌，AI 还不太认识，先看品类问题'],
})

const GSC: GscRow[] = [
  {
    query: 'nordvolt',
    page: 'https://nordvolt.example/',
    clicks: 30,
    impressions: 300,
    ctr: 0.1,
    position: 1,
  },
  {
    query: 'nordvolt review',
    page: 'https://nordvolt.example/r',
    clicks: 5,
    impressions: 100,
    ctr: 0.05,
    position: 5,
  },
  {
    query: 'travel power bank',
    page: 'https://nordvolt.example/t',
    clicks: 20,
    impressions: 2000,
    ctr: 0.01,
    position: 8.4,
  },
]

const MENTION = 'For trips, NordVolt Air is a great pick. Anker is also popular.'
const NO_MENTION = 'Anker and Belkin are the usual picks.'

function world(opts: { route?: 'official' | 'byo' } = {}) {
  let now = '2026-10-05T08:30:00.000Z'
  const clock = { now: () => now }
  /** 每个 AI、每一问怎么答（测试里随周改）。 */
  let say = (_p: AiPlatform, _q: string): string => MENTION
  let brands: string[] = []
  let ready = true
  let rankOf = (_k: string): number | undefined => 4
  const probes: AiAnswerProbe[] = []
  const citations = [
    {
      position: 1,
      url: 'https://travelblog.example/best',
      domain: 'travelblog.example',
      where: 'inline' as const,
    },
    {
      position: 2,
      url: 'https://nordvolt.example/air',
      domain: 'nordvolt.example',
      where: 'listed' as const,
    },
  ]
  /** 没提我们的回答也不引我们的站（「缺位」= 既没提、也没引）。 */
  const citesFor = (text: string) => (text === NO_MENTION ? citations.slice(0, 1) : citations)
  const result = (platform: AiPlatform, q: string): AiAnswerResult => ({
    platform,
    answer_excerpt: '',
    answer_markdown: say(platform, q),
    citations: citesFor(say(platform, q)),
    brand_mentioned: false,
    our_domain_cited: false,
    cited_urls: citesFor(say(platform, q)).map((c) => c.url),
    competitors_mentioned: [],
    fetched_at: now,
    source: opts.route ?? 'official',
    credits: opts.route === 'byo' ? 0 : 0.2,
  })
  const search = {
    status: async () => ({
      configured: true,
      route: opts.route ?? ('official' as const),
      platforms:
        opts.route === 'byo'
          ? (['chatgpt', 'gemini', 'google_ai_overview', 'claude'] as AiPlatform[])
          : (['chatgpt', 'gemini', 'google_ai_overview'] as AiPlatform[]),
      prices: { serp: 0.2, ai_answer: 0.2 },
    }),
    serp: async (q: { query: string }) => ({
      query: q,
      items: [],
      fetched_at: now,
      source: 'official',
    }),
    aiAnswers: async (p: AiAnswerProbe) => {
      probes.push(p)
      return p.platforms.map((pl) => result(pl, p.question))
    },
  }
  // ── 数据能力口（排队档批量问答、Claude、关注词排名）──
  const cap = (id: string, credits: number, mode: 'sync' | 'async'): DataCapabilityView => ({
    id,
    label_zh: id,
    label_en: id,
    group: 'search',
    mode,
    unit: mode === 'sync' ? 'call' : 'item',
    credits_per_unit: credits,
    available: true,
    input: [],
  })
  const submitted: { capability: string; input: Record<string, unknown> }[] = []
  const called: { capability: string; input: Record<string, unknown> }[] = []
  const tasks = new Map<string, { capability: string; input: Record<string, unknown> }>()
  const itemsOf = (id: string): Record<string, unknown>[] => {
    const t = tasks.get(id)
    if (t === undefined) return []
    if (t.capability === 'seo.rank_check')
      return (t.input.keywords as string[]).map((k): SeoRankCheckItem => {
        const r = rankOf(k)
        return {
          keyword: k,
          country: 'us',
          language: 'en',
          device: 'mobile',
          organic: [
            { rank: 1, url: 'https://anker.com/x', domain: 'anker.com', title: 'Anker' },
            ...(r === undefined
              ? []
              : [
                  {
                    rank: r,
                    url: 'https://shop.nordvolt.example/p',
                    domain: 'shop.nordvolt.example',
                    title: 'NordVolt',
                  },
                ]),
          ],
          features: { ai_overview: true, people_also_ask: true, shopping: false, video: false },
          ai_overview: { text: 'NordVolt and Anker both work.', citations: [] },
          fetched_at: now,
        }
      }) as unknown as Record<string, unknown>[]
    const platform = t.capability.slice('ai_answer_batch.'.length) as AiPlatform
    return (t.input.questions as string[]).map((q) => ({
      platform,
      text: say(platform, q),
      cited_urls: citesFor(say(platform, q)).map((c) => c.url),
      citations: citesFor(say(platform, q)),
      model: 'web',
      via: 'web_ui',
      question: q,
    }))
  }
  const view = (id: string): DataTaskView => ({
    id,
    capability: tasks.get(id)?.capability ?? '',
    status: ready ? 'succeeded' : 'running',
    max_items: 100,
    item_count: ready ? itemsOf(id).length : 0,
    reserved_credits: 1,
    credits: ready ? Math.round(itemsOf(id).length * 0.2 * 10) / 10 : 0,
    created_at: now,
    source: 'official',
  })
  const data: WatchDataPort = {
    capabilities: async () => ({
      capabilities: [
        cap('ai_answer.claude', 3.6, 'sync'),
        cap('seo.rank_check', 0.1, 'async'),
        cap('ai_answer_batch.chatgpt', 0.2, 'async'),
        cap('ai_answer_batch.gemini', 0.2, 'async'),
        cap('ai_answer_batch.google_ai_overview', 0.2, 'async'),
      ],
      at: now,
    }),
    call: async (capability, { input }) => {
      called.push({ capability, input })
      const q = String(input.question)
      return {
        capability,
        items: [
          {
            platform: 'claude',
            text: say('claude', q),
            cited_urls: [],
            citations: citesFor(say('claude', q)),
            model: 'claude-sonnet-5',
            via: 'model_api',
          },
        ],
        quantity: 1,
        credits: 3.6,
        cached: false,
        fetched_at: now,
        source: 'official',
      }
    },
    submit: async (input) => {
      const id = `task_${tasks.size + 1}`
      tasks.set(id, { capability: input.capability, input: input.input })
      submitted.push({ capability: input.capability, input: input.input })
      return view(id)
    },
    task: async (id) => view(id),
    items: async (id) => ({ task_id: id, items: itemsOf(id), total: itemsOf(id).length }),
  }
  // ── 模型口（策略、情感、站点分类）──
  const modelPrompts: string[] = []
  const model = async ({ prompt }: { prompt: string }) => {
    modelPrompts.push(prompt)
    if (prompt.includes('tracking strategy')) return { text: STRATEGY_REPLY }
    if (prompt.includes('Classify each website domain'))
      return { text: JSON.stringify({ 'travelblog.example': 'media' }) }
    const body = prompt.split('<<<ANSWER\n')[1]?.split('\nANSWER>>>')[0] ?? ''
    const sentence = body.split(/(?<=\.)\s/).find((x) => x.includes('NordVolt'))
    return {
      text: JSON.stringify({
        sentiment: sentence === undefined ? null : 'positive',
        quote: sentence ?? null,
        brands,
      }),
    }
  }
  return {
    clock,
    setNow: (iso: string) => {
      now = iso
    },
    nextWeek: () => {
      now = new Date(Date.parse(now) + 7 * DAY).toISOString()
    },
    setSay: (f: typeof say) => {
      say = f
    },
    setBrands: (b: string[]) => {
      brands = b
    },
    setReady: (v: boolean) => {
      ready = v
    },
    setRank: (f: typeof rankOf) => {
      rankOf = f
    },
    search,
    data,
    probes,
    submitted,
    called,
    model,
    modelPrompts,
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
  const matters: {
    id: string
    title: string
    summary?: string
    role_id?: string
    position_template_id?: string
  }[] = []
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
    holderOf: (role) => (role === 'dtc.seo' ? CONTENT : role === 'pr.forums' ? PR : undefined),
    thresholds: () => ({}),
    work: {
      createMatter: (input) => {
        const m = { id: `mat_${matters.length + 1}`, ...input }
        matters.push(m)
        return m
      },
    },
    searchConsole: () => standInSearchConsole({ rows: GSC, pages: [] }),
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
    }),
    appendEvent: (e) => events.push(e as EventEnvelope),
    dataService: () => w.data,
    watchModel: () => w.model,
    watchSleep: async () => undefined,
    watchWaitBudgetMs: 0,
    ...over,
  })
  const cards = (form?: GeoWatchCardPayload['form']) =>
    txn.approvals
      .queue({ workspace_id: 'ws_1', person_id: 'p_li', lane: 'mine', kind: 'geo_watch' })
      .then((xs) =>
        xs.filter((x) => form === undefined || (x.payload as GeoWatchCardPayload).form === form),
      )
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
  const reports = () =>
    events
      .filter((e) => e.type === 'seo.weekly_geo')
      .map((e) => e.payload as Record<string, unknown>)
  return { service, txn, matters, events, cards, decide, reports }
}

describe('WP321 策略设定与每周一轮', () => {
  it('第一次：AI 按档案给策略出设定卡（不预设带品牌名几条、Claude 每月写清）；决策 650：定之前也问四家（Claude 走能力目录），三家走排队档批量', async () => {
    const w = world()
    const { service, txn, cards, decide } = setup(w)
    // 兜底先选的几条（品牌档案没写品类：只有带品牌名的套句）
    const n = (await service.watchView()).watch.prompts.length
    const out = await service.weeklyGeo()
    const [card] = await cards('geo_watch_setup')
    if (card === undefined) throw new Error('没出设定卡')
    const p = card.payload as Extract<GeoWatchCardPayload, { form: 'geo_watch_setup' }>
    expect(p.first).toBe(true)
    expect(p.strategy).toMatchObject({
      by: 'ai',
      prompt_limit: 5,
      branded: 1,
      category: 'power bank',
    })
    expect(p.strategy.prompts.map((q) => q.text)).toEqual([
      'Is NordVolt a good power bank brand?',
      'Which power bank brand is best for long flights?',
      'What portable charger do travel bloggers recommend?',
      'Best power bank for camping trips?',
      'Anker or Belkin for a travel power bank?',
    ])
    expect(p.strategy.competitors.map((c) => c.name)).toEqual(['Anker'])
    expect(p.estimate).toMatchObject({ claude_credits_per_month: 77.9, needs_confirm: true })
    expect(card.summary).toContain('带品牌名 1 条')
    expect(card.summary).toContain('其中 Claude 每月')
    expect(card.summary).not.toMatch(/DataForSEO/i)
    // 决策 650（Luoye 10-14）：定之前定时那一轮也问 Claude；三家走排队档批量
    expect(w.submitted.map((s) => s.capability).sort()).toEqual([
      'ai_answer_batch.chatgpt',
      'ai_answer_batch.gemini',
      'ai_answer_batch.google_ai_overview',
    ])
    expect(w.called.map((c) => c.capability)).toEqual(Array(n).fill('ai_answer.claude'))
    expect(w.probes).toHaveLength(0)
    const store = await service.geoHistory()
    const asked = store.answers()
    expect(n).toBeGreaterThan(0)
    expect(asked.length).toBe(n * 4)
    expect(asked.filter((a) => a.platform === 'claude')).toHaveLength(n)
    expect(asked.every((a) => a.status === 'ok')).toBe(true)
    // 情感：模型判、附原话（原话对得上才算）；站点分类：模型一次、缓存
    const ours = store.mentions(asked[0]?.id ?? '').find((m) => m.entity === 'ours')
    expect(ours).toMatchObject({ mentioned: true, sentiment: 'positive' })
    expect(ours?.sentiment_quote).toContain('NordVolt Air')
    expect(store.domainKind('travelblog.example')).toBe('media')
    const report = await txn.approvals.get(out.approval_item_id ?? '')
    const payload = report?.payload as SeoWeeklyGeoPayload
    expect(payload.run_id).toBeDefined()
    expect(payload.metrics).toMatchObject({
      planned: n * 4,
      ok: n * 4,
      mention_rate: 1,
      citation_rate: 1,
    })
    expect(payload.notes.join('')).not.toContain('Claude 这一轮没问')
    expect((await service.watchView()).setup).toBe('pending_card')

    // 批了：落成关注设置；下一周起按新的 5 条问、查关注词排名（前 20、手机）
    await decide(card.id, 'approve')
    const v = await service.watchView()
    expect(v.setup).toBe('done')
    expect(v.watch.prompts.map((q) => q.text)).toEqual(p.strategy.prompts.map((q) => q.text))
    expect(v.watch.competitors.map((c) => c.name)).toEqual(['Anker'])
    expect(v.watch.keywords.map((k) => k.keyword)).toEqual(['nordvolt', 'travel power bank'])
    w.nextWeek()
    await service.weeklyGeo()
    expect(w.called.map((c) => c.capability)).toEqual(Array(n + 5).fill('ai_answer.claude'))
    const rank = w.submitted.find((s) => s.capability === 'seo.rank_check')
    expect(rank?.input).toMatchObject({
      keywords: ['nordvolt', 'travel power bank'],
      depth: 20,
      device: 'mobile',
      country: 'us',
    })
    const runs = (await service.geoHistory()).runs({ kind: 'geo' })
    expect(runs.map((r) => [r.period, r.planned, r.answered, r.status])).toEqual([
      ['2026-10-05', n * 4, n * 4, 'done'],
      ['2026-10-12', 20, 20, 'done'],
    ])
    expect(runs[1]?.credits).toBe(21)
  })

  it('不要：先按兜底跑、不再自动出设定卡；面板照样显示「还没定」', async () => {
    const w = world()
    const { service, cards, decide } = setup(w)
    await service.weeklyGeo()
    const [card] = await cards('geo_watch_setup')
    await decide(card?.id ?? '', 'reject')
    w.nextWeek()
    await service.weeklyGeo()
    expect(await cards('geo_watch_setup')).toHaveLength(0)
    const v = await service.watchView()
    expect(v.setup).toBe('needed')
    expect(v.setup_card_id).toBeUndefined()
    // 改策略：自己要一份新的（同时出卡）
    const s = await service.watchSuggest({ card: true })
    expect(s.approval_item_id).toBeDefined()
    expect(s.strategy.by).toBe('ai')
  })

  it('现在跑一轮：Claude 单格 ≥ 1 积分先只回估算；确认了才跑，而且走即时（不走排队档）', async () => {
    const w = world()
    const { service } = setup(w)
    const first = await service.watchRun({})
    expect(first).toMatchObject({ started: false, needs_confirm: true })
    expect(first.estimate.platforms.map((p) => p.platform)).toContain('claude')
    expect(w.probes).toHaveLength(0)
    const n = (await service.watchView()).watch.prompts.length
    const ran = await service.watchRun({ confirm: true })
    expect(ran.started).toBe(true)
    expect(ran.runs[0]).toMatchObject({ kind: 'geo', trigger: 'manual', status: 'done' })
    expect(w.probes).toHaveLength(n)
    expect(
      w.probes.every((p) => p.platforms.join(',') === 'chatgpt,gemini,google_ai_overview'),
    ).toBe(true)
    expect(w.called).toHaveLength(n)
    expect(w.submitted).toHaveLength(0)
  })

  it('排队档没回来：先留着，报告卡写「还在排队」；每天早上那一轮收回来、按同一周重出', async () => {
    const w = world()
    w.setReady(false)
    const { service, reports } = setup(w)
    const n = (await service.watchView()).watch.prompts.length * 3
    await service.weeklyGeo()
    expect(reports()[0]).toMatchObject({ pending_cells: n })
    const store = await service.geoHistory()
    expect(store.runs({ kind: 'geo' })[0]?.status).toBe('running')
    expect(store.tasks({ status: 'pending' })).toHaveLength(3)
    w.setReady(true)
    w.setNow('2026-10-06T08:00:00.000Z')
    await service.daily()
    expect(store.runs({ kind: 'geo' })[0]?.status).toBe('done')
    // 排队档那三家 + Claude（即时，当场就存了）
    expect(store.answers()).toHaveLength(n + n / 3)
    expect(reports()).toHaveLength(2)
    expect(reports()[1]?.pending_cells).toBeUndefined()
    expect(reports()[1]?.run_id).toBe(reports()[0]?.run_id)
  })
})

describe('WP321 变化大才出卡、指标', () => {
  it('某 AI 周跌 ≥ 15 个百分点、同一问连续两周在 ≥ 2 个 AI 缺位、关注词掉出前 10、新竞品 ≥ 3 条：各进改页面 / 交公关 / 设定卡；小波动不出', async () => {
    const w = world()
    const { service, matters, cards, decide } = setup(w)
    const P0 = 'Which power bank lasts longest on flights?'
    const P1 = 'What charger fits a carry-on best?'
    await service.watchApply({
      add_prompts: [{ text: P0 }, { text: P1 }],
      keywords: [{ keyword: 'travel power bank', branded: false, enabled: true }],
    })
    const ids = (await service.watchView()).watch.prompt_candidates
      .concat((await service.watchView()).watch.prompts)
      .filter((q) => q.text === P0 || q.text === P1)
      .map((q) => q.id)
    await service.watchApply({ select: ids })
    // 第一周：P0 在 Gemini 与 AI 概览上没提我们；其余都提
    w.setSay((p, q) =>
      q === P0 && (p === 'gemini' || p === 'google_ai_overview') ? NO_MENTION : MENTION,
    )
    await service.weeklyGeo()
    expect(matters.filter((m) => m.title.includes('AI 回答'))).toHaveLength(0)
    // 第二周：ChatGPT 哪儿都不提了；P0 照旧缺位；关注词从第 4 掉到第 14；回答里冒出 Zendure
    w.nextWeek()
    w.setSay((p, q) =>
      p === 'chatgpt' || (q === P0 && (p === 'gemini' || p === 'google_ai_overview'))
        ? NO_MENTION
        : MENTION,
    )
    w.setRank(() => 14)
    w.setBrands(['Zendure'])
    await service.weeklyGeo()
    const titles = matters.map((m) => m.title)
    expect(titles).toContain(`交公关：AI 回答「${P0}」时没提我们`)
    expect(titles).toContain(`写一页回答「${P1}」`)
    // 同一问已经按「连续缺位」交公关了，ChatGPT 那一跌不再为它另开一件
    expect(titles).not.toContain(`写一页回答「${P0}」`)
    expect(titles).toContain('关注词「travel power bank」掉出前 10（上周第 4，这周第 14）')
    expect(matters.find((m) => m.title.startsWith('交公关'))?.position_template_id).toBe('pr')
    // WP449：改页面的那件带上「好不好被 AI 引用」五条写法；交公关的不带
    const fix = matters.find((m) => m.title === `写一页回答「${P1}」`) as { summary?: string }
    expect(fix.summary).toContain('改动稿这样写：先给答案')
    expect(
      (matters.find((m) => m.title.startsWith('交公关')) as { summary?: string }).summary,
    ).not.toContain('改动稿这样写')
    const [rivals] = await cards('geo_watch_competitors')
    if (rivals === undefined) throw new Error('没出竞品卡')
    const rp = rivals.payload as Extract<GeoWatchCardPayload, { form: 'geo_watch_competitors' }>
    expect(rp.competitors.map((c) => c.name)).toEqual(['Zendure'])
    await decide(rivals.id, 'approve')
    expect((await service.watchView()).watch.competitors.map((c) => c.name)).toContain('Zendure')

    // 看板要的数
    const m = await service.watchMetrics()
    expect(m.week).toBe('2026-10-12')
    const chatgpt = m.trends.find((l) => l.kind === 'platform' && l.key === 'chatgpt')
    expect(chatgpt?.points.map((x) => x.change_pp)).toEqual([undefined, -100])
    expect(m.top_domains.find((d) => d.domain === 'travelblog.example')).toMatchObject({
      site_kind: 'media',
      group: 'offsite',
      // 近 4 周里两周都在；再往前 4 周没有 → 算新冒出来的
      new: true,
    })
    expect(m.our_pages[0]?.url_norm).toBe('https://nordvolt.example/air')
    expect(
      m.changes.some((c) => c.platform === 'chatgpt' && c.mentioned.before && !c.mentioned.after),
    ).toBe(true)
    expect(m.rank).toMatchObject({ week: '2026-10-12', left_top10: 1 })
    expect(m.rank.rows[0]).toMatchObject({
      keyword: 'travel power bank',
      rank: 14,
      previous: 4,
      change: -10,
      gsc_position: 8.4,
      aio_mentions_us: true,
    })
    expect(m.brand_gsc.connected).toBe(true)
    expect(m.brand_gsc.weeks.at(-1)).toMatchObject({ impressions: 400, clicks: 35, position: 2 })
    // 两周内同一件事不再交（第三周照样缺位）
    const before = matters.length
    w.nextWeek()
    await service.weeklyGeo()
    expect(matters.filter((x) => x.title === `交公关：AI 回答「${P0}」时没提我们`)).toHaveLength(1)
    expect(matters.length).toBeGreaterThanOrEqual(before)
  })

  it('没连 Search Console：品牌词那一块不显示，面板提示去连', async () => {
    const w = world()
    const { service } = setup(w, { searchConsole: () => disconnectedSearchConsole() })
    await service.weeklyGeo()
    expect((await service.watchView()).gsc_connected).toBe(false)
    const m = await service.watchMetrics()
    expect(m.brand_gsc).toEqual({ connected: false, weeks: [] })
  })
})

describe('WP321 自带 key 与迁移', () => {
  it('决策 534：自带 key 问 Claude 前每天查一次免费模型清单；不过就跳过（没花钱）并在面板说一句', async () => {
    const w = world({ route: 'byo' })
    let checks = 0
    const { service } = setup(w, {
      claudeModelCheck: async () => {
        checks += 1
        return { ok: false, reason: '清单里没有我们用的那个 Claude 模型' }
      },
    })
    const out = await service.watchRun({})
    expect(out.started).toBe(true)
    expect(out.estimate.needs_confirm).toBe(false)
    expect(out.notes.join('')).toContain('Claude 这一轮没问（没花钱）')
    expect(w.probes.some((p) => p.platforms.includes('claude'))).toBe(false)
    await service.watchRun({})
    expect(checks).toBe(1)
    expect((await service.watchView()).notes.join('')).toContain('Claude 今天没问')
    w.setNow('2026-10-06T09:00:00.000Z')
    await service.watchRun({})
    expect(checks).toBe(2)
  })

  it('自带 key、清单通过：手动这一轮照问 Claude（不扣积分，不用确认）', async () => {
    const w = world({ route: 'byo' })
    const { service } = setup(w, { claudeModelCheck: async () => ({ ok: true }) })
    await service.watchRun({})
    expect(w.probes.some((p) => p.platforms.includes('claude'))).toBe(true)
    expect(w.called).toHaveLength(0)
  })

  it('决策 532：已有关注设置（老三家、6 条）一律迁到新设置；老问题与老回答都在；只迁一次', async () => {
    const w = world()
    const store = createGeoStore()
    const at = '2026-09-01T00:00:00.000Z'
    store.setMeta(SEO_STATE_IMPORTED_KEY, at)
    store.saveSettings({
      brand: { name: 'NordVolt', aliases: [], domains: ['nordvolt.example'] },
      competitors: [],
      prompt_limit: 6,
      prompt_cap: 20,
      keywords: [],
      markets: ['US'],
      platforms: ['chatgpt', 'gemini', 'google_ai_overview'],
      frequency: 'weekly',
      rank_device: 'mobile',
      enabled: true,
      updated_at: at,
    })
    for (let i = 0; i < 7; i += 1)
      store.addPrompt({
        id: `gq_${i}`,
        text: `Old question ${i}?`,
        origin: 'brand',
        enabled: true,
        created_at: at,
      })
    store.selectPrompts(['gq_0', 'gq_1', 'gq_2', 'gq_3', 'gq_4', 'gq_5'])
    store.startRun({
      id: 'wr_old',
      kind: 'geo',
      trigger: 'scheduled',
      period: '2026-08-31',
      status: 'done',
      planned: 1,
      answered: 1,
      credits: 0.2,
      started_at: at,
    })
    store.recordAnswer(
      {
        id: 'ga_old',
        run_id: 'wr_old',
        prompt_id: 'gq_0',
        prompt_text: 'Old question 0?',
        asked_text: 'Old question 0?',
        platform: 'chatgpt',
        model: 'web',
        via: 'web_ui',
        market: 'US',
        language: 'en',
        status: 'ok',
        answer_md: MENTION,
        answer_hash: 'h',
        fetched_at: at,
        credits: 0.2,
      },
      [],
      [],
    )
    const { service } = setup(w, { geoStore: () => store })
    const s = await service.geoHistory()
    const watch = s.watch()
    expect(watch?.platforms).toEqual(['chatgpt', 'gemini', 'claude', 'google_ai_overview'])
    expect(watch?.prompt_limit).toBe(5)
    expect(watch?.prompts.map((p) => p.id)).toEqual(['gq_0', 'gq_1', 'gq_2', 'gq_3', 'gq_4'])
    expect(s.prompts()).toHaveLength(7)
    expect(s.answers().map((a) => a.id)).toEqual(['ga_old'])
    // 人之后改的照人改的（不再迁）
    await service.watchApply({ prompt_limit: 10 })
    expect((await service.geoHistory()).watch()?.prompt_limit).toBe(10)
  })
})

describe('WP392 品牌档案里新查到的竞品：沿用「要不要加进竞品」那张卡问一次', () => {
  it('不在关注清单里的才问；给担店铺管理的人；批了加进竞品；同一家不再问第二次', async () => {
    const w = world()
    const STORE = { ...CONTENT, assignment_id: 'asg_store', role_id: 'dtc.store' }
    const { service, cards, decide } = setup(w, {
      holderOf: (role) => (role === 'dtc.store' ? STORE : role === 'dtc.seo' ? CONTENT : undefined),
      brand: () => ({
        name: 'NordVolt',
        language: 'en',
        domains: ['nordvolt.example'],
        shop_host: 'nordvolt.example',
        currency: 'USD',
        country: 'us',
        markets: ['US'],
        competitors: [
          { name: 'Anker', reason: '同价位', url: 'https://www.anker.example/us' },
          { name: 'Zendure', reason: '露营圈常比' },
        ],
      }),
    })
    await service.watchApply({
      competitors: [{ id: 'c_anker', name: 'Anker', aliases: [], domains: [] }],
    })
    const first = await service.askProfileCompetitors()
    expect(first.asked).toEqual(['Zendure'])
    const [card] = await cards('geo_watch_competitors')
    if (card === undefined) throw new Error('没出竞品卡')
    expect(card.role_id).toBe('dtc.store')
    const p = card.payload as Extract<GeoWatchCardPayload, { form: 'geo_watch_competitors' }>
    expect(p.competitors).toMatchObject([{ name: 'Zendure', answers: 0 }])
    // 再敲一次：问过了，不再问
    expect((await service.askProfileCompetitors()).asked).toEqual([])
    await decide(card.id, 'approve')
    expect((await service.watchView()).watch.competitors.map((c) => c.name)).toEqual([
      'Anker',
      'Zendure',
    ])
  })
})
