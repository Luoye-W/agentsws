/**
 * 28 §2 幂等表的 SQLite 档（WP18）。接口与 {@link MemoryIdempotencyStore} 一致——
 * 同一份契约一致性套件对两档各跑一遍。
 *
 * - 24h TTL：读时按 `nowMs` 判过期（过期即当作没有并顺手删掉），
 *   批量清理走 `sweep(clock)`，时间一律经注入的 Clock，不裸调 `Date.now()`
 * - 同键不同 body 的判定不在这里——存的是 `fingerprint`，网关比对后抛 `idempotency_conflict`
 * - 所有 SQL 参数化；`better-sqlite3` 同步 API
 */

import type { Clock } from '@agentsws/contracts'
import type { Database as Db } from 'better-sqlite3'
import Database from 'better-sqlite3'
import {
  DEFAULT_IDEMPOTENCY_TTL_MS,
  type IdempotencyRecord,
  type IdempotencyStore,
} from './idempotency.js'
import { type Migration, migrate, schemaVersion } from './sqlite-migrations.js'

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    sql: `
CREATE TABLE IF NOT EXISTS idempotency (
  scope        TEXT    NOT NULL,
  key          TEXT    NOT NULL,
  fingerprint  TEXT    NOT NULL,
  status       INTEGER NOT NULL,
  body         TEXT    NOT NULL,
  content_type TEXT    NOT NULL,
  stored_at    INTEGER NOT NULL,
  PRIMARY KEY (scope, key)
) STRICT;
CREATE INDEX IF NOT EXISTS idempotency_by_age ON idempotency (stored_at);
`,
  },
]

export interface SqliteIdempotencyOptions {
  /** SQLite 文件路径；缺省 `:memory:`。 */
  dbPath?: string
  /** 保留时长，默认 24h（28 §2）。 */
  ttlMs?: number
  /** 迁移记时间用；不给则用固定占位时刻（不裸调 Date.now）。 */
  clock?: Clock
}

interface Row {
  fingerprint: string
  status: number
  body: string
  content_type: string
  stored_at: number
}

const EPOCH = '1970-01-01T00:00:00.000Z'

export class SqliteIdempotencyStore implements IdempotencyStore {
  readonly #db: Db
  readonly #ttl: number
  #closed = false

  constructor(options: SqliteIdempotencyOptions = {}) {
    this.#ttl = options.ttlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS
    this.#db = new Database(options.dbPath ?? ':memory:')
    this.#db.pragma('journal_mode = WAL')
    migrate(this.#db, MIGRATIONS, options.clock?.now() ?? EPOCH)
  }

  get schemaVersion(): number {
    return schemaVersion(this.#db)
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
    const row = this.#db
      .prepare<[string, string], Row>(
        `SELECT fingerprint, status, body, content_type, stored_at
           FROM idempotency WHERE scope = ? AND key = ?`,
      )
      .get(scope, key)
    if (row === undefined) return undefined
    if (nowMs - row.stored_at >= this.#ttl) {
      this.#db.prepare('DELETE FROM idempotency WHERE scope = ? AND key = ?').run(scope, key)
      return undefined
    }
    return {
      fingerprint: row.fingerprint,
      status: row.status,
      body: row.body,
      content_type: row.content_type,
      stored_at: row.stored_at,
    }
  }

  put(scope: string, key: string, record: IdempotencyRecord): void {
    this.#db
      .prepare(
        `INSERT INTO idempotency (scope, key, fingerprint, status, body, content_type, stored_at)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(scope, key) DO UPDATE SET
           fingerprint  = excluded.fingerprint,
           status       = excluded.status,
           body         = excluded.body,
           content_type = excluded.content_type,
           stored_at    = excluded.stored_at`,
      )
      .run(
        scope,
        key,
        record.fingerprint,
        record.status,
        record.body,
        record.content_type,
        record.stored_at,
      )
  }

  /** 过期清理（由宿主定时调用；时间经 Clock，不裸调 Date.now）。返回删掉的条数。 */
  sweep(clock: Clock): number {
    const now = Date.parse(clock.now())
    return this.#db
      .prepare<[number]>('DELETE FROM idempotency WHERE stored_at <= ?')
      .run(now - this.#ttl).changes
  }

  /** 表里现有的条数（观察面，测试用）。 */
  get size(): number {
    return (
      this.#db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM idempotency').get()?.n ?? 0
    )
  }
}

export function createSqliteIdempotencyStore(
  options: SqliteIdempotencyOptions = {},
): SqliteIdempotencyStore {
  return new SqliteIdempotencyStore(options)
}
