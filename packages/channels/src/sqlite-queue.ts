/**
 * 入站队列 + 去重表的 SQLite 档（WP18）。接口与内存档一致——
 * 同一份契约一致性套件对两档各跑一遍。
 *
 * 18 §2.2 要求入站这一跳「去重 / 死信 / 重试」都落盘：
 * - **去重键**：24h 窗口，`prune` 丢窗口外的
 * - **重试**：`attempts` 与 `next_at_ms`（退避时间）都在行上，重启后接着退避
 * - **死信**：单独一张表，按 workspace 可翻
 * - **租约**：`claim` 领走时写 `lease_until_ms`；进程崩在半路不删不改，
 *   租约到期后这条自动回到可领取状态（"崩溃中途的项重启后回到可领取"）
 *
 * 纪律：所有 SQL 参数化；`better-sqlite3` 同步 API；时间由调用方按注入的 Clock 传进来。
 */

import type { Clock, InboundEvent, WorkspaceId } from '@agentsws/contracts'
import type { Database as Db } from 'better-sqlite3'
import Database from 'better-sqlite3'
import { type Migration, migrate, schemaVersion } from './migrations.js'
import type { DedupeStore, Seen } from './pipeline.js'
import type { DeadLetterRecord, QueueItem, QueueStore } from './queue.js'

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    sql: `
CREATE TABLE IF NOT EXISTS queue (
  id             TEXT PRIMARY KEY NOT NULL,
  lane           TEXT NOT NULL,
  workspace_id   TEXT NOT NULL,
  role_id        TEXT,
  attempts       INTEGER NOT NULL,
  next_at_ms     INTEGER NOT NULL,
  last_error     TEXT,
  lease_until_ms INTEGER,
  event          TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS queue_due  ON queue (next_at_ms, lease_until_ms);
CREATE INDEX IF NOT EXISTS queue_lane ON queue (lane);

CREATE TABLE IF NOT EXISTS dead_letters (
  id           TEXT PRIMARY KEY NOT NULL,
  lane         TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  role_id      TEXT,
  reason       TEXT NOT NULL,
  attempts     INTEGER NOT NULL,
  last_error   TEXT,
  at_ms        INTEGER NOT NULL,
  event        TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS dead_by_ws ON dead_letters (workspace_id);

CREATE TABLE IF NOT EXISTS dedupe (
  key   TEXT PRIMARY KEY NOT NULL,
  at_ms INTEGER NOT NULL,
  event TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS dedupe_by_age ON dedupe (at_ms);
`,
  },
]

export interface SqliteChannelStoreOptions {
  /** SQLite 文件路径；缺省 `:memory:`。 */
  dbPath?: string
  /** 迁移记时间用；不给则用固定占位时刻（不裸调 Date.now）。 */
  clock?: Clock
}

const EPOCH = '1970-01-01T00:00:00.000Z'

interface QueueRow {
  id: string
  lane: string
  workspace_id: string
  role_id: string | null
  attempts: number
  next_at_ms: number
  last_error: string | null
  lease_until_ms: number | null
  event: string
}

interface DeadRow {
  id: string
  lane: string
  workspace_id: string
  role_id: string | null
  reason: string
  attempts: number
  last_error: string | null
  at_ms: number
  event: string
}

/** 打开（或新建）一张渠道库，供队列与去重表共用一个连接。 */
function openDb(options: SqliteChannelStoreOptions): Db {
  const db = new Database(options.dbPath ?? ':memory:')
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')
  migrate(db, MIGRATIONS, options.clock?.now() ?? EPOCH)
  return db
}

export class SqliteQueueStore implements QueueStore {
  readonly #db: Db
  readonly #owned: boolean
  #closed = false

  constructor(options: SqliteChannelStoreOptions | { database: Db } = {}) {
    if ('database' in options) {
      this.#db = options.database
      this.#owned = false
    } else {
      this.#db = openDb(options)
      this.#owned = true
    }
  }

  get schemaVersion(): number {
    return schemaVersion(this.#db)
  }

  /** 底层连接；只给同包测试与「同库共用一个连接」用。 */
  get database(): Db {
    return this.#db
  }

  close(): void {
    if (this.#closed || !this.#owned) return
    this.#closed = true
    this.#db.close()
  }

  #item(row: QueueRow): QueueItem {
    return {
      id: row.id,
      lane: row.lane,
      workspace_id: row.workspace_id,
      attempts: row.attempts,
      next_at_ms: row.next_at_ms,
      event: JSON.parse(row.event) as InboundEvent,
      ...(row.role_id === null ? {} : { role_id: row.role_id }),
      ...(row.last_error === null ? {} : { last_error: row.last_error }),
      ...(row.lease_until_ms === null ? {} : { lease_until_ms: row.lease_until_ms }),
    }
  }

  put(item: QueueItem): void {
    this.#db
      .prepare(
        `INSERT INTO queue (id, lane, workspace_id, role_id, attempts, next_at_ms,
                            last_error, lease_until_ms, event)
         VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           lane           = excluded.lane,
           workspace_id   = excluded.workspace_id,
           role_id        = excluded.role_id,
           attempts       = excluded.attempts,
           next_at_ms     = excluded.next_at_ms,
           last_error     = excluded.last_error,
           lease_until_ms = excluded.lease_until_ms,
           event          = excluded.event`,
      )
      .run(
        item.id,
        item.lane,
        item.workspace_id,
        item.role_id ?? null,
        item.attempts,
        item.next_at_ms,
        item.last_error ?? null,
        item.lease_until_ms ?? null,
        JSON.stringify(item.event),
      )
  }

  remove(id: string): void {
    this.#db.prepare('DELETE FROM queue WHERE id = ?').run(id)
  }

  due(now_ms: number): QueueItem[] {
    return this.#db
      .prepare<[number, number], QueueRow>(
        `SELECT * FROM queue
          WHERE next_at_ms <= ? AND IFNULL(lease_until_ms, 0) <= ?
          ORDER BY next_at_ms, rowid`,
      )
      .all(now_ms, now_ms)
      .map((r) => this.#item(r))
  }

  all(): QueueItem[] {
    return this.#db
      .prepare<[], QueueRow>('SELECT * FROM queue ORDER BY rowid')
      .all()
      .map((r) => this.#item(r))
  }

  /** 领取 + 打租约在同一个事务里，两个领取方不会拿到同一条。 */
  claim(now_ms: number, lease_ms: number, limit?: number): QueueItem[] {
    const take = limit ?? -1 // SQLite 的 LIMIT -1 = 不限
    const claimed = this.#db.transaction((): QueueRow[] => {
      const rows = this.#db
        .prepare<[number, number, number], QueueRow>(
          `SELECT * FROM queue
            WHERE next_at_ms <= ? AND IFNULL(lease_until_ms, 0) <= ?
            ORDER BY next_at_ms, rowid
            LIMIT ?`,
        )
        .all(now_ms, now_ms, take)
      const lease = this.#db.prepare('UPDATE queue SET lease_until_ms = ? WHERE id = ?')
      for (const r of rows) lease.run(now_ms + lease_ms, r.id)
      return rows
    })
    return claimed.immediate().map((r) => this.#item({ ...r, lease_until_ms: now_ms + lease_ms }))
  }

  putDead(record: DeadLetterRecord): void {
    this.#db
      .prepare(
        `INSERT INTO dead_letters (id, lane, workspace_id, role_id, reason, attempts,
                                   last_error, at_ms, event)
         VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           lane         = excluded.lane,
           workspace_id = excluded.workspace_id,
           role_id      = excluded.role_id,
           reason       = excluded.reason,
           attempts     = excluded.attempts,
           last_error   = excluded.last_error,
           at_ms        = excluded.at_ms,
           event        = excluded.event`,
      )
      .run(
        record.id,
        record.lane,
        record.workspace_id,
        record.role_id ?? null,
        record.reason,
        record.attempts,
        record.last_error ?? null,
        record.at_ms,
        JSON.stringify(record.event),
      )
  }

  deadLetters(workspace_id: WorkspaceId): DeadLetterRecord[] {
    return this.#db
      .prepare<[string], DeadRow>(
        'SELECT * FROM dead_letters WHERE workspace_id = ? ORDER BY rowid',
      )
      .all(workspace_id)
      .map((row) => ({
        id: row.id,
        lane: row.lane,
        workspace_id: row.workspace_id,
        reason: row.reason,
        attempts: row.attempts,
        at_ms: row.at_ms,
        event: JSON.parse(row.event) as InboundEvent,
        ...(row.role_id === null ? {} : { role_id: row.role_id }),
        ...(row.last_error === null ? {} : { last_error: row.last_error }),
      }))
  }

  get size(): number {
    return this.#db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM queue').get()?.n ?? 0
  }
}

/** 18 §2.2 去重键（24h 窗口）的 SQLite 档。 */
export class SqliteDedupeStore implements DedupeStore {
  readonly #db: Db
  readonly #owned: boolean
  #closed = false

  constructor(options: SqliteChannelStoreOptions | { database: Db } = {}) {
    if ('database' in options) {
      this.#db = options.database
      this.#owned = false
    } else {
      this.#db = openDb(options)
      this.#owned = true
    }
  }

  get database(): Db {
    return this.#db
  }

  close(): void {
    if (this.#closed || !this.#owned) return
    this.#closed = true
    this.#db.close()
  }

  get(key: string): Seen | undefined {
    const row = this.#db
      .prepare<[string], { at_ms: number; event: string }>(
        'SELECT at_ms, event FROM dedupe WHERE key = ?',
      )
      .get(key)
    return row === undefined
      ? undefined
      : { at_ms: row.at_ms, event: JSON.parse(row.event) as InboundEvent }
  }

  set(key: string, seen: Seen): void {
    this.#db
      .prepare(
        `INSERT INTO dedupe (key, at_ms, event) VALUES (?,?,?)
         ON CONFLICT(key) DO UPDATE SET at_ms = excluded.at_ms, event = excluded.event`,
      )
      .run(key, seen.at_ms, JSON.stringify(seen.event))
  }

  prune(before_ms: number): void {
    this.#db.prepare('DELETE FROM dedupe WHERE at_ms < ?').run(before_ms)
  }

  get size(): number {
    return this.#db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM dedupe').get()?.n ?? 0
  }
}

/** 一张库、一个连接，同时给队列与去重表用（`apps/server` 的装配走这条）。 */
export function createSqliteChannelStores(options: SqliteChannelStoreOptions = {}): {
  queue: SqliteQueueStore
  dedupe: SqliteDedupeStore
  close(): void
} {
  const database = openDb(options)
  const queue = new SqliteQueueStore({ database })
  const dedupe = new SqliteDedupeStore({ database })
  let closed = false
  return {
    queue,
    dedupe,
    close(): void {
      if (closed) return
      closed = true
      database.close()
    },
  }
}
