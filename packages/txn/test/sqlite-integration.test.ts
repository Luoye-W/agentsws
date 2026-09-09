/**
 * 换存储不换行为：整条 stage → decide → apply 链路跑在 SQLite 档上，
 * 并证明 15 §5.8 的 `unknown` **跨进程重启**仍在对账队列里、`reconcile()` 能接着处理。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SqliteTxnStore } from '../src/sqlite-store.js'
import type { BackendResult } from '../src/types.js'
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

/**
 * 31 §3.2「同目标同 kind 的 apply 串行（单一施行者队列）」的**跨进程**那一半。
 *
 * 两个 `SqliteTxnStore` 连同一个库文件 = 两个服务进程（桌面壳重启 sidecar 时
 * 老进程还没死透，就是这个局面）。WP4 的 Promise 链只管得住自己那个进程。
 */
describe('跨进程施行锁 + 围栏号（WP4 遗留）', () => {
  let dir = ''
  let dbPath = ''
  const open: SqliteTxnStore[] = []

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agentsws-txn-lock-'))
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

  /** stage → approve → 过取消窗口，返回一条随时可 apply 的变更 id。 */
  async function readyChange(s: SqliteTxnStore): Promise<{ change_id: string }> {
    const h = harness({ store: s, records: { 'order:ord_1042': { record_version: 'v1' } } })
    const staged = await h.txn.ledger.stage(refundStage())
    if (!staged.ok) throw new Error(staged.message)
    await h.txn.approvals.decide(staged.approval.id, 'p_wang', {
      decision_token: tokenOf(staged.approval),
      action: 'approve',
      via: 'workstation',
    })
    return { change_id: staged.change.id }
  }

  it('两个进程同时 apply 同一条变更：一个赢，另一个回 conflict，后端只被叫一次', async () => {
    const s = store()
    const { change_id } = await readyChange(s)

    // 两个执行器 = 两个进程。各自的后端故意卡住，好让两次 apply 真的重叠。
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const a = harness({
      store: store(),
      start: '2026-09-07T09:05:00.000Z',
      records: { 'order:ord_1042': { record_version: 'v1' } },
      backend: async () => {
        await gate
        return { status: 'ok', execution_id: 'exec_a' }
      },
    })
    const b = harness({
      store: store(),
      start: '2026-09-07T09:05:00.000Z',
      records: { 'order:ord_1042': { record_version: 'v1' } },
    })

    const first = a.txn.executor.apply(change_id)
    // b 在 a 还卡在后端里的时候进来
    const second = b.txn.executor.apply(change_id).then(
      (out) => ({ ok: true as const, out }),
      (err: unknown) => ({ ok: false as const, err }),
    )
    const loser = await second
    release()
    const winner = await first

    expect(winner.status).toBe('applied')
    expect(loser.ok).toBe(false)
    expect(loser.ok === false ? loser.err : undefined).toMatchObject({ code: 'conflict' })
    expect(a.backendCalls).toHaveLength(1)
    expect(b.backendCalls).toHaveLength(0)
  })

  it('赢家释放之后，另一个进程再来能拿到锁，且围栏号更大', async () => {
    const s = store()
    const { change_id } = await readyChange(s)
    const a = harness({
      store: store(),
      start: '2026-09-07T09:05:00.000Z',
      records: { 'order:ord_1042': { record_version: 'v1' } },
      backend: () => ({ status: 'failed', error: { message: '上游 500' } }),
    })
    const failed = await a.txn.executor.apply(change_id)
    expect(failed.status).toBe('failed')
    const firstToken = a.backendCalls[0]?.fencing_token ?? 0
    expect(firstToken).toBeGreaterThan(0)

    // 另一个进程重试同一个目标（另建一条变更走同一把锁）
    const b = harness({
      store: store(),
      start: '2026-09-07T09:06:00.000Z',
      records: { 'order:ord_1042': { record_version: 'v1' } },
    })
    const staged = await b.txn.ledger.stage(refundStage())
    if (!staged.ok) throw new Error(staged.message)
    await b.txn.approvals.decide(staged.approval.id, 'p_wang', {
      decision_token: tokenOf(staged.approval),
      action: 'approve',
      via: 'workstation',
    })
    b.clock.advance(121_000)
    const out = await b.txn.executor.apply(staged.change.id)
    expect(out.status).toBe('applied')
    expect(b.backendCalls[0]?.fencing_token).toBeGreaterThan(firstToken)
  })

  it('围栏号能拦住「租约过期后才醒过来」的老施行者', async () => {
    const s = store()
    // 老施行者拿了 1 号，然后卡住；租约只有 1 秒
    const stale = s.acquireApplyLock({
      key: 'order:ord_1042|refund',
      holder: 'exec_stale',
      now: '2026-09-07T09:00:00.000Z',
      leaseMs: 1000,
    })
    expect(stale?.token).toBe(1)

    // 五分钟后另一个进程接管：租约早过期了，锁拿得到，**号更大**
    const { change_id } = await readyChange(s)
    const fresh = harness({
      store: store(),
      start: '2026-09-07T09:05:00.000Z',
      records: { 'order:ord_1042': { record_version: 'v1' } },
    })
    const out = await fresh.txn.executor.apply(change_id)
    expect(out.status).toBe('applied')
    const freshToken = fresh.backendCalls[0]?.fencing_token ?? 0
    expect(freshToken).toBeGreaterThan(stale?.token ?? 0)

    // 这就是后端该怎么用这个号：记下见过的最大号，比它小的一律拒。
    // 老施行者此刻醒过来、拿着 1 号去写，被自己的号挡在门外。
    let highest = 0
    const fencedBackend = (token: number): BackendResult => {
      if (token < highest) return { status: 'failed', error: { message: 'fenced_out' } }
      highest = token
      return { status: 'ok', execution_id: `exec_${token}` }
    }
    expect(fencedBackend(freshToken)).toMatchObject({ status: 'ok' })
    expect(fencedBackend(stale?.token ?? 0)).toMatchObject({
      status: 'failed',
      error: { message: 'fenced_out' },
    })
  })
})
