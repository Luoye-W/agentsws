/**
 * 28 §2 幂等表的 SQLite 档（WP18）。接口与 {@link MemoryIdempotencyStore} 一致——
 * 同一份契约一致性套件对两档各跑一遍。
 *
 * WP114 之后这里只剩**两件 better-sqlite3 才有的事**：开库、关库。
 * 表结构、SQL 与全部语义都在 `sql-idempotency.ts`（写在同步 SQL 口 `SyncDb` 上），
 * Workers 形态的 Durable Object 用的是同一份。
 *
 * - 24h TTL：读时按 `nowMs` 判过期（过期即当作没有并顺手删掉），
 *   批量清理走 `sweep(clock)`，时间一律经注入的 Clock，不裸调 `Date.now()`
 * - 同键不同 body 的判定不在这里——存的是 `fingerprint`，网关比对后抛 `idempotency_conflict`
 * - 所有 SQL 参数化；`better-sqlite3` 同步 API
 */

import type { Clock } from '@agentsws/contracts'
import { syncDbFromBetterSqlite } from '@agentsws/core/sql/sync-db'
import type { Database as Db } from 'better-sqlite3'
import Database from 'better-sqlite3'
import type { IdempotencyRecord, IdempotencyStore } from './idempotency.js'
import { IDEMPOTENCY_EPOCH, SqlIdempotencyStore } from './sql-idempotency.js'

export interface SqliteIdempotencyOptions {
  /** SQLite 文件路径；缺省 `:memory:`。 */
  dbPath?: string
  /** 保留时长，默认 24h（28 §2）。 */
  ttlMs?: number
  /** 迁移记时间用；不给则用固定占位时刻（不裸调 Date.now）。 */
  clock?: Clock
}

export class SqliteIdempotencyStore implements IdempotencyStore {
  readonly #db: Db
  readonly #inner: SqlIdempotencyStore
  #closed = false

  constructor(options: SqliteIdempotencyOptions = {}) {
    this.#db = new Database(options.dbPath ?? ':memory:')
    this.#db.pragma('journal_mode = WAL')
    this.#inner = new SqlIdempotencyStore({
      db: syncDbFromBetterSqlite(this.#db),
      ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
      clock: options.clock ?? { now: () => IDEMPOTENCY_EPOCH },
    })
  }

  get schemaVersion(): number {
    return this.#inner.schemaVersion
  }

  /** 底层连接；只给同包测试用。 */
  get database(): Db {
    return this.#db
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#db.close()
  }

  get(scope: string, key: string, nowMs: number): IdempotencyRecord | undefined {
    return this.#inner.get(scope, key, nowMs)
  }

  put(scope: string, key: string, record: IdempotencyRecord): void {
    this.#inner.put(scope, key, record)
  }

  /** 过期清理（由宿主定时调用；时间经 Clock，不裸调 Date.now）。返回删掉的条数。 */
  sweep(clock: Clock): number {
    return this.#inner.sweep(clock)
  }

  /** 表里现有的条数（观察面，测试用）。 */
  get size(): number {
    return this.#inner.size
  }
}

export function createSqliteIdempotencyStore(
  options: SqliteIdempotencyOptions = {},
): SqliteIdempotencyStore {
  return new SqliteIdempotencyStore(options)
}
