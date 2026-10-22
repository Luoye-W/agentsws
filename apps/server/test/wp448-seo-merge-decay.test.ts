/**
 * WP448（docs/109 §5.1 #3–4）：服务端——每周一次抢词检测（报告卡 + 严重的进今天 5 件事）、合并车道落成什么
 * （合并后跳转 → 交建站带改跳转清单；改写角度 → 内链改动卡）、掉量分诊「该下线」交建站、改版回归进简报一行。
 * 真的账本与审批总线，上游全是替身，不联网。
 */
import type { DriftRun, EventEnvelope, GscRow, SeoDailyPayload } from '@agentsws/contracts'
import { standInSearchConsole, unconfiguredSearchData } from '@agentsws/seo-core'
import { createTxn } from '@agentsws/txn'
import { describe, expect, it } from 'vitest'
import { createSeoService, type SeoServiceOptions } from '../src/seo-service.js'

const O = 'https://shop.example'
const SEO = {
  workspace_id: 'ws_1',
  person_id: 'p_li',
  assignment_id: 'asg_seo',
  role_id: 'dtc.seo',
}
const SITE = {
  ...SEO,
  person_id: 'p_wang',
  assignment_id: 'asg_site',
  role_id: 'site.shopify-build',
}

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

/** 两篇文章抢一组词（严重、合并后跳转）；商品页与文章抢一个词（严重、改写角度）；一页掉到快没人搜。 */
const ROWS: GscRow[] = [
  row('best power bank for iphone', '/blogs/news/best-power-banks', 40, 900, 1.6),
  row('best power bank for iphone', '/blogs/news/iphone-power-bank-guide', 12, 700, 1.9),
  row('magsafe power bank', '/products/magsafe-10k', 30, 400, 1.4),
  row('magsafe power bank', '/blogs/news/magsafe-explained', 5, 120, 2.5),
  row('old cable promo', '/blogs/news/promo-2023', 1, 40, 1.5, 12),
]

function setup(over: Partial<SeoServiceOptions> = {}) {
  let now = '2026-10-22T00:00:00.000Z'
  const events: EventEnvelope[] = []
  const txn = createTxn({
    clock: { now: () => now },
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
  // 出过的卡都记一份（报告卡看完归档、不进队列，只能这样读回来）
  const created: { kind: string; payload: Record<string, unknown> }[] = []
  const approvals = new Proxy(txn.approvals, {
    get(target, prop) {
      if (prop === 'create')
        return async (input: Parameters<typeof target.create>[0]) => {
          const item = await target.create(input)
          created.push(item as never)
          return item
        }
      const v = Reflect.get(target, prop) as unknown
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v
    },
  })
  const service = createSeoService({
    workspace_id: 'ws_1',
    clock: { now: () => now },
    random: () => 0.5,
    approvals,
    ledger: txn.ledger,
    actionOf: (_a, action) =>
      action === 'stage_internal_link_edit'
        ? { mandate: { caps: { max_links_per_change: 5 } }, level: 'L1' }
        : { mandate: { caps: { max_page_edits_per_day: 10 } }, level: 'L1' },
    holderOf: (role) =>
      role === 'dtc.seo' ? SEO : role === 'site.shopify-build' ? SITE : undefined,
    thresholds: () => ({ seo_position_min: 3, seo_position_max: 20 }),
    work: {
      createMatter: (input) => {
        const m = { id: `mat_${matters.length + 1}`, ...input }
        matters.push(m)
        return m
      },
    },
    searchConsole: () => standInSearchConsole({ rows: ROWS, pages: [] }),
    searchData: () => unconfiguredSearchData(),
    orders: () => [],
    brand: () => ({
      name: 'NordVolt',
      language: 'en',
      domains: [],
      shop_host: 'shop.example',
      currency: 'USD',
      country: 'us',
    }),
    appendEvent: (e) => events.push(e as EventEnvelope),
    ...over,
  })
  return {
    service,
    txn,
    created,
    matters,
    events,
    setNow: (t: string) => {
      now = t
    },
  }
}

const reportOf = (
  created: { kind: string; payload: Record<string, unknown> }[],
  variant: string,
): Record<string, unknown> | undefined =>
  created.filter((i) => i.kind === 'seo_report' && i.payload.variant === variant).pop()?.payload

describe('WP448 抢词（每周）与合并车道', () => {
  it('每周一张抢词报告卡；严重的进今天 5 件事（merge 车道）；不算六个信号', async () => {
    const { service, created, events } = setup()
    const out = await service.daily()
    const cann = reportOf(created, 'weekly_cannibalization')
    const groups = (cann?.groups ?? []) as { severity: string; action: string }[]
    expect(groups.map((g) => `${g.severity}|${g.action}`)).toEqual([
      'critical|redirect',
      'critical|differentiate',
    ])
    const daily = reportOf(created, 'daily') as unknown as SeoDailyPayload
    const merges = daily.picks.filter((p) => p.lane === 'merge')
    expect(merges).toHaveLength(2)
    expect(merges.every((p) => p.signal === 'cannibalization')).toBe(true)
    expect(Object.keys(daily.signal_counts)).not.toContain('cannibalization')
    expect(out.picks).toBe(daily.picks.length)
    expect(events.some((e) => e.type === 'seo.weekly_cannibalization')).toBe(true)
    // 报告卡同每日那张一样：L3、进简报不进队列
    const card = created.find(
      (i) => i.kind === 'seo_report' && i.payload.variant === 'weekly_cannibalization',
    ) as unknown as { priority: string; automation: { level_at_creation: string } }
    expect(card.priority).toBe('digest')
    expect(card.automation.level_at_creation).toBe('L3')
  })

  it('合并后跳转 → 交建站带改跳转清单；改写角度 → 内链改动卡（从要改写的那页链到保留页）', async () => {
    const { service, txn, matters } = setup()
    await service.daily()
    const site = matters.find((m) => m.title.startsWith('合并抢词的页'))
    expect(site).toMatchObject({ role_id: 'site.shopify-build', position_template_id: 'site' })
    expect(site?.summary).toContain('可以直接出「改跳转」卡的清单（旧路径 → 新路径）：')
    expect(site?.summary).toContain(
      '/blogs/news/iphone-power-bank-guide → /blogs/news/best-power-banks',
    )
    const changes = await txn.ledger.list({ workspace_id: 'ws_1' })
    const link = changes.find(
      (c) => c.kind === 'internal_link_edit' && c.target.id === `${O}/blogs/news/magsafe-explained`,
    )
    expect(link).toBeDefined()
    expect(
      (link?.after as { links?: { to: string; anchor: string }[] } | undefined)?.links,
    ).toEqual([{ to: `${O}/products/magsafe-10k`, anchor: 'magsafe power bank' }])
  })

  it('同一对页落过之后 4 周内不再进 5 件事；抢词报告一周只出一张', async () => {
    const { service, created, setNow } = setup()
    await service.daily()
    setNow('2026-10-23T00:00:00.000Z')
    await service.daily()
    const daily = reportOf(created, 'daily') as unknown as SeoDailyPayload
    expect(daily.picks.filter((p) => p.lane === 'merge')).toHaveLength(0)
    expect(
      created.filter(
        (i) => i.kind === 'seo_report' && i.payload.variant === 'weekly_cannibalization',
      ),
    ).toHaveLength(1)
  })
})

describe('WP448 掉量分诊落地与改版回归简报', () => {
  it('「该下线」交建站：定一个最相关的页加跳转', async () => {
    const { service, matters, created } = setup()
    await service.daily()
    const retire = matters.find((m) => m.title.startsWith('下线这页并加跳转'))
    expect(retire?.role_id).toBe('site.shopify-build')
    expect(retire?.summary).toContain('掉量分诊')
    const daily = reportOf(created, 'daily') as unknown as SeoDailyPayload
    const pick = daily.picks.find((p) => p.signal === 'decaying')
    expect(pick?.triage?.verdict).toBe('retire')
    expect(pick?.triage?.evidence).toMatchObject({ page_clicks: 1, page_impressions: 40 })
  })

  it('改版回归的「注意 / 知道一下」进当天简报一行，每一次只进一回', async () => {
    const drift: DriftRun = {
      id: 'drift_1',
      trigger: { kind: 'theme_publish', label: '主题发布', at: '2026-10-21T10:00:00.000Z' },
      started_at: '2026-10-21T10:00:00.000Z',
      finished_at: '2026-10-21T10:00:30.000Z',
      status: 'ok',
      pages: 5,
      findings: [
        {
          rule: 'title_changed',
          severity: 'warning',
          url: `${O}/`,
          kind: 'home',
          detail: '标题改了',
        },
        {
          rule: 'schema_added',
          severity: 'info',
          url: `${O}/`,
          kind: 'home',
          detail: '新加了结构化数据',
        },
      ],
      notes: [],
    }
    const { service, created, setNow } = setup({ drift: () => drift })
    await service.daily()
    const first = reportOf(created, 'daily') as unknown as SeoDailyPayload
    expect(first.notes).toContain(
      '改版回归（主题发布，2026-10-21）：严重 0、注意 1、知道一下 1——看面板「改版回归」。',
    )
    setNow('2026-10-23T00:00:00.000Z')
    await service.daily()
    const second = reportOf(created, 'daily') as unknown as SeoDailyPayload
    expect(second.notes.some((n) => n.startsWith('改版回归'))).toBe(false)
  })
})
