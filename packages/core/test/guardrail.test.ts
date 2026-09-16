import type { Mandate } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  authorizationCheck,
  evaluateGuardrail,
  executionSnapshot,
  KOL_OUTREACH_FORBIDDEN,
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

describe('WP67 红人营销那五条（15 §2 + 48 §5.1）', () => {
  const creator = { type: 'creator', id: 'cre_1' } as const
  const collab = { type: 'collaboration', id: 'col_1' } as const
  const deliverable = { type: 'deliverable', id: 'dlv_1' } as const
  const link = { type: 'tracked_link', id: 'tl_1' } as const
  const seen = (ref: { type: string; id: string }) => {
    const p = new Provenance('run_wp67')
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
  const outreach = (after: Record<string, unknown>) => ({
    kind: 'kol_outreach' as const,
    target: creator,
    before: { stage: 'sourced' },
    after: { suppression_checked: true, recipients: [], suppressed: [], ...after },
  })

  it('干净的开发信在额度内：放行', () => {
    const out = evaluateGuardrail(
      outreach({ subject: '想聊聊合作', body: '你好，我们是 Nordvolt，想寄一台样机给你试试。' }),
      { caps: { max_outreach_per_day: 30 } },
      f(creator),
      'stage',
    )
    expect(out.verdict).toBe('allow')
  })

  it('禁承诺是 block 不是转人审：给钱要去建合作，不能在信里写死一个数', () => {
    const money = evaluateGuardrail(
      outreach({ subject: '合作', body: '我们付你 800 美元，这一条视频就发吧。' }),
      { caps: { max_outreach_per_day: 30 } },
      f(creator),
      'stage',
    )
    expect(money.verdict).toBe('block')
    expect(ruleOf(money, 'kol_outreach_commitment')?.cap).toBe('我们付你')

    const free = evaluateGuardrail(
      outreach({ body: 'We will send you a free unit, no cost to you.' }),
      { caps: {} },
      f(creator),
      'stage',
    )
    expect(free.verdict).toBe('block')

    const promise = evaluateGuardrail(
      outreach({ body: '按我们的经验保证出单，放心做。' }),
      { caps: {} },
      f(creator),
      'stage',
    )
    expect(promise.verdict).toBe('block')
  })

  it('禁承诺词表只可加行，且三类都在（钱 / 白送 / 保证）', () => {
    for (const w of ['我们付你', '免费寄样', '保证出单', 'we will pay', 'free sample'])
      expect(KOL_OUTREACH_FORBIDDEN).toContain(w)
  })

  it('抑制名单 fail-closed：不报"查过了"就 block，报了但名单上的人还在里面也 block', () => {
    const never = evaluateGuardrail(
      {
        kind: 'kol_outreach',
        target: creator,
        before: {},
        after: { body: '你好' },
      },
      { caps: {} },
      f(creator),
      'stage',
    )
    expect(never.verdict).toBe('block')
    expect(ruleOf(never, 'suppression_list_required')?.actual).toBe('never')

    const leaked = evaluateGuardrail(
      outreach({
        body: '你好',
        recipients: ['Anna+kol@example.com'],
        suppressed: ['anna@example.com'],
      }),
      { caps: {} },
      f(creator),
      'stage',
    )
    expect(leaked.verdict).toBe('block')
    expect(ruleOf(leaked, 'suppression_list')?.actual).toContain('1')
  })

  it('日配额超了转人审（不是 block：多发一封不是安全事故）', () => {
    const out = evaluateGuardrail(
      outreach({ body: '你好' }),
      { caps: { max_outreach_per_day: 30 } },
      f(creator, { windowCount: 30 }),
      'stage',
    )
    expect(out.verdict).toBe('require_review')
    expect(ruleOf(out, 'max_outreach_per_day')?.actual).toBe(31)
  })

  it('建合作永远人审；超过人审线的预算另记一条 hit', () => {
    const cheap = evaluateGuardrail(
      {
        kind: 'kol_collaboration',
        target: collab,
        before: { stage: 'negotiating' },
        after: { stage: 'agreed', budget: 200, currency: 'USD' },
      },
      { caps: { max_collab_budget: 500 } },
      f(collab),
      'stage',
    )
    expect(cheap.verdict).toBe('require_review')
    expect(ruleOf(cheap, 'hard_ceiling')?.cap).toBe('L1')
    expect(ruleOf(cheap, 'max_collab_budget')).toBeUndefined()

    const rich = evaluateGuardrail(
      {
        kind: 'kol_collaboration',
        target: collab,
        before: { stage: 'negotiating' },
        after: { stage: 'agreed', budget: 900, currency: 'USD' },
      },
      { caps: { max_collab_budget: 500 } },
      f(collab),
      'stage',
    )
    expect(ruleOf(rich, 'max_collab_budget')?.actual).toBe(900)
  })

  it('阶段机说这一跳非法就 block（合法迁移表在 kol-core，这里只认结论）', () => {
    const out = evaluateGuardrail(
      {
        kind: 'kol_collaboration',
        target: collab,
        before: { stage: 'sourced' },
        after: { stage: 'delivered', stage_transition_ok: false },
      },
      { caps: {} },
      f(collab),
      'stage',
    )
    expect(out.verdict).toBe('block')
    expect(ruleOf(out, 'kol_stage_transition')?.actual).toBe('delivered')
  })

  it('交付物审核：结论必须是三个之一；每天审几条有上限', () => {
    const bad = evaluateGuardrail(
      {
        kind: 'kol_deliverable_review',
        target: deliverable,
        before: { review: 'pending' },
        after: { review: 'pending' },
      },
      { caps: {} },
      f(deliverable),
      'stage',
    )
    expect(bad.verdict).toBe('block')

    const many = evaluateGuardrail(
      {
        kind: 'kol_deliverable_review',
        target: deliverable,
        before: { review: 'pending' },
        after: { review: 'approved' },
      },
      { caps: { max_deliverable_reviews_per_day: 20 } },
      f(deliverable, { windowCount: 20 }),
      'stage',
    )
    expect(many.verdict).toBe('require_review')
  })

  it('联盟码折扣率超 20 转人审，且与客服 / 营销那两组 cap 分账', () => {
    const over = evaluateGuardrail(
      {
        kind: 'kol_affiliate_code',
        target: collab,
        before: {},
        after: { code: 'JONAS25', percent: 25 },
      },
      { caps: { max_affiliate_discount_pct: 20 } },
      f(collab),
      'stage',
    )
    expect(over.verdict).toBe('require_review')
    expect(ruleOf(over, 'max_affiliate_discount_pct')?.actual).toBe(25)

    // 只配了客服那一组 cap 的老 mandate：红人这条一个都不多判
    const unrelated = evaluateGuardrail(
      {
        kind: 'kol_affiliate_code',
        target: collab,
        before: {},
        after: { code: 'JONAS25', percent: 25 },
      },
      { caps: { max_presales_discount_pct: 10 } },
      f(collab),
      'stage',
    )
    expect(unrelated.verdict).toBe('allow')
  })

  it('追踪链接缺 UTM 必填参数就 block（归不到合作头上等于白建）', () => {
    const missing = evaluateGuardrail(
      {
        kind: 'kol_tracked_link',
        target: link,
        before: {},
        after: { url: 'https://shop.example/p/1', utm: { source: 'youtube', medium: '' } },
      },
      { caps: {} },
      f(link),
      'stage',
    )
    expect(missing.verdict).toBe('block')
    expect(ruleOf(missing, 'kol_utm_required')?.actual).toBe('medium,campaign')

    const ok = evaluateGuardrail(
      {
        kind: 'kol_tracked_link',
        target: link,
        before: {},
        after: {
          url: 'https://shop.example/p/1',
          utm: { source: 'youtube', medium: 'kol', campaign: 'autumn' },
        },
      },
      { caps: {} },
      f(link),
      'stage',
    )
    expect(ok.verdict).toBe('allow')
  })
})

describe('WP72 社媒运营那六条（15 §2 + 56 §2）', () => {
  const account = { type: 'social_account', id: 'sa_1' } as const
  const post = { type: 'social_post', id: 'sp_1' } as const
  const thread = { type: 'community_thread', id: 'ct_1' } as const
  const member = { type: 'community_member', id: 'cm_1' } as const
  const seen = (ref: { type: string; id: string }) => {
    const p = new Provenance('run_wp72')
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

  it('发内容永远人审——排期与立发同一条门', () => {
    const r = evaluateGuardrail(
      {
        kind: 'social_post',
        target: post,
        before: {},
        after: { body: '新的 65W 充电器上架了。', scheduled_at: '2026-09-09T08:00:00Z' },
      },
      { caps: { max_posts_per_day: 3 } },
      f(post),
      'stage',
    )
    expect(r.verdict).toBe('require_review')
    expect(ruleOf(r, 'hard_ceiling')?.actual).toBe('social_post')
  })

  it('排期时间在过去 = block：人在卡面上看不出那个时刻已经过去了', () => {
    const r = evaluateGuardrail(
      {
        kind: 'social_post',
        target: post,
        before: {},
        after: { body: '迟到的公告', scheduled_at: '2026-09-01T08:00:00Z' },
      },
      { caps: {} },
      f(post),
      'stage',
    )
    expect(r.verdict).toBe('block')
    expect(ruleOf(r, 'social_post_schedule_in_past')).toBeDefined()
  })

  it('既没文案也没素材 = block（平台发得出去，所以不能靠平台挡）', () => {
    const r = evaluateGuardrail(
      { kind: 'social_post', target: post, before: {}, after: { body: '   ' } },
      { caps: {} },
      f(post),
      'stage',
    )
    expect(ruleOf(r, 'social_post_empty')?.severity).toBe('block')
  })

  it('发帖超日额：多一条 hit，卡面上看得见', () => {
    const r = evaluateGuardrail(
      { kind: 'social_post', target: post, before: {}, after: { body: '第四条' } },
      { caps: { max_posts_per_day: 3 } },
      f(post, { windowCount: 3 }),
      'stage',
    )
    expect(ruleOf(r, 'max_posts_per_day')?.actual).toBe(4)
  })

  it('改账号资料要人点；改 handle 连提都不许提', () => {
    const bio = evaluateGuardrail(
      {
        kind: 'social_profile_edit',
        target: account,
        before: { bio: '旧简介' },
        after: { bio: '新简介' },
      },
      { caps: {} },
      f(account, { provenance: seen(account) }),
      'stage',
    )
    expect(bio.verdict).toBe('require_review')
    expect(ruleOf(bio, 'social_profile_edit_needs_review')).toBeDefined()

    const handle = evaluateGuardrail(
      {
        kind: 'social_profile_edit',
        target: account,
        field: 'handle',
        before: { handle: 'nordvolt' },
        after: { handle: 'nordvolt-official' },
      },
      { caps: {} },
      f(account),
      'stage',
    )
    expect(handle.verdict).toBe('block')
    expect(ruleOf(handle, 'protected_field')).toBeDefined()
  })

  it('改群规没读全就改 = block（before 就是那段正文）', () => {
    const p = new Provenance('run_wp72_rules')
    p.see([account], { full: false })
    const r = evaluateGuardrail(
      {
        kind: 'community_rules',
        target: account,
        before: { rules: '不许发链接' },
        after: { rules: '可以发链接' },
      },
      { caps: {} },
      { now, changeSet: [], windowCount: 0, provenance: p },
      'stage',
    )
    expect(r.verdict).toBe('block')
    expect(ruleOf(r, 'requires_record_read')).toBeDefined()
  })

  it('入群审核：说不清是批还是拒的卡，人点不下去', () => {
    const r = evaluateGuardrail(
      { kind: 'community_membership', target: member, before: {}, after: {} },
      { caps: {} },
      f(member),
      'stage',
    )
    expect(r.verdict).toBe('block')
    expect(ruleOf(r, 'community_membership_decision_required')).toBeDefined()

    const okOne = evaluateGuardrail(
      { kind: 'community_membership', target: member, before: {}, after: { decision: 'approve' } },
      { caps: { max_member_approvals_per_day: 50 } },
      f(member),
      'stage',
    )
    expect(okOne.verdict).toBe('allow')
  })

  it('群发：不报「查过抑制名单」就 block——没问过与问过了没人必须分得开', () => {
    const never = evaluateGuardrail(
      {
        kind: 'community_broadcast',
        target: account,
        before: {},
        after: { channel: 'discord', audience: ['u1', 'u2'], audience_size: 2 },
      },
      { caps: { max_broadcasts_per_week: 1 } },
      f(account),
      'stage',
    )
    expect(never.verdict).toBe('block')
    expect(ruleOf(never, 'suppression_list_required')?.actual).toBe('never')
  })

  it('群发：名单上的人漏在受众里 = block（规则是 suppression.ts 那一份）', () => {
    const leak = evaluateGuardrail(
      {
        kind: 'community_broadcast',
        target: account,
        before: {},
        after: {
          channel: 'telegram_group',
          suppression_checked: true,
          audience: ['A+promo@x.com', 'b@x.com'],
          suppressed: ['a@x.com'],
        },
      },
      { caps: {} },
      f(account),
      'stage',
    )
    expect(leak.verdict).toBe('block')
    expect(ruleOf(leak, 'suppression_list')?.actual).toContain('A+promo@x.com')
  })

  it('群发：查过了、名单上一个人都不在 → 只剩「永远人审」那一条', () => {
    const clean = evaluateGuardrail(
      {
        kind: 'community_broadcast',
        target: account,
        before: {},
        after: {
          channel: 'discord',
          suppression_checked: true,
          audience: ['b@x.com'],
          suppressed: ['a@x.com'],
          audience_size: 1,
        },
      },
      { caps: { max_broadcasts_per_week: 1 } },
      f(account),
      'stage',
    )
    expect(clean.verdict).toBe('require_review')
    expect(clean.hits.map((h) => h.rule)).toEqual(['hard_ceiling'])
  })

  it('WhatsApp：没 opt-in / 没模板 id 一律 block，不是转人审', () => {
    const r = evaluateGuardrail(
      {
        kind: 'community_broadcast',
        target: account,
        before: {},
        after: {
          channel: 'whatsapp',
          suppression_checked: true,
          audience: ['+4915112345678'],
          suppressed: [],
          audience_size: 1,
        },
      },
      { caps: { max_template_messages_per_day: 100 } },
      f(account),
      'stage',
    )
    expect(r.verdict).toBe('block')
    expect(ruleOf(r, 'whatsapp_template_required')).toBeDefined()
    expect(ruleOf(r, 'whatsapp_opt_in_required')?.actual).toBe('never')

    const withBoth = evaluateGuardrail(
      {
        kind: 'community_broadcast',
        target: account,
        before: {},
        after: {
          channel: 'whatsapp',
          template_id: 'order_update_v3',
          opt_in_verified: true,
          suppression_checked: true,
          audience: ['+4915112345678'],
          suppressed: [],
          audience_size: 1,
        },
      },
      { caps: { max_template_messages_per_day: 100 } },
      f(account),
      'stage',
    )
    expect(withBoth.verdict).toBe('require_review')
  })

  it('管理动作按 after.action 分档：删帖 L2 自动得了，封禁升 L1', () => {
    const del = evaluateGuardrail(
      {
        kind: 'community_moderation',
        target: thread,
        before: {},
        after: { action: 'delete_post', reason: '广告' },
      },
      { caps: { max_moderations_per_day: 20 } },
      f(thread),
      'stage',
    )
    expect(del.verdict).toBe('allow')

    const ban = evaluateGuardrail(
      {
        kind: 'community_moderation',
        target: thread,
        before: {},
        after: { action: 'ban', reason: '反复刷广告' },
      },
      { caps: { max_moderations_per_day: 20 } },
      f(thread),
      'stage',
    )
    expect(ban.verdict).toBe('require_review')
    expect(ruleOf(ban, 'community_moderation_ban')?.actual).toBe('ban')
  })

  it('认不出的管理动作 = block（不猜它想干什么）', () => {
    const r = evaluateGuardrail(
      { kind: 'community_moderation', target: thread, before: {}, after: { action: 'shadowban' } },
      { caps: {} },
      f(thread),
      'stage',
    )
    expect(r.verdict).toBe('block')
    expect(ruleOf(r, 'community_moderation_action_required')?.actual).toBe('shadowban')
  })
})
