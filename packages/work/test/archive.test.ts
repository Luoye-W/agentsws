/**
 * WP207：事项的自动归档、取消归档与找回打分。
 */
import type { EventEnvelope } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  archiveVerdict,
  createWork,
  DAY_MS,
  queryTerms,
  type RecallDoc,
  rankArchived,
  SqliteWorkStore,
  textMatches,
  timeHint,
} from '../src/index.js'
import { FakeClock, matter, seeded, T0 } from './helpers.js'

type Emitted = Omit<EventEnvelope, 'id' | 'at'>

function setup(store?: SqliteWorkStore) {
  const clock = new FakeClock()
  const events: Emitted[] = []
  const work = createWork({
    workspace_id: 'ws_1',
    clock,
    random: seeded(),
    ...(store === undefined ? {} : { store }),
    emit: (e) => {
      events.push(e)
    },
  })
  return { clock, work, events }
}

describe('archiveVerdict', () => {
  const now = new Date(Date.parse(T0) + 4 * DAY_MS).toISOString()
  it('超过 N 天没动的开着的事归档；在忙 / 已关 / 已归档 / 不自动归档都不归', () => {
    expect(archiveVerdict(matter(), { now, idle_days: 3 })).toBe(true)
    expect(archiveVerdict(matter(), { now, idle_days: 5 })).toBe(false)
    expect(archiveVerdict(matter(), { now, idle_days: 3, busy: true })).toBe(false)
    expect(archiveVerdict(matter({ status: 'closed' }), { now, idle_days: 3 })).toBe(false)
    expect(archiveVerdict(matter({ archived_at: T0 }), { now, idle_days: 3 })).toBe(false)
    expect(archiveVerdict(matter(), { now, idle_days: null })).toBe(false)
  })
})

describe.each([
  ['memory', () => undefined],
  ['sqlite', () => new SqliteWorkStore({ dbPath: ':memory:', clock: new FakeClock() })],
] as const)('Work 归档（%s）', (_name, makeStore) => {
  it('N 天没动归档，在跑 / 等批的不归；一次扫只发一条摘要', () => {
    const { clock, work, events } = setup(makeStore())
    const idle = work.createMatter({ kind: 'adhoc', title: '美国红人谈样品' })
    const busy = work.createMatter({ kind: 'adhoc', title: '在跑的那件' })
    const fresh = work.createMatter({ kind: 'adhoc', title: '昨天刚动过' })
    clock.advance(2 * DAY_MS)
    work.appendEvent(fresh.id, { kind: 'note', text: '动一下', actor: { kind: 'system', id: 's' } })
    clock.advance(DAY_MS + 1)
    const done = work.archiveIdle({ idle_days: 3, busy: (m) => m.id === busy.id })
    expect(done.map((m) => m.id)).toEqual([idle.id])
    expect(work.getMatter(idle.id)?.archived_at).toBe(clock.now())
    expect(work.getMatter(idle.id)?.status).toBe('open')
    expect(work.listMatters({ archived: false }).map((m) => m.id)).not.toContain(idle.id)
    expect(work.listMatters({ archived: true }).map((m) => m.id)).toEqual([idle.id])
    // 不给 archived = 都要（老调用方行为不变）
    expect(work.listMatters().length).toBe(3)
    const archived = events.filter((e) => e.type === 'work.archived')
    expect(archived).toHaveLength(1)
    expect(archived[0]?.payload).toEqual({ by: 'auto', idle_days: 3, count: 1 })
    // 再扫一次：没有新的可归
    expect(work.archiveIdle({ idle_days: 3 })).toHaveLength(1) // 只有「在跑的那件」这次不忙了
    expect(work.archiveIdle({ idle_days: null })).toEqual([])
  })

  it('新活动（时间线新一条 / 运行结束写摘要）自动取消归档，审计 by=activity', () => {
    const { clock, work, events } = setup(makeStore())
    const m = work.createMatter({ kind: 'adhoc', title: '一件事' })
    const other = work.createMatter({ kind: 'adhoc', title: '另一件' })
    clock.advance(4 * DAY_MS)
    work.archiveIdle({ idle_days: 3 })
    work.appendEvent(m.id, {
      kind: 'human_message',
      text: '接着说',
      actor: { kind: 'person', id: 'per_1' },
    })
    expect(work.getMatter(m.id)?.archived_at).toBeUndefined()
    work.onRunCompleted({ matter_id: other.id, run_id: 'run_1', summary: '定时任务跑完了' })
    expect(work.getMatter(other.id)?.archived_at).toBeUndefined()
    const un = events.filter((e) => e.type === 'work.unarchived')
    expect(un.map((e) => e.payload.by)).toEqual(['activity', 'activity'])
    // 没归档的事有新活动不发事件
    work.appendEvent(m.id, { kind: 'note', text: '再一条', actor: { kind: 'system', id: 's' } })
    expect(events.filter((e) => e.type === 'work.unarchived')).toHaveLength(2)
  })

  it('人点了恢复 / AI 候选点选：只动这一件，审计记是谁', () => {
    const { clock, work, events } = setup(makeStore())
    const a = work.createMatter({ kind: 'adhoc', title: 'A' })
    const b = work.createMatter({ kind: 'adhoc', title: 'B' })
    clock.advance(4 * DAY_MS)
    work.archiveIdle({ idle_days: 3 })
    work.unarchive(a.id, 'ai_suggested', 'per_1')
    expect(work.getMatter(a.id)?.archived_at).toBeUndefined()
    expect(work.getMatter(b.id)?.archived_at).toBeDefined()
    const un = events.filter((e) => e.type === 'work.unarchived')
    expect(un).toHaveLength(1)
    expect(un[0]?.payload).toEqual({ by: 'ai_suggested', archived_days: 0 })
    expect(un[0]?.actor).toEqual({ kind: 'person', id: 'per_1' })
    // 没归档的再点一次：原样返回，不发事件
    work.unarchive(a.id, 'user', 'per_1')
    expect(events.filter((e) => e.type === 'work.unarchived')).toHaveLength(1)
  })
})

describe('找回：时间段 / 查询词 / 打分', () => {
  // 2026-09-30 是周三（+8 时区）
  const now = '2026-09-30T04:00:00.000Z'

  it('拆时间段：昨天 / 上周 / N 天前 / last week；拆不出来是空', () => {
    expect(timeHint('昨天那个', now)).toEqual({
      since: '2026-09-28T16:00:00.000Z',
      until: '2026-09-29T16:00:00.000Z',
      label: '昨天',
    })
    const lastWeek = timeHint('上周跟红人谈的', now)
    expect(lastWeek.since).toBe('2026-09-20T16:00:00.000Z')
    expect(lastWeek.until).toBe('2026-09-27T16:00:00.000Z')
    expect(timeHint('last week chat', now).label).toBe('上周')
    expect(timeHint('3 天前', now).label).toBe('3 天前')
    expect(timeHint('红人样品', now)).toEqual({})
  })

  it('查询词去掉时间字眼与「找回来 / 对话」这类套话', () => {
    const terms = queryTerms('把上周跟那个美国红人谈样品的对话找回来')
    expect(terms).toContain('美国')
    expect(terms).toContain('红人')
    expect(terms).toContain('样品')
    expect(terms).not.toContain('对话')
    expect(terms).not.toContain('上周')
    expect(queryTerms('find the sample chat with the US creator')).toEqual([
      'sample',
      'us',
      'creator',
    ])
  })

  const doc = (id: string, title: string, over: Partial<RecallDoc> = {}, at = now): RecallDoc => ({
    matter: matter({
      id,
      title,
      archived_at: at,
      context: { summary: '', pinned: [], participants: [], last_activity: at },
      created_at: at,
    }),
    people: [],
    labels: [],
    body: '',
    ...over,
  })

  it('模糊描述排出最像的几个，时间段加分不硬筛，不相干的不给', () => {
    const lastWeek = '2026-09-23T04:00:00.000Z'
    const docs = [
      doc('m1', '美国红人样品寄送', {}, lastWeek),
      doc('m2', '红人报价', { body: '跟美国的红人谈了样品和档期' }, '2026-09-10T04:00:00.000Z'),
      doc('m3', '退款 #1001', {}, lastWeek),
      doc('m4', 'Instagram 帖子排期', { labels: ['红人营销'] }, lastWeek),
    ]
    const out = rankArchived(docs, { query: '把上周跟那个美国红人谈样品的对话找回来', now })
    // m4 只中了岗位名「红人营销」：同一个岗位下的事个个都带着它，不算像；m3 什么都没中
    expect(out.map((c) => c.matter_id)).toEqual(['m1', 'm2'])
    expect(out[0]?.why).toContain('title:美国红人 样品')
    expect(out[0]?.why).toContain('time:上周')
    expect(out[0]?.score).toBeGreaterThan(out[1]?.score ?? 1)
  })

  it('有语义分就混进来：关键词一个没中但语义很像的也能进候选', () => {
    const docs = [doc('m1', 'Creator sample shipping'), doc('m2', '退款')]
    const kwOnly = rankArchived(docs, { query: '红人样品', now })
    expect(kwOnly).toEqual([])
    const mixed = rankArchived(docs, { query: '红人样品', now }, [0.9, 0.1])
    expect(mixed.map((c) => c.matter_id)).toEqual(['m1'])
    expect(mixed[0]?.why).toContain('semantic')
  })

  it('最多给 limit 个（默认 5、上限 8）；参与人对上加分', () => {
    const docs = Array.from({ length: 10 }, (_, i) =>
      doc(`m${i}`, `样品 ${i}`, i === 7 ? { people: ['Alice'] } : {}),
    )
    expect(rankArchived(docs, { query: '样品', now })).toHaveLength(5)
    expect(rankArchived(docs, { query: '样品', now, limit: 20 })).toHaveLength(8)
    const who = rankArchived(docs, { query: '样品', now, participant: 'alice' })
    expect(who[0]?.matter_id).toBe('m7')
  })

  it('全文搜：几个词都出现才算', () => {
    const d = doc('m1', '红人报价', { body: '样品下周到' })
    expect(textMatches('红人 样品', d)).toBe(true)
    expect(textMatches('红人 退款', d)).toBe(false)
    expect(textMatches('', d)).toBe(true)
  })
})
