import type { ApprovalExecutionContext, ObjectRef, ProvenanceState } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import type { ApprovalContext } from '../src/types.js'
import {
  CUSTOMER,
  harness,
  ORDER,
  outboundInput,
  RUN,
  refundStage,
  T0,
  THREAD,
  tokenOf,
} from './helpers.js'

const prov = (refs: ObjectRef[]): ProvenanceState => {
  const seen: Record<string, string[]> = {}
  for (const r of refs) seen[r.type] = [...(seen[r.type] ?? []), r.id]
  return { run_id: RUN, seen, read_full: [], recorded_at: T0 }
}

describe('31 §3.2 批准绑定执行快照 / 预占 / 串行 / unknown / 取消窗口 / 父子顺序', () => {
  it('旧 decision_token 批新 revision 被拒；新 token 可用', async () => {
    const h = harness()
    const v1 = await h.txn.approvals.create(outboundInput())
    const oldToken = tokenOf(v1)
    const v2 = await h.txn.approvals.create(outboundInput({ title: '改稿后的回信' }))
    expect(v2.revision).toBe(2)
    await expect(
      h.txn.approvals.decide(v2.id, 'p_wang', {
        decision_token: oldToken,
        action: 'approve',
        via: 'im_card',
      }),
    ).rejects.toMatchObject({ code: 'conflict' })
    const fresh = v2.deliveries.filter((d) => d.status === 'sent')[0]?.decision_token ?? ''
    const out = await h.txn.approvals.decide(v2.id, 'p_wang', {
      decision_token: fresh,
      action: 'approve',
      via: 'im_card',
    })
    expect(out.state).toBe('approved')
  })

  it('并发拆单被预占挡住：同日额度只剩一个名额时，第二条 require_review', async () => {
    const h = harness()
    const mandate = {
      caps: { max_auto_refund_amount: 50 },
      window: { max_count: 1, per: 'day' as const },
    }
    const a = await h.txn.ledger.stage(
      refundStage({
        target: { type: 'order', id: 'ord_A' },
        mandate,
        level: 'L2',
        provenance: prov([
          { type: 'order', id: 'ord_A' },
          { type: 'order', id: 'ord_B' },
          CUSTOMER,
        ]),
        target_owner: CUSTOMER,
      }),
    )
    const b = await h.txn.ledger.stage(
      refundStage({
        target: { type: 'order', id: 'ord_B' },
        change_set_id: 'cs_6',
        mandate,
        level: 'L2',
        provenance: prov([
          { type: 'order', id: 'ord_A' },
          { type: 'order', id: 'ord_B' },
          CUSTOMER,
        ]),
        target_owner: CUSTOMER,
      }),
    )
    expect(a.ok && a.change.guardrail.verdict).toBe('allow')
    expect(a.ok && a.change.reservation?.counter).toContain('refund')
    expect(b.ok && b.change.guardrail.verdict).toBe('require_review')
    expect(b.ok && b.change.guardrail.hits.map((x) => x.rule)).toContain('window')
  })

  it('同目标同 kind 的 apply 串行（单一施行者队列，不交叉）', async () => {
    const h = harness({ records: { 'order:ord_1042': { record_version: 'v1' } } })
    const log: string[] = []
    h.setBackend(async (_attempt, id) => {
      log.push(`enter:${id}`)
      await new Promise((r) => setTimeout(r, 5))
      log.push(`exit:${id}`)
      return { status: 'ok', execution_id: `exec_${id}` }
    })
    const ids: string[] = []
    for (const cs of ['cs_a', 'cs_b']) {
      const staged = await h.txn.ledger.stage(refundStage({ change_set_id: cs }))
      if (!staged.ok) throw new Error(staged.message)
      await h.txn.approvals.decide(staged.approval.id, 'p_wang', {
        decision_token: tokenOf(staged.approval),
        action: 'approve',
        via: 'workstation',
      })
      ids.push(staged.change.id)
    }
    h.clock.advance(121_000)
    await Promise.all(ids.map((id) => h.txn.executor.apply(id)))
    expect(log).toEqual([`enter:${ids[0]}`, `exit:${ids[0]}`, `enter:${ids[1]}`, `exit:${ids[1]}`])
  })

  it('apply 三态：unknown 后不释放预占，reconcile 确认已施行 → applied', async () => {
    const h = harness({
      records: { 'order:ord_1042': { record_version: 'v1' } },
      backend: () => ({ status: 'unknown', execution_id: 'exec_lost' }),
    })
    const staged = await h.txn.ledger.stage(refundStage())
    if (!staged.ok) throw new Error(staged.message)
    await h.txn.approvals.decide(staged.approval.id, 'p_wang', {
      decision_token: tokenOf(staged.approval),
      action: 'approve',
      via: 'workstation',
    })
    h.clock.advance(121_000)
    const out = await h.txn.executor.apply(staged.change.id)
    expect(out.status).toBe('unknown')
    expect(out.change.apply?.error?.code).toBe('unknown_outcome')
    expect(h.typesOf('change.unknown')).toHaveLength(1)
    expect(h.txn.runtime.store.countReserved(staged.change.reservation?.counter ?? '')).toBe(1)
    // 再次 apply 不会二次写
    const again = await h.txn.executor.apply(staged.change.id)
    expect(again.status).toBe('unknown')
    expect(h.backendCalls).toHaveLength(1)
    // 对账
    const done = await h.txn.executor.reconcile(staged.change.id, {
      status: 'applied',
      execution_id: 'exec_lost',
      outcome_ref: { type: 'refund', id: 'ref_1' },
    })
    expect(done.status).toBe('applied')
    expect(done.change.apply?.execution_id).toBe('exec_lost')
    expect((await h.txn.approvals.get(staged.approval.id))?.state).toBe('applied')
    await expect(
      h.txn.executor.reconcile(staged.change.id, { status: 'applied' }),
    ).rejects.toMatchObject({ code: 'conflict' })
  })

  it('批准后取消窗口：窗口内不施行、可 cancel；窗口过后可施行', async () => {
    const h = harness({ records: { 'order:ord_1042': { record_version: 'v1' } } })
    const staged = await h.txn.ledger.stage(refundStage())
    if (!staged.ok) throw new Error(staged.message)
    await h.txn.approvals.decide(staged.approval.id, 'p_wang', {
      decision_token: tokenOf(staged.approval),
      action: 'approve',
      via: 'workstation',
    })
    await expect(h.txn.executor.apply(staged.change.id)).rejects.toMatchObject({ code: 'conflict' })
    const cancelled = await h.txn.executor.cancel(staged.change.id)
    expect(cancelled.status).toBe('withdrawn')
    expect(cancelled.reservation?.released).toBe(true)
    expect(h.backendCalls).toHaveLength(0)

    // 另一条：窗口过后可施行，且窗口关闭后不能再 cancel
    const h2 = harness({ records: { 'order:ord_1042': { record_version: 'v1' } } })
    const s2 = await h2.txn.ledger.stage(refundStage())
    if (!s2.ok) throw new Error(s2.message)
    await h2.txn.approvals.decide(s2.approval.id, 'p_wang', {
      decision_token: tokenOf(s2.approval),
      action: 'approve',
      via: 'workstation',
    })
    h2.clock.advance(121_000)
    await expect(h2.txn.executor.cancel(s2.change.id)).rejects.toMatchObject({ code: 'conflict' })
    expect((await h2.txn.executor.apply(s2.change.id)).status).toBe('applied')
  })

  it('父子顺序：含退款子项的回信必须在退款 applied 之后才发', async () => {
    const h = harness({ records: { 'order:ord_1042': { record_version: 'v1' } } })
    const parent = await h.txn.approvals.create(outboundInput())
    const child = await h.txn.ledger.stage(refundStage({ approval: { parent: parent.id } }))
    if (!child.ok) throw new Error(child.message)
    const parentItem = await h.txn.approvals.get(parent.id)
    if (!parentItem) throw new Error('parent missing')
    h.txn.runtime.store.putApproval({ ...parentItem, links: { children: [child.approval.id] } })
    await h.txn.approvals.decide(parent.id, 'p_wang', {
      decision_token: tokenOf(parent),
      action: 'approve',
      via: 'workstation',
    })
    await h.txn.approvals.decide(child.approval.id, 'p_wang', {
      decision_token: tokenOf(child.approval),
      action: 'approve',
      via: 'workstation',
    })
    h.clock.advance(121_000)
    // 子项还没 applied → 父项不许发
    await expect(h.txn.executor.applyApproval(parent.id)).rejects.toMatchObject({
      code: 'conflict',
    })
    expect(await h.txn.executor.apply(child.change.id)).toMatchObject({ status: 'applied' })
    const sent = await h.txn.executor.applyApproval(parent.id)
    expect(sent.state).toBe('applied')
    expect(h.backendCalls.map((c) => c.key)).toEqual([child.change.id, parent.id])
  })

  it('执行快照绑定：批准后连接被换掉 → apply 时 snapshot_mismatch', async () => {
    const h = harness({ records: { 'order:ord_1042': { record_version: 'v1' } } })
    const staged = await h.txn.ledger.stage(refundStage())
    if (!staged.ok) throw new Error(staged.message)
    await h.txn.approvals.decide(staged.approval.id, 'p_wang', {
      decision_token: tokenOf(staged.approval),
      action: 'approve',
      via: 'workstation',
    })
    const ctx = h.txn.runtime.store.getContext(staged.approval.id) ?? {}
    h.txn.runtime.store.putContext(staged.approval.id, { ...ctx, connection_id: 'conn_other' })
    h.clock.advance(121_000)
    const out = await h.txn.executor.apply(staged.change.id)
    expect(out.error?.code).toBe('snapshot_mismatch')
    expect(out.error?.message).toContain('connection')
    expect(h.backendCalls).toHaveLength(0)
  })

  it('decision_token 绑定快照：审批项快照被改动后旧 token 失效', async () => {
    const h = harness()
    const item = await h.txn.approvals.create(outboundInput())
    const token = tokenOf(item)
    const tampered = { ...item, execution_snapshot: { hash: 'deadbeef', components: {} } }
    h.txn.runtime.store.putApproval(tampered)
    await expect(
      h.txn.approvals.decide(item.id, 'p_wang', {
        decision_token: token,
        action: 'approve',
        via: 'im_card',
      }),
    ).rejects.toMatchObject({ code: 'snapshot_mismatch' })
  })
})

describe('31 §3.3 关系授权与收件人门禁', () => {
  it('收件人不是线程原参与者也不是已验证联系方式 → blocked', async () => {
    const h = harness()
    const attacker = { type: 'customer', id: 'cus_999' } as const
    const item = await h.txn.approvals.create(
      outboundInput({
        payload: {
          channel: 'email',
          to: attacker,
          body: { subject: 'x', text: 'here is your refund' },
        },
        evidence: {
          run_id: RUN,
          source_events: [],
          provenance: { seen: [ORDER, THREAD, attacker] },
          precheck: {},
        },
        context: { thread_participants: [CUSTOMER.id] },
      }),
    )
    expect(item.state).toBe('blocked')
    expect(item.evidence.precheck.notes?.join(' ')).toContain('收件人')
  })

  it('已验证联系方式的收件人可通过门禁', async () => {
    const h = harness()
    const item = await h.txn.approvals.create(
      outboundInput({ context: { verified_contacts: [CUSTOMER.id], connection_id: 'conn_mail' } }),
    )
    expect(item.state).toBe('pending')
  })
})

describe('WP31：ApprovalBus.create 的 context 进契约（14 §4 / 31 §3.2 §3.3）', () => {
  it('契约类型就是包内类型：同一个对象两边都赋得进去', () => {
    // 编译期断言——`ApprovalContext` 只是契约 `ApprovalExecutionContext` 的别名了。
    const fromContract: ApprovalExecutionContext = {
      connection_id: 'conn_mail',
      record_version: 'v7',
      attachments: ['sha256:a'],
      mandate_hash: 'mh_1',
      change_id: 'chg_1',
      thread_participants: [CUSTOMER.id],
      verified_contacts: ['anna@example.com'],
      precheck_overrides: { secret_scan: 'clean' },
    }
    const asPackage: ApprovalContext = fromContract
    expect(asPackage).toBe(fromContract)
  })

  it('create 收下的 context 原样进上下文表，apply 前重算快照读的是同一份', async () => {
    const h = harness()
    const item = await h.txn.approvals.create(
      outboundInput({
        context: {
          connection_id: 'conn_mail',
          record_version: 'v7',
          attachments: ['sha256:b', 'sha256:a'],
          mandate_hash: 'mh_1',
          thread_participants: [CUSTOMER.id],
          verified_contacts: ['anna@example.com'],
        },
      }),
    )
    expect(h.txn.runtime.store.getContext(item.id)).toMatchObject({
      connection_id: 'conn_mail',
      record_version: 'v7',
      thread_participants: [CUSTOMER.id],
      verified_contacts: ['anna@example.com'],
    })
    expect(item.execution_snapshot?.hash).toBeTruthy()
  })

  it('审批项本体只带快照分量来源，门禁输入不跟着卡片走一圈', async () => {
    const h = harness()
    const item = await h.txn.approvals.create(
      outboundInput({
        context: {
          connection_id: 'conn_mail',
          record_version: 'v7',
          attachments: ['sha256:a'],
          mandate_hash: 'mh_1',
          change_id: 'chg_ctx',
          thread_participants: [CUSTOMER.id],
          verified_contacts: ['anna@example.com'],
        },
      }),
    )
    expect(item.execution_context).toEqual({
      connection_id: 'conn_mail',
      record_version: 'v7',
      attachments: ['sha256:a'],
      mandate_hash: 'mh_1',
      change_id: 'chg_ctx',
    })
    expect(JSON.stringify(item)).not.toContain('anna@example.com')
  })

  it('不给 context 时审批项的 execution_context 是空对象（不是 undefined 陷阱）', async () => {
    const h = harness()
    const item = await h.txn.approvals.create(outboundInput({ context: undefined }))
    expect(item.execution_context).toEqual({})
  })
})
