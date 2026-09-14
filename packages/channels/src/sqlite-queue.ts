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

import type { Clock, InboundEvent, Iso8601, WorkspaceId } from '@agentsws/contracts'
import type { Database as Db } from 'better-sqlite3'
import Database from 'better-sqlite3'
import type { FolderCursor, FolderSyncFault, MailboxStateStore } from './email/cursors.js'
import { type Migration, migrate, schemaVersion } from './migrations.js'
import type { ConfirmationSource, OutboxRecord, OutboxStore } from './outbox.js'
import { ACCEPTED_RECONCILE_GRACE_MS, MAX_RECONCILE_ATTEMPTS } from './outbox.js'
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
  {
    // WP55 / 48 §4 L3 #4：出站 outbox。这张表是「能不能发、是不是已经发了、要不要
    // 对账」的唯一持久权威——SMTP 抛异常不等于这封信没发出去。
    version: 2,
    sql: `
CREATE TABLE IF NOT EXISTS outbox (
  id                        TEXT PRIMARY KEY NOT NULL,
  workspace_id              TEXT NOT NULL,
  idempotency_key           TEXT NOT NULL,
  approval_item_id          TEXT,
  thread_ref                TEXT NOT NULL,
  payload_hash              TEXT NOT NULL,
  message_id                TEXT NOT NULL,
  status                    TEXT NOT NULL,
  attempts                  INTEGER NOT NULL,
  next_at_ms                INTEGER,
  reconcile_attempts        INTEGER NOT NULL,
  reconcile_next_at_ms      INTEGER,
  reconcile_exhausted_at_ms INTEGER,
  confirmation_source       TEXT,
  external_id               TEXT,
  last_error                TEXT,
  created_at_ms             INTEGER NOT NULL,
  updated_at_ms             INTEGER NOT NULL
) STRICT;
-- 同一工作区同一幂等键只有一行：这就是「同一审批项只发一次」的落地处。
CREATE UNIQUE INDEX IF NOT EXISTS outbox_idem ON outbox (workspace_id, idempotency_key);
CREATE INDEX IF NOT EXISTS outbox_reconcile ON outbox (status, reconcile_next_at_ms);
CREATE INDEX IF NOT EXISTS outbox_by_ws ON outbox (workspace_id);
`,
  },
  {
    // WP55 / 48 §4 L3 #5：邮箱加固的三样——每文件夹 UID 游标、毒消息隔离、扫描租约。
    version: 3,
    sql: `
CREATE TABLE IF NOT EXISTS folder_cursors (
  account       TEXT NOT NULL,
  folder        TEXT NOT NULL,
  uid_validity  INTEGER NOT NULL,
  last_seen_uid INTEGER NOT NULL,
  PRIMARY KEY (account, folder)
) STRICT;

CREATE TABLE IF NOT EXISTS folder_sync_faults (
  account        TEXT NOT NULL,
  folder         TEXT NOT NULL,
  failed_uid     INTEGER,
  fail_count     INTEGER NOT NULL,
  last_error     TEXT,
  last_failed_at TEXT,
  skipped_uids   TEXT NOT NULL,
  PRIMARY KEY (account, folder)
) STRICT;

CREATE TABLE IF NOT EXISTS scan_leases (
  account        TEXT PRIMARY KEY NOT NULL,
  owner          TEXT NOT NULL,
  expires_at_ms  INTEGER NOT NULL
) STRICT;
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

  deadLetter(id: string): DeadLetterRecord | undefined {
    const row = this.#db
      .prepare<[string], DeadRow>('SELECT * FROM dead_letters WHERE id = ?')
      .get(id)
    return row === undefined
      ? undefined
      : {
          id: row.id,
          lane: row.lane,
          workspace_id: row.workspace_id,
          reason: row.reason,
          attempts: row.attempts,
          at_ms: row.at_ms,
          event: JSON.parse(row.event) as InboundEvent,
          ...(row.role_id === null ? {} : { role_id: row.role_id }),
          ...(row.last_error === null ? {} : { last_error: row.last_error }),
        }
  }

  removeDead(id: string): void {
    this.#db.prepare('DELETE FROM dead_letters WHERE id = ?').run(id)
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

interface OutboxRow {
  id: string
  workspace_id: string
  idempotency_key: string
  approval_item_id: string | null
  thread_ref: string
  payload_hash: string
  message_id: string
  status: string
  attempts: number
  next_at_ms: number | null
  reconcile_attempts: number
  reconcile_next_at_ms: number | null
  reconcile_exhausted_at_ms: number | null
  confirmation_source: string | null
  external_id: string | null
  last_error: string | null
  created_at_ms: number
  updated_at_ms: number
}

/** WP55 / 48 §4 L3 #4：出站 outbox 的 SQLite 档（接口与内存档一致）。 */
export class SqliteOutboxStore implements OutboxStore {
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

  #row(row: OutboxRow): OutboxRecord {
    return {
      id: row.id,
      workspace_id: row.workspace_id,
      idempotency_key: row.idempotency_key,
      thread_ref: row.thread_ref,
      payload_hash: row.payload_hash,
      message_id: row.message_id,
      status: row.status as OutboxRecord['status'],
      attempts: row.attempts,
      reconcile_attempts: row.reconcile_attempts,
      created_at_ms: row.created_at_ms,
      updated_at_ms: row.updated_at_ms,
      ...(row.approval_item_id === null ? {} : { approval_item_id: row.approval_item_id }),
      ...(row.next_at_ms === null ? {} : { next_at_ms: row.next_at_ms }),
      ...(row.reconcile_next_at_ms === null
        ? {}
        : { reconcile_next_at_ms: row.reconcile_next_at_ms }),
      ...(row.reconcile_exhausted_at_ms === null
        ? {}
        : { reconcile_exhausted_at_ms: row.reconcile_exhausted_at_ms }),
      ...(row.confirmation_source === null
        ? {}
        : { confirmation_source: row.confirmation_source as ConfirmationSource }),
      ...(row.external_id === null ? {} : { external_id: row.external_id }),
      ...(row.last_error === null ? {} : { last_error: row.last_error }),
    }
  }

  get(id: string): OutboxRecord | undefined {
    const row = this.#db.prepare<[string], OutboxRow>('SELECT * FROM outbox WHERE id = ?').get(id)
    return row === undefined ? undefined : this.#row(row)
  }

  byIdempotencyKey(workspace_id: WorkspaceId, key: string): OutboxRecord | undefined {
    const row = this.#db
      .prepare<[string, string], OutboxRow>(
        'SELECT * FROM outbox WHERE workspace_id = ? AND idempotency_key = ?',
      )
      .get(workspace_id, key)
    return row === undefined ? undefined : this.#row(row)
  }

  put(record: OutboxRecord): void {
    this.#db
      .prepare(
        `INSERT INTO outbox (id, workspace_id, idempotency_key, approval_item_id, thread_ref,
                             payload_hash, message_id, status, attempts, next_at_ms,
                             reconcile_attempts, reconcile_next_at_ms, reconcile_exhausted_at_ms,
                             confirmation_source, external_id, last_error,
                             created_at_ms, updated_at_ms)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           status                    = excluded.status,
           attempts                  = excluded.attempts,
           next_at_ms                = excluded.next_at_ms,
           reconcile_attempts        = excluded.reconcile_attempts,
           reconcile_next_at_ms      = excluded.reconcile_next_at_ms,
           reconcile_exhausted_at_ms = excluded.reconcile_exhausted_at_ms,
           confirmation_source       = excluded.confirmation_source,
           external_id               = excluded.external_id,
           last_error                = excluded.last_error,
           updated_at_ms             = excluded.updated_at_ms`,
      )
      .run(
        record.id,
        record.workspace_id,
        record.idempotency_key,
        record.approval_item_id ?? null,
        record.thread_ref,
        record.payload_hash,
        record.message_id,
        record.status,
        record.attempts,
        record.next_at_ms ?? null,
        record.reconcile_attempts,
        record.reconcile_next_at_ms ?? null,
        record.reconcile_exhausted_at_ms ?? null,
        record.confirmation_source ?? null,
        record.external_id ?? null,
        record.last_error ?? null,
        record.created_at_ms,
        record.updated_at_ms,
      )
  }

  dueForReconcile(now_ms: number, limit?: number): OutboxRecord[] {
    return this.#db
      .prepare<[number, number, number, number, number], OutboxRow>(
        `SELECT * FROM outbox
          WHERE reconcile_exhausted_at_ms IS NULL
            AND (
              (status = 'sent_unknown'
                 AND IFNULL(reconcile_next_at_ms, 0) <= ?
                 AND reconcile_attempts < ?)
              OR (status = 'accepted_by_provider' AND updated_at_ms + ? <= ?)
            )
          ORDER BY IFNULL(reconcile_next_at_ms, 0), rowid
          LIMIT ?`,
      )
      .all(now_ms, MAX_RECONCILE_ATTEMPTS, ACCEPTED_RECONCILE_GRACE_MS, now_ms, limit ?? -1)
      .map((r) => this.#row(r))
  }

  list(workspace_id: WorkspaceId): OutboxRecord[] {
    return this.#db
      .prepare<[string], OutboxRow>('SELECT * FROM outbox WHERE workspace_id = ? ORDER BY rowid')
      .all(workspace_id)
      .map((r) => this.#row(r))
  }
}

/**
 * WP55 / 48 §4 L3 #5：邮箱状态（游标 / 隔离 / 租约）的 SQLite 档。
 *
 * 租约的领取是**一条条件 UPDATE + 一条条件 INSERT**，包在一个事务里：
 * 「先查有没有人占着，再写上自己」这种写法，两个进程同时跑就会双双拿到。
 */
export class SqliteMailboxStateStore implements MailboxStateStore {
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

  cursor(account: string, folder: string): FolderCursor | undefined {
    const row = this.#db
      .prepare<[string, string], { folder: string; uid_validity: number; last_seen_uid: number }>(
        'SELECT folder, uid_validity, last_seen_uid FROM folder_cursors WHERE account = ? AND folder = ?',
      )
      .get(account, folder)
    return row === undefined ? undefined : { ...row }
  }

  setCursor(account: string, cursor: FolderCursor): void {
    this.#db
      .prepare(
        `INSERT INTO folder_cursors (account, folder, uid_validity, last_seen_uid)
         VALUES (?,?,?,?)
         ON CONFLICT(account, folder) DO UPDATE SET
           uid_validity  = excluded.uid_validity,
           last_seen_uid = excluded.last_seen_uid`,
      )
      .run(account, cursor.folder, cursor.uid_validity, cursor.last_seen_uid)
  }

  #fault(row: {
    folder: string
    failed_uid: number | null
    fail_count: number
    last_error: string | null
    last_failed_at: string | null
    skipped_uids: string
  }): FolderSyncFault {
    return {
      folder: row.folder,
      fail_count: row.fail_count,
      skipped_uids: JSON.parse(row.skipped_uids) as number[],
      ...(row.failed_uid === null ? {} : { failed_uid: row.failed_uid }),
      ...(row.last_error === null ? {} : { last_error: row.last_error }),
      ...(row.last_failed_at === null ? {} : { last_failed_at: row.last_failed_at as Iso8601 }),
    }
  }

  fault(account: string, folder: string): FolderSyncFault | undefined {
    const row = this.#db
      .prepare<
        [string, string],
        {
          folder: string
          failed_uid: number | null
          fail_count: number
          last_error: string | null
          last_failed_at: string | null
          skipped_uids: string
        }
      >('SELECT * FROM folder_sync_faults WHERE account = ? AND folder = ?')
      .get(account, folder)
    return row === undefined ? undefined : this.#fault(row)
  }

  faults(account: string): FolderSyncFault[] {
    return this.#db
      .prepare<
        [string],
        {
          folder: string
          failed_uid: number | null
          fail_count: number
          last_error: string | null
          last_failed_at: string | null
          skipped_uids: string
        }
      >('SELECT * FROM folder_sync_faults WHERE account = ? ORDER BY folder')
      .all(account)
      .map((r) => this.#fault(r))
  }

  setFault(account: string, fault: FolderSyncFault): void {
    this.#db
      .prepare(
        `INSERT INTO folder_sync_faults
           (account, folder, failed_uid, fail_count, last_error, last_failed_at, skipped_uids)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(account, folder) DO UPDATE SET
           failed_uid     = excluded.failed_uid,
           fail_count     = excluded.fail_count,
           last_error     = excluded.last_error,
           last_failed_at = excluded.last_failed_at,
           skipped_uids   = excluded.skipped_uids`,
      )
      .run(
        account,
        fault.folder,
        fault.failed_uid ?? null,
        fault.fail_count,
        fault.last_error ?? null,
        fault.last_failed_at ?? null,
        JSON.stringify(fault.skipped_uids),
      )
  }

  claimScanLease(account: string, owner: string, now_ms: number, ttl_ms: number): boolean {
    const claim = this.#db.transaction((): boolean => {
      // 条件 UPDATE：只有"没人占着 / 过期了 / 就是我"才改得动
      const updated = this.#db
        .prepare(
          `UPDATE scan_leases SET owner = ?, expires_at_ms = ?
            WHERE account = ? AND (expires_at_ms <= ? OR owner = ?)`,
        )
        .run(owner, now_ms + ttl_ms, account, now_ms, owner)
      if (updated.changes > 0) return true
      // 还没有这一行：条件 INSERT（`OR IGNORE` 在别人抢先时不炸）
      const inserted = this.#db
        .prepare('INSERT OR IGNORE INTO scan_leases (account, owner, expires_at_ms) VALUES (?,?,?)')
        .run(account, owner, now_ms + ttl_ms)
      return inserted.changes > 0
    })
    return claim.immediate()
  }

  releaseScanLease(account: string, owner: string): void {
    this.#db.prepare('DELETE FROM scan_leases WHERE account = ? AND owner = ?').run(account, owner)
  }
}

/** 一张库、一个连接，同时给队列与去重表用（`apps/server` 的装配走这条）。 */
export function createSqliteChannelStores(options: SqliteChannelStoreOptions = {}): {
  queue: SqliteQueueStore
  dedupe: SqliteDedupeStore
  outbox: SqliteOutboxStore
  mailbox: SqliteMailboxStateStore
  close(): void
} {
  const database = openDb(options)
  const queue = new SqliteQueueStore({ database })
  const dedupe = new SqliteDedupeStore({ database })
  const outbox = new SqliteOutboxStore({ database })
  const mailbox = new SqliteMailboxStateStore({ database })
  let closed = false
  return {
    queue,
    dedupe,
    outbox,
    mailbox,
    close(): void {
      if (closed) return
      closed = true
      database.close()
    },
  }
}
