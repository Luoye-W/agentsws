/**
 * WP232（10-05 真模型实测）：**收件人待定的回信草稿卡**。
 *
 * 人在任务里贴了一封红人来信、让 Agent 起草回复——事项上没有来信人，找不到能替人发的收件地址。
 * 以前这一步回 `undefined`，草稿就丢了。现在出一张 `manual_send` 的卡：
 *
 * - 预检**不**拿收件人门禁拦它（没有收件人，也就不会发错人）；其余几道（围栏、密钥）照旧；
 * - 批了**一个渠道都不碰**：直接记 applied，outcome 是 `manual_send`；
 * - 带了 `to` 的卡就不是它——标记绕不过收件人门禁。
 */
import { describe, expect, it } from 'vitest'
import { isManualSendDraft } from '../src/index.js'
import { harness, outboundInput, THREAD, tokenOf } from './helpers.js'

const manualPayload = {
  channel: 'email',
  manual_send: true,
  body: { subject: 'Re: Earbuds collab', text: 'Hi, thanks for getting back to me.' },
}

describe('WP232：收件人待定的回信草稿卡', () => {
  it('判据：manual_send 为真且没有 to', () => {
    expect(isManualSendDraft(manualPayload)).toBe(true)
    expect(isManualSendDraft({ ...manualPayload, to: { type: 'contact', id: 'c1' } })).toBe(false)
    expect(isManualSendDraft({ ...manualPayload, manual_send: 'yes' })).toBe(false)
    expect(isManualSendDraft(undefined)).toBe(false)
  })

  it('建得出来（不被收件人门禁拦），批了不碰任何渠道、直接记 applied', async () => {
    const h = harness()
    const item = await h.txn.approvals.create(
      outboundInput({
        payload: manualPayload,
        evidence: {
          run_id: 'run_5',
          source_events: [],
          provenance: { seen: [THREAD] },
          precheck: {},
        },
        context: {},
      }),
    )
    expect(item.state).toBe('pending')
    expect(item.evidence.precheck.notes?.join('')).toContain('收件人待定')
    const approved = await h.txn.approvals.decide(item.id, 'p_wang', {
      decision_token: tokenOf(item),
      action: 'approve',
      via: 'workstation',
    })
    expect(approved.state).toBe('approved')
    h.clock.advance(121_000)
    const out = await h.txn.executor.applyApproval(item.id)
    expect(out.state).toBe('applied')
    expect(out.apply?.outcome_ref).toEqual({ type: 'manual_send', id: item.id })
    // 一封都没发：施行回调一次都没被叫
    expect(h.backendCalls).toEqual([])
  })

  it('带了 to 的卡不算：照旧过收件人门禁（标记绕不过去）', async () => {
    const h = harness()
    const item = await h.txn.approvals.create(
      outboundInput({
        payload: { ...manualPayload, to: { type: 'customer', id: 'cus_stranger' } },
        evidence: {
          run_id: 'run_5',
          source_events: [],
          provenance: { seen: [THREAD, { type: 'customer', id: 'cus_stranger' }] },
          precheck: {},
        },
        context: {},
      }),
    )
    expect(item.state).toBe('blocked')
  })

  it('其余预检照旧：正文里有卡号形态照样拦', async () => {
    const h = harness()
    const item = await h.txn.approvals.create(
      outboundInput({
        payload: {
          ...manualPayload,
          body: { subject: 'Re', text: 'card 4111 1111 1111 1111 exp 12/29' },
        },
        evidence: {
          run_id: 'run_5',
          source_events: [],
          provenance: { seen: [THREAD] },
          precheck: {},
        },
        context: {},
      }),
    )
    expect(item.state).toBe('blocked')
  })
})
