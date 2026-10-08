/**
 * WP261：经账本提的「改文案」卡（`listing_edit`），这次运行的 provenance 证明读过目标全文时，
 * 预检那道老门（`record_read`）照实记 ok——以前这一类卡一律被老门拦成 blocked（10-08 端到端撞上）。
 * 没读过照旧拦（guardrail 那一道），一个字不放宽。
 */
import type { ObjectRef } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { ASG, harness, provenanceState, refundStage, WS } from './helpers.js'

const PRODUCT: ObjectRef = { type: 'product', id: 'gid://shopify/Product/1001' }

const listing = (read: boolean) =>
  refundStage({
    kind: 'listing_edit',
    target: PRODUCT,
    field: 'title',
    before: { title: 'A' },
    after: { title: 'B' },
    money: undefined,
    requester: undefined,
    target_owner: undefined,
    mandate: { caps: {} },
    level: 'L1',
    provenance: provenanceState({
      seen: { product: [PRODUCT.id] },
      ...(read ? { read_full: [`product:${PRODUCT.id}`] } : {}),
    }),
    approval: {
      title: '改商品「A」：标题',
      summary: '标题：A → B',
      recipients: [{ person: 'p_li', via: 'scope_manager' }],
      proposer: { kind: 'agent', id: 'agent_store', assignment_id: ASG },
      separation_of_duties: false,
    },
  })

describe('改文案卡：读过全文才出得来', () => {
  it('读过 → 出卡（pending），预检记 record_read ok', async () => {
    const h = harness()
    const out = await h.txn.ledger.stage(listing(true))
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.approval.state).toBe('pending')
    expect(out.approval.evidence.precheck.record_read).toBe('ok')
  })

  it('没读过 → 照旧拦下，一张都不进账本', async () => {
    const h = harness()
    const out = await h.txn.ledger.stage(listing(false))
    expect(out.ok).toBe(false)
    expect(await h.txn.ledger.list({ workspace_id: WS })).toHaveLength(0)
  })
})
