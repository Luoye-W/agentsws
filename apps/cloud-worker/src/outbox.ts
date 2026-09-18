/**
 * 抄写的待补队列（WP115 / 65 §9）。
 *
 * 它住在**源头那一侧**（`WalletDO`），不在 Ledger 里——重投的责任属于写的那一方。
 *
 * 一条纪律：**抄写绝不阻塞扣费，也绝不回滚扣费**。`settle()` 已经把钱从 lot 里
 * 扣掉了，那件事已经发生；抄一份给看板是"顺便"。所以：
 *
 * 1. 每次 `appendEvent` 之后把这一条塞进队列（同步、同一张库、同一个事务边界内）；
 * 2. 请求结束时走 `ctx.waitUntil(flush)`——**在响应之后**，用户不等它；
 * 3. flush 失败就留在队列里，alarm 时再试。重投是安全的（Ledger 那一头有唯一索引）。
 * 4. 重试次数记在行上，只用来**报警**，不用来丢弃：一条抄不进去的账，扔掉比留着更糟。
 */

import { migrate } from '@agentsws/api'
import type { MeteringEvent, WalletLot } from '@agentsws/contracts'
import type { SyncDb } from '@agentsws/core/sql/sync-db'
import { eventIdOf } from '@agentsws/metering'

export const OUTBOX_MIGRATIONS_TABLE = '_outbox_migrations'

export const OUTBOX_MIGRATIONS = [
  {
    version: 1,
    sql: `
-- 待抄给 Ledger 的行。kind = 'event' | 'lot'，payload 是那条记录的 JSON。
-- **这里不存正文**：payload 里只有计量事件（十六列）或一笔 lot，与库里那两张表同形。
CREATE TABLE IF NOT EXISTS ledger_outbox (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  kind     TEXT NOT NULL,
  key      TEXT NOT NULL,
  payload  TEXT NOT NULL,
  at       TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);

-- 同一条记录只排一次队（事件按 event_id，lot 按 lot id）
CREATE UNIQUE INDEX IF NOT EXISTS ledger_outbox_key ON ledger_outbox (kind, key);
`,
  },
]

interface OutboxRow {
  id: number
  kind: string
  key: string
  payload: string
  attempts: number
}

export interface Outbox {
  /** 排一条队（同步，就在扣费那一跳里）。 */
  push(kind: 'event' | 'lot', key: string, payload: unknown, at: string): void
  /** 取一批待抄的。 */
  take(limit?: number): { events: MeteringEvent[]; lots: WalletLot[]; ids: number[] }
  /** 抄成了就删。 */
  done(ids: number[]): void
  /** 抄失败：`attempts + 1`，行留着。 */
  failed(ids: number[]): void
  /** 还有多少条没抄出去（健康页那一格）。 */
  size(): number
  /** 试过多少次还没成的最大值（报警用）。 */
  worstAttempts(): number
}

export function createOutbox(db: SyncDb, now: () => string): Outbox {
  migrate(db, OUTBOX_MIGRATIONS, now(), { table: OUTBOX_MIGRATIONS_TABLE })
  const insert = db.prepare(
    `INSERT INTO ledger_outbox (kind, key, payload, at, attempts) VALUES (?, ?, ?, ?, 0)
     ON CONFLICT(kind, key) DO UPDATE SET payload = excluded.payload`,
  )
  const select = db.prepare<OutboxRow>(
    'SELECT id, kind, key, payload, attempts FROM ledger_outbox ORDER BY id LIMIT ?',
  )
  const count = db.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM ledger_outbox')
  const worst = db.prepare<{ n: number | null }>('SELECT MAX(attempts) AS n FROM ledger_outbox')

  return {
    push(kind, key, payload, at) {
      insert.run(kind, key, JSON.stringify(payload), at)
    },

    take(limit = 100) {
      const rows = select.all(limit)
      const events: MeteringEvent[] = []
      const lots: WalletLot[] = []
      const ids: number[] = []
      for (const row of rows) {
        ids.push(row.id)
        try {
          const parsed: unknown = JSON.parse(row.payload)
          if (row.kind === 'event') events.push(parsed as MeteringEvent)
          else lots.push(parsed as WalletLot)
        } catch {
          // 坏行（几乎不可能）：留在 ids 里一起删掉，否则它会永远堵着队头
        }
      }
      return { events, lots, ids }
    },

    done(ids) {
      if (ids.length === 0) return
      const holes = ids.map(() => '?').join(', ')
      db.prepare(`DELETE FROM ledger_outbox WHERE id IN (${holes})`).run(...ids)
    },

    failed(ids) {
      if (ids.length === 0) return
      const holes = ids.map(() => '?').join(', ')
      db.prepare(`UPDATE ledger_outbox SET attempts = attempts + 1 WHERE id IN (${holes})`).run(
        ...ids,
      )
    },

    size: () => count.get()?.n ?? 0,
    worstAttempts: () => worst.get()?.n ?? 0,
  }
}

/** 事件的排队键：与 Ledger 那一头的幂等键**同一串**。 */
export const outboxEventKey = (e: MeteringEvent): string => eventIdOf(e)
