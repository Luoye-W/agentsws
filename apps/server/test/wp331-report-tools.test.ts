/**
 * WP331：报告积木四个工具的执行器（替身巡查库、替身发出记录、替身审批总线；不联网）。
 *
 * - 查巡查数据：没配照实说；只给担巡查的职责；时间窗认不出照实回；按话题归组；
 * - 立即巡查：不能现巡 / 没读成 / 读成了，三种都照实说（没读成不挡报告）；
 * - 查发出记录：按渠道数回帖子 / 回评论；
 * - 发布报告：校验、报表块（`weekly_review`，不进审批队列）、同一系列同一周期同一个键、第几版、
 *   记录去处只有点名 `report` 的才记一行（不看渠道）。
 */
import type {
  ApprovalItem,
  CreateApprovalInput,
  OutboundRecord,
  OutboundRecordInput,
  RecordSinkView,
  RunRequest,
  WatchItem,
} from '@agentsws/contracts'
import {
  PUBLISH_REPORT_TOOL,
  QUERY_SENT_RECORDS_TOOL,
  QUERY_WATCH_ITEMS_TOOL,
  RUN_WATCH_NOW_TOOL,
} from '@agentsws/stand-ins'
import { describe, expect, it } from 'vitest'
import { matchesFilter } from '../src/outbound/mapping.js'
import {
  createReportToolExecutor,
  REPORT_MAX_CHARS,
  reportDedupeKey,
  type WatchSource,
} from '../src/report-tools.js'

const NOW = '2026-10-16T09:00:00.000Z' // 周五 17:00（东八区）
const WS = 'ws_1'

const item = (over: Partial<WatchItem>): WatchItem => ({
  id: 't1_a',
  platform: 'reddit',
  kind: 'comment',
  scope: 'own',
  place: 'inmoxr',
  created_at: '2026-10-13T03:00:00.000Z',
  url: 'https://www.reddit.com/r/inmoxr/comments/a/',
  text: 'hello',
  ...over,
})

function setup(opts: { source?: WatchSource | undefined; sinks?: RecordSinkView[] } = {}) {
  const created: CreateApprovalInput<unknown>[] = []
  const recorded: OutboundRecordInput[] = []
  const published = new Map<string, number>()
  const records = [
    {
      id: 'ob_1',
      sent_at: '2026-10-13T02:00:00.000Z',
      channel: 'reddit',
      action: 'reply',
      status: 'sent',
      content: 'hi',
      link: 'https://www.reddit.com/r/inmoxr/comments/1/x/our1/',
      parent_external_id: 't1_x',
    },
  ] as OutboundRecord[]
  const source: WatchSource | undefined =
    'source' in opts
      ? opts.source
      : {
          platform: 'reddit',
          configured: () => true,
          ownPlaces: () => ['inmoxr'],
          items: () => [
            item({}),
            item({
              id: 't3_x',
              kind: 'post',
              scope: 'external',
              place: 'ar',
              topic: { key: 't:a', label: '话题甲' },
              assessment: 'follow_up',
            }),
          ],
          sweeps: () => ['2026-10-15T01:00:00.000Z'],
        }
  const exec = createReportToolExecutor({
    clock: { now: () => NOW },
    tzOffsetMinutes: () => 480,
    watch: () => source,
    watchRoles: new Set(['social.reddit']),
    outbound: () => ({
      list: () => records,
      sinks: () => opts.sinks ?? [],
      record: (_ws, input) => {
        recorded.push(input)
        return { ...input, id: 'ob_r' } as OutboundRecord
      },
    }),
    approvals: () => ({
      create: async <P>(input: CreateApprovalInput<P>) => {
        created.push(input as CreateApprovalInput<unknown>)
        published.set(input.dedupe_key, (published.get(input.dedupe_key) ?? 0) + 1)
        return { id: `ap_${created.length}`, ...input } as unknown as ApprovalItem<P>
      },
    }),
    publishedCount: (_ws, key) => published.get(key) ?? 0,
  })
  const run = (name: string, input: Record<string, unknown>, role = 'social.reddit') =>
    exec({
      name,
      input,
      request: {
        id: 'run_1',
        workspace_id: WS,
        actor: { assignment_id: 'asg_1', role_id: role, person_id: 'per_1' },
      } as unknown as RunRequest,
    })
  return { run, created, recorded }
}

describe('查巡查数据 / 立即巡查', () => {
  it('按时间窗查、按话题归组；只给担巡查的职责；时间窗认不出照实回', async () => {
    const { run } = setup()
    const r = await run(QUERY_WATCH_ITEMS_TOOL, {
      period: 'this_week',
      week_start: 0,
      scope: 'external',
      group_by: 'topic',
    })
    expect(r.status).toBe('ok')
    expect(r.data).toMatchObject({
      configured: true,
      platform: 'reddit',
      window: { start_date: '2026-10-11', label: '10/11 – 10/16' },
      sweeps: { count: 1 },
      totals: { items: 1, external: { posts: 1, comments: 0 } },
      groups: [{ topic: '话题甲', assessment: 'follow_up' }],
    })
    const bad = await run(QUERY_WATCH_ITEMS_TOOL, { period: 'fortnight' })
    expect((bad.data as { problems: string[] }).problems[0]).toContain('fortnight')
    expect((await run(QUERY_WATCH_ITEMS_TOOL, {}, 'dtc.store')).status).toBe('blocked')
    expect((await run(RUN_WATCH_NOW_TOOL, {}, 'dtc.store')).status).toBe('blocked')
  })

  it('没配巡查照实说', async () => {
    const { run } = setup({ source: undefined })
    expect((await run(QUERY_WATCH_ITEMS_TOOL, {})).data).toMatchObject({ configured: false })
    expect((await run(RUN_WATCH_NOW_TOOL, {})).data).toMatchObject({ ok: false })
  })

  it('立即巡查：不能现巡 / 没读成 / 读成了', async () => {
    const base: WatchSource = {
      platform: 'reddit',
      configured: () => true,
      ownPlaces: () => [],
      items: () => [],
      sweeps: () => [],
    }
    expect((await setup({ source: base }).run(RUN_WATCH_NOW_TOOL, {})).data).toMatchObject({
      ok: false,
    })
    const broken = {
      ...base,
      sweepNow: async () => {
        throw new Error('插件还没交回这一轮')
      },
    }
    expect((await setup({ source: broken }).run(RUN_WATCH_NOW_TOOL, {})).data).toMatchObject({
      ok: false,
      message: '插件还没交回这一轮',
    })
    const good = {
      ...base,
      sweepNow: async () => ({
        finished_at: NOW,
        parts: [{ part: 'inbox', status: 'ok', fresh: 2 }],
      }),
    }
    expect((await setup({ source: good }).run(RUN_WATCH_NOW_TOOL, {})).data).toEqual({
      ok: true,
      finished_at: NOW,
      parts: [{ part: 'inbox', status: 'ok', fresh: 2 }],
    })
  })
})

describe('查发出记录', () => {
  it('按渠道数回帖子 / 回评论，带链接', async () => {
    const { run } = setup()
    const r = await run(QUERY_SENT_RECORDS_TOOL, { period: 'this_week', channel: 'Reddit' })
    expect(r.data).toMatchObject({
      totals: { all: 1, replies_to_comments: 1 },
      records: [{ link: 'https://www.reddit.com/r/inmoxr/comments/1/x/our1/' }],
    })
  })
})

describe('发布报告', () => {
  it('校验：缺标题 / 正文、太长、周期起点写法', async () => {
    const { run, created } = setup()
    const r = await run(PUBLISH_REPORT_TOOL, {
      title: '',
      period: '本周',
      markdown: 'x'.repeat(REPORT_MAX_CHARS + 1),
      period_start: '10/11',
    })
    expect((r.data as { problems: string[] }).problems).toHaveLength(3)
    expect(created).toEqual([])
  })

  it('报表块、同一系列同一周期 = 同一个键、第几版；没点名的去处不记', async () => {
    const { run, created, recorded } = setup()
    const input = {
      title: 'r/inmoxr 周报（10/11 – 10/16）',
      period: '10/11 – 10/16',
      period_start: '2026-10-11',
      series: 'r/inmoxr 周报',
      markdown: '# 周报\n\n## 1. 帖子\n',
    }
    const first = await run(PUBLISH_REPORT_TOOL, input)
    expect(first.data).toEqual({ ok: true, report_id: 'ap_1', version: 1 })
    const again = await run(PUBLISH_REPORT_TOOL, { ...input, title: '换了个标题' })
    expect(again.data).toMatchObject({ version: 2 })
    expect(created[0]?.dedupe_key).toBe(created[1]?.dedupe_key)
    expect(created[0]?.dedupe_key).toBe(
      reportDedupeKey({
        workspace_id: WS,
        assignment_id: 'asg_1',
        series: 'r/inmoxr 周报',
        period_key: '2026-10-11',
      }),
    )
    expect(created[0]).toMatchObject({
      kind: 'weekly_review',
      role_id: 'social.reddit',
      priority: 'digest',
      routing: { recipients: [{ person: 'per_1' }] },
      payload: { kind: 'report', version: 1, period_start: '2026-10-11' },
    })
    const nextWeek = await run(PUBLISH_REPORT_TOOL, { ...input, period_start: '2026-10-18' })
    expect(nextWeek.data).toMatchObject({ version: 1 })
    expect(recorded).toEqual([])
  })

  it('记录去处点名 report 的才记一行（一版一行），不看渠道', async () => {
    const sink = {
      id: 'sink_1',
      state: 'active',
      filter: { channels: ['reddit'], actions: ['reply', 'report'] },
    } as unknown as RecordSinkView
    const { run, recorded } = setup({ sinks: [sink] })
    const out = await run(PUBLISH_REPORT_TOOL, { title: '日报', period: '10/16', markdown: '正文' })
    expect(out.data).toMatchObject({ recorded: true })
    expect(recorded[0]).toMatchObject({ action: 'report', channel: 'report', content: '正文\n' })
    const row = { ...recorded[0], id: 'ob_r', status: 'sent', follow_ups: [] } as OutboundRecord
    expect(matchesFilter(row, sink.filter)).toBe(true)
    expect(matchesFilter(row, { channels: ['reddit'] })).toBe(false)
    expect(matchesFilter(row, {})).toBe(false)
  })
})
