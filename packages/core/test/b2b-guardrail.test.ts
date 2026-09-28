/**
 * WP171（docs/84）：B2B 的承诺词表、改收款账户识别与 guardrail 那十三条 kind。
 *
 * 钉死四件事：
 *
 * 1. 报价 / 展会缴费 / 放单 / 付款指示 / 平台花钱在 `HARD_L1` 里（永远人审）；
 * 2. 报价超授权四个数任何一个 → 多一条 review hit（路由看它转上级），版本不可改；
 * 3. 回询盘碰到承诺说法 → 转人审；开发信碰到 → block；
 * 4. "改收款账户"识别得出来，往外发的正文里的账户必须取自事实卡。
 */
import type { Mandate } from '@agentsws/contracts'
import { DEFAULT_B2B_QUOTE_MANDATE } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  B2B_GUARDED_KINDS,
  detectPaymentAccountChange,
  evaluateGuardrail,
  HARD_L1,
  KIND_RISK,
  Provenance,
  scanB2bCommitments,
} from '../src/index.js'

const now = '2026-09-28T09:00:00Z'
const prov = (target: { type: string; id: string }) => {
  const p = new Provenance('run_1')
  p.see([target as never], { full: true })
  return p
}
const facts = (target: { type: string; id: string }, windowCount = 0) => ({
  now,
  changeSet: [],
  windowCount,
  provenance: prov(target),
})
const rules = (r: { hits: { rule: string; severity: string }[] }, severity?: string) =>
  r.hits.filter((h) => severity === undefined || h.severity === severity).map((h) => h.rule)

const quoteMandate: Mandate = { caps: { ...DEFAULT_B2B_QUOTE_MANDATE } }
const quote = { type: 'b2b_quote', id: 'q_1' } as const
const quoteChange = (after: Record<string, unknown>, before: Record<string, unknown> = {}) => ({
  kind: 'b2b_quote' as const,
  target: quote,
  before,
  after: {
    version: 1,
    amount_usd: 8_000,
    margin_pct: 26,
    discount_pct: 3,
    payment_terms_days: 30,
    ...after,
  },
})

describe('B2B kind 的风险级与硬顶', () => {
  it('十三条都有风险级，而且都归 b2b-guardrail 判', () => {
    for (const k of B2B_GUARDED_KINDS) expect(KIND_RISK[k]).toBeDefined()
    expect(B2B_GUARDED_KINDS.size).toBe(13)
  })
  it('报价、展会缴费、放单、付款指示、平台花钱永远人审', () => {
    for (const k of [
      'b2b_quote',
      'trade_show_registration',
      'bill_release',
      'payment_instruction',
      'marketplace_spend',
    ] as const)
      expect(HARD_L1.has(k)).toBe(true)
    // 回询盘与开发信不进硬顶：它们由承诺词表管
    expect(HARD_L1.has('b2b_reply')).toBe(false)
    expect(HARD_L1.has('b2b_outreach')).toBe(false)
  })
})

describe('报价：授权只决定谁批', () => {
  it('授权内：只有硬顶那一条 review（照样出卡）', () => {
    const r = evaluateGuardrail(quoteChange({}), quoteMandate, facts(quote), 'stage')
    expect(r.verdict).toBe('require_review')
    expect(rules(r)).toEqual(['hard_ceiling'])
  })
  it('四个数各超一次，各多报一条', () => {
    const r = evaluateGuardrail(
      quoteChange({ amount_usd: 15_000, margin_pct: 18, discount_pct: 8, payment_terms_days: 60 }),
      quoteMandate,
      facts(quote),
      'stage',
    )
    expect(rules(r, 'review')).toEqual([
      'hard_ceiling',
      'quote_amount_over_mandate',
      'quote_margin_under_mandate',
      'quote_discount_over_mandate',
      'quote_payment_terms_over_mandate',
    ])
  })
  it('缺数按超出算（fail-closed）', () => {
    const r = evaluateGuardrail(
      quoteChange({ margin_pct: undefined }),
      quoteMandate,
      facts(quote),
      'stage',
    )
    expect(rules(r, 'review')).toContain('quote_margin_under_mandate')
  })
  it('报价版本不可改：同一版号再提一次就 block', () => {
    const r = evaluateGuardrail(
      quoteChange({ version: 2 }, { version: 2 }),
      quoteMandate,
      facts(quote),
      'stage',
    )
    expect(r.verdict).toBe('block')
    expect(rules(r, 'block')).toContain('quote_version_immutable')
    const ok = evaluateGuardrail(
      quoteChange({ version: 3 }, { version: 2 }),
      quoteMandate,
      facts(quote),
      'stage',
    )
    expect(rules(ok, 'block')).toEqual([])
  })
})

describe('承诺词表', () => {
  it('按类各报一个命中词', () => {
    const hits = scanB2bCommitments(
      'Unit price is USD 3.2/pcs, MOQ 1000, lead time 15 days, we can be your exclusive agent.',
    )
    expect(hits.map((h) => h.category)).toEqual(['price', 'lead_time', 'moq', 'exclusive'])
  })
  it('中文也认', () => {
    const hits = scanB2bCommitments('我们的起订量是 500 个，账期可以给到 60 天，保证质量。')
    expect(hits.map((h) => h.category)).toEqual(['moq', 'payment_terms', 'guarantee'])
  })
  it('没有承诺的话一条都不报', () => {
    expect(
      scanB2bCommitments('Thanks for reaching out — could you share your target market?'),
    ).toEqual([])
  })

  const reply = { type: 'b2b_account', id: 'acc_1' } as const
  it('回询盘碰到承诺 → 转人审，不 block', () => {
    const r = evaluateGuardrail(
      { kind: 'b2b_reply', target: reply, before: {}, after: { body: 'MOQ is 500 pcs.' } },
      { caps: {} },
      facts(reply),
      'stage',
    )
    expect(r.verdict).toBe('require_review')
    expect(r.hits[0]).toMatchObject({ rule: 'b2b_commitment', cap: '起订量' })
  })
  it('开发信碰到承诺 → block', () => {
    const r = evaluateGuardrail(
      {
        kind: 'b2b_outreach',
        target: reply,
        before: {},
        after: {
          body: 'We guarantee the best price.',
          footer_unsubscribe: true,
          footer_address: true,
          sender_auth: { spf: 'pass', dkim: 'pass', dmarc: 'pass' },
          suppression_checked: true,
        },
      },
      { caps: { max_outreach_per_day: 20 } },
      facts(reply),
      'stage',
    )
    expect(rules(r, 'block')).toEqual(['b2b_outreach_commitment'])
  })
})

describe('开发信的三道 B2B 闸', () => {
  const t = { type: 'b2b_list', id: 'l_1' } as const
  const base = {
    body: 'Saw your new GaN range on your site — are you sourcing 65W chargers this quarter?',
    footer_unsubscribe: true,
    footer_address: true,
    sender_auth: { spf: 'pass', dkim: 'pass', dmarc: 'pass' },
    suppression_checked: true,
    countries: ['US', 'GB'],
    count: 10,
  }
  const run = (over: Record<string, unknown>, windowCount = 0) =>
    evaluateGuardrail(
      { kind: 'b2b_outreach', target: t, before: {}, after: { ...base, ...over } },
      { caps: { max_outreach_per_day: 20 } },
      facts(t, windowCount),
      'stage',
    )
  it('全齐：放行', () => {
    expect(run({}).verdict).toBe('allow')
  })
  it('缺页脚 / 缺来源 / SPF 没过 / 德奥未确认 → 各自 block', () => {
    expect(rules(run({ footer_address: false }), 'block')).toEqual(['b2b_outreach_footer'])
    expect(rules(run({ contacts_missing_source: 2 }), 'block')).toEqual(['contact_source_required'])
    expect(rules(run({ sender_auth: { spf: 'fail', dkim: 'pass' } }), 'block')).toEqual([
      'sender_auth',
    ])
    expect(rules(run({ countries: ['DE', 'US'] }), 'block')).toEqual(['country_excluded'])
    expect(rules(run({ countries: ['DE'], de_at_confirmed: true }), 'block')).toEqual([])
  })
  it('用主域名发：能发，只多一句风险提示；DMARC 缺了只提示', () => {
    const r = run({ shared_sending_domain: true, sender_auth: { spf: 'pass', dkim: 'pass' } })
    expect(r.verdict).toBe('require_review')
    expect(rules(r, 'review')).toEqual(['sender_dmarc_missing', 'shared_sending_domain'])
  })
  it('日配额按这一批的条数算', () => {
    expect(rules(run({}, 15), 'review')).toEqual(['max_outreach_per_day'])
  })
})

describe('改收款账户', () => {
  it('说法命中就是红卡', () => {
    const s = detectPaymentAccountChange(
      'Dear partner, please note our bank details have changed. Kindly remit the balance to the new account.',
    )
    expect(s.hit).toBe(true)
    expect(s.phrases).toContain('bank details have changed')
  })
  it('账户信息 + 更换字眼也算', () => {
    const s = detectPaymentAccountChange('我们更换了开户行，账号 6222 0210 0112 3456，请按新的付。')
    expect(s).toMatchObject({ hit: true, has_account_details: true })
  })
  it('只是提到付款、没有账户与更换字眼：不命中', () => {
    const s = detectPaymentAccountChange('Balance payment was sent yesterday, please check.')
    expect(s).toEqual({ hit: false, phrases: [], has_account_details: false })
  })
  const acc = { type: 'b2b_account', id: 'acc_1' } as const
  it('往外发的信里带账户，必须取自事实卡', () => {
    const change = (flag?: boolean) => ({
      kind: 'b2b_reply' as const,
      target: acc,
      before: {},
      after: {
        body: 'Please pay to account no 6222021001123456.',
        ...(flag === undefined ? {} : { account_from_fact_card: flag }),
      },
    })
    expect(rules(evaluateGuardrail(change(), { caps: {} }, facts(acc), 'stage'), 'block')).toEqual([
      'payment_account_not_from_fact_card',
    ])
    expect(
      rules(evaluateGuardrail(change(true), { caps: {} }, facts(acc), 'stage'), 'block'),
    ).toEqual([])
  })
  it('付款指示的账户对不上事实卡 → block', () => {
    const t = { type: 'export_shipment', id: 'sh_1' } as const
    const r = evaluateGuardrail(
      { kind: 'payment_instruction', target: t, before: {}, after: {} },
      { caps: {} },
      facts(t),
      'stage',
    )
    expect(rules(r, 'block')).toEqual(['payment_account_mismatch'])
  })
})

describe('跟单：放单与单证', () => {
  const t = { type: 'export_shipment', id: 'sh_1' } as const
  it('尾款没到放单：多一条提醒', () => {
    const r = evaluateGuardrail(
      { kind: 'bill_release', target: t, before: {}, after: { balance_received: false } },
      { caps: {} },
      facts(t),
      'stage',
    )
    expect(rules(r, 'review')).toEqual(['hard_ceiling', 'balance_unpaid'])
  })
  it('单证有不符点没确认：转人审', () => {
    const r = evaluateGuardrail(
      {
        kind: 'export_docs_send',
        target: t,
        before: {},
        after: { docs: [{ kind: 'lc_documents', status: 'discrepancy' }] },
      },
      { caps: {} },
      facts(t),
      'stage',
    )
    expect(rules(r, 'review')).toEqual(['doc_discrepancy'])
  })
  it('寄样标已寄必须带单号', () => {
    const s = { type: 'b2b_sample', id: 's_1' } as const
    const r = evaluateGuardrail(
      { kind: 'b2b_sample', target: s, before: {}, after: { status: 'shipped' } },
      { caps: {} },
      facts(s),
      'stage',
    )
    expect(rules(r, 'block')).toEqual(['sample_tracking_required'])
  })
})
