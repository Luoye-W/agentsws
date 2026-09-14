/**
 * WP55 / 48 §4 L3 #3 #2：guardrail 前置多四条。
 *
 * 三道「不自主」的门（`l3_denylist` / `draft_origin` / `commitment_scan`）
 * **只记录不改状态**——门说「不自主」不等于这张卡不该建，只等于它不能自己发出去。
 * Amazon 出站硬闸（`amazon_outbound`）不同：它是「这封信根本不能这样发出去」，
 * 命中就 blocked，重写指令原样回给起草那一跳。
 */
import type { GateDecision } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { runPrecheck } from '../src/index.js'
import { CUSTOMER, harness, outboundInput, THREAD } from './helpers.js'

const HASH = 'a'.repeat(64)

const gate = (
  g: GateDecision['gate'],
  status: GateDecision['status'],
  reason?: string,
): GateDecision => ({
  gate: g,
  status,
  ruleset_hash: HASH,
  ...(reason === undefined ? {} : { reason }),
})

const ctx = {
  thread_participants: [CUSTOMER.id, THREAD.id],
  verified_contacts: [CUSTOMER.id],
}

describe('三道门：只记录不改状态（15 前置）', () => {
  it('不装口子 = 不判：三个字段都不写，`autonomous` 是 undefined 而不是 true', () => {
    const out = runPrecheck(outboundInput(), ctx)
    expect(out.precheck.l3_denylist).toBeUndefined()
    expect(out.precheck.draft_origin).toBeUndefined()
    expect(out.precheck.commitment_scan).toBeUndefined()
    // 「没问过」与「问过了说可以」在自主发送这件事上必须分得开
    expect(out.autonomous).toBeUndefined()
    expect(out.gate_decisions).toBeUndefined()
  })

  it('三条全 pass → 可以自主发，卡照常进队列', () => {
    const out = runPrecheck(outboundInput(), {
      ...ctx,
      gates: [
        gate('l3_denylist', 'pass'),
        gate('draft_origin', 'pass'),
        gate('commitment_scan', 'pass'),
      ],
    })
    expect(out.autonomous).toBe(true)
    expect(out.precheck.l3_denylist).toBe('ok')
    expect(out.blocked).toEqual([])
  })

  it('任一条 fail → 不自主，但**不 blocked**：卡照常建，只是要人按', () => {
    const out = runPrecheck(outboundInput(), {
      ...ctx,
      gates: [
        gate('l3_denylist', 'fail', 'l3_intent:refund'),
        gate('draft_origin', 'pass'),
        gate('commitment_scan', 'pass'),
      ],
    })
    expect(out.autonomous).toBe(false)
    expect(out.precheck.l3_denylist).toBe('fail')
    // 这是本条的要害：门不改状态
    expect(out.blocked).toEqual([])
    expect(out.precheck.notes?.join('\n')).toContain('l3_intent:refund')
    // 规则集哈希进 notes（自主发送审计链的锚）
    expect(out.precheck.notes?.join('\n')).toContain(HASH.slice(0, 12))
  })

  it('gate_error 与 fail 分得开（一个写崩的正则不该被当成"确实命中"）', () => {
    const out = runPrecheck(outboundInput(), {
      ...ctx,
      gates: [
        gate('l3_denylist', 'gate_error', 'boom'),
        gate('draft_origin', 'pass'),
        gate('commitment_scan', 'pass'),
      ],
    })
    expect(out.precheck.l3_denylist).toBe('gate_error')
    // fail-closed：门炸了同样不自主
    expect(out.autonomous).toBe(false)
  })

  it('门的结论原样带出来给调用方落事件', () => {
    const gates = [
      gate('l3_denylist', 'pass'),
      gate('draft_origin', 'fail', 'draft_not_ai'),
      gate('commitment_scan', 'pass'),
    ]
    const out = runPrecheck(outboundInput(), { ...ctx, gates })
    expect(out.gate_decisions).toEqual(gates)
  })
})

describe('Amazon 出站硬闸：这封信根本不能这样发出去', () => {
  it('ok → 记一笔就过', () => {
    const out = runPrecheck(outboundInput(), { ...ctx, amazon_outbound: { ok: true } })
    expect(out.precheck.amazon_outbound).toBe('ok')
    expect(out.blocked).toEqual([])
  })

  it('不 ok → blocked，重写指令原样进 notes（打回重写，不静默删改）', () => {
    const out = runPrecheck(outboundInput(), {
      ...ctx,
      amazon_outbound: {
        ok: false,
        codes: ['external_link', 'emoji'],
        rewrite_instruction: '请去掉正文里的站外链接与 emoji',
      },
    })
    expect(out.precheck.amazon_outbound).toBe('fail')
    expect(out.blocked).toContain('amazon_outbound')
    const notes = out.precheck.notes?.join('\n') ?? ''
    expect(notes).toContain('external_link, emoji')
    expect(notes).toContain('请去掉正文里的站外链接与 emoji')
  })

  it('只对 outbound_draft 判（staged_change 不是"发信"）', () => {
    const out = runPrecheck(
      { ...outboundInput(), kind: 'knowledge_update' },
      { ...ctx, amazon_outbound: { ok: false, codes: ['emoji'] } },
    )
    expect(out.precheck.amazon_outbound).toBeUndefined()
    expect(out.blocked).not.toContain('amazon_outbound')
  })
})

describe('guardrail.gate_decided：只记门名与结论', () => {
  it('建卡时落一条事件，payload 里只有门名 / 结论 / 规则 id', async () => {
    const h = harness()
    await h.txn.approvals.create({
      ...outboundInput(),
      context: {
        ...ctx,
        gates: [
          gate('l3_denylist', 'pass'),
          gate('draft_origin', 'fail', 'draft_not_ai'),
          gate('commitment_scan', 'pass'),
        ],
      },
    })
    const decided = h.events.find((e) => e.type === 'guardrail.gate_decided')
    expect(decided).toBeDefined()
    const payload = decided?.payload as {
      autonomous: boolean
      ruleset_hash: string
      gates: { gate: string; status: string }[]
    }
    expect(payload.autonomous).toBe(false)
    expect(payload.ruleset_hash).toBe(HASH)
    expect(payload.gates.map((g) => g.gate)).toEqual([
      'l3_denylist',
      'draft_origin',
      'commitment_scan',
    ])
    // 被扫的客户原文与草稿正文一个字都不进日志
    expect(JSON.stringify(decided)).not.toContain('we will refund you')
  })

  it('不装门就不发这条事件（老路径一个字不用改）', async () => {
    const h = harness()
    await h.txn.approvals.create({ ...outboundInput(), context: ctx })
    expect(h.events.some((e) => e.type === 'guardrail.gate_decided')).toBe(false)
  })
})
