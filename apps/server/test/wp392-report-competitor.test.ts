/**
 * WP392：竞品变化接进报告积木（替身库；不联网）。
 *
 * - `list_competitor_changes`：只给担竞品监控的职责；按竞品 / 种类 / 来源 / 时间窗筛；出参白名单；没读到的照实回；
 * - `query_watch_items`：`platform: all` 帖子和变化混查；`kind: change` 只要变化；
 * - `publish_report`：用变化出一份报表（报表块，不进审批队列）。
 */
import type {
  ApprovalItem,
  CompetitorChange,
  CreateApprovalInput,
  RunRequest,
  WatchItem,
} from '@agentsws/contracts'
import { watchItemOfChange } from '@agentsws/social-core'
import {
  LIST_COMPETITOR_CHANGES_TOOL,
  PUBLISH_REPORT_TOOL,
  QUERY_WATCH_ITEMS_TOOL,
} from '@agentsws/stand-ins'
import { describe, expect, it } from 'vitest'
import {
  combineWatchSources,
  createReportToolExecutor,
  type WatchSource,
} from '../src/report-tools.js'

const NOW = '2026-10-16T09:00:00.000Z'
const WS = 'ws_1'

const change = (over: Partial<CompetitorChange>): CompetitorChange => ({
  id: 'cc_1',
  workspace_id: WS as never,
  kind: 'price',
  competitor_id: 'c1',
  competitor: 'Alpha Bikes',
  source_id: 'cw_shop_c1',
  source_kind: 'shop_catalog',
  product_key: 'p1',
  title: 'Level 3',
  url: 'https://alpha.test/products/level-3',
  image: 'https://cdn.alpha.test/l3.jpg',
  before: 1799,
  after: 1599,
  pct: -11.1,
  currency: 'USD',
  detected_at: '2026-10-14T01:00:00.000Z',
  ...over,
})

const CHANGES = [
  change({}),
  change({
    id: 'cc_2',
    kind: 'new',
    title: 'Level 4',
    before: undefined,
    after: 2199,
    pct: undefined,
    detected_at: '2026-10-15T01:00:00.000Z',
  }),
  change({
    id: 'cc_3',
    competitor_id: 'c2',
    competitor: 'Beta Ride',
    source_id: 'cw_amz_c2_US',
    source_kind: 'amazon_asin',
    kind: 'out_of_stock',
    title: 'Beta X',
    before: true,
    after: false,
    pct: undefined,
  }),
  // 窗口外
  change({ id: 'cc_old', detected_at: '2026-09-01T01:00:00.000Z' }),
]

const competitorSource = (): WatchSource => ({
  platform: 'competitor',
  configured: () => true,
  ownPlaces: () => [],
  items: () => CHANGES.map(watchItemOfChange),
  sweeps: () => ['2026-10-15T01:00:00.000Z'],
  changes: () => CHANGES,
  health: () => ({ sources: 3, failed: ['Gamma'], partial: [] }),
})

const redditSource = (): WatchSource => ({
  platform: 'reddit',
  configured: () => true,
  ownPlaces: () => ['ours'],
  items: (): WatchItem[] => [
    {
      id: 't3_a',
      platform: 'reddit',
      kind: 'post',
      scope: 'external',
      place: 'ebikes',
      created_at: '2026-10-14T03:00:00.000Z',
      url: 'https://www.reddit.com/r/ebikes/comments/a/',
      text: 'Alpha vs Ours?',
      topic: { key: 't:cmp', label: '对比' },
    },
  ],
  sweeps: () => ['2026-10-15T02:00:00.000Z'],
})

function setup() {
  const created: CreateApprovalInput<unknown>[] = []
  const comp = competitorSource()
  const reddit = redditSource()
  const exec = createReportToolExecutor({
    clock: { now: () => NOW },
    tzOffsetMinutes: () => 480,
    watch: async (_ws, platform, role) => {
      if (platform === 'all') return combineWatchSources([reddit, comp])
      if (platform === 'competitor') return comp
      if (platform === 'reddit') return reddit
      return role === 'dtc.store' ? comp : reddit
    },
    watchRoles: new Set(['social.reddit']),
    competitorRoles: new Set(['dtc.store', 'amz.store']),
    outbound: () => undefined,
    approvals: () => ({
      create: async <P>(input: CreateApprovalInput<P>) => {
        created.push(input as CreateApprovalInput<unknown>)
        return { id: `ap_${created.length}`, ...input } as unknown as ApprovalItem<P>
      },
    }),
    publishedCount: () => 0,
  })
  const run = (name: string, input: Record<string, unknown>, role = 'dtc.store') =>
    exec({
      name,
      input,
      request: {
        id: 'run_1',
        workspace_id: WS,
        actor: { assignment_id: 'asg_1', role_id: role, person_id: 'per_1' },
      } as unknown as RunRequest,
    })
  return { run, created }
}

describe('WP392 list_competitor_changes', () => {
  it('只给担竞品监控的职责', async () => {
    const { run } = setup()
    expect((await run(LIST_COMPETITOR_CHANGES_TOOL, {}, 'social.reddit')).status).toBe('blocked')
    expect((await run(LIST_COMPETITOR_CHANGES_TOOL, {}, 'amz.store')).status).toBe('ok')
  })

  it('按时间窗 / 竞品 / 种类 / 来源筛；回计数和白名单字段；没读到的照实回', async () => {
    const { run } = setup()
    const r = await run(LIST_COMPETITOR_CHANGES_TOOL, { period: 'last_7_days' })
    expect(r.data).toMatchObject({
      configured: true,
      reads: { count: 1 },
      sources: { count: 3, not_read: ['Gamma'] },
      totals: {
        changes: 3,
        by_kind: { price: 1, new: 1, out_of_stock: 1 },
        by_competitor: { 'Alpha Bikes': 2, 'Beta Ride': 1 },
      },
    })
    const items = (r.data as { items: Record<string, unknown>[] }).items
    // 白名单：不带图、不带内部 id / 来源 id / 商品键
    for (const it of items) {
      expect(it).not.toHaveProperty('image')
      expect(it).not.toHaveProperty('id')
      expect(it).not.toHaveProperty('source_id')
      expect(it).not.toHaveProperty('product_key')
      expect(it).not.toHaveProperty('workspace_id')
    }
    const price = items.find((i) => i.kind === 'price')
    expect(price).toMatchObject({
      title: 'Level 3',
      url: 'https://alpha.test/products/level-3',
      before: 1799,
      after: 1599,
      pct: -11.1,
      text: 'Level 3：降价11.1%（$1,799 → $1,599）',
    })

    const byKind = await run(LIST_COMPETITOR_CHANGES_TOOL, {
      period: 'last_7_days',
      kinds: ['price', 'new'],
      competitor: 'alpha bikes',
    })
    expect((byKind.data as { totals: { changes: number } }).totals.changes).toBe(2)
    const amazon = await run(LIST_COMPETITOR_CHANGES_TOOL, {
      period: 'last_7_days',
      source: 'amazon',
    })
    expect((amazon.data as { totals: { changes: number } }).totals.changes).toBe(1)
  })
})

describe('WP392 query_watch_items 混查帖子和变化', () => {
  it('platform=all：帖子与竞品变化一起数；kind=change 只要变化', async () => {
    const { run } = setup()
    const all = await run(
      QUERY_WATCH_ITEMS_TOOL,
      { platform: 'all', period: 'last_7_days' },
      'social.reddit',
    )
    expect(all.data).toMatchObject({
      configured: true,
      platform: 'reddit+competitor',
      totals: { items: 4, posts: 1, comments: 0, changes: 3 },
    })
    const only = await run(QUERY_WATCH_ITEMS_TOOL, {
      platform: 'all',
      period: 'last_7_days',
      kind: 'change',
      group_by: 'topic',
    })
    const data = only.data as {
      totals: { items: number }
      groups: { topic: string; changes?: number; items: { change?: { kind: string } }[] }[]
    }
    expect(data.totals.items).toBe(3)
    expect(data.groups.map((g) => [g.topic, g.changes])).toEqual([
      ['竞品：Alpha Bikes', 2],
      ['竞品：Beta Ride', 1],
    ])
    expect(data.groups[0]?.items[0]?.change?.kind).toBeDefined()
  })

  it('竞品职责不给平台 = 默认查竞品那一份', async () => {
    const { run } = setup()
    const r = await run(QUERY_WATCH_ITEMS_TOOL, { period: 'last_7_days' }, 'dtc.store')
    expect(r.data).toMatchObject({ platform: 'competitor', totals: { changes: 3, posts: 0 } })
  })
})

describe('WP392 publish_report 用变化出一份报表', () => {
  it('查完变化 → 发一份竞品周报（报表块，不进审批队列）', async () => {
    const { run, created } = setup()
    const q = await run(LIST_COMPETITOR_CHANGES_TOOL, { period: 'this_week' })
    const data = q.data as {
      window: { start_date: string; label: string }
      items: { text: string }[]
    }
    const markdown = ['## 竞品动向', ...data.items.map((i) => `- ${i.text}`)].join('\n')
    const r = await run(PUBLISH_REPORT_TOOL, {
      title: '竞品周报',
      period: data.window.label,
      period_start: data.window.start_date,
      markdown,
    })
    expect(r.data).toMatchObject({ ok: true, version: 1 })
    expect(created).toHaveLength(1)
    expect(created[0]).toMatchObject({ kind: 'weekly_review', title: '竞品周报' })
    expect((created[0]?.payload as { markdown: string }).markdown).toContain('降价11.1%')
  })
})
