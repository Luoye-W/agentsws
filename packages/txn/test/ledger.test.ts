import type { ObjectRef, ProvenanceState } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { ChangeLedgerImpl } from '../src/index.js'
import { CUSTOMER, harness, ORDER, RUN, refundStage, T0, tokenOf, WS } from './helpers.js'

const VARIANT: ObjectRef = { type: 'variant', id: 'var_9' }
const THEME: ObjectRef = { type: 'theme', id: 'thm_1' }
const ADSET: ObjectRef = { type: 'ad_set', id: 'as_1' }

const prov = (refs: ObjectRef[]): ProvenanceState => {
  const seen: Record<string, string[]> = {}
  for (const r of refs) seen[r.type] = [...(seen[r.type] ?? []), r.id]
  return { run_id: RUN, seen, read_full: [], recorded_at: T0 }
}

const priceStage = (change_set_id: string, price: number, over = {}) =>
  refundStage({
    kind: 'price_change',
    target: VARIANT,
    field: 'price',
    change_set_id,
    before: { price: 100 },
    after: { price },
    money: undefined,
    record_version: undefined,
    provenance: prov([VARIANT]),
    mandate: { caps: { max_price_delta_pct: 20, max_cumulative_delta_pct_30d: 30 } },
    ...over,
  })

describe('15 §8 变更账本一致性用例', () => {
  it('用例 0：陌生人声称订单归自己 → 合法读到订单 → 要求补发新地址 → authorization_check block', async () => {
    const h = harness()
    const out = await h.txn.ledger.stage(
      refundStage({
        kind: 'reship',
        before: { financial_status: 'paid' },
        after: { items: 1, address: '99 Attacker St' },
        money: undefined,
        // 读过订单（provenance 命中），但请求者不是订单客户
        requester: {
          channel: 'email',
          external_id: 'stranger@evil.example',
          resolved: { type: 'customer', id: 'cus_999' },
        },
        target_owner: CUSTOMER,
      }),
    )
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.reason).toBe('authorization_check_failed')
    expect(h.typesOf('change.blocked')).toHaveLength(1)
    expect(h.txn.runtime.store.listChanges()).toHaveLength(0)
    // 没有请求者身份时同样 block（最严解释）
    const anon = await h.txn.ledger.stage(
      refundStage({ requester: undefined, target_owner: undefined }),
    )
    expect(anon.ok).toBe(false)
  })

  it('用例 1：账本对外只有 stage_* 与受控的 apply/withdraw/reverse，没有"直接改"的写方法（静态检查）', () => {
    const names = Object.getOwnPropertyNames(ChangeLedgerImpl.prototype).filter(
      (n) => n !== 'constructor' && !n.startsWith('#'),
    )
    expect(names.sort()).toEqual(
      ['cumulativePct', 'dedupeFor', 'get', 'list', 'reverse', 'stage', 'withdraw'].sort(),
    )
    expect(names.filter((n) => /^(update|set|write|save|patch|delete)/.test(n))).toEqual([])
  })

  it('用例 2：篡改 before 的 stage 请求被拒（before 必须来自 stage 时读到的记录）', async () => {
    const h = harness({
      records: {
        'order:ord_1042': {
          record_version: 'v1',
          record: { total: 89, refunded: 0, financial_status: 'paid' },
        },
      },
    })
    const out = await h.txn.ledger.stage(
      refundStage({ before: { total: 500, refunded: 0, financial_status: 'paid' } }),
    )
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.message).toContain('before_ungrounded')
  })

  it('用例 3：同一 change_set 内两次 price_change 同一 variant → 第二次 block', async () => {
    const h = harness()
    const first = await h.txn.ledger.stage(priceStage('cs_1', 85))
    expect(first.ok).toBe(true)
    const second = await h.txn.ledger.stage(priceStage('cs_1', 80))
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.message).toContain('no_repeat_target_field')
  })

  it('用例 4：两次运行各降价 20%（各自 allow）→ 第二次累计 40% > 30% → require_review', async () => {
    const h = harness()
    const a = await h.txn.ledger.stage(priceStage('cs_1', 80))
    expect(a.ok).toBe(true)
    if (!a.ok) return
    expect(a.change.guardrail.verdict).toBe('allow')
    const b = await h.txn.ledger.stage(priceStage('cs_2', 80, { run_id: 'run_6' }))
    expect(b.ok).toBe(true)
    if (!b.ok) return
    expect(b.change.guardrail.verdict).toBe('require_review')
    expect(b.change.guardrail.hits.map((x) => x.rule)).toContain('max_cumulative_delta_pct_30d')
  })

  it('用例 5：退款 $40 额度 $50 → L1 路由；L2 因 risk_class=medium 仍人审（31 §3.4）；低风险 kind L2 → auto', async () => {
    const h = harness()
    const l1 = await h.txn.ledger.stage(refundStage({ after: { refund_amount: 40 }, level: 'L1' }))
    expect(l1.ok && l1.approval.state).toBe('pending')
    const h2 = harness()
    const l2 = await h2.txn.ledger.stage(
      refundStage({ after: { refund_amount: 40 }, level: 'L2', change_set_id: 'cs_9' }),
    )
    expect(l2.ok && l2.change.risk_class).toBe('medium')
    expect(l2.ok && l2.approval.state).toBe('pending')
    const h3 = harness()
    const low = await h3.txn.ledger.stage(
      refundStage({
        kind: 'discount_code',
        target: { type: 'discount', id: 'disc_1' },
        before: { percent: 0 },
        after: { percent: 5 },
        money: undefined,
        record_version: undefined,
        provenance: prov([{ type: 'discount', id: 'disc_1' }]),
        mandate: { caps: { max_presales_discount_pct: 10 } },
        level: 'L2',
      }),
    )
    expect(low.ok && low.change.risk_class).toBe('low')
    expect(low.ok && low.approval.state).toBe('auto_approved')
  })

  it('用例 6：stage 后策略层把 max_auto_refund_amount 改成 30 → apply 时 policy_tightened', async () => {
    const h = harness({
      records: { 'order:ord_1042': { record_version: 'v1' } },
      mandateFor: () => ({ caps: { max_auto_refund_amount: 30 } }),
    })
    const staged = await h.txn.ledger.stage(refundStage())
    if (!staged.ok) throw new Error(staged.message)
    await h.txn.approvals.decide(staged.approval.id, 'p_wang', {
      decision_token: tokenOf(staged.approval),
      action: 'approve',
      via: 'workstation',
    })
    h.clock.advance(121_000)
    const out = await h.txn.executor.apply(staged.change.id)
    expect(out.error?.code).toBe('policy_tightened')
    expect(out.change.status).toBe('failed')
    expect(out.change.reservation?.released).toBe(true)
  })

  it('用例 7：stage 后订单已发货 → address_change apply 时 stale_record', async () => {
    const h = harness({
      records: {
        'order:ord_1042': { record_version: 'v1', record: { fulfillment: 'unfulfilled' } },
      },
    })
    const staged = await h.txn.ledger.stage(
      refundStage({
        kind: 'address_change',
        field: 'shipping_address',
        before: { fulfillment: 'unfulfilled' },
        after: { shipping_address: '12 New St' },
        money: undefined,
        mandate: { caps: { unfulfilled_only: true } },
      }),
    )
    if (!staged.ok) throw new Error(staged.message)
    expect(staged.change.record_version).toBe('v1')
    await h.txn.approvals.decide(staged.approval.id, 'p_wang', {
      decision_token: tokenOf(staged.approval),
      action: 'approve',
      via: 'workstation',
    })
    h.setRecord(ORDER, { record_version: 'v2', record: { fulfillment: 'fulfilled' } })
    h.clock.advance(121_000)
    const out = await h.txn.executor.apply(staged.change.id)
    expect(out.error?.code).toBe('stale_record')
    expect(h.backendCalls).toHaveLength(0)
  })

  it('用例 8：同 id apply 两次 → 第二次返回第一次结果，无二次退款', async () => {
    const h = harness({ records: { 'order:ord_1042': { record_version: 'v1' } } })
    const staged = await h.txn.ledger.stage(refundStage())
    if (!staged.ok) throw new Error(staged.message)
    await h.txn.approvals.decide(staged.approval.id, 'p_wang', {
      decision_token: tokenOf(staged.approval),
      action: 'approve',
      via: 'workstation',
    })
    h.clock.advance(121_000)
    const first = await h.txn.executor.apply(staged.change.id)
    const second = await h.txn.executor.apply(staged.change.id)
    expect(first.status).toBe('applied')
    expect(second.status).toBe('applied')
    expect(second.change.apply?.at).toBe(first.change.apply?.at)
    expect(h.backendCalls).toHaveLength(1)
    expect(h.backendCalls[0]?.key).toBe(staged.change.id)
  })

  it('用例 9：target 不在 provenance → stage block；篡改 seen 后 apply → 仍 block', async () => {
    const h = harness({ records: { 'order:ord_1042': { record_version: 'v1' } } })
    const blocked = await h.txn.ledger.stage(refundStage({ provenance: prov([CUSTOMER]) }))
    expect(blocked.ok).toBe(false)
    if (!blocked.ok) expect(blocked.message).toContain('provenance_missing')

    const staged = await h.txn.ledger.stage(refundStage())
    if (!staged.ok) throw new Error(staged.message)
    await h.txn.approvals.decide(staged.approval.id, 'p_wang', {
      decision_token: tokenOf(staged.approval),
      action: 'approve',
      via: 'workstation',
    })
    // 审批项 / provenance 被篡改：apply 时重查
    h.txn.runtime.store.putProvenance(prov([CUSTOMER]))
    h.clock.advance(121_000)
    const out = await h.txn.executor.apply(staged.change.id)
    expect(out.status).toBe('failed')
    expect(out.error?.message).toContain('provenance_missing')
    expect(h.backendCalls).toHaveLength(0)
  })

  it('用例 10：publish_theme 无论等级多高都 L1（hard_ceiling）', async () => {
    const h = harness()
    const out = await h.txn.ledger.stage(
      refundStage({
        kind: 'publish_theme',
        target: THEME,
        before: { published: false },
        after: { published: true },
        money: undefined,
        record_version: undefined,
        provenance: prov([THEME]),
        mandate: { caps: {} },
        level: 'L3',
      }),
    )
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.change.risk_class).toBe('high')
    expect(out.change.guardrail.hits.map((x) => x.rule)).toContain('hard_ceiling')
    expect(out.approval.state).toBe('pending')
  })

  it('用例 11：多币种 EUR 退款换算基准 USD 后与 cap 比较，fx 快照记录', async () => {
    const h = harness()
    const money = {
      amount: 45,
      currency: 'EUR',
      amount_base: 49.5,
      base_currency: 'USD',
      fx_rate: 1.1,
      fx_at: T0,
    }
    const ok = await h.txn.ledger.stage(refundStage({ after: { refund_amount: 45 }, money }))
    expect(ok.ok && ok.change.guardrail.verdict).toBe('allow')
    expect(ok.ok && ok.change.money?.fx_rate).toBe(1.1)

    const h2 = harness()
    const over = await h2.txn.ledger.stage(
      refundStage({
        after: { refund_amount: 45 },
        money: { ...money, amount_base: 54, fx_rate: 1.2 },
      }),
    )
    expect(over.ok && over.change.guardrail.verdict).toBe('require_review')
  })

  it('用例 12：pause_ad 在 L3 下仍建审批记录（auto_approved，不进人的待办）并 apply，留 StagedChange 与事件', async () => {
    const h = harness()
    const out = await h.txn.ledger.stage(
      refundStage({
        kind: 'pause_ad',
        target: ADSET,
        before: { status: 'active' },
        after: { status: 'paused' },
        money: undefined,
        record_version: undefined,
        provenance: prov([ADSET]),
        mandate: { caps: {} },
        level: 'L3',
      }),
    )
    if (!out.ok) throw new Error(out.message)
    expect(out.approval.state).toBe('auto_approved')
    const queue = await h.txn.approvals.queue({
      workspace_id: WS,
      person_id: 'p_wang',
      lane: 'mine',
    })
    expect(queue).toHaveLength(0)
    h.clock.advance(121_000)
    const applied = await h.txn.executor.apply(out.change.id)
    expect(applied.status).toBe('applied')
    expect(h.typesOf('change.')).toEqual(
      expect.arrayContaining([
        'change.staged',
        'change.approved',
        'change.applying',
        'change.applied',
      ]),
    )
    expect((await h.txn.approvals.get(out.approval.id))?.state).toBe('applied')
  })

  it('用例 13：合成 provider 注入 429 → 同 key 重试后 failed{retryable}，审批项 apply_failed', async () => {
    const h = harness({
      records: { 'order:ord_1042': { record_version: 'v1' } },
      backend: () => ({
        status: 'failed',
        error: { message: '429 rate limited', retryable: true },
      }),
    })
    const staged = await h.txn.ledger.stage(refundStage())
    if (!staged.ok) throw new Error(staged.message)
    await h.txn.approvals.decide(staged.approval.id, 'p_wang', {
      decision_token: tokenOf(staged.approval),
      action: 'approve',
      via: 'workstation',
    })
    h.clock.advance(121_000)
    const out = await h.txn.executor.apply(staged.change.id)
    expect(out.status).toBe('failed')
    expect(out.error?.retryable).toBe(true)
    expect(h.backendCalls).toHaveLength(4) // 1 次 + 重试 ≤ 3
    expect(new Set(h.backendCalls.map((c) => c.key)).size).toBe(1)
    const item = await h.txn.approvals.get(staged.approval.id)
    expect(item?.state).toBe('apply_failed')
    expect(item?.apply?.attempts).toHaveLength(4)
    expect(out.change.reservation?.released).toBe(true)
  })
})

describe('账本其他行为（15 §1 §4 §5）', () => {
  it('未建模的 kind（staged_action v1 关闭）直接拒', async () => {
    const h = harness()
    await expect(
      h.txn.ledger.stage(refundStage({ kind: 'staged_action' as never })),
    ).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('未批准的变更 apply → failed{not_approved}', async () => {
    const h = harness()
    const staged = await h.txn.ledger.stage(refundStage())
    if (!staged.ok) throw new Error(staged.message)
    const out = await h.txn.executor.apply(staged.change.id)
    expect(out.error?.code).toBe('not_approved')
  })

  it('审批项撤回 → 变更 withdrawn 且释放预占', async () => {
    const h = harness()
    const staged = await h.txn.ledger.stage(refundStage())
    if (!staged.ok) throw new Error(staged.message)
    await h.txn.approvals.withdraw(staged.approval.id, 'agent_aftersales')
    const change = await h.txn.ledger.get(staged.change.id)
    expect(change?.status).toBe('withdrawn')
    expect(change?.reservation?.released).toBe(true)
    expect(h.txn.runtime.store.countReserved(change?.reservation?.counter ?? '')).toBe(0)
  })

  it('不可逆 kind 不给反向；可逆 kind applied 后可反向', async () => {
    const h = harness({ records: { 'order:ord_1042': { record_version: 'v1' } } })
    const refund = await h.txn.ledger.stage(refundStage())
    if (!refund.ok) throw new Error(refund.message)
    await expect(h.txn.ledger.reverse(refund.change.id, 'p_wang')).rejects.toMatchObject({
      code: 'conflict',
    })

    const price = await h.txn.ledger.stage(priceStage('cs_rev', 90))
    if (!price.ok) throw new Error(price.message)
    await h.txn.approvals.decide(price.approval.id, 'p_wang', {
      decision_token: tokenOf(price.approval),
      action: 'approve',
      via: 'workstation',
    })
    h.clock.advance(121_000)
    await h.txn.executor.apply(price.change.id)
    const reversal = await h.txn.ledger.reverse(price.change.id, 'p_wang')
    expect(reversal.reversal_of).toBe(price.change.id)
    expect(reversal.before).toEqual({ price: 90 })
    expect((await h.txn.ledger.get(price.change.id))?.status).toBe('reversed')
  })
})
