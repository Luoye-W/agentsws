/**
 * 28 §2 幂等表，写在**同步 SQL 口**（{@link SyncDb}）上（WP114）。
 *
 * 这个文件里没有 `better-sqlite3`、也没有任何 Cloudflare 的东西——它只认一张能
 * `exec / prepare / transaction` 的库。于是同一张表、同一份迁移、同一套 SQL
 * 在两个地方跑：本机与 Compose 形态走 better-sqlite3（`sqlite-idempotency.ts`），
 * Workers 形态走 Durable Object 的 SQLite。
 *
 * 语义与 WP18 那一版一字不差：
 *
 * - 24h TTL：读时按 `nowMs` 判过期（过期即当作没有并顺手删掉），
 *   批量清理走 `sweep(clock)`，时间一律经注入的 Clock，不裸调 `Date.now()`
 * - 同键不同 body 的判定不在这里——存的是 `fingerprint`，网关比对后抛 `idempotency_conflict`
 * - 所有 SQL 参数化
 */

import type { Clock } from '@agentsws/contracts'
import type { SyncDb } from '@agentsws/core/sql/sync-db'
import {
  DEFAULT_IDEMPOTENCY_TTL_MS,
  type IdempotencyRecord,
  type SweepableIdempotencyStore,
} from './idempotency.js'
import { type Migration, migrate, schemaVersion } from './sqlite-migrations.js'

/** 幂等表的建表 SQL。两份实现共用这一份——表结构只写一遍。 */
export const IDEMPOTENCY_MIGRATIONS: readonly Migration[] = [
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

export const IDEMPOTENCY_EPOCH = '1970-01-01T00:00:00.000Z'

interface Row {
  fingerprint: string
  status: number
  body: string
  content_type: string
  stored_at: number
}

export interface SqlIdempotencyOptions {
  db: SyncDb
  /** 保留时长，默认 24h（28 §2）。 */
  ttlMs?: number
  /** 迁移记时间用；不给则用固定占位时刻（不裸调 Date.now）。 */
  clock?: Clock
}

export class SqlIdempotencyStore implements SweepableIdempotencyStore {
  readonly #db: SyncDb
  readonly #ttl: number

  constructor(options: SqlIdempotencyOptions) {
    this.#ttl = options.ttlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS
    this.#db = options.db
    migrate(this.#db, IDEMPOTENCY_MIGRATIONS, options.clock?.now() ?? IDEMPOTENCY_EPOCH)
  }

  get schemaVersion(): number {
    return schemaVersion(this.#db)
  }

  get(scope: string, key: string, nowMs: number): IdempotencyRecord | undefined {
    const row = this.#db
      .prepare<Row>(
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
    return this.#db.prepare('DELETE FROM idempotency WHERE stored_at <= ?').run(now - this.#ttl)
      .changes
  }

  /** 表里现有的条数（观察面，测试用）。 */
  get size(): number {
    return this.#db.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM idempotency').get()?.n ?? 0
  }
}
