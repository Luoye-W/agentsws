/**
 * WP154「内容与搜索」服务端那一层：每日 5 件事落成什么、周小结、发布前质检、选题卡批了开事项。
 *
 * 用真的账本与审批总线（`@agentsws/txn`）——改动卡要真过一遍 guardrail，
 * 不然"机械第一稿提不提得上去"这件事测不出来。上游全是替身，不联网。
 */
import type { EventEnvelope } from '@agentsws/contracts'
import {
  DEMO_GSC_ROWS,
  DEMO_PAGES,
  disconnectedSearchConsole,
  standInSearchConsole,
  standInSearchData,
  unconfiguredSearchData,
} from '@agentsws/seo-core'
import { createTxn } from '@agentsws/txn'
import { describe, expect, it } from 'vitest'
import { createSeoService, draftTitle, type SeoServiceOptions } from '../src/seo-service.js'

const NOW = '2026-09-28T00:00:00.000Z'

function seeded(seed = 7): () => number {
  let a = seed >>> 0
  return () => {
    a = (a * 1664525 + 1013904223) >>> 0
    return a / 0x100000000
  }
}

const CONTENT = {
  workspace_id: 'ws_1',
  person_id: 'p_li',
  assignment_id: 'asg_content',
  role_id: 'dtc.content',
}
const SITE = {
  ...CONTENT,
  person_id: 'p_wang',
  assignment_id: 'asg_site',
  role_id: 'site.shopify-build',
}

function setup(over: Partial<SeoServiceOptions> = {}) {
  const events: EventEnvelope[] = []
  const txn = createTxn({
    clock: { now: () => NOW },
    random: seeded(),
    eventSink: (e) => events.push(e),
    readRecord: () => ({}),
    backendApply: () => ({ status: 'ok', execution_id: 'exec_1' }),
    deliverOutbound: () => ({ status: 'ok', execution_id: 'exec_1' }),
  })
  const matters: { id: string; title: string; role_id?: string; position_template_id?: string }[] =
    []
  const service = createSeoService({
    workspace_id: 'ws_1',
    clock: { now: () => NOW },
    random: seeded(3),
    approvals: txn.approvals,
    ledger: txn.ledger,
    actionOf: (_a, action) =>
      action === 'stage_internal_link_edit'
        ? { mandate: { caps: { max_links_per_change: 5 } }, level: 'L1' }
        : { mandate: { caps: { max_page_edits_per_day: 10 } }, level: 'L1' },
    holderOf: (role) =>
      role === 'dtc.content' ? CONTENT : role === 'site.shopify-build' ? SITE : undefined,
    thresholds: () => ({ seo_position_min: 3, seo_position_max: 20 }),
    work: {
      createMatter: (input) => {
        const m = { id: `mat_${matters.length + 1}`, ...input }
        matters.push(m)
        return m
      },
    },
    searchConsole: () => standInSearchConsole({ rows: DEMO_GSC_ROWS, pages: DEMO_PAGES }),
    searchData: () => unconfiguredSearchData(),
    orders: () => [
      { id: 'o1', landing_site: '/blogs/guide/best-magsafe-car-mount', total: 45, currency: 'USD' },
      {
        id: 'o2',
        landing_site: '/products/usb-c-65w-charger?utm_medium=cpc',
        total: 129,
        currency: 'USD',
      },
    ],
    brand: () => ({
      name: 'NordVolt',
      language: 'en',
      domains: [],
      shop_host: 'shop.example',
      currency: 'USD',
      country: 'de',
    }),
    appendEvent: (e) => events.push(e as EventEnvelope),
    ...over,
  })
  return { service, txn, matters, events }
}

describe('每日：今天值得动的 5 件事落成什么', () => {
  it('一张报告卡（不进队列）+ 两张改动卡 + 一件本职责事项 + 一件交建站', async () => {
    const { service, txn, matters } = setup()
    const out = await service.daily()
    expect(out).toMatchObject({ picks: 5, changes: 2, matters: 2, topics: 0 })
    const report = await txn.approvals.get(out.approval_item_id ?? '')
    expect(report?.kind).toBe('seo_report')
    expect(report?.automation.level_at_creation).toBe('L3')
    const payload = report?.payload as { picks: { lane: string; outcome?: { kind: string } }[] }
    expect(payload.picks.map((p) => p.outcome?.kind)).toEqual([
      'change',
      'matter',
      'change',
      'matter',
      'none',
    ])
    // 两张改动卡：标题的机械第一稿、从强页链到卡住那页的内链
    const changes = await txn.ledger.list({ workspace_id: 'ws_1' })
    expect(changes.map((c) => c.kind).sort()).toEqual(['internal_link_edit', 'page_seo_edit'])
    const seo = changes.find((c) => c.kind === 'page_seo_edit')
    expect((seo?.after as { title: string } | undefined)?.title).toBe(
      'Usb C Laptop Charger – USB-C 65W Charger',
    )
    const link = changes.find((c) => c.kind === 'internal_link_edit')
    expect(link?.target.id).toBe('https://shop.example/blogs/guide/best-magsafe-car-mount')
    // 交建站的那件落在建站岗位、挂着建站那条职责
    const site = matters.find((m) => m.position_template_id === 'site')
    expect(site?.role_id).toBe('site.shopify-build')
    expect(site?.title).toContain('在跳转')
    // 加小节那件开给本职责自己
    expect(matters.some((m) => m.role_id === 'dtc.content' && m.title.includes('braided'))).toBe(
      true,
    )
  })

  it('同一件事两周内不重复交出去', async () => {
    const { service, matters } = setup()
    await service.daily()
    const before = matters.length
    await service.daily()
    expect(matters.length).toBe(before)
  })

  it('Search Console 没连：一件都不出，卡上明说接上才看得到', async () => {
    const { service, txn } = setup({ searchConsole: () => disconnectedSearchConsole() })
    const out = await service.daily()
    expect(out.picks).toBe(0)
    const report = await txn.approvals.get(out.approval_item_id ?? '')
    expect(report?.summary).toContain('接上才看得到')
  })

  it('接了搜索数据、人群对 → 新页面选题卡；批了开一件写这一页的事项', async () => {
    const serp = {
      items: [
        {
          position: 1,
          url: 'https://a.example/x',
          domain: 'a.example',
          title: 'GaN vs silicon charger: which to buy',
          type: 'organic' as const,
        },
        {
          position: 2,
          url: 'https://b.example/y',
          domain: 'b.example',
          title: 'Best GaN chargers review',
          type: 'organic' as const,
        },
        {
          position: 3,
          url: 'https://reddit.com/r/x',
          domain: 'reddit.com',
          title: 'GaN or silicon?',
          type: 'forum' as const,
        },
      ],
      fetched_at: NOW,
      source: 'stand-in',
    }
    const { service, txn, matters } = setup({
      searchData: () => standInSearchData({ serp: { 'gan vs silicon charger': serp } }),
    })
    const out = await service.daily()
    expect(out.topics).toBe(1)
    const queue = await txn.approvals.queue({
      workspace_id: 'ws_1',
      person_id: 'p_li',
      lane: 'mine',
      kind: 'seo_topic',
    })
    expect(queue).toHaveLength(1)
    const card = queue[0]
    if (card === undefined) return
    const token = card.deliveries.find((d) => d.to === 'p_li')?.decision_token ?? ''
    const decided = await txn.approvals.decide(card.id, 'p_li', {
      action: 'approve',
      decision_token: token,
      via: 'web',
    })
    await service.onDecided(decided)
    expect(matters.some((m) => m.title === '写一页新的：gan vs silicon charger')).toBe(true)
  })

  it('没人持有内容与搜索：不跑', async () => {
    const { service } = setup({ holderOf: () => undefined })
    expect((await service.daily()).skipped).toContain('没人持有')
  })
})

describe('每周：收入小结与 AI 可见度', () => {
  it('收入按页面并排；广告带来的不算给文章', async () => {
    const { service, txn } = setup()
    const out = await service.weeklyRevenue()
    const payload = (await txn.approvals.get(out.approval_item_id ?? ''))?.payload as {
      rows: { page: string; orders: number }[]
      ga4: string
    }
    expect(payload.ga4).toBe('not_connected')
    expect(payload.rows.find((r) => r.page.endsWith('best-magsafe-car-mount'))?.orders).toBe(1)
    expect(payload.rows.find((r) => r.page.endsWith('usb-c-65w-charger'))?.orders).toBe(0)
  })

  it('搜索数据接口没接：不探测，说一句人话；门面那件交建站只开一次', async () => {
    const { service, txn, matters } = setup()
    const out = await service.weeklyGeo()
    const report = await txn.approvals.get(out.approval_item_id ?? '')
    expect(report?.summary).toContain('搜索数据接口还没接')
    await service.weeklyGeo()
    expect(matters.filter((m) => m.title.includes('llms.txt'))).toHaveLength(1)
  })

  it('问题清单：自动生成；人改过的记成人的', async () => {
    const { service } = setup()
    const auto = await service.geoQuestions()
    expect(auto.some((q) => q.text === 'Is NordVolt worth it?')).toBe(true)
    const mine = service.setGeoQuestions([
      { id: 'q1', text: 'Is a 65W charger enough for a MacBook?', origin: 'brand', enabled: true },
    ])
    expect(mine[0]?.origin).toBe('human')
    expect((await service.geoQuestions()).find((q) => q.id === 'q1')?.enabled).toBe(true)
  })
})

describe('发布前质检（账本 stage 之前的改写口）', () => {
  const input = (body: string) => ({
    workspace_id: 'ws_1',
    role_id: 'dtc.content',
    assignment_id: 'asg_content',
    run_id: 'run_1',
    change_set_id: 'cs_1',
    kind: 'publish_post' as const,
    target: { type: 'article', id: 'art_1' },
    before: { title: '快充头怎么挑', published: false },
    after: { title: '快充头怎么挑', published: true, body },
    created_by: { kind: 'agent' as const, id: 'agent_dtc.content' },
    mandate: { caps: { max_posts_per_day: 2 } },
    level: 'L2' as const,
    approval: {
      title: '发布文章：快充头怎么挑',
      summary: '这篇会出现在店里的博客上。',
      recipients: [{ person: 'p_li', via: 'scope_manager' as const }],
      proposer: { kind: 'agent' as const, id: 'agent_dtc.content', assignment_id: 'asg_content' },
    },
  })
  const knowledge = async () => ({
    facts: [{ id: 'fc_w', statement: '充电类产品的保修期是 24 个月。', terms: ['保修'] }],
    rules: [],
  })

  it('没过：改回草稿、拉回 L1、卡上逐句说明', async () => {
    const { service } = setup({ knowledge })
    const out = await service.gatePublish(input('全网最好的快充头。保修 36 个月。'))
    expect((out.after as { published: boolean }).published).toBe(false)
    expect(out.level).toBe('L1')
    expect(out.approval.title).toBe('没过质检，先留在草稿：快充头怎么挑')
    expect(out.approval.summary).toContain('「全网最好的快充头。」')
    expect(out.approval.summary).toContain('24 个月')
  })

  it('过了：照原样发（结论记在 after 上）；草稿与别的变更不碰', async () => {
    const { service } = setup({ knowledge })
    const ok = await service.gatePublish(input('保修 24 个月。'))
    expect(
      (ok.after as { published: boolean; quality_gate: { passed: boolean } }).quality_gate.passed,
    ).toBe(true)
    const draft = {
      ...input('全网最好。'),
      after: { title: 't', published: false, body: '全网最好。' },
    }
    expect(await service.gatePublish(draft)).toBe(draft)
  })
})

describe('WP159：违规宣称规则按市场分组（知识库里能改能关）', () => {
  const gateInput = (body: string) => ({
    workspace_id: 'ws_1',
    role_id: 'dtc.content',
    assignment_id: 'asg_content',
    run_id: 'run_2',
    change_set_id: 'cs_2',
    kind: 'publish_post' as const,
    target: { type: 'article', id: 'art_2' },
    before: { title: 'Our story', published: false },
    after: { title: 'Our story', published: true, body },
    created_by: { kind: 'agent' as const, id: 'agent_dtc.content' },
    mandate: { caps: {} },
    level: 'L2' as const,
    approval: {
      title: '发布文章',
      summary: 's',
      recipients: [{ person: 'p_li', via: 'scope_manager' as const }],
      proposer: { kind: 'agent' as const, id: 'agent_dtc.content', assignment_id: 'asg_content' },
    },
  })
  /** 替身知识库：`saveClaimRule` 写进来的卡，`knowledge` 原样读回去（后写的在后面）。 */
  const kb = () => {
    const cards: {
      id: string
      subject: { type: string; key: string }
      statement: string
      structured: Record<string, unknown>
    }[] = []
    return {
      cards,
      knowledge: async () => ({ facts: [], rules: [], rule_cards: [...cards] }),
      saveClaimRule: async (
        _a: unknown,
        input: { key: string; statement: string; structured: Record<string, unknown> },
      ) => {
        cards.push({
          id: `k${cards.length}`,
          subject: { type: 'content_rule', key: input.key },
          ...input,
        })
      },
    }
  }
  const brandIn = (markets?: string[]) => () => ({
    name: 'NordVolt',
    language: 'en' as const,
    domains: ['nordvolt.example'],
    shop_host: 'nordvolt.example',
    currency: 'USD',
    country: 'us',
    ...(markets === undefined ? {} : { markets }),
  })
  const passed = async (svc: ReturnType<typeof setup>['service'], body: string) =>
    ((await svc.gatePublish(gateInput(body))).after as { published: boolean }).published

  it('只卖美国：开通用 + 美国；「Made in USA」拦、「carbon neutral」不拦；每条有官方出处', async () => {
    const k = kb()
    const { service } = setup({ ...k, brand: brandIn(['US']) })
    const view = await service.claimRules(CONTENT)
    expect(view).toMatchObject({ markets: ['US'], markets_from: 'brand_profile' })
    expect(view.groups.filter((g) => g.enabled).map((g) => g.id)).toEqual(['global', 'us'])
    expect(view.rules.every((r) => r.source_url?.startsWith('https://'))).toBe(true)
    expect(await passed(service, 'Made in USA with pride.')).toBe(false)
    expect(await passed(service, 'Our factory is carbon neutral.')).toBe(true)
  })

  it('档案里没写市场：按探测国家那一个算（写明是默认）', async () => {
    const { service } = setup({ ...kb(), brand: brandIn() })
    expect(await service.claimRules(CONTENT)).toMatchObject({
      markets: ['US'],
      markets_from: 'default',
    })
  })

  it('在知识库里关掉一条：写一张卡，之后不再拦；改理由也写卡（edited）', async () => {
    const k = kb()
    const { service } = setup({ ...k, brand: brandIn(['US']) })
    await service.setClaimRules(CONTENT, { rule: { id: 'us.made_in_usa', enabled: false } })
    expect(k.cards[0]).toMatchObject({
      subject: { key: 'us.made_in_usa' },
      structured: { enabled: false, market: 'us', source_url: expect.stringContaining('ftc.gov') },
    })
    expect(await passed(service, 'Made in USA with pride.')).toBe(true)
    const view = await service.setClaimRules(CONTENT, {
      rule: { id: 'abs_zh_top', reason: '我们卖的是入门款，别写顶级' },
    })
    expect(view.rules.find((r) => r.id === 'abs_zh_top')).toMatchObject({
      origin: 'edited',
      enabled: true,
      reason: '我们卖的是入门款，别写顶级',
    })
  })

  it('手动打开欧盟组：碳中和也拦了，标 manual；加一条自己的规则也生效', async () => {
    const k = kb()
    const { service } = setup({ ...k, brand: brandIn(['US']) })
    const view = await service.setClaimRules(CONTENT, { group: { id: 'eu_uk', enabled: true } })
    expect(view.groups.find((g) => g.id === 'eu_uk')).toMatchObject({
      enabled: true,
      why: 'manual',
    })
    expect(await passed(service, 'Our factory is carbon neutral.')).toBe(false)
    await service.setClaimRules(CONTENT, { add: { pattern: 'military grade', reason: '没法证明' } })
    expect(await passed(service, 'Military grade aluminium.')).toBe(false)
  })

  it('没装知识库写口：只能看不能改', async () => {
    const { service } = setup({ knowledge: kb().knowledge, brand: brandIn(['US']) })
    await expect(
      service.setClaimRules(CONTENT, { rule: { id: 'us.made_in_usa', enabled: false } }),
    ).rejects.toThrow(/只能看不能改/)
  })
})

describe('draftTitle', () => {
  it('查询放最前面；原标题已经含查询就不机械改', () => {
    expect(draftTitle('usb c laptop charger', 'USB-C 65W Charger')).toBe(
      'Usb C Laptop Charger – USB-C 65W Charger',
    )
    expect(draftTitle('braided cable care', 'Braided cable care guide')).toBeUndefined()
  })
})

describe('每周 AI 探测花多少（WP155 提醒：看得到、调得动、关得掉）', () => {
  const official = () => {
    const calls: string[] = []
    return {
      calls,
      port: {
        status: async () => ({
          configured: true,
          route: 'official' as const,
          platforms: ['chatgpt', 'perplexity', 'gemini', 'google_ai_overview'] as const,
          prices: { serp: 0.2, ai_answer: 0.2 },
        }),
        serp: async () => {
          throw new Error('不该查 SERP')
        },
        aiAnswers: async (p: { question: string; platforms: readonly string[] }) => {
          calls.push(`${p.question}|${p.platforms.join(',')}`)
          return []
        },
      },
    }
  }

  it('默认每周问 6 个 × 3 个平台（ChatGPT / Gemini / AI 概览）× 0.2 = 3.6 积分；Perplexity、Copilot 不问（WP159）', async () => {
    const o = official()
    const { service } = setup({ searchData: () => o.port as never })
    service.setGeoQuestions(
      Array.from({ length: 8 }, (_, i) => ({
        id: `q${i}`,
        text: `question number ${i}`,
        origin: 'human' as const,
        enabled: true,
      })),
    )
    const view = await service.geoView()
    expect(view.settings).toEqual({ enabled: true, max_questions: 6 })
    expect(view.estimate.platforms).toBe(3)
    expect(view.estimate.questions).toBe(6)
    expect(view.estimate.credits_per_week).toBe(3.6)
    await service.weeklyGeo()
    expect(o.calls.every((c) => !c.includes('copilot') && !c.includes('perplexity'))).toBe(true)
    expect(o.calls.every((c) => c.endsWith('|chatgpt,gemini,google_ai_overview'))).toBe(true)
    expect(o.calls.length).toBe(view.estimate.questions)
  })

  it('调成 2 个就只问 2 个；关掉就一次都不问', async () => {
    const o = official()
    const { service } = setup({ searchData: () => o.port as never })
    service.setGeoSettings({ max_questions: 2 })
    await service.weeklyGeo()
    expect(o.calls).toHaveLength(2)
    service.setGeoSettings({ enabled: false })
    await service.weeklyGeo()
    expect(o.calls).toHaveLength(2)
    expect((await service.geoView()).estimate.questions).toBe(0)
  })
})

describe('WP159：改动卡初稿由模型写（规则版兜底）', () => {
  const META = JSON.stringify({
    title: 'USB-C Laptop Charger, 65W GaN | NordVolt',
    meta_description: 'A compact USB-C laptop charger that powers a laptop and a phone at once.',
    h1: 'USB-C Laptop Charger',
    opening:
      'This USB-C laptop charger powers most laptops from one plug. It also tops up a phone.',
  })
  const SECTION = JSON.stringify({
    heading: 'How to care for a braided cable',
    body: 'Coil it loosely and keep it away from sharp bends. Wipe it with a dry cloth.',
  })
  const fakeModel = (reply: (prompt: string) => string | Promise<string>) => {
    const prompts: string[] = []
    const drafter: SeoServiceOptions['drafter'] =
      () =>
      async ({ prompt }) => {
        prompts.push(prompt)
        return { text: await reply(prompt) }
      }
    return { prompts, drafter }
  }
  const byKind = (prompt: string): string => (prompt.includes('"heading"') ? SECTION : META)

  it('标题 / 描述 / H1 / 开头与加小节都由模型写、都出卡；品牌口吻注进提示词；报告卡记几份', async () => {
    const m = fakeModel(byKind)
    const { service, txn, matters } = setup({
      drafter: m.drafter,
      brandVoice: () => ({ context: 'Brand: NordVolt', voice: 'calm, practical, no hype' }),
    })
    const out = await service.daily()
    expect(out).toMatchObject({ changes: 3, matters: 1 })
    expect(m.prompts).toHaveLength(2)
    expect(m.prompts[0]).toContain('NordVolt')
    expect(m.prompts[0]).toContain('calm, practical, no hype')
    const changes = await txn.ledger.list({ workspace_id: 'ws_1' })
    expect(changes.map((c) => c.kind).sort()).toEqual([
      'internal_link_edit',
      'page_section_add',
      'page_seo_edit',
    ])
    const seo = changes.find((c) => c.kind === 'page_seo_edit')
    expect(seo?.after).toMatchObject({
      title: 'USB-C Laptop Charger, 65W GaN | NordVolt',
      meta_description: expect.stringContaining('compact'),
      target_query: 'usb c laptop charger',
    })
    expect(changes.find((c) => c.kind === 'page_section_add')?.after).toMatchObject({
      heading: 'How to care for a braided cable',
    })
    // 加小节不再开事项（只剩交建站那一件）
    expect(matters.every((m) => m.position_template_id === 'site')).toBe(true)
    const report = await txn.approvals.get(out.approval_item_id ?? '')
    const payload = report?.payload as {
      drafts?: unknown
      picks: { outcome?: { draft?: string } }[]
    }
    expect(payload.drafts).toEqual({ model: 2, rules: 0, cap: 5 })
    expect(payload.picks.filter((p) => p.outcome?.draft === 'model')).toHaveLength(2)
  })

  it('没配模型：规则版照旧（标题机械第一稿 + 加小节开事项）', async () => {
    const { service, txn } = setup({ drafter: () => undefined })
    const out = await service.daily()
    expect(out).toMatchObject({ changes: 2, matters: 2 })
    const report = await txn.approvals.get(out.approval_item_id ?? '')
    expect((report?.payload as { drafts?: unknown } | undefined)?.drafts).toEqual({
      model: 0,
      rules: 1,
      cap: 5,
    })
  })

  it('每天有上限：调到 1 份，第二件退回规则版并写明原因；同一天再跑一次模型一次都不打', async () => {
    const m = fakeModel(byKind)
    const { service, txn, matters } = setup({
      drafter: m.drafter,
      thresholds: () => ({
        seo_position_min: 3,
        seo_position_max: 20,
        seo_model_drafts_per_day: 1,
      }),
    })
    const out = await service.daily()
    expect(m.prompts).toHaveLength(1)
    expect(out.changes).toBe(2)
    const payload = (await txn.approvals.get(out.approval_item_id ?? ''))?.payload as {
      picks: { outcome?: { note?: string } }[]
    }
    expect(payload.picks.some((p) => p.outcome?.note?.includes('上限（1 份）'))).toBe(true)
    expect(matters.some((x) => x.title.includes('braided'))).toBe(true)
    await service.daily()
    expect(m.prompts).toHaveLength(1)
  })

  it('模型报错（比如超预算）或初稿里有违规宣称：不用那一份，退回规则版', async () => {
    const broken = fakeModel(() => {
      throw new Error('budget exceeded')
    })
    const a = setup({ drafter: broken.drafter })
    const outA = await a.service.daily()
    expect(outA).toMatchObject({ changes: 2, matters: 2 })
    const seoA = (await a.txn.ledger.list({ workspace_id: 'ws_1' })).find(
      (c) => c.kind === 'page_seo_edit',
    )
    expect((seoA?.after as { title?: string } | undefined)?.title).toBe(
      'Usb C Laptop Charger – USB-C 65W Charger',
    )
    const bragging = fakeModel((p) =>
      p.includes('"heading"')
        ? SECTION
        : JSON.stringify({ ...JSON.parse(META), opening: 'The best in the world. Guaranteed.' }),
    )
    const b = setup({ drafter: bragging.drafter })
    await b.service.daily()
    const kinds = (await b.txn.ledger.list({ workspace_id: 'ws_1' })).map((c) => c.kind).sort()
    expect(kinds).toEqual(['internal_link_edit', 'page_section_add', 'page_seo_edit'])
    const seoB = (await b.txn.ledger.list({ workspace_id: 'ws_1' })).find(
      (c) => c.kind === 'page_seo_edit',
    )
    expect(seoB?.after).not.toHaveProperty('opening')
  })
})

describe('WP158：真读数接进每日与周收入', () => {
  it('Search Console 给的是上一份：卡上第一行照实说', async () => {
    const stale = standInSearchConsole({ rows: DEMO_GSC_ROWS, pages: DEMO_PAGES })
    const { service, txn } = setup({
      searchConsole: () => ({
        ...stale,
        note: () => 'Google 这边今天读 Search Console 的额度用完了，先用上一份。',
      }),
    })
    const out = await service.daily()
    const payload = (await txn.approvals.get(out.approval_item_id ?? ''))?.payload as {
      notes: string[]
      picks: unknown[]
    }
    expect(payload.notes[0]).toContain('先用上一份')
    expect(payload.picks.length).toBeGreaterThan(0)
  })

  it('接了 GA4：转化率与 GA4 口径收入并排，口径写明；连了没选说一句', async () => {
    const withGa4 = setup({
      ga4: async () => [
        {
          page: 'https://shop.example/blogs/guide/best-magsafe-car-mount',
          conversion_rate: 0.05,
          sessions: 40,
          purchases: 2,
          revenue: 90,
        },
      ],
    })
    const out = await withGa4.service.weeklyRevenue()
    const payload = (await withGa4.txn.approvals.get(out.approval_item_id ?? ''))?.payload as {
      ga4: string
      notes: string[]
      rows: { page: string; orders: number; revenue: number; ga4_revenue?: number }[]
    }
    expect(payload.ga4).toBe('connected')
    expect(payload.notes.some((n) => n.includes('以 Shopify 为准'))).toBe(true)
    expect(payload.rows.find((r) => r.page.endsWith('best-magsafe-car-mount'))).toMatchObject({
      orders: 1,
      revenue: 45,
      ga4_revenue: 90,
    })

    const picking = setup({
      ga4: async () => undefined,
      ga4Note: () => 'GA4 连上了，还没选是哪个媒体资源',
    })
    const p2 = await picking.service.weeklyRevenue()
    const payload2 = (await picking.txn.approvals.get(p2.approval_item_id ?? ''))?.payload as {
      notes: string[]
    }
    expect(payload2.notes).toContain('GA4 连上了，还没选是哪个媒体资源')
  })
})

describe('WP166：模型初稿读页面正文', () => {
  const META = JSON.stringify({
    title: 'USB-C Laptop Charger, 65W GaN | NordVolt',
    meta_description: 'A compact USB-C laptop charger that powers a laptop and a phone at once.',
    h1: 'USB-C Laptop Charger',
    opening:
      'This USB-C laptop charger powers most laptops from one plug. It also tops up a phone.',
  })
  const SECTION = JSON.stringify({
    heading: 'How to care for a braided cable',
    body: 'Coil it loosely and keep it away from sharp bends. Wipe it with a dry cloth.',
  })
  const model = () => {
    const prompts: string[] = []
    const drafter: SeoServiceOptions['drafter'] =
      () =>
      async ({ prompt }) => {
        prompts.push(prompt)
        return { text: prompt.includes('"heading"') ? SECTION : META }
      }
    return { prompts, drafter }
  }

  it('读到正文：去 HTML 放进数据围栏，卡上记「读过正文」、结果标来源', async () => {
    const m = model()
    const asked: { url: string; domains: readonly string[] }[] = []
    const { service, txn } = setup({
      drafter: m.drafter,
      pageBody: async (input) => {
        asked.push(input)
        return { text: '<p>Our 65W charger &amp; cable.</p><script>x()</script>', from: 'store' }
      },
    })
    const out = await service.daily()
    expect(asked.length).toBe(2)
    expect(asked[0]?.domains).toContain('shop.example')
    expect(m.prompts[0]).toContain('<<<PAGE_BODY\nOur 65W charger & cable.\nPAGE_BODY>>>')
    const report = await txn.approvals.get(out.approval_item_id ?? '')
    const picks =
      (report?.payload as { picks: { outcome?: { id?: string; body?: string } }[] })?.picks ?? []
    expect(picks.filter((p) => p.outcome?.body === 'store')).toHaveLength(2)
    const changeId = picks.find((p) => p.outcome?.body === 'store')?.outcome?.id
    const card = await txn.approvals.get(changeId ?? '')
    expect(card?.summary).toContain('读过这一页的正文')
  })

  it('读不到正文：照原来的写法，卡上注明「没读到正文」', async () => {
    const m = model()
    const { service, txn } = setup({ drafter: m.drafter, pageBody: async () => undefined })
    const out = await service.daily()
    expect(m.prompts[0]).toContain('[Page body] Not available')
    const report = await txn.approvals.get(out.approval_item_id ?? '')
    const picks =
      (report?.payload as { picks: { outcome?: { body?: string; note?: string } }[] })?.picks ?? []
    const drafted = picks.filter((p) => p.outcome?.body === 'none')
    expect(drafted).toHaveLength(2)
    expect(drafted[0]?.outcome?.note).toBe('没读到正文')
  })
})
