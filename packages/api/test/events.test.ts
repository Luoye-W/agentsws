/**
 * WP33 A：`/v1/events` 按岗位可读（docs/35 §4 WP24 遗留的「非 owner 403」）+ since / until 时间范围。
 */
import type { EventEnvelope } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { approvalItem, harness, T0 } from './helpers.js'

const data = async <T>(res: Response): Promise<T> => ((await res.json()) as { data: T }).data

interface Page {
  events: EventEnvelope[]
  next_since: string | null
  has_more: boolean
  scope: 'workspace' | 'assignment'
}

/** 往假事件日志里塞一条；`at` 显式给，时间范围过滤要靠它。 */
function seed(
  h: Awaited<ReturnType<typeof harness>>,
  over: Partial<EventEnvelope> & { type: string; at: string },
): EventEnvelope {
  return h.eventLog.append({
    schema_version: 1,
    workspace_id: h.workspace_id,
    actor: { kind: 'system', id: 'sys' },
    correlation: { trace_id: 'tr_seed' },
    payload: {},
    ...over,
  } as Omit<EventEnvelope, 'id'>)
}

describe('21 §1 事件流按岗位可读', () => {
  it('有 workspace 级读权限的（owner 一档）看全部，scope = workspace', async () => {
    const h = await harness()
    seed(h, { type: 'run.started', at: T0, actor: { kind: 'agent', id: 'agent_x' } })
    seed(h, { type: 'model.usage', at: T0, actor: { kind: 'system', id: 'sys' } })
    const page = await data<Page>(await h.get('/v1/events'))
    expect(page.scope).toBe('workspace')
    expect(page.events).toHaveLength(2)
  })

  it('只有 own 级的岗位不再 403：拿到的是与本岗位相关的那些', async () => {
    const h = await harness()
    // 与本人无关的一条（别人做的、别人的卡）
    seed(h, { type: 'model.usage', at: T0, actor: { kind: 'system', id: 'sys' } })
    // 本人做的一条
    const mine = seed(h, {
      type: 'approval.claimed',
      at: T0,
      actor: { kind: 'person', id: h.person_id },
    })
    // 本人是收件人的那张卡上的一条（actor 是 agent，靠 subject 认出来）
    const onMyCard = seed(h, {
      type: 'approval.created',
      at: T0,
      actor: { kind: 'agent', id: 'agent_x' },
      subject: { type: 'approval_item', id: h.item.id },
    })
    // 本岗位 staged 的那条变更上的一条
    const onMyChange = seed(h, {
      type: 'change.staged',
      at: T0,
      actor: { kind: 'agent', id: 'agent_x' },
      subject: { type: 'staged_change', id: 'chg_member' },
    })
    // 别的岗位 staged 的那条不算
    seed(h, {
      type: 'change.staged',
      at: T0,
      actor: { kind: 'agent', id: 'agent_x' },
      subject: { type: 'staged_change', id: 'chg_1' },
    })
    const res = await h.get('/v1/events', { assignment: h.memberAssignment.id })
    expect(res.status).toBe(200)
    const page = await data<Page>(res)
    expect(page.scope).toBe('assignment')
    expect(page.events.map((e) => e.id).sort()).toEqual(
      [mine.id, onMyCard.id, onMyChange.id].sort(),
    )
  })

  it('同一次运行的其余事件跟着可见（一条运行不该被切碎）', async () => {
    const h = await harness()
    seed(h, {
      type: 'proposal.created',
      at: T0,
      actor: { kind: 'agent', id: 'agent_x' },
      subject: { type: 'approval_item', id: h.item.id },
      correlation: { trace_id: 'tr', run_id: 'run_visible' },
    })
    const delta = seed(h, {
      type: 'text.delta',
      at: T0,
      actor: { kind: 'agent', id: 'agent_x', run_id: 'run_visible' },
      correlation: { trace_id: 'tr', run_id: 'run_visible' },
    })
    // 别的运行照样看不见
    seed(h, {
      type: 'text.delta',
      at: T0,
      actor: { kind: 'agent', id: 'agent_x', run_id: 'run_other' },
      correlation: { trace_id: 'tr', run_id: 'run_other' },
    })
    const page = await data<Page>(await h.get('/v1/events', { assignment: h.memberAssignment.id }))
    const ids = page.events.map((e) => e.id)
    expect(ids).toContain(delta.id)
    expect(page.events.every((e) => e.correlation.run_id !== 'run_other')).toBe(true)
  })

  it('别的工作区的卡不让本岗位看见（跨工作区不泄漏）', async () => {
    const h = await harness()
    h.approvals.seed({ ...approvalItem({ id: 'ap_foreign' }), workspace_id: 'ws_elsewhere' })
    seed(h, {
      type: 'approval.created',
      at: T0,
      actor: { kind: 'agent', id: 'agent_x' },
      subject: { type: 'approval_item', id: 'ap_foreign' },
    })
    const page = await data<Page>(await h.get('/v1/events', { assignment: h.memberAssignment.id }))
    expect(page.events).toHaveLength(0)
  })

  it('续传游标用过滤前最后一条：被过滤掉的不会被反复重读', async () => {
    const h = await harness()
    seed(h, { type: 'model.usage', at: T0, actor: { kind: 'system', id: 'sys' } })
    const last = seed(h, { type: 'model.usage', at: T0, actor: { kind: 'system', id: 'sys' } })
    const page = await data<Page>(await h.get('/v1/events', { assignment: h.memberAssignment.id }))
    expect(page.events).toHaveLength(0)
    expect(page.next_since).toBe(last.id)
    // 拿这个游标再拉一次：空，不是又把那两条扫一遍
    const again = await data<Page>(
      await h.get(`/v1/events?since=${page.next_since}`, { assignment: h.memberAssignment.id }),
    )
    expect(again.events).toHaveLength(0)
  })
})

describe('21 §1 时间范围（since / until）', () => {
  it('since 是 ISO 时间时当下界；until 是闭区间上界', async () => {
    const h = await harness()
    seed(h, { type: 'run.started', at: '2026-09-05T00:00:00.000Z' })
    const mid = seed(h, { type: 'run.started', at: '2026-09-07T00:00:00.000Z' })
    seed(h, { type: 'run.started', at: '2026-09-09T00:00:00.000Z' })

    const from = await data<Page>(await h.get('/v1/events?since=2026-09-06T00:00:00.000Z'))
    expect(from.events).toHaveLength(2)

    const window = await data<Page>(
      await h.get('/v1/events?since=2026-09-06T00:00:00.000Z&until=2026-09-08T00:00:00.000Z'),
    )
    expect(window.events.map((e) => e.id)).toEqual([mid.id])
  })

  it('until 不是时间 → 400', async () => {
    const h = await harness()
    expect((await h.get('/v1/events?until=tomorrow')).status).toBe(400)
  })

  it('since 仍然可以是续传游标（ulid 形状 / 实现自己的 id 形状）', async () => {
    const h = await harness()
    const first = seed(h, { type: 'run.started', at: T0 })
    const second = seed(h, { type: 'run.completed', at: T0 })
    const page = await data<Page>(await h.get(`/v1/events?since=${first.id}`))
    expect(page.events.map((e) => e.id)).toEqual([second.id])
  })
})
