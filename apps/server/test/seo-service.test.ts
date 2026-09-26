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
          prices: { serp: 0.2, ai_answer: 0.4 },
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

  it('默认每周问 6 个 × 官方能探测的 4 个平台 ≈ 9.6 积分；Copilot 不问', async () => {
    const o = official()
    const { service } = setup({ searchData: () => o.port as never })
    const view = await service.geoView()
    expect(view.settings).toEqual({ enabled: true, max_questions: 6 })
    expect(view.estimate.platforms).toBe(4)
    expect(view.estimate.credits_per_week).toBe(
      Math.round(view.estimate.questions * 4 * 0.4 * 10) / 10,
    )
    await service.weeklyGeo()
    expect(o.calls.every((c) => !c.includes('copilot'))).toBe(true)
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
