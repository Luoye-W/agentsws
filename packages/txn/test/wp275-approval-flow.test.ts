/**
 * WP275（docs/95 §5，决策 222）：审批总线按「有没有审批流」走（`Directory.approvalFlow`）。
 *
 * - ① 个人 / ② 同事互联（`false`）：职责分离不拦（标 self_approved）；没人管到点只提醒本人、
 *   一个人都不加；超了上限的改动卡要收件人再确认一次（`reconfirm`）。
 * - ③ 公司集体（`true`）：职责分离照拦（不再看人数）、升级照链走、不标再确认。
 * - 硬闸三种模式都关不掉：`HARD_L1` 的改动 L3 也永远出卡，`approvalFlow` 不碰它。
 */
import { describe, expect, it } from 'vitest'
import { harness, outboundInput, refundStage, tokenOf } from './helpers.js'

const flow = (on: boolean) => ({ approvalFlow: () => on })

describe('WP275 职责分离按模式', () => {
  it('① ②：提的人自己点 → 过，事件标 self_approved（人数再多也不看）', async () => {
    const h = harness({ directory: { ...flow(false), memberCount: () => 5 } })
    const item = await h.txn.approvals.create(
      outboundInput({ proposer: { kind: 'person', id: 'p_wang' } }),
    )
    const out = await h.txn.approvals.decide(item.id, 'p_wang', {
      decision_token: tokenOf(item),
      action: 'approve',
      via: 'workstation',
    })
    expect(out.state).toBe('approved')
    const ev = h.events.find((e) => e.type === 'approval.decided')
    expect((ev?.payload as { self_approved?: boolean }).self_approved).toBe(true)
  })

  it('③：照拦，哪怕只有一个人（模式说了算，不是人数）', async () => {
    const h = harness({ directory: { approvalFlow: async () => true, memberCount: () => 1 } })
    const item = await h.txn.approvals.create(
      outboundInput({ proposer: { kind: 'person', id: 'p_wang' } }),
    )
    await expect(
      h.txn.approvals.decide(item.id, 'p_wang', {
        decision_token: tokenOf(item),
        action: 'approve',
        via: 'workstation',
      }),
    ).rejects.toMatchObject({ code: 'sod_violation' })
  })
})

describe('WP275 没人管的卡按模式', () => {
  const directory = { scopeManager: () => 'p_manager', owner: () => 'p_owner' }

  it('① ②：24 / 48 工作小时只提醒本人——不加人、不升级、每一级只提醒一次', async () => {
    const h = harness({
      policy: { business_tz_offset_minutes: 0 },
      directory: { ...directory, ...flow(false) },
    })
    await h.txn.approvals.create(outboundInput({ expires_at: '2026-10-01T00:00:00.000Z' }))
    h.clock.set('2026-09-08T12:00:00.000Z') // 12 工作小时
    expect(await h.txn.approvals.escalate()).toHaveLength(0)
    h.clock.set('2026-09-09T15:00:00.000Z') // 24 工作小时
    const [first] = await h.txn.approvals.escalate()
    expect(first?.routing.recipients.map((r) => r.person)).toEqual(['p_wang'])
    expect(first?.deliveries.filter((d) => d.status === 'sent').map((d) => d.to)).toEqual([
      'p_wang',
      'p_wang',
    ])
    expect(first?.routing.escalation.trail ?? []).toEqual([])
    // 同一拍再跑一遍：不重复提醒
    expect(await h.txn.approvals.escalate()).toHaveLength(0)
    h.clock.set('2026-09-14T12:00:00.000Z') // 48 工作小时
    const [second] = await h.txn.approvals.escalate()
    expect(second?.routing.recipients.map((r) => r.person)).toEqual(['p_wang'])
    expect(second?.routing.escalation.escalated_at).toHaveLength(2)
    expect(h.typesOf('approval.escalated')).toHaveLength(0)
    expect(h.typesOf('approval.reminded')).toHaveLength(2)
  })

  it('③：照旧升到主管、再到老板', async () => {
    const h = harness({
      policy: { business_tz_offset_minutes: 0 },
      directory: { ...directory, ...flow(true) },
    })
    await h.txn.approvals.create(outboundInput({ expires_at: '2026-10-01T00:00:00.000Z' }))
    h.clock.set('2026-09-14T12:00:00.000Z')
    const [out] = await h.txn.approvals.escalate()
    expect(out?.routing.recipients.map((r) => r.person)).toEqual(['p_wang', 'p_manager', 'p_owner'])
    expect(h.typesOf('approval.reminded')).toHaveLength(0)
  })
})

describe('WP275 超了上限：① ② 再确认一次', () => {
  // 退款 $80，超了自动退款上限 $50 → 护栏判「要人看」（额度核对没过）
  const over = () =>
    refundStage({
      after: { refund_amount: 80 },
      money: {
        amount: 80,
        currency: 'USD',
        amount_base: 80,
        base_currency: 'USD',
        fx_rate: 1,
        fx_at: '2026-09-07T09:00:00.000Z',
      },
    })

  it('① ②：收件人标 reconfirm，卡上一句「超了你设的上限」，不写「转给」', async () => {
    const h = harness({ directory: flow(false) })
    const out = await h.txn.ledger.stage(over())
    if (!out.ok) throw new Error(out.message)
    expect(out.approval.automation.mandate_check.within).toBe(false)
    expect(out.approval.routing.recipients).toEqual([
      {
        person: 'p_wang',
        via: 'role_holder',
        reconfirm: true,
        reason: '超了你设的上限，要你再确认一次',
      },
    ])
  })

  it('① ②：没超上限的照常——一下就过，不标', async () => {
    const h = harness({ directory: flow(false) })
    const out = await h.txn.ledger.stage(refundStage())
    if (!out.ok) throw new Error(out.message)
    expect(out.approval.routing.recipients[0]?.reconfirm).toBeUndefined()
  })

  it('③：不标（超了就按规矩转人，那是路由的事）', async () => {
    const h = harness({ directory: flow(true) })
    const out = await h.txn.ledger.stage(over())
    if (!out.ok) throw new Error(out.message)
    expect(out.approval.routing.recipients[0]?.reconfirm).toBeUndefined()
  })
})

describe('WP275 硬闸三种模式都关不掉', () => {
  it('群发（HARD_L1）在 ① 里提成 L3 也永远出卡等人点', async () => {
    for (const on of [false, true]) {
      const h = harness({ directory: flow(on) })
      const out = await h.txn.ledger.stage(
        refundStage({
          kind: 'campaign_send',
          level: 'L3',
          target: { type: 'campaign', id: 'cmp_1' },
          before: {},
          after: { audience: 1200 },
        }),
      )
      if (!out.ok) {
        // 硬顶直接拦下也算「关不掉」
        expect(out.reason).toBe('guardrail')
        continue
      }
      expect(out.approval.automation.auto_approved).toBe(false)
      expect(out.approval.state).toBe('pending')
    }
  })
})
