/**
 * 39 待办 A：审批的过期与升级在**真机器**上要按真实节奏发生。
 *
 * 跑的是服务进程真装配出来的那条调度线（`createServer` → `registerApprovalHousekeeping`），
 * 不是另拼一套；时间用注入的假时钟推进，测试里没有一个 `setTimeout`。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ApprovalItem, CreateApprovalInput } from '@agentsws/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { createServer, HANDLERS, type Server } from '../src/index.js'

const T0 = '2026-09-10T00:00:00.000Z'
const CHANGE_ID = 'chg_expire_1'
const HOUR = 3_600_000
const DAY = 24 * HOUR

function makeClock(start = T0) {
  let t = Date.parse(start)
  return {
    now: () => new Date(t).toISOString(),
    advance: (ms: number) => {
      t += ms
    },
  }
}

function seeded(seed = 11): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

let server: Server | undefined
let dir: string | undefined

afterEach(async () => {
  await server?.close()
  server = undefined
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

const ORDER = { type: 'order', id: 'ord_1042' } as const

/** 一张退款变更卡（默认 7 天过期，14 §13.1），路由给持有人本人。 */
function draft(s: Server, over: Partial<CreateApprovalInput<unknown>> = {}): CreateApprovalInput {
  return {
    workspace_id: s.bootstrap.workspace.id,
    schema_version: 1,
    kind: 'staged_change',
    role_id: s.bootstrap.ownerAssignment.role_id,
    subject: { object: ORDER },
    dedupe_key: `${s.bootstrap.workspace.id}:staged_change:ord_1042:refund`,
    title: '退款 42.00 USD 给 Anna',
    summary: '订单 #1042 已签收 6 天，在退货窗口内。',
    payload: {
      change_id: CHANGE_ID,
      kind: 'refund',
      target: ORDER,
      before: { refunded: 0 },
      after: { refunded: 42 },
    },
    evidence: { source_events: [], provenance: { seen: [ORDER] }, precheck: {} },
    proposer: { kind: 'agent', id: 'agent_aftersales' },
    automation: {
      level_at_creation: 'L1',
      auto_approved: false,
      mandate_check: { within: true, caps_hit: [] },
      sampling: { selected: false },
    },
    routing: {
      recipients: [{ person: s.bootstrap.person.id, via: 'role_holder' }],
      rule: 'role_holder',
      escalation: {
        after_hours: 8,
        // 测试要的是「时间到了就升级」，工作时间的换算另有专门用例（txn 包里）
        business_hours: false,
        chain: ['scope_manager', 'owner'],
        escalated_at: [],
      },
      separation_of_duties: false,
    },
    priority: 'queue',
    ...over,
  } as CreateApprovalInput
}

async function start(clock: ReturnType<typeof makeClock>): Promise<Server> {
  dir = mkdtempSync(join(tmpdir(), 'agentsws-housekeeping-'))
  const s = await createServer({
    clock,
    random: seeded(),
    quiet: true,
    startRun: false,
    scheduleIntervalMs: 0,
    dbDir: dir,
    env: { AGENTSWS_OWNER_EMAIL: 'owner@localhost' },
  })
  server = s
  return s
}

describe('审批家务接进调度器（39 待办 A）', () => {
  it('装配之后有一条一分钟一拍的家务任务，处理器已登记', async () => {
    const s = await start(makeClock())
    const task = s.schedule.scheduler.get('sched_approval_housekeeping')
    expect(task?.handler).toBe(HANDLERS.approvalHousekeeping)
    expect(task?.trigger).toMatchObject({ kind: 'interval', every_ms: 60_000 })
    // 关机错过了要补跑：那几天该过期的仍然该过期
    expect(task?.misfire_policy).toBe('run_once_now')
    expect(s.schedule.scheduler.handlers()).toContain(HANDLERS.approvalHousekeeping)
  })

  it('真机器节奏下一张卡到期会 expired，并释放它挂着的额度预占（15 §3.2 d）', async () => {
    const clock = makeClock()
    const s = await start(clock)
    const item = (await s.txn.approvals.create(draft(s))) as ApprovalItem
    expect(item.state).toBe('pending')
    expect(item.expires_at).toBeDefined()

    // 挂一条预占在这条卡上：过期时它必须跟着放掉
    const counter = 'asg_test|refund|2026-09-10'
    s.txn.runtime.store.reserve(counter, CHANGE_ID, 1)
    s.txn.runtime.store.putChange({
      id: CHANGE_ID,
      schema_version: 1,
      workspace_id: s.bootstrap.workspace.id,
      role_id: s.bootstrap.ownerAssignment.role_id,
      assignment_id: s.bootstrap.ownerAssignment.id,
      run_id: 'run_1',
      change_set_id: 'cs_1',
      kind: 'refund',
      target: ORDER,
      before: {},
      after: {},
      guardrail: { verdict: 'allow', hits: [], effective_mandate_hash: 'm:1', evaluated_at: T0 },
      notes: [],
      created_by: { kind: 'agent', id: 'agent_aftersales' },
      status: 'staged',
      risk_class: 'medium',
      reservation: { counter, amount: 1 },
      approval: { item_id: item.id, by: 'mandate', at: T0 },
      expires_at: item.expires_at ?? T0,
      created_at: T0,
      updated_at: T0,
    })
    expect(s.txn.runtime.store.countReserved(counter)).toBe(1)

    // 一分钟一拍：还没到期，什么都不发生
    clock.advance(60_000)
    const early = await s.schedule.scheduler.runNow('sched_approval_housekeeping')
    expect(early.result).toMatchObject({ expired: [], failed: [] })
    expect(s.txn.runtime.store.getApproval(item.id)?.state).toBe('pending')

    // 默认 7 天（14 §13.1）：推过去再跑一拍
    clock.advance(8 * DAY)
    const out = await s.schedule.scheduler.runNow('sched_approval_housekeeping')
    expect(out.ok).toBe(true)
    expect(out.result).toMatchObject({ expired: [item.id] })
    expect(s.txn.runtime.store.getApproval(item.id)?.state).toBe('expired')
    // 预占释放：那一天的额度不再被一条没人管的卡白占着
    expect(s.txn.runtime.store.countReserved(counter)).toBe(0)
    expect(s.txn.runtime.store.getChange(CHANGE_ID)?.status).toBe('expired')
  })

  it('超时会 escalated 到 scope_manager，再久一点到 owner；原 recipients 不撤', async () => {
    const clock = makeClock()
    const s = await start(clock)
    const item = (await s.txn.approvals.create(draft(s))) as ApprovalItem

    // 24 小时（policy 的 scope_manager 阈值）之前不升级
    clock.advance(2 * HOUR)
    await s.schedule.scheduler.runNow('sched_approval_housekeeping')
    expect(s.txn.runtime.store.getApproval(item.id)?.routing.escalation.escalated_at).toEqual([])

    clock.advance(25 * HOUR)
    const out = await s.schedule.scheduler.runNow('sched_approval_housekeeping')
    expect(out.result).toMatchObject({ escalated: [item.id] })
    const after = s.txn.runtime.store.getApproval(item.id) as ApprovalItem
    // 单人工作区：范围管理者退回 owner——宁可多通知一个人，也不要卡在无人可升
    expect(after.routing.escalation.escalated_at).toHaveLength(1)
    expect(after.routing.recipients.some((r) => r.person === s.bootstrap.person.id)).toBe(true)
    expect(after.state).toBe('pending')

    // 48 小时之后链条的第二层（owner）也走一遍
    clock.advance(24 * HOUR)
    await s.schedule.scheduler.runNow('sched_approval_housekeeping')
    expect(
      (s.txn.runtime.store.getApproval(item.id) as ApprovalItem).routing.escalation.escalated_at,
    ).toHaveLength(2)
  })

  it('已经过期的卡不再被升级去打扰下一层（先过期后升级的顺序）', async () => {
    const clock = makeClock()
    const s = await start(clock)
    const item = (await s.txn.approvals.create(draft(s))) as ApprovalItem
    clock.advance(8 * DAY)
    const out = await s.schedule.scheduler.runNow('sched_approval_housekeeping')
    expect(out.result).toMatchObject({ expired: [item.id], escalated: [] })
  })
})
