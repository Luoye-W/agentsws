import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createSqliteTxnStore, SqliteTxnStore } from '../src/sqlite-store.js'
import type { TxnStore } from '../src/types.js'
import { approval, change, runTxnStoreConformance } from './store-conformance.js'

/** 一致性套件第二遍：SQLite 档。行为必须与内存档逐字一致。 */
runTxnStoreConformance({
  name: 'SqliteTxnStore',
  make: () => new SqliteTxnStore(),
  dispose: (s: TxnStore) => {
    ;(s as SqliteTxnStore).close()
  },
})

// ── SQLite 档独有：重启、并发、迁移幂等
describe('SqliteTxnStore · 落盘特性', () => {
  const withDir = <T>(fn: (dir: string) => T): T => {
    const dir = mkdtempSync(join(tmpdir(), 'agentsws-txn-'))
    try {
      return fn(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('重启（关库再开）后状态保持：审批项、token、变更、预占、批准标记、游标', () => {
    withDir((dir) => {
      const dbPath = join(dir, 'txn.sqlite')
      const first = new SqliteTxnStore({ dbPath })
      first.transaction(() => {
        first.putChange(change({ status: 'approved' }))
        first.putMandate('chg_1', { caps: { max_auto_refund_amount: 50 } })
        first.reserve('ctr_a', 'chg_1', 1)
        first.markApproved('chg_1')
      })
      first.putApproval(approval({ state: 'approved' }))
      first.pushRevision(approval({ revision: 1 }))
      first.pushEventId('itm_1', 'evt_a')
      first.putContext('itm_1', { change_id: 'chg_1' })
      first.putToken({
        token: 'dt_a',
        item_id: 'itm_1',
        revision: 1,
        snapshot_hash: 'snap_1',
        person: 'per_1',
        issued_at: '2026-09-07T09:00:00.000Z',
        revoked: false,
      })
      first.putProvenance({
        run_id: 'run_5',
        seen: { 'order:ord_1': ['status'] },
        read_full: [],
        recorded_at: '2026-09-07T09:00:00.000Z',
      })
      first.setCursor('reconcile', 'chg_1')
      first.close()

      const second = new SqliteTxnStore({ dbPath })
      expect(second.getChange('chg_1')?.status).toBe('approved')
      expect(second.isApproved('chg_1')).toBe(true)
      expect(second.countReserved('ctr_a')).toBe(1)
      expect(second.getApproval('itm_1')?.state).toBe('approved')
      expect(second.revisions('itm_1')).toHaveLength(1)
      expect(second.eventIds('itm_1')).toEqual(['evt_a'])
      expect(second.getContext('itm_1')?.change_id).toBe('chg_1')
      expect(second.getToken('dt_a')?.snapshot_hash).toBe('snap_1')
      expect(second.getMandate('chg_1')?.caps.max_auto_refund_amount).toBe(50)
      expect(second.getProvenance('run_5')?.seen).toEqual({ 'order:ord_1': ['status'] })
      expect(second.getCursor('reconcile')).toBe('chg_1')
      second.close()
    })
  })

  it('15 §5.8：重启后 unknown 仍在对账队列里，游标接着走', () => {
    withDir((dir) => {
      const dbPath = join(dir, 'txn.sqlite')
      const first = new SqliteTxnStore({ dbPath })
      first.putChange(change({ id: 'chg_1', status: 'unknown' }))
      first.putChange(change({ id: 'chg_2', status: 'unknown' }))
      first.putChange(change({ id: 'chg_3', status: 'applied' }))
      // 第一条对完账，游标推进；进程在这里崩溃
      first.transaction(() => {
        first.putChange(change({ id: 'chg_1', status: 'applied' }))
        first.setCursor('reconcile', 'chg_1')
      })
      first.close()

      const second = new SqliteTxnStore({ dbPath })
      expect(second.getCursor('reconcile')).toBe('chg_1')
      expect(second.pendingReconcile().map((c) => c.id)).toEqual(['chg_2'])
      second.close()
    })
  })

  it('transaction：中途抛异常整组回滚（预占不会只落一半）', () => {
    const s = new SqliteTxnStore()
    s.putChange(change())
    expect(() =>
      s.transaction(() => {
        s.reserve('ctr_a', 'chg_1', 1)
        s.markApproved('chg_1')
        throw new Error('backend 崩了')
      }),
    ).toThrow('backend 崩了')
    expect(s.countReserved('ctr_a')).toBe(0)
    expect(s.isApproved('chg_1')).toBe(false)
    expect(s.getChange('chg_1')?.id).toBe('chg_1')
    s.close()
  })

  it('迁移幂等：同一个库开两次不报错，版本号不重复涨', () => {
    withDir((dir) => {
      const dbPath = join(dir, 'txn.sqlite')
      const first = new SqliteTxnStore({ dbPath })
      const v = first.schemaVersion
      expect(v).toBeGreaterThan(0)
      first.close()
      const second = new SqliteTxnStore({ dbPath })
      expect(second.schemaVersion).toBe(v)
      const rows = second.database
        .prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM _migrations')
        .get()
      expect(rows?.n).toBe(v)
      second.close()
    })
  })

  it('createSqliteTxnStore：工厂返回可用实例，缺省内存库', () => {
    const s = createSqliteTxnStore()
    s.putChange(change())
    expect(s.getChange('chg_1')?.id).toBe('chg_1')
    expect(s.schemaVersion).toBeGreaterThan(0)
    s.close()
  })

  it('close 幂等：关两次不抛', () => {
    const s = new SqliteTxnStore()
    s.close()
    expect(() => {
      s.close()
    }).not.toThrow()
  })

  it('同一个库文件两个连接：一边写另一边立刻读得到（预占计数不重复）', () => {
    withDir((dir) => {
      const dbPath = join(dir, 'txn.sqlite')
      const a = new SqliteTxnStore({ dbPath })
      const b = new SqliteTxnStore({ dbPath })
      a.reserve('ctr_a', 'chg_1', 1)
      b.reserve('ctr_a', 'chg_2', 1)
      // 同一条变更被两边各占一次：主键是 change_id，计数不会翻倍
      a.reserve('ctr_a', 'chg_2', 1)
      expect(a.countReserved('ctr_a')).toBe(2)
      expect(b.countReserved('ctr_a')).toBe(2)
      a.close()
      b.close()
    })
  })
})
