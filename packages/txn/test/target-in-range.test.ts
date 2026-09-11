/**
 * WP47 / 44 G2 写动作那一半：`target_in_range` 前置检查。
 *
 * 一个亚马逊账号里，厨房线的运营不该改得动户外线的价。整店的过滤下推（19 §3）
 * 管不到商品这一级，所以这一条要在 **stage 那一步**拦下来——不是拦在施行那一步，
 * 更不是"提了案让人在审批卡上发现跑不通"。
 */
import type { ObjectRef } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { runPrecheck } from '../src/index.js'
import { ASG, harness, provenanceState, refundStage, T0, WS } from './helpers.js'

const PRODUCT: ObjectRef = { type: 'product', id: 'prod_7' }

const priceStage = (over: Parameters<typeof refundStage>[0] = {}) =>
  refundStage({
    kind: 'price_change',
    target: PRODUCT,
    field: 'price',
    before: { price: 129, title: 'USB-C 65W Charger' },
    after: { price: 119 },
    money: undefined,
    requester: undefined,
    target_owner: undefined,
    mandate: { caps: { max_price_delta_pct: 50 } },
    provenance: provenanceState({ seen: { product: [PRODUCT.id] } }),
    approval: {
      title: '改价：USB-C 65W Charger 129 → 119',
      summary: '竞品降价了，跟一档',
      recipients: [{ person: 'p_li', via: 'scope_manager' }],
      proposer: { kind: 'agent', id: 'agent_ops', assignment_id: ASG },
      separation_of_duties: true,
    },
    ...over,
  })

describe('stage 那一步就拦住越权改价', () => {
  it('目标不在这个岗位管的范围里 → block，理由原样带出来', async () => {
    const h = harness({
      targetInRange: () => ({
        ok: false,
        reason: 'prod_7 不在这个岗位管的范围里（管的是：厨房线）',
      }),
    })
    const out = await h.txn.ledger.stage(priceStage())
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.reason).toBe('guardrail')
    expect(out.message).toContain('target_in_range')
    const hit = out.guardrail?.hits.find((x) => x.rule === 'target_in_range')
    expect(hit?.severity).toBe('block')
    expect(String(hit?.actual)).toContain('厨房线')
    // 一条变更都没进账本
    expect(await h.txn.ledger.list({ workspace_id: WS })).toHaveLength(0)
    expect(h.typesOf('change.blocked')).toEqual(['change.blocked'])
  })

  it('目标在范围里 → 照常提案', async () => {
    const h = harness({ targetInRange: () => ({ ok: true }) })
    const out = await h.txn.ledger.stage(priceStage())
    expect(out.ok).toBe(true)
  })

  it('不装这个口子（老调用方）→ 这一条不判，行为一个字不变', async () => {
    const h = harness()
    const out = await h.txn.ledger.stage(priceStage())
    expect(out.ok).toBe(true)
  })

  it('退款这种以订单为目标的变更压根不问范围（走的是关系授权门禁）', async () => {
    const asked: string[] = []
    const h = harness({
      targetInRange: ({ kind }) => {
        asked.push(kind)
        return { ok: false, reason: '不该问到这里' }
      },
    })
    const out = await h.txn.ledger.stage(refundStage())
    expect(out.ok).toBe(true)
    expect(asked).toEqual([])
  })

  it('改 Listing 也问（44 G2 列的那几种）', async () => {
    const asked: string[] = []
    const h = harness({
      targetInRange: ({ kind }) => {
        asked.push(kind)
        return { ok: true }
      },
    })
    await h.txn.ledger.stage(
      priceStage({
        kind: 'listing_edit',
        field: 'title',
        before: { title: 'A' },
        after: { title: 'B' },
        provenance: provenanceState({ seen: { product: [PRODUCT.id] }, read_full: [PRODUCT] }),
      }),
    )
    expect(asked).toEqual(['listing_edit'])
  })
})

describe('预检那一层也认（14 §6：blocked 不进队列）', () => {
  const stagedChange = (kind: string) => ({
    workspace_id: WS,
    schema_version: 1 as const,
    kind: 'staged_change' as const,
    role_id: 'dtc.ops',
    subject: { object: PRODUCT },
    dedupe_key: 'dk_1',
    title: '改价',
    summary: '改价',
    payload: { kind, target: PRODUCT, after: { price: 119 } },
    evidence: {
      run_id: 'run_1',
      source_events: [],
      provenance: { seen: [PRODUCT] },
      precheck: {},
    },
    automation: {
      level_at_creation: 'L1' as const,
      mandate_check: { within: true },
    },
    created_at: T0,
  })

  it('范围结论是 false → blocked + 人话理由', () => {
    const out = runPrecheck(stagedChange('price_change'), {
      target_in_range: { ok: false, reason: '户外线的商品不在你管的范围里' },
    })
    expect(out.blocked).toContain('target_in_range')
    expect(out.precheck.target_in_range).toBe('fail')
    expect(out.precheck.notes?.join('')).toContain('户外线')
  })

  it('范围结论是 true → ok，不拦', () => {
    const out = runPrecheck(stagedChange('price_change'), { target_in_range: { ok: true } })
    expect(out.blocked).not.toContain('target_in_range')
    expect(out.precheck.target_in_range).toBe('ok')
  })

  it('没给结论 → 这一条不判（老路径）；不是商品类的变更也不判', () => {
    expect(runPrecheck(stagedChange('price_change')).precheck.target_in_range).toBeUndefined()
    expect(
      runPrecheck(stagedChange('refund'), { target_in_range: { ok: false, reason: 'x' } }).blocked,
    ).not.toContain('target_in_range')
  })
})
