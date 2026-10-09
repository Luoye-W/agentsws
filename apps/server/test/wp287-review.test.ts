/**
 * WP287（Luoye 10-09 Windows 真机：「要你处理」里 39 张一模一样的「今天的复盘：你处理 0 张，AI 0 张」）：
 * 全 0 不出复盘；一个人一天一份（不是每条职责一份）；① 个人模式不出卡；积压的老复盘卡收成过期。
 * 真服务进程的工作模型与审批总线，复盘处理函数直接调。
 */
import type { ApprovalItem } from '@agentsws/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildReviewsFor,
  createServer,
  type SchedulePosition,
  type Server,
  sweepStaleReviews,
} from '../src/index.js'

/** 东八区 2026-10-09 晚上 20:00 = UTC 12:00。 */
const T0 = '2026-10-09T12:00:00.000Z'
let now = Date.parse(T0)
let server: Server
const positions: SchedulePosition[] = []

const ws = (): string => server.bootstrap.workspace.id
const me = (): string => server.bootstrap.person.id

const reviewCards = async (): Promise<ApprovalItem[]> =>
  (
    (await server.txn.approvals.queue({
      workspace_id: ws(),
      person_id: me(),
      lane: 'mine',
      state: ['pending', 'in_review', 'expired'],
    })) as ApprovalItem[]
  ).filter((i) => i.kind === 'review')

const deps = (solo: boolean) => ({
  workspace_id: ws(),
  work: server.work,
  approvals: server.txn.approvals,
  positions: () => positions,
  tz: 'Asia/Shanghai',
  solo: () => solo,
  cards: async () =>
    (await server.txn.approvals.queue({
      workspace_id: ws(),
      person_id: me(),
      lane: 'mine',
    })) as ApprovalItem[],
})

beforeEach(async () => {
  now = Date.parse(T0)
  server = await createServer({
    clock: { now: () => new Date(now).toISOString() },
    quiet: true,
    startRun: false,
    tokenRefreshIntervalMs: 0,
    scheduleIntervalMs: 0,
  })
  positions.length = 0
  // 真机那样：底座两条 + 四条职责，全是同一个人
  positions.push({
    assignment_id: server.bootstrap.ownerAssignment.id,
    person_id: me(),
    role_id: 'common.owner',
  })
  for (const role_id of [
    'dtc.fulfillment',
    'dtc.store',
    'site.shopify-build',
    'site.shopify-theme',
  ]) {
    const a = server.roles.assignments.create({
      person_id: me(),
      workspace_id: ws(),
      role_id,
      granted_by: me(),
      ranges: [],
    })
    positions.push({ assignment_id: a.id, person_id: me(), role_id })
  }
})

afterEach(async () => {
  await server.close()
})

describe('WP287 复盘别刷屏', () => {
  it('一点动静都没有（处理 0、AI 0、待办 0、会议 0）→ 不出复盘', async () => {
    const out = await buildReviewsFor(deps(false), 'day')
    expect(out.reviews).toEqual([])
    expect(await reviewCards()).toEqual([])
  })

  it('有动静 → 一个人一天一份卡（挂在他真在做的职责上，不挂底座），重跑不重复', async () => {
    server.work.createTodo({ title: '补发 #1024', owner: me(), horizon: 'today' })
    // 五条分配各有一条复盘定时：只让挂复盘的那一条出
    for (const p of positions) await buildReviewsFor(deps(false), 'day', p.assignment_id)
    await buildReviewsFor(deps(false), 'day')
    const cards = await reviewCards()
    expect(cards).toHaveLength(1)
    expect(cards[0]?.role_id).toBe('dtc.fulfillment')
    expect(cards[0]?.expires_at).toBeDefined()
    expect(server.work.listReviews({ person_id: me() })).toHaveLength(1)
  })

  it('① 个人模式：复盘照记（岗位页「记录」里看得到），不出卡', async () => {
    server.work.createTodo({ title: '补发 #1024', owner: me(), horizon: 'today' })
    const out = await buildReviewsFor(deps(true), 'day')
    expect(out.reviews).toHaveLength(1)
    expect(await reviewCards()).toEqual([])
  })

  it('启动时收掉积压的老复盘卡：全 0 的、过了当天的记成过期（不删）；今天有动静的留着', async () => {
    server.work.createTodo({ title: '补发 #1024', owner: me(), horizon: 'today' })
    // 前一天：一张有动静的（过了当天）
    now = Date.parse(T0) - 24 * 3600_000
    await buildReviewsFor(deps(false), 'day')
    // 今天：一张有动静的 + 一张老版本出的全 0 卡（模拟升级前的积压）
    now = Date.parse(T0)
    await buildReviewsFor(deps(false), 'day')
    const zero = await server.txn.approvals.create({
      workspace_id: ws(),
      schema_version: 1,
      kind: 'review',
      role_id: 'common.member',
      subject: { object: { type: 'review', id: 'rev_old' } },
      dedupe_key: 'legacy:review:zero',
      title: '今天的复盘：你处理 0 张，AI 0 张',
      summary: '待办完成 0/0，会议 0 个。',
      payload: {
        cards: { ai_handled: 0, you_handled: 0, auto_sent: 0, blocked: 0 },
        todos: { done: 0, total: 0, completion_pct: 100 },
        meetings: { count: 0, outputs: 0 },
      },
      evidence: { source_events: [], provenance: { seen: [] }, precheck: {} },
      proposer: { kind: 'system', id: 'work.reviewer' },
      automation: { level_at_creation: 'L1' },
      routing: {
        recipients: [{ person: me(), via: 'role_holder' }],
        rule: 'role_holder',
        escalation: { after_hours: 24, business_hours: true, chain: ['owner'], escalated_at: [] },
        separation_of_duties: false,
      },
      priority: 'queue',
    } as never)
    expect((await reviewCards()).filter((c) => c.state === 'pending')).toHaveLength(3)
    const swept = await sweepStaleReviews({
      approvals: server.txn.approvals,
      work: server.work,
      workspace_id: ws(),
      people: [me()],
      solo: () => false,
    })
    expect(swept).toBe(2)
    const cards = await reviewCards()
    expect(cards.find((c) => c.id === zero.id)?.state).toBe('expired')
    expect(cards.filter((c) => c.state === 'pending')).toHaveLength(1)
    expect(cards).toHaveLength(3)
  })
})
