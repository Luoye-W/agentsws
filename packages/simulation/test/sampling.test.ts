/**
 * 抽检复核（14 §13.2）与升级链（14 §7）在 tick 循环里的行为。
 *
 * 场景 `ops/sampling` 钉的是"售后这套职责里再高的采纳率也换不来一次自动执行"
 * （31 §3.4，`refund` 是 medium 风险）。这里钉的是**另一半**：真的出现一条低风险、
 * 额度内、L2 的变更时，抽检到底有没有把它抽出来给人复核。
 *
 * 低风险的写动作（`discount_code`）不在 `dtc.aftersales` 的动作表里，运行时也不会提，
 * 所以这里由测试**当宿主**直接调账本 stage 一条——这正是宿主该做的事（15 §5）。
 */
import { describe, expect, it } from 'vitest'
import { createWorld } from '../src/world.js'
import { pack } from './helpers.js'

const START = '2026-09-07T09:00:00+08:00'

async function worldWith(samplingRate: number) {
  return createWorld({
    pack: pack(),
    seed: 42,
    start: new Date(Date.parse(START)).toISOString(),
    txnPolicy: { sampling_rate: samplingRate },
  })
}

/** 一条低风险、额度内的折扣码变更；宿主直接下单，模拟"某个职责真有这个动作"。 */
async function stageLowRisk(world: Awaited<ReturnType<typeof worldWith>>) {
  return world.txn.ledger.stage({
    workspace_id: world.workspace_id,
    role_id: world.role_id,
    assignment_id: world.assignment.id,
    run_id: 'run_sampling_0001',
    change_set_id: 'cs_sampling_0001',
    kind: 'discount_code',
    target: { type: 'discount', id: 'disc_welcome10' },
    before: null,
    after: { code: 'WELCOME10', percentage: 10 },
    notes: ['低风险变更：折扣码 10%'],
    created_by: { kind: 'agent', id: 'agent_aftersales' },
    mandate: { caps: { max_promotion_discount_pct: 50 }, window: { max_count: 20, per: 'day' } },
    // 05 §1.4：只有 low 风险的动作才可能超过 L1
    level: 'L2',
    provenance: {
      run_id: 'run_sampling_0001',
      // 15 §6：改一个对象前必须证明读过它
      seen: { discount: ['disc_welcome10'] },
      read_full: ['discount:disc_welcome10'],
      recorded_at: START,
    },
    requester: { channel: 'email', external_id: 'anna@example.com' },
    connection_id: 'conn_shopify_admin',
    approval: {
      title: '折扣码 WELCOME10（10%）',
      summary: '额度内的低风险变更',
      recipients: [{ person: world.owner, via: 'scope_manager' }],
      proposer: { kind: 'agent', id: 'agent_aftersales', assignment_id: world.assignment.id },
      rule: 'scope_manager',
      separation_of_duties: false,
    },
  })
}

describe('抽检（14 §13.2）', () => {
  it('抽检比例 1：额度内的 L2 低风险变更自动批，并被抽出一张复核卡给范围管理者', async () => {
    const world = await worldWith(1)
    try {
      const outcome = await stageLowRisk(world)
      expect(outcome.ok).toBe(true)
      if (!outcome.ok) return
      // 15 §2 + 14 §13.2：low 风险 + 额度内 + L2 → auto_approved，且被抽中
      expect(outcome.approval.state).toBe('auto_approved')
      expect(outcome.approval.automation.auto_approved).toBe(true)
      expect(outcome.approval.automation.sampling.selected).toBe(true)

      // 抽中只是"打了个标记"；把它送到复核人手上是宿主每一拍要做的事
      expect(world.samplingReviews).toHaveLength(0)
      const tick = await world.tickApprovals()
      expect(tick.sampled).toBe(1)

      const review = world.samplingReviews[0]
      expect(review?.item_id).toBe(outcome.approval.id)
      expect(review?.to).toBe(world.scopeManager)
      expect(review?.rate).toBe(1)

      // 事件、卡片、通知三样都在（26 §6.4：每个数都能追溯到事件查询）
      expect(world.events.some((e) => e.type === 'approval.sampled')).toBe(true)
      const emitted = world.events.filter((e) => e.type === 'simulation.sampling_review')
      expect(emitted).toHaveLength(1)
      expect(world.notifications.some((n) => n.to === world.scopeManager)).toBe(true)
      expect(
        world.standIns.deliveries.workstation
          .all()
          .some((d) => d.item.id === `smp_${outcome.approval.id}`),
      ).toBe(true)

      // 同一条不会被抽第二次
      const again = await world.tickApprovals()
      expect(again.sampled).toBe(0)
      expect(world.samplingReviews).toHaveLength(1)
    } finally {
      await world.close()
    }
  })

  it('抽检比例 0：照样自动批，但一条复核卡都不出', async () => {
    const world = await worldWith(0)
    try {
      const outcome = await stageLowRisk(world)
      expect(outcome.ok).toBe(true)
      if (!outcome.ok) return
      expect(outcome.approval.state).toBe('auto_approved')
      expect(outcome.approval.automation.sampling.selected).toBe(false)
      const tick = await world.tickApprovals()
      expect(tick.sampled).toBe(0)
      expect(world.samplingReviews).toHaveLength(0)
    } finally {
      await world.close()
    }
  })
})
