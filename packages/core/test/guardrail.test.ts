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
      'listing_edit',
      'price_change',
      'promotion',
      'publish_product',
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
