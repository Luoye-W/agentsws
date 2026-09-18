/**
 * 钱包的 sqlite 档（{@link WalletStore} 的第二份实现）。
 *
 * WP114 之后这个文件里只剩**两件 better-sqlite3 才有的事**：开库（WAL / 外键）
 * 与拿住那个连接。三张表、全部 SQL 与全部语义在 `sql-store.ts`——它写在同步
 * SQL 口（`@agentsws/core/sql/sync-db`）上，Cloudflare Workers 形态的
 * Durable Object 用的是同一份，**业务 SQL 与迁移只写一遍**。
 *
 * 签名一个都没动：`createSqliteWalletStore({ dbPath, now, db? })` 与它返回的
 * `SqliteWalletStore`（含 `db` 与 `sweepReservations`）原样在。
 */
import type { Iso8601 } from '@agentsws/contracts'
import { syncDbFromBetterSqlite } from '@agentsws/core/sql/sync-db'
import type { Database as Db } from 'better-sqlite3'
import Database from 'better-sqlite3'
import { createSqlWalletStore } from './sql-store.js'
import type { WalletStore } from './wallet.js'

export { WALLET_MIGRATIONS } from './sql-store.js'

export interface SqliteWalletStoreOptions {
  /** 库文件路径；`:memory:` 也行（测试用）。 */
  dbPath: string
  now: () => Iso8601
  /** 已经开好的库（宿主想与别的表共用一个连接时给它）。 */
  db?: Db
}

export interface SqliteWalletStore extends WalletStore {
  readonly db: Db
  /**
   * 扫掉太老的预扣（进程崩在 reserve 与 settle 之间留下的孤儿）。
   * 不扫的话那些积分就永远被占住——用户看到余额少了一块，却找不到是哪一笔。
   */
  sweepReservations(olderThan: Iso8601): number
  close(): void
}

export function createSqliteWalletStore(options: SqliteWalletStoreOptions): SqliteWalletStore {
  const db = options.db ?? new Database(options.dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  const inner = createSqlWalletStore({ db: syncDbFromBetterSqlite(db), now: options.now })
  return {
    db,
    lots: (org_id) => inner.lots(org_id),
    addLot: (lot) => {
      inner.addLot(lot)
    },
    consume: (lot_id, credits) => {
      inner.consume(lot_id, credits)
    },
    lotBySourceRef: (org_id, source_ref) => inner.lotBySourceRef(org_id, source_ref),
    reservations: (org_id) => inner.reservations(org_id),
    putReservation: (r) => {
      inner.putReservation(r)
    },
    dropReservation: (id) => {
      inner.dropReservation(id)
    },
    appendEvent: (e) => {
      inner.appendEvent(e)
    },
    events: (filter) => inner.events(filter),
    sweepReservations: (olderThan) => inner.sweepReservations(olderThan),
    close: () => {
      db.close()
    },
  }
}
