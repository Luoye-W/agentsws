/**
 * WP440（docs/108 M9）：邮件客服「有把握就直接回」在审批总线这一层的那条自动批路径。
 *
 * 判断层把置信度结论放进 `context.confident_reply`；总线**自己再核**它管得着的那几样，
 * 差一样都照常进队列等人批：
 * - 等级不是 L1（别的岗位的回信草稿一律 L1 → 永远不自动批）；
 * - 三道自主门全放行（前置从 `gates` 算出的 `autonomous`）；没给门 = 不自主；
 * - 收件人门禁过了（没过就是 blocked，根本到不了这一步）；
 * - 不是收件人待定（`manual_send`）。
 * 自动批下来的那张由执行器施行（出站那一条路照旧），批的人记 `mandate`。
 */
import type { GateDecision } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { CUSTOMER, harness, outboundInput, THREAD } from './helpers.js'

const HASH = 'b'.repeat(64)
const pass = (g: GateDecision['gate']): GateDecision => ({
  gate: g,
  status: 'pass',
  ruleset_hash: HASH,
})
const PASS_ALL: GateDecision[] = [
  pass('l3_denylist'),
  pass('draft_origin'),
  pass('commitment_scan'),
]
const confident = { score: 0.86, strictness: 'balanced', source_ids: ['fc_warranty'] }
const ctx = {
  thread_participants: [CUSTOMER.id],
  verified_contacts: [CUSTOMER.id],
  connection_id: 'conn_mail',
}
const L2 = {
  level_at_creation: 'L2' as const,
  auto_approved: false,
  mandate_check: { within: true, caps_hit: [] },
  sampling: { selected: false },
}

describe('WP440：outbound_draft 的「置信度直答」自动批', () => {
  it('L2 + confident_reply + 三道门全放行 → 自动批（mandate），执行器真发', async () => {
    const h = harness()
    const item = await h.txn.approvals.create(
      outboundInput({
        dedupe_key: 'dk_auto_1',
        automation: L2,
        context: { ...ctx, gates: PASS_ALL, confident_reply: confident },
      }),
    )
    expect(item.state).toBe('auto_approved')
    expect(item.automation.auto_approved).toBe(true)
    expect(item.decision?.by).toBe('mandate')
    // 不进任何人的队列
    expect(item.deliveries).toEqual([])
    const out = await h.txn.executor.applyApproval(item.id, { skip_cancel_window: true })
    expect(out.state).toBe('applied')
    expect(h.backendCalls.map((c) => c.id)).toEqual([item.id])
  })

  it('别的岗位的回信草稿是 L1：带了 confident_reply 也照旧等人批（守卫）', async () => {
    const h = harness()
    const item = await h.txn.approvals.create(
      outboundInput({
        dedupe_key: 'dk_auto_2',
        context: { ...ctx, gates: PASS_ALL, confident_reply: confident },
      }),
    )
    expect(item.automation.level_at_creation).toBe('L1')
    expect(item.state).toBe('pending')
  })

  it('没有 confident_reply：L2 也不自动批（老路径一个字节不变）', async () => {
    const h = harness()
    const item = await h.txn.approvals.create(
      outboundInput({
        dedupe_key: 'dk_auto_3',
        automation: L2,
        context: { ...ctx, gates: PASS_ALL },
      }),
    )
    expect(item.state).toBe('pending')
  })

  it('三道门有一道不放行 / 没给门：不自动批', async () => {
    const h = harness()
    const failed = await h.txn.approvals.create(
      outboundInput({
        dedupe_key: 'dk_auto_4',
        automation: L2,
        context: {
          ...ctx,
          gates: [...PASS_ALL.slice(0, 2), { ...pass('commitment_scan'), status: 'fail' }],
          confident_reply: confident,
        },
      }),
    )
    expect(failed.state).toBe('pending')
    const none = await h.txn.approvals.create(
      outboundInput({
        dedupe_key: 'dk_auto_5',
        automation: L2,
        context: { ...ctx, confident_reply: confident },
      }),
    )
    expect(none.state).toBe('pending')
  })

  it('收件人不是线程原参与者：blocked（收件人门禁在自动批之前）', async () => {
    const h = harness()
    const item = await h.txn.approvals.create(
      outboundInput({
        dedupe_key: 'dk_auto_6',
        automation: L2,
        context: {
          thread_participants: ['someone_else'],
          gates: PASS_ALL,
          confident_reply: confident,
        },
      }),
    )
    expect(item.state).toBe('blocked')
  })

  it('收件人待定（manual_send）：不自动批', async () => {
    const h = harness()
    const item = await h.txn.approvals.create(
      outboundInput({
        dedupe_key: 'dk_auto_7',
        automation: L2,
        payload: { channel: 'email', manual_send: true, body: { text: 'hi' } },
        evidence: {
          run_id: 'run_1',
          source_events: [],
          provenance: { seen: [THREAD] },
          precheck: {},
        },
        context: { gates: PASS_ALL, confident_reply: confident },
      }),
    )
    expect(item.state).toBe('pending')
  })

  it('额度外：不自动批', async () => {
    const h = harness()
    const item = await h.txn.approvals.create(
      outboundInput({
        dedupe_key: 'dk_auto_8',
        automation: { ...L2, mandate_check: { within: false, caps_hit: ['per_day'] } },
        context: { ...ctx, gates: PASS_ALL, confident_reply: confident },
      }),
    )
    expect(item.state).toBe('pending')
  })
})
