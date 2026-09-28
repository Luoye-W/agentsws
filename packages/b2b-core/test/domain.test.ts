/**
 * 移植自 Luoye/BtoBAgents `tests/unit/btobagents-domain.test.ts`（首次 `5d4ed9c`，`c832e1e` 改名，
 * 仓库 HEAD `940f12b`）里证据 / 授权 / 交接那五条（积分与模型计价那两条不搬：agentsws 有自己的
 * metering）。原样保留断言，只改字段名与授权阈值（统一成 1 万 / 20% / 5% / 30 天），
 * 另加本仓的规矩：**报价永远出卡**、超授权转上级、没有上级转老板。
 */
import { DEFAULT_B2B_QUOTE_MANDATE } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  buildTransferPlan,
  decideEvidence,
  evaluateAction,
  quoteApprover,
  quoteBreaches,
} from '../src/index.js'

describe('BtoBAgents domain rules（移植）', () => {
  it('applies facts only when strong independent evidence exists', () => {
    const decision = decideEvidence([
      {
        kind: 'crm.signature-block',
        source_id: 'email-1',
        detail: 'Signature says Head of Sourcing.',
      },
    ])
    expect(decision.band).toBe('verified')
    expect(decision.can_apply_automatically).toBe(true)
  })

  it('holds facts when sources contradict each other', () => {
    const decision = decideEvidence([
      { kind: 'crm.imported-field', source_id: 'crm-1', detail: 'Company A' },
      { kind: 'contradiction', source_id: 'email-2', detail: 'Company B' },
    ])
    expect(decision.band).toBe('held')
  })

  it('requires approval for a quote outside the mandate', () => {
    const decision = evaluateAction(
      { action: 'create_quote', level: 'L3', amount_usd: 20000, margin_pct: 28 },
      { ...DEFAULT_B2B_QUOTE_MANDATE },
    )
    expect(decision.outcome).toBe('approval_required')
  })

  it('never allows LinkedIn to execute automatically', () => {
    const decision = evaluateAction({ action: 'linkedin_task', level: 'L3', channel: 'linkedin' })
    expect(decision.outcome).toBe('draft_only')
  })

  it('builds a deterministic ownership transfer plan', () => {
    const plan = buildTransferPlan(
      'departing',
      [
        { id: 'a1', kind: 'account', owner_id: 'departing', region: 'EU', value_usd: 100 },
        { id: 'd1', kind: 'deal', owner_id: 'departing', region: 'US', value_usd: 200 },
      ],
      [{ successor_id: 'successor', region: 'EU' }],
    )
    expect(plan.assignments).toHaveLength(1)
    expect(plan.unassigned).toHaveLength(1)
    expect(plan.totals.value_usd).toBe(300)
  })
})

describe('本仓的报价规矩（docs/84 §3.2 / §11.1 第 3 条）', () => {
  const inside = {
    action: 'create_quote' as const,
    level: 'L3' as const,
    amount_usd: 8_000,
    margin_pct: 26,
    discount_pct: 3,
    payment_terms_days: 30,
    has_verified_evidence: true,
  }

  it('授权内、证据齐、L3：照样出卡（不搬 L3 自动报价），业务员自己批', () => {
    const d = evaluateAction(inside)
    expect(d).toMatchObject({ outcome: 'approval_required', approver: 'role_holder', breaches: [] })
  })

  it('超授权转上级；没有上级转老板', () => {
    const over = { ...inside, amount_usd: 12_000 }
    expect(evaluateAction(over).approver).toBe('scope_manager')
    expect(evaluateAction(over, DEFAULT_B2B_QUOTE_MANDATE, false).approver).toBe('owner')
  })

  it('四个数的边界：等于上限算授权内，毛利等于下限算授权内', () => {
    expect(
      quoteBreaches({
        amount_usd: 10_000,
        margin_pct: 20,
        discount_pct: 5,
        payment_terms_days: 30,
      }),
    ).toEqual([])
    expect(
      quoteBreaches({
        amount_usd: 10_001,
        margin_pct: 19.9,
        discount_pct: 5.1,
        payment_terms_days: 31,
      }),
    ).toEqual([
      'quote_amount_over_mandate',
      'quote_margin_under_mandate',
      'quote_discount_over_mandate',
      'quote_payment_terms_over_mandate',
    ])
  })

  it('首次设置改过的授权照改后的算', () => {
    const loose = { ...DEFAULT_B2B_QUOTE_MANDATE, max_amount_usd: 50_000 }
    expect(quoteBreaches({ ...inside, amount_usd: 30_000 }, loose)).toEqual([])
  })

  it('路由只看有没有超、有没有上级', () => {
    expect(quoteApprover([], false)).toBe('role_holder')
    expect(quoteApprover(['quote_margin_under_mandate'], true)).toBe('scope_manager')
    expect(quoteApprover(['quote_margin_under_mandate'], false)).toBe('owner')
  })

  it('证据两个以上独立来源才会叠上去：同一来源只算最强那条', () => {
    const one = decideEvidence([
      { kind: 'web.cited-claim', source_id: 's1', detail: 'site' },
      { kind: 'search.cites-profile', source_id: 's1', detail: 'same site' },
    ])
    expect(one).toMatchObject({ band: 'possible', score: 40 })
    const two = decideEvidence([
      { kind: 'web.cited-claim', source_id: 's1', detail: 'site' },
      { kind: 'search.cites-profile', source_id: 's2', detail: 'directory' },
    ])
    expect(two).toMatchObject({ band: 'probable', score: 65, can_apply_automatically: false })
  })
})
