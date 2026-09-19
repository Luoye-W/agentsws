/*
 * WP117b（66 复测 #19 的根因修复）：**两本审批账合成一本的读与写。**
 *
 * demo 里世界的卡（演示数据）与服务进程 stage 的卡（红人开发信 / 议价）各住
 * 一本账。以前网关只读世界那一本，服务进程 stage 的卡永远进不了队列——没人
 * 能批，主线自然走不通。这里钉住合成总线的三条纪律：
 *
 * 1. **读合并**：get / queue 两本都看，去重后按队列同样的次序排；
 * 2. **写各回各家**：决定落到卡片住在的那一本，另一本毫发无动；
 * 3. **谁都不认识就照实炸**：不编造一个"存在"。
 */
import type { ApprovalItem, CreateApprovalInput, EventEnvelope } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { createTxn, type Txn } from '@agentsws/txn'
import { compositeApprovals } from '../src/approvals-composite.js'

const T0 = '2026-09-19T09:00:00.000Z'

function makeClock(start = T0) {
  let t = Date.parse(start)
  return { now: () => new Date(t).toISOString(), advance: (ms: number) => (t += ms) }
}

function seeded(seed = 7): () => number {
  let a = seed >>> 0
  return () => {
    a = (a * 1664525 + 1013904223) >>> 0
    return a / 0x100000000
  }
}

/** 一本独立的账（与另一本互不相通，连 id 序列都各是各的），两本才有“合成”可言。 */
function ledger(seed = 7): { txn: Txn; events: EventEnvelope[] } {
  const events: EventEnvelope[] = []
  const clock = makeClock()
  const txn = createTxn({
    clock: { now: clock.now },
    random: seeded(seed),
    eventSink: (e) => events.push(e),
    readRecord: () => ({}),
    backendApply: () => ({ status: 'ok', execution_id: 'exec_1' }),
    deliverOutbound: () => ({ status: 'ok', execution_id: 'exec_1' }),
  })
  return { txn, events }
}

const tokenOf = (item: ApprovalItem, person = 'p_wang'): string => {
  const d = item.deliveries.find((x) => x.to === person)
  if (d === undefined) throw new Error(`没有给 ${person} 的 decision_token`)
  return d.decision_token
}

/** 一张最小的待审卡（policy_change：无写类门禁，reject 就够验证路由）。 */
function cardInput(over: Partial<CreateApprovalInput<Record<string, unknown>>> = {}) {
  const base: CreateApprovalInput<Record<string, unknown>> = {
    workspace_id: 'ws_1',
    schema_version: 1,
    kind: 'policy_change',
    role_id: 'dtc.support',
    subject: { object: { type: 'policy', id: 'pol_1' } },
    dedupe_key: `dk_${Math.random().toString(36).slice(2)}`,
    title: '一张测试卡',
    payload: {},
    evidence: { source_events: [], provenance: { seen: [] }, precheck: {} },
    proposer: { kind: 'agent', id: 'agent_test', assignment_id: 'asg_1' },
    automation: {
      level_at_creation: 'L1',
      auto_approved: false,
      mandate_check: { within: true, caps_hit: [] },
      sampling: { selected: false },
    },
    routing: {
      recipients: [{ person: 'p_wang', via: 'role_holder' }],
      rule: 'role_holder',
      escalation: {
        after_hours: 24,
        business_hours: true,
        chain: ['scope_manager', 'owner'],
        escalated_at: [],
      },
      separation_of_duties: false,
    },
    priority: 'queue',
  }
  return { ...base, ...over } as CreateApprovalInput<Record<string, unknown>>
}

describe('两本审批账合成一本（WP117b）', () => {
  it('读合并：get / queue 两本都看得到，一张不丢', async () => {
    const world = ledger(7).txn
    const server = ledger(11).txn
    const a = await world.approvals.create(cardInput({ title: '世界的卡' }))
    const b = await server.approvals.create(cardInput({ title: '服务进程的卡' }))
    const bus = compositeApprovals(world.approvals, server.approvals)

    expect((await bus.get(a.id))?.title).toBe('世界的卡')
    expect((await bus.get(b.id))?.title).toBe('服务进程的卡')
    const queue = await bus.queue({ workspace_id: 'ws_1', person_id: 'p_wang', lane: 'mine' })
    expect(queue.map((i) => i.id).sort()).toEqual([a.id, b.id].sort())
  })

  it('写各回各家：决定落到卡片住在的那一本，另一本不动', async () => {
    const world = ledger(7).txn
    const server = ledger(11).txn
    const worldCard = await world.approvals.create(cardInput({ title: '世界的卡' }))
    const serverCard = await server.approvals.create(cardInput({ title: '服务进程的卡' }))
    const bus = compositeApprovals(world.approvals, server.approvals)

    // 世界的卡：驳回了，改动落在世界那一本；服务进程那张照旧 pending
    const rejected = await bus.decide(worldCard.id, 'p_wang', {
      decision_token: tokenOf(worldCard),
      action: 'reject',
      reason: '不必发了',
    })
    expect(rejected.state).toBe('rejected')
    expect((await world.approvals.get(worldCard.id))?.state).toBe('rejected')
    expect((await server.approvals.get(serverCard.id))?.state).toBe('pending')

    // 服务进程的卡：同一本合成总线，决定落回服务进程那一本
    const out = await bus.decide(serverCard.id, 'p_wang', {
      decision_token: tokenOf(serverCard),
      action: 'reject',
      reason: '下一拍再说',
    })
    expect(out.state).toBe('rejected')
    expect((await server.approvals.get(serverCard.id))?.state).toBe('rejected')
  })

  it('两本账里都没有的卡，get 回 undefined，决定照实炸', async () => {
    const bus = compositeApprovals(ledger(7).txn.approvals, ledger(11).txn.approvals)
    expect(await bus.get('apr_nope')).toBeUndefined()
    await expect(
      bus.decide('apr_nope', 'p_wang', { decision_token: 't', action: 'approve' }),
    ).rejects.toThrow()
  })
})
