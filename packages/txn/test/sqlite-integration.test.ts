/**
 * 换存储不换行为：整条 stage → decide → apply 链路跑在 SQLite 档上，
 * 并证明 15 §5.8 的 `unknown` **跨进程重启**仍在对账队列里、`reconcile()` 能接着处理。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SqliteTxnStore } from '../src/sqlite-store.js'
import { harness, refundStage, tokenOf } from './helpers.js'

describe('SqliteTxnStore · 端到端', () => {
  let dir = ''
  let dbPath = ''
  const open: SqliteTxnStore[] = []

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agentsws-txn-e2e-'))
    dbPath = join(dir, 'txn.sqlite')
  })
  afterEach(() => {
    for (const s of open.splice(0)) s.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const store = (): SqliteTxnStore => {
    const s = new SqliteTxnStore({ dbPath })
    open.push(s)
    return s
  }

  it('stage → approve → apply 全程落盘，事件与内存档一致', async () => {
    const s = store()
    const h = harness({ store: s, records: { 'order:ord_1042': { record_version: 'v1' } } })
    const staged = await h.txn.ledger.stage(refundStage())
    if (!staged.ok) throw new Error(staged.message)
    expect(s.getChange(staged.change.id)?.status).toBe('staged')
    expect(s.getMandate(staged.change.id)?.caps.max_auto_refund_amount).toBe(50)
    expect(s.countReserved(staged.change.reservation?.counter ?? '')).toBe(1)

    await h.txn.approvals.decide(staged.approval.id, 'p_wang', {
      decision_token: tokenOf(staged.approval),
      action: 'approve',
      via: 'workstation',
    })
    expect(s.isApproved(staged.change.id)).toBe(true)

    h.clock.advance(121_000)
    const out = await h.txn.executor.apply(staged.change.id)
    expect(out.status).toBe('applied')
    expect(s.getChange(staged.change.id)?.status).toBe('applied')
    expect(s.reservationOf(staged.change.id)?.state).toBe('committed')
    expect(s.eventIds(staged.approval.id).length).toBeGreaterThan(0)
    expect(h.typesOf('change.applied')).toHaveLength(1)
  })

  it('15 §5.8：apply 拿到 unknown → 关库重开后仍在对账队列，reconcile 接着处理', async () => {
    const first = store()
    const h1 = harness({
      store: first,
      records: { 'order:ord_1042': { record_version: 'v1' } },
      backend: () => ({ status: 'unknown', execution_id: 'exec_lost' }),
    })
    const staged = await h1.txn.ledger.stage(refundStage())
    if (!staged.ok) throw new Error(staged.message)
    await h1.txn.approvals.decide(staged.approval.id, 'p_wang', {
      decision_token: tokenOf(staged.approval),
      action: 'approve',
      via: 'workstation',
    })
    h1.clock.advance(121_000)
    expect((await h1.txn.executor.apply(staged.change.id)).status).toBe('unknown')
    // 进程在这里退出：预占不释放，等对账
    first.close()

    const second = store()
    expect(second.pendingReconcile().map((c) => c.id)).toEqual([staged.change.id])
    expect(second.countReserved(staged.change.reservation?.counter ?? '')).toBe(1)

    const h2 = harness({ store: second, records: { 'order:ord_1042': { record_version: 'v1' } } })
    const done = await h2.txn.executor.reconcile(staged.change.id, {
      status: 'applied',
      execution_id: 'exec_lost',
      outcome_ref: { type: 'refund', id: 'ref_1' },
    })
    expect(done.status).toBe('applied')
    expect(second.pendingReconcile()).toEqual([])
    expect(second.reservationOf(staged.change.id)?.state).toBe('committed')
    // 游标记到哪条，重启后也在
    second.setCursor('reconcile', staged.change.id)
    expect(store().getCursor('reconcile')).toBe(staged.change.id)
  })

  it('15 §5.8：明确失败在重启后释放预占，且不进对账队列', async () => {
    const first = store()
    const h = harness({
      store: first,
      records: { 'order:ord_1042': { record_version: 'v1' } },
      backend: () => ({ status: 'failed', error: { message: '上游拒绝' } }),
    })
    const staged = await h.txn.ledger.stage(refundStage())
    if (!staged.ok) throw new Error(staged.message)
    await h.txn.approvals.decide(staged.approval.id, 'p_wang', {
      decision_token: tokenOf(staged.approval),
      action: 'approve',
      via: 'workstation',
    })
    h.clock.advance(121_000)
    expect((await h.txn.executor.apply(staged.change.id)).status).toBe('failed')
    first.close()

    const second = store()
    expect(second.getChange(staged.change.id)?.status).toBe('failed')
    expect(second.countReserved(staged.change.reservation?.counter ?? '')).toBe(0)
    expect(second.pendingReconcile()).toEqual([])
  })
})
