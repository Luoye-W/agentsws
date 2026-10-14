/**
 * WP330：Reddit 周报服务（替身巡查源 + 真发出记录 + 替身飞书）：
 * 最后一次巡查之后出 → 一张周报卡（报表类、发给担 Reddit 运营的人）→ 存、能导出 Markdown →
 * 我们的回复从发出记录数 → 点名要周报的去处记一行、别的去处不记 → 分节与措辞能改、能回默认。
 */
import type {
  ApprovalItem,
  Assignment,
  OutboundRecordInput,
  RedditWatchItem,
} from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { createSinkAdapters } from '../src/outbound/adapters.js'
import { createFeishuSinkAdapter } from '../src/outbound/feishu.js'
import { createOutboundLog } from '../src/outbound/log.js'
import { createOutboundStore } from '../src/outbound/store.js'
import {
  createRedditWeeklyService,
  EMPTY_REDDIT_WEEK_SOURCE,
  type RedditWeekSource,
} from '../src/reddit-weekly.js'
import { createRedditWeeklyStore } from '../src/reddit-weekly-store.js'
import { createFakeFeishu } from './fake-feishu-api.js'

const WS = 'ws_a' as never
const NOW = '2026-10-16T09:00:00.000Z' // 周五 17:00（东八区）
const TABLE = (name: string) => ({
  name,
  fields: [
    { field_name: '日期', type: 1 },
    { field_name: '动作', type: 1 },
    { field_name: '内容', type: 1 },
  ],
  records: [] as Record<string, unknown>[],
})

const assignment = (role_id: string, person_id = 'p_ops'): Assignment =>
  ({ id: `asg_${role_id}`, role_id, person_id, workspace_id: WS }) as unknown as Assignment

const watch = (over: Partial<RedditWatchItem>): RedditWatchItem => ({
  id: 't3_1',
  kind: 'post',
  scope: 'own',
  subreddit: 'inmoxr',
  author: 'alice',
  created_at: '2026-10-12T03:00:00.000Z',
  permalink: 'https://www.reddit.com/r/inmoxr/comments/1/',
  text: 'hello',
  ...over,
})

function setup(opts: { roles?: string[]; source?: RedditWeekSource } = {}) {
  let n = 0
  const t = Date.parse(NOW)
  const fake = createFakeFeishu()
  fake.bitables.set(
    'bascnWEEK',
    new Map([
      ['tblA', TABLE('回复记录')],
      ['tblB', TABLE('周报与回复')],
    ]),
  )
  fake.shared.add('bascnWEEK')
  const cardIds: string[] = []
  const log = createOutboundLog({
    store: createOutboundStore(),
    adapters: createSinkAdapters([
      createFeishuSinkAdapter({
        credentials: () => ({ app_id: 'cli_test', app_secret: 'test-secret' }),
        fetch: fake.fetch,
        nowMs: () => t,
      }),
    ]),
    now: () => new Date(t).toISOString(),
    newId: (p) => `${p}${++n}`,
    tzOffsetMinutes: () => 480,
    stageCard: async () => {
      cardIds.push(`apv_sink${cardIds.length}`)
      return cardIds.at(-1)
    },
  })
  // 巡查源替身：sweepNow 时「读到」周五 16:58 的一条新评论（证明周报在最后一次巡查之后出）
  const items: RedditWatchItem[] = [
    watch({ id: 't3_1', signals: { voc: true, note: '问续航' } }),
    watch({
      id: 't1_ext',
      kind: 'comment',
      scope: 'external',
      subreddit: 'augmentedreality',
      topic: { key: 'compare', label: '和别家对比' },
      assessment: 'follow_up',
      permalink: 'https://www.reddit.com/r/augmentedreality/comments/9/x/c1/',
    }),
  ]
  const sweeps = ['2026-10-12T01:00:00.000Z']
  let swept = 0
  const source: RedditWeekSource = opts.source ?? {
    configured: () => true,
    subreddits: () => ['inmoxr'],
    items: () => items,
    sweeps: () => sweeps,
    sweepNow: async () => {
      swept += 1
      items.push(watch({ id: 't1_late', kind: 'comment', created_at: '2026-10-16T08:58:00.000Z' }))
      sweeps.push(NOW)
    },
  }
  const created: ApprovalItem[] = []
  const service = createRedditWeeklyService({
    workspace_id: WS,
    clock: { now: () => NOW } as never,
    tzOffsetMinutes: () => 480,
    brandName: () => 'INMO',
    assignments: () => (opts.roles ?? ['social.reddit']).map((r) => assignment(r)),
    approvals: {
      create: (async (input: Record<string, unknown>) => {
        const item = { ...input, id: `apv_${created.length + 1}` } as unknown as ApprovalItem
        created.push(item)
        return item
      }) as never,
    },
    store: createRedditWeeklyStore(),
    source: () => source,
    outbound: log,
  })
  return { service, log, created, fake, cardIds, swept: () => swept }
}

const reply = (i: number, over: Partial<OutboundRecordInput> = {}): OutboundRecordInput => ({
  source_key: `approval:r${i}`,
  sent_at: '2026-10-13T02:00:00.000Z',
  channel: 'reddit',
  action: 'reply',
  kind: 'outbound_draft',
  destination: 'r/inmoxr',
  content: `reply ${i}`,
  link: `https://www.reddit.com/r/inmoxr/comments/1/x/our${i}/`,
  parent_external_id: i % 2 === 0 ? `t1_c${i}` : `t3_p${i}`,
  ...over,
})

describe('Reddit 周报服务', () => {
  it('没配巡查 / 没人担 Reddit 运营 → 不出（不出 0）', async () => {
    expect(await setup({ source: EMPTY_REDDIT_WEEK_SOURCE }).service.run()).toEqual({
      skipped: '没配 Reddit 巡查（自家版块、外部关键词都没有）',
    })
    expect((await setup({ roles: ['dtc.store'] }).service.run()).skipped).toContain('没人担')
    expect(await setup({ source: EMPTY_REDDIT_WEEK_SOURCE }).service.build()).toBeUndefined()
  })

  it('先做最后一次巡查再出；一张报表卡发给担 Reddit 运营的人；存着、能导出 Markdown', async () => {
    const s = setup()
    s.log.record(WS, reply(1))
    s.log.record(WS, reply(2))
    s.log.record(WS, reply(3, { sent_at: '2026-10-10T10:00:00.000Z' })) // 上周六，不算
    const r = await s.service.run()
    expect(s.swept()).toBe(1)
    expect(r).toMatchObject({ approval_item_id: 'apv_1', week_of: '2026-10-11' })
    const card = s.created[0] as unknown as Record<string, unknown> & ApprovalItem
    expect(card).toMatchObject({
      kind: 'weekly_review',
      role_id: 'social.reddit',
      dedupe_key: 'dk_ws_a|reddit_weekly|2026-10-11',
      title: 'INMO Reddit 周报（10/11 – 10/16）',
      priority: 'digest',
      routing: { recipients: [{ person: 'p_ops', via: 'role_holder' }] },
    })
    const p = s.service.report()
    expect(p?.totals).toMatchObject({
      posts: 1,
      comments: 1, // 巡查时读到的那条
      voc: 1,
      topics: 1,
      follow_up_topics: 1,
      to_posts: 1,
      to_comments: 1,
    })
    expect(p?.sweeps).toEqual({ count: 2, last_at: NOW })
    const doc = s.service.exportDoc()
    expect(doc?.filename).toBe('reddit-weekly-2026-10-11.md')
    expect(doc?.content).toContain('### 1. 和别家对比（post × 0 / comment × 1）')
    expect(doc?.content).toContain('https://www.reddit.com/r/inmoxr/comments/1/x/our2/')
    expect(doc?.content).not.toContain('our3')
    // 同一周再出：同一个去重键（同一张卡出新一版）
    await s.service.run({ sweep: false })
    expect(s.created[1]?.dedupe_key).toBe(card.dedupe_key)
  })

  it('最后一次巡查没跑成 → 照样出，用已入库的，照实带回原因', async () => {
    const s = setup({
      source: {
        configured: () => true,
        subreddits: () => ['inmoxr'],
        items: () => [watch({})],
        sweeps: () => [],
        sweepNow: async () => {
          throw new Error('插件没连上')
        },
      },
    })
    const r = await s.service.run()
    expect(r).toMatchObject({ approval_item_id: 'apv_1', sweep_failed: '插件没连上' })
    expect(s.service.report()?.markdown).toContain('这段时间没有巡查记录')
  })

  it('没有 social.reddit 时发给担 pr.reddit 的人', async () => {
    const s = setup({ roles: ['pr.reddit'] })
    await s.service.run()
    expect(s.created[0]?.role_id).toBe('pr.reddit')
  })

  it('记录去处：筛选点名 weekly_report 的那个记一行整份周报；只记回复的那个不记', async () => {
    const s = setup()
    const confirm = async (table: string, actions?: string[]) => {
      const p = await s.log.propose(WS, {
        url: `https://x.feishu.cn/base/bascnWEEK?table=${table}`,
        instruction: '记到这张表',
        name: table,
        columns: [
          { column: '日期', source: { field: 'sent_date' } },
          { column: '动作', source: { field: 'action' } },
          { column: '内容', source: { field: 'content' } },
        ],
        filter: { channels: ['reddit'], ...(actions === undefined ? {} : { actions }) },
        actor: { person_id: 'p_ops' },
      })
      if (!p.ok) throw new Error(p.message)
      await s.log.onDecided({
        id: p.card_id,
        workspace_id: WS,
        kind: 'policy_change',
        state: 'approved',
        payload: { form: 'record_sink', sink_id: p.sink_id },
        decision: { by: 'p_ops', at: NOW, selected_option_id: 'after' },
      } as unknown as ApprovalItem)
    }
    await confirm('tblA')
    await confirm('tblB', ['reply', 'weekly_report'])
    s.log.record(WS, reply(1))
    const r = await s.service.run()
    expect(r.recorded).toBe(true)
    // 记一条时已经当场起了一轮写（还在路上），再补一轮把周报那一笔写完
    await s.log.flush()
    await s.log.flush()
    const rows = (t: string) => s.fake.bitables.get('bascnWEEK')?.get(t)?.records ?? []
    expect(rows('tblA').map((x) => x.动作)).toEqual(['回复'])
    const actions = rows('tblB').map((x) => String(x.动作))
    expect(actions).toHaveLength(2)
    expect(actions[0]).toBe('回复')
    expect(String(rows('tblB')[1]?.内容)).toContain('# INMO Reddit 周报')
    // 周报那一行不算进「我们本周的回复」
    await s.service.run({ sweep: false })
    expect(s.service.report()?.totals.to_posts).toBe(1)
  })

  it('分节与措辞：叠改动、下一份照新的出；回默认', async () => {
    const s = setup()
    const r = s.service.setFormat({
      title: '{brand} 社区周报',
      sections: [
        { id: 'our_replies', title: '官方号回复' },
        { id: 'voc_ugc', enabled: false },
      ],
      instruction: '回复放最前面，不要 VOC 那节',
    })
    expect(r.problems).toEqual([])
    expect(s.service.format().instruction).toBe('回复放最前面，不要 VOC 那节')
    const p = await s.service.build()
    expect(p?.title).toBe('INMO 社区周报')
    expect(p?.sections.map((x) => x.id)).toEqual(['our_replies', 'own_stats', 'external'])
    expect(p?.markdown).toContain('## 一、官方号回复')
    s.service.setFormat({}, { reset: true })
    expect(s.service.format().title).toBe('{brand} Reddit 周报（{start} – {end}）')
  })
})
