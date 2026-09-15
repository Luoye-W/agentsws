import type { Mandate } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  authorizationCheck,
  evaluateGuardrail,
  executionSnapshot,
  Provenance,
  resolveMandate,
  snapshotMatches,
  TARGET_SCOPED_KINDS,
} from '../src/index.js'

const now = '2026-09-08T09:00:00Z'
const refundMandate: Mandate = {
  caps: { max_auto_refund_amount: 50, within_policy_window_only: true, return_window_days: 14 },
  per_change_limits: { max_items: 1, no_repeat_target_field: true },
  window: { max_count: 20, per: 'day' },
}
const order = { type: 'order', id: 'ord_1042' } as const
const prov = (full = false) => {
  const p = new Provenance('run_1')
  p.see([order], { full })
  return p
}
const facts = (over: Partial<Parameters<typeof evaluateGuardrail>[2]> = {}) => ({
  now,
  changeSet: [],
  windowCount: 0,
  provenance: prov(),
  ...over,
})
const refund = (amount: number, deliveredDaysAgo = 6) => ({
  kind: 'refund' as const,
  target: order,
  before: {
    total: 89,
    refunded: 0,
    delivered_at: new Date(Date.parse(now) - deliveredDaysAgo * 86_400_000).toISOString(),
  },
  after: { refund_amount: amount },
  amount_base: amount,
})

describe('guardrail (15 §3)', () => {
  it('within caps → allow', () => {
    expect(evaluateGuardrail(refund(42), refundMandate, facts(), 'stage').verdict).toBe('allow')
  })
  it('over soft cap → require_review, not block (用例 5)', () => {
    const r = evaluateGuardrail(refund(60), refundMandate, facts(), 'stage')
    expect(r.verdict).toBe('require_review')
    expect(r.hits[0]?.rule).toBe('max_auto_refund_amount')
  })
  it('approved exception at apply keeps soft cap from failing (I15 修正)', () => {
    const r = evaluateGuardrail(
      refund(60),
      refundMandate,
      facts({ approvedException: true }),
      'apply',
    )
    expect(r.verdict).toBe('allow')
    expect(r.approved_exception).toBe(true)
  })
  it('outside return window → block (state condition)', () => {
    expect(evaluateGuardrail(refund(10, 30), refundMandate, facts(), 'stage').verdict).toBe('block')
  })
  it('exceeds paid → block', () => {
    expect(
      evaluateGuardrail(refund(100), refundMandate, facts(), 'stage').hits.map((h) => h.rule),
    ).toContain('refund_exceeds_paid')
  })
  it('repeat (target, field) in change set → block (用例 3)', () => {
    const r = evaluateGuardrail(
      refund(10),
      refundMandate,
      facts({ changeSet: [{ kind: 'refund', target: order }] }),
      'stage',
    )
    expect(r.hits.map((h) => h.rule)).toContain('no_repeat_target_field')
    expect(r.verdict).toBe('block')
  })
  it('window exceeded → review', () => {
    expect(
      evaluateGuardrail(refund(10), refundMandate, facts({ windowCount: 20 }), 'stage').hits.map(
        (h) => h.rule,
      ),
    ).toContain('window')
  })
  it('target not in provenance → block (用例 9)', () => {
    expect(
      evaluateGuardrail(
        refund(10),
        refundMandate,
        facts({ provenance: new Provenance('run_x') }),
        'stage',
      ).hits.map((h) => h.rule),
    ).toContain('provenance_missing')
  })
  it('price: per-change and cumulative caps (用例 4)', () => {
    const m: Mandate = { caps: { max_price_delta_pct: 20, max_cumulative_delta_pct_30d: 30 } }
    const p = new Provenance('r')
    p.see([{ type: 'variant', id: 'v1' }])
    const c = {
      kind: 'price_change' as const,
      target: { type: 'variant', id: 'v1' },
      field: 'price',
      before: { price: 100 },
      after: { price: 80 },
    }
    expect(
      evaluateGuardrail(c, m, { now, changeSet: [], windowCount: 0, provenance: p }, 'stage')
        .verdict,
    ).toBe('allow')
    expect(
      evaluateGuardrail(
        c,
        m,
        { now, changeSet: [], windowCount: 0, provenance: p, cumulativePct: 20 },
        'stage',
      ).hits.map((h) => h.rule),
    ).toContain('max_cumulative_delta_pct_30d')
    expect(
      evaluateGuardrail(
        { ...c, field: 'currency' },
        m,
        { now, changeSet: [], windowCount: 0, provenance: p },
        'stage',
      ).verdict,
    ).toBe('block')
  })
  it('hard L1 kinds always require review (用例 10)', () => {
    const p = new Provenance('r')
    p.see([{ type: 'theme', id: 't1' }])
    expect(
      evaluateGuardrail(
        { kind: 'publish_theme', target: { type: 'theme', id: 't1' }, before: {}, after: {} },
        { caps: {} },
        { now, changeSet: [], windowCount: 0, provenance: p },
        'stage',
      ).hits[0]?.rule,
    ).toBe('hard_ceiling')
  })
  it('listing edit requires full record read', () => {
    const c = {
      kind: 'listing_edit' as const,
      target: { type: 'product', id: 'p1' },
      before: {},
      after: { title: 'x' },
    }
    const p = new Provenance('r')
    p.see([{ type: 'product', id: 'p1' }])
    expect(
      evaluateGuardrail(
        c,
        { caps: {} },
        { now, changeSet: [], windowCount: 0, provenance: p },
        'stage',
      ).verdict,
    ).toBe('block')
    p.see([{ type: 'product', id: 'p1' }], { full: true })
    expect(
      evaluateGuardrail(
        c,
        { caps: {} },
        { now, changeSet: [], windowCount: 0, provenance: p },
        'stage',
      ).verdict,
    ).toBe('allow')
  })
})

describe('mandate resolution (15 §3.1)', () => {
  it('assignment can only tighten', () => {
    const m = resolveMandate(
      { caps: { max_auto_refund_amount: 50, protected: ['a', 'b'] } },
      { caps: { max_auto_refund_amount: 80 } },
      { caps: { max_auto_refund_amount: 200, protected: ['b'] } },
    )
    expect(m.caps.max_auto_refund_amount).toBe(80)
    expect(m.caps.protected).toEqual(['b'])
  })
})

describe('provenance (15 §6, A12)', () => {
  it('pinned ids survive eviction', () => {
    const p = new Provenance('r', 3)
    p.see([{ type: 'order', id: 'a' }])
    p.pin({ type: 'order', id: 'a' })
    for (const id of ['b', 'c', 'd', 'e']) p.see([{ type: 'order', id }])
    expect(p.has({ type: 'order', id: 'a' })).toBe(true)
    expect(p.evicted.length).toBeGreaterThan(0)
  })
  it('round-trips state', () => {
    const p = prov(true)
    expect(Provenance.from(p.toState(now)).hasFull(order)).toBe(true)
  })
})

describe('execution snapshot (14 §4)', () => {
  it('is deterministic and detects component change', () => {
    const a = executionSnapshot({ target: { id: 'o1', v: '1' }, recipients: ['a@x'] })
    const b = executionSnapshot({ recipients: ['a@x'], target: { v: '1', id: 'o1' } })
    expect(a.hash).toBe(b.hash)
    const c = executionSnapshot({ target: { id: 'o1', v: '2' }, recipients: ['a@x'] })
    expect(snapshotMatches(a, c)).toEqual({ ok: false, changed: ['target'] })
  })
})

describe('authorization check (15 §6.1)', () => {
  it('stranger claiming an order is blocked; owner passes', () => {
    const base = {
      kind: 'reship' as const,
      target: order,
      target_owner: { type: 'customer', id: 'cus_7' },
    }
    expect(
      authorizationCheck({
        ...base,
        requester: {
          channel: 'email',
          external_id: 'x@y',
          resolved: { type: 'customer', id: 'cus_9' },
        },
      }).ok,
    ).toBe(false)
    expect(
      authorizationCheck({
        ...base,
        requester: {
          channel: 'email',
          external_id: 'a@y',
          resolved: { type: 'customer', id: 'cus_7' },
        },
      }).ok,
    ).toBe(true)
    expect(
      authorizationCheck({ ...base, requester: { channel: 'email', external_id: 'a@y' } }).ok,
    ).toBe(false)
  })
})

describe('44 G2 target_in_range', () => {
  const priceChange = {
    kind: 'price_change' as const,
    target: { type: 'product', id: 'prod_7' },
    field: 'price',
    before: { price: 129 },
    after: { price: 119 },
  }
  const prodFacts = (over: Record<string, unknown> = {}) => {
    const p = new Provenance('run_1')
    p.see([priceChange.target], { full: true })
    return { now, changeSet: [], windowCount: 0, provenance: p, ...over }
  }

  it('不在范围里 = block，理由原样带进 hit', () => {
    const out = evaluateGuardrail(
      priceChange,
      { caps: {} },
      prodFacts({ target_in_range: { ok: false, reason: '户外线的商品不归你管' } }),
      'stage',
    )
    expect(out.verdict).toBe('block')
    const hit = out.hits.find((h) => h.rule === 'target_in_range')
    expect(hit?.severity).toBe('block')
    expect(hit?.cap).toBe('product:prod_7')
    expect(hit?.actual).toBe('户外线的商品不归你管')
  })

  it('在范围里 / 压根没给结论 → 这一条不出现', () => {
    for (const facts of [prodFacts({ target_in_range: { ok: true } }), prodFacts()]) {
      const out = evaluateGuardrail(priceChange, { caps: {} }, facts, 'stage')
      expect(out.hits.some((h) => h.rule === 'target_in_range')).toBe(false)
      expect(out.verdict).toBe('allow')
    }
  })

  it('没写理由时落一句机器码，不留空', () => {
    const out = evaluateGuardrail(
      priceChange,
      { caps: {} },
      prodFacts({ target_in_range: { ok: false } }),
      'stage',
    )
    expect(out.hits.find((h) => h.rule === 'target_in_range')?.actual).toBe('out_of_range')
  })

  it('哪几种变更该问范围写在一张表里（补货计划等有 ChangeKind 时再加）', () => {
    expect([...TARGET_SCOPED_KINDS].sort()).toEqual([
      // WP63（51 §2.1）：集合 / 库存 / 评价也顺着目标问得出"这归不归你管"
      'collection_edit',
      'inventory_adjust',
      'listing_edit',
      'price_change',
      'promotion',
      'publish_product',
      'review_invite',
      'review_reply',
      'unpublish_product',
    ])
  })

  it('批准过的软额度例外救不了越权：block 就是 block', () => {
    const out = evaluateGuardrail(
      priceChange,
      { caps: {} },
      prodFacts({ target_in_range: { ok: false }, approvedException: true }),
      'apply',
    )
    expect(out.verdict).toBe('block')
  })
})

/**
 * WP64（51 §2.3 / §2.4）：邮件营销与订单履约的五条新 kind。
 *
 * 钉的是"这几条硬规则在 guardrail 这一层就说不"，而不是"面板上会提示"——
 * 提示劝得住人，劝不住一个自动跑的 Agent。
 */
describe('WP64 邮件营销与订单履约（15 §2 + 51 §2.3 / §2.4）', () => {
  const campaign = { type: 'campaign', id: 'cmp_1' } as const
  const ord = { type: 'order', id: 'ord_2001' } as const
  const seen = (ref: { type: string; id: string }) => {
    const p = new Provenance('run_wp64')
    p.see([ref], { full: true })
    return p
  }
  const f = (ref: { type: string; id: string }, over = {}) => ({
    now,
    changeSet: [],
    windowCount: 0,
    provenance: seen(ref),
    ...over,
  })
  const ruleOf = (r: ReturnType<typeof evaluateGuardrail>, rule: string) =>
    r.hits.find((h) => h.rule === rule)

  it('群发永远人审：就算额度、名单都干净，硬顶也把它按回 L1', () => {
    const out = evaluateGuardrail(
      {
        kind: 'campaign_send',
        target: campaign,
        before: {},
        after: {
          audience_size: 3,
          audience: ['a@x.com'],
          suppressed: [],
          suppression_checked: true,
        },
      },
      { caps: { max_campaign_audience: 5000 } },
      f(campaign),
      'stage',
    )
    expect(out.verdict).toBe('require_review')
    expect(ruleOf(out, 'hard_ceiling')?.cap).toBe('L1')
  })

  it('抑制名单没查过 = block（"没问过"与"问过了没人"分得开）', () => {
    const out = evaluateGuardrail(
      { kind: 'campaign_send', target: campaign, before: {}, after: { audience: ['a@x.com'] } },
      { caps: {} },
      f(campaign),
      'stage',
    )
    expect(out.verdict).toBe('block')
    expect(ruleOf(out, 'suppression_list_required')).toBeDefined()
  })

  it('剔干净了才放行；名单上的人还留在收件人里就 block', () => {
    const leaky = evaluateGuardrail(
      {
        kind: 'campaign_send',
        target: campaign,
        before: {},
        after: {
          audience: ['Anna+promo@Example.com'],
          suppressed: ['anna@example.com'],
          suppression_checked: true,
        },
      },
      { caps: {} },
      f(campaign),
      'stage',
    )
    expect(leaky.verdict).toBe('block')
    expect(ruleOf(leaky, 'suppression_list')).toBeDefined()
  })

  it('自动流：触发条件动不得，延迟改短 / 上限调大一样是 block', () => {
    const protectedField = evaluateGuardrail(
      {
        kind: 'flow_edit',
        target: { type: 'campaign', id: 'flow_abandon' },
        before: { trigger: 'checkout_abandoned_60m', body: '旧文案' },
        after: { trigger: 'checkout_abandoned_10m', body: '新文案' },
      },
      { caps: {} },
      f({ type: 'campaign', id: 'flow_abandon' }),
      'stage',
    )
    expect(protectedField.verdict).toBe('block')
    expect(ruleOf(protectedField, 'protected_field')).toBeDefined()

    const loosened = evaluateGuardrail(
      {
        kind: 'flow_edit',
        target: { type: 'campaign', id: 'flow_winback' },
        before: { delay_minutes: 60, max_recipients: 500 },
        after: { delay_minutes: 10, max_recipients: 5000 },
      },
      { caps: {} },
      f({ type: 'campaign', id: 'flow_winback' }),
      'stage',
    )
    expect(loosened.verdict).toBe('block')
    expect(ruleOf(loosened, 'flow_trigger_not_loosened')).toBeDefined()
  })

  it('自动流只改开关与文案 → allow', () => {
    const out = evaluateGuardrail(
      {
        kind: 'flow_edit',
        target: { type: 'campaign', id: 'flow_winback' },
        before: { enabled: false, body: '旧文案', delay_minutes: 60 },
        after: { enabled: true, body: '新文案', delay_minutes: 60 },
      },
      { caps: {} },
      f({ type: 'campaign', id: 'flow_winback' }),
      'stage',
    )
    expect(out.verdict).toBe('allow')
  })

  it('标记发货必须带单号与承运商；已发货的不许再发一次', () => {
    const naked = evaluateGuardrail(
      {
        kind: 'create_fulfillment',
        target: ord,
        before: { fulfillment_status: 'unfulfilled' },
        after: {},
      },
      { caps: {} },
      f(ord),
      'stage',
    )
    expect(naked.verdict).toBe('block')
    expect(ruleOf(naked, 'tracking_number_required')).toBeDefined()
    expect(ruleOf(naked, 'carrier_required')).toBeDefined()

    const ok = evaluateGuardrail(
      {
        kind: 'create_fulfillment',
        target: ord,
        before: { fulfillment_status: 'unfulfilled' },
        after: { tracking_number: 'YT2026', carrier: 'YunExpress' },
      },
      { caps: {} },
      f(ord),
      'stage',
    )
    expect(ok.verdict).toBe('allow')

    const again = evaluateGuardrail(
      {
        kind: 'create_fulfillment',
        target: ord,
        before: { fulfillment_status: 'fulfilled' },
        after: { tracking_number: 'YT2026', carrier: 'YunExpress' },
      },
      { caps: {} },
      f(ord),
      'stage',
    )
    expect(again.verdict).toBe('block')
  })

  it('拆单至少两件；超过上限转人审', () => {
    const one = evaluateGuardrail(
      { kind: 'split_order', target: ord, before: {}, after: { parts: 1 } },
      { caps: { max_split_parts: 3 } },
      f(ord),
      'stage',
    )
    expect(one.verdict).toBe('block')
    const many = evaluateGuardrail(
      { kind: 'split_order', target: ord, before: {}, after: { parts: 5 } },
      { caps: { max_split_parts: 3 } },
      f(ord),
      'stage',
    )
    expect(many.verdict).toBe('require_review')
  })

  it('取消订单永远人审；已发货的取消不了', () => {
    const pending = evaluateGuardrail(
      {
        kind: 'cancel_order',
        target: ord,
        before: { fulfillment_status: 'unfulfilled' },
        after: { reason: 'customer_request' },
      },
      { caps: {} },
      f(ord),
      'stage',
    )
    expect(pending.verdict).toBe('require_review')
    expect(ruleOf(pending, 'hard_ceiling')?.cap).toBe('L1')

    const shipped = evaluateGuardrail(
      {
        kind: 'cancel_order',
        target: ord,
        before: { fulfillment_status: 'fulfilled' },
        after: { reason: 'customer_request' },
      },
      { caps: {} },
      f(ord),
      'stage',
    )
    expect(shipped.verdict).toBe('block')
  })
})
