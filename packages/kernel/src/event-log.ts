/**
 * 事件日志（21 §1）：SQLite append-only 实现。
 *
 * - **只追加**：SQLite 触发器把 UPDATE / DELETE 直接 ABORT（21 §6 用例 1），应用层删不掉也改不掉；
 *   删除请求走 21 §4（销毁主体密钥 + `privacy.erased` 墓碑），不动这张表。
 * - **版本**：写入永远最新版（用例 2 前半）；旧版记录读出来经迁移器链升到最新形状（用例 2 后半、21 §5）。
 * - **信封**：无 `workspace_id` 拒写（用例 3），列上另有 NOT NULL + CHECK 兜底。
 * - **链式校验**：每条存 `hash`，并把上一条的 hash 写进 `prev_hash`（21 §1「可选链式校验」）。
 */

import { createHash } from 'node:crypto'
import type { EventEnvelope, EventId, EventLog, RunId, WorkspaceId } from '@agentsws/contracts'
import Database from 'better-sqlite3'
import type { Clock, Random } from './clock.js'
import { KernelError } from './errors.js'
import { createUlidFactory } from './ulid.js'

/** 当前事件信封版本；`append` 只接受这个版本（21 §5「写入永远最新版」）。 */
export const EVENT_SCHEMA_VERSION = 1

/**
 * 迁移器（upcaster）：把 `type` 在 `fromVersion` 上的 payload 升到 `fromVersion + 1`。
 * 链永久保留（21 §5），任何历史版本都能读到最新形状。
 */
export type Upcaster = (payload: unknown, event: Readonly<EventEnvelope>) => unknown

export interface SqliteEventLogOptions {
  /** SQLite 文件路径；缺省 `:memory:`。 */
  dbPath?: string
  clock: Clock
  random: Random
  /** 当前信封版本，缺省 {@link EVENT_SCHEMA_VERSION}；测试可下调以构造多级迁移链。 */
  schemaVersion?: number
}

export type EventInput<T extends string = string, P = unknown> = Omit<
  EventEnvelope<T, P>,
  'id' | 'at'
>

interface EventRow {
  id: string
  schema_version: number
  workspace_id: string
  type: string
  at: string
  actor_kind: string
  actor_id: string
  actor_run_id: string | null
  subject_type: string | null
  subject_id: string | null
  trace_id: string
  run_id: string | null
  work_item_id: string | null
  change_id: string | null
  execution_id: string | null
  payload: string
  payload_encrypted: string | null
  prev_hash: string | null
  hash: string
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id             TEXT    PRIMARY KEY NOT NULL,
  schema_version INTEGER NOT NULL,
  workspace_id   TEXT    NOT NULL CHECK (length(workspace_id) > 0),
  type           TEXT    NOT NULL CHECK (length(type) > 0),
  at             TEXT    NOT NULL,
  actor_kind     TEXT    NOT NULL CHECK (actor_kind IN ('person','agent','system','sentinel')),
  actor_id       TEXT    NOT NULL,
  actor_run_id   TEXT,
  subject_type   TEXT,
  subject_id     TEXT,
  trace_id       TEXT    NOT NULL CHECK (length(trace_id) > 0),
  run_id         TEXT,
  work_item_id   TEXT,
  change_id      TEXT,
  execution_id   TEXT,
  payload        TEXT    NOT NULL,
  payload_encrypted TEXT,
  prev_hash      TEXT,
  hash           TEXT    NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS events_by_workspace ON events (workspace_id, id);
CREATE INDEX IF NOT EXISTS events_by_run       ON events (run_id, id);
CREATE INDEX IF NOT EXISTS events_by_type      ON events (workspace_id, type, id);

-- 21 §1「从不 UPDATE / DELETE」：在存储层强制，任何路径（含直连 SQL）都改不动。
CREATE TRIGGER IF NOT EXISTS events_append_only_update
BEFORE UPDATE ON events
BEGIN SELECT RAISE(ABORT, 'event log is append-only: UPDATE rejected'); END;

CREATE TRIGGER IF NOT EXISTS events_append_only_delete
BEFORE DELETE ON events
BEGIN SELECT RAISE(ABORT, 'event log is append-only: DELETE rejected'); END;
`

const INSERT_SQL = `
INSERT INTO events (
  id, schema_version, workspace_id, type, at,
  actor_kind, actor_id, actor_run_id,
  subject_type, subject_id,
  trace_id, run_id, work_item_id, change_id, execution_id,
  payload, payload_encrypted, prev_hash, hash
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
`

const SELECT_COLUMNS = `
  id, schema_version, workspace_id, type, at,
  actor_kind, actor_id, actor_run_id,
  subject_type, subject_id,
  trace_id, run_id, work_item_id, change_id, execution_id,
  payload, payload_encrypted, prev_hash, hash
`

/** 稳定序列化（键排序），保证 hash 与 payload 存储不受属性顺序影响。 */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
}

function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new KernelError('invalid_input', `event requires a non-empty ${field}`)
  }
  return value
}

export class SqliteEventLog implements EventLog {
  readonly schemaVersion: number
  private readonly db: Database.Database
  private readonly nextId: () => string
  private readonly clock: Clock
  private readonly upcasters = new Map<string, Upcaster>()
  private closed = false

  constructor(options: SqliteEventLogOptions) {
    this.schemaVersion = options.schemaVersion ?? EVENT_SCHEMA_VERSION
    if (!Number.isInteger(this.schemaVersion) || this.schemaVersion < 1) {
      throw new KernelError('invalid_input', `schemaVersion must be a positive integer`)
    }
    this.clock = options.clock
    this.nextId = createUlidFactory(options.clock, options.random)
    this.db = new Database(options.dbPath ?? ':memory:')
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    this.db.exec(SCHEMA)
  }

  /** 底层连接；只给同包的一致性测试用（断言触发器行为），业务代码不得直连 SQL（21 §3）。 */
  get database(): Database.Database {
    return this.db
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.db.close()
  }

  /**
   * 注册迁移器（21 §5）。`type@fromVersion` 唯一，链永久保留，不允许覆盖已注册的一环——
   * 覆盖等于悄悄改写历史读法。
   */
  registerUpcaster(type: string, fromVersion: number, fn: Upcaster): void {
    requireNonEmpty(type, 'upcaster type')
    if (!Number.isInteger(fromVersion) || fromVersion < 1) {
      throw new KernelError('invalid_input', `upcaster fromVersion must be a positive integer`)
    }
    if (fromVersion >= this.schemaVersion) {
      throw new KernelError(
        'invalid_input',
        `upcaster fromVersion ${fromVersion} must be below the current schema_version ${this.schemaVersion}`,
      )
    }
    const key = `${type}@${fromVersion}`
    if (this.upcasters.has(key)) {
      throw new KernelError('conflict', `upcaster already registered for ${key}`)
    }
    this.upcasters.set(key, fn)
  }

  /** 21 §6 用例 1 的另一半：追加是唯一的写路径。 */
  async append<T extends string, P>(e: EventInput<T, P>): Promise<EventEnvelope<T, P>> {
    return this.appendSync(e)
  }

  appendSync<T extends string, P>(e: EventInput<T, P>): EventEnvelope<T, P> {
    if (e.schema_version !== this.schemaVersion) {
      // 21 §6 用例 2 前半：写入旧版（或未来版）schema 的记录被拒。
      throw new KernelError(
        'invalid_input',
        `events are always written at the current schema_version ${this.schemaVersion}, got ${String(e.schema_version)}`,
        { details: { expected: this.schemaVersion, received: e.schema_version } },
      )
    }
    return this.insert(e, this.schemaVersion)
  }

  /**
   * 从旧版备份 / 旧发行版导入历史事件（保留原 `schema_version` 与原 id）。
   * **不在 `EventLog` 契约里**：这是运维导入口，业务代码只能用 `append`。
   */
  appendHistorical<T extends string, P>(
    e: EventInput<T, P> & { id?: EventId; at?: string },
  ): EventEnvelope<T, P> {
    if (!Number.isInteger(e.schema_version) || e.schema_version < 1) {
      throw new KernelError('invalid_input', 'historical event requires a positive schema_version')
    }
    if (e.schema_version > this.schemaVersion) {
      throw new KernelError(
        'invalid_input',
        `cannot import an event newer than the current schema_version ${this.schemaVersion}`,
      )
    }
    return this.insert(e, e.schema_version, e.id, e.at)
  }

  private insert<T extends string, P>(
    e: EventInput<T, P>,
    schemaVersion: number,
    forcedId?: EventId,
    forcedAt?: string,
  ): EventEnvelope<T, P> {
    // 21 §6 用例 3：无 workspace_id 拒写。列上另有 NOT NULL + CHECK 兜底。
    const workspace_id = requireNonEmpty(e.workspace_id, 'workspace_id')
    requireNonEmpty(e.type, 'type')
    if (e.actor === null || typeof e.actor !== 'object') {
      throw new KernelError('invalid_input', 'event requires an actor')
    }
    requireNonEmpty(e.actor.id, 'actor.id')
    if (e.correlation === null || typeof e.correlation !== 'object') {
      throw new KernelError('invalid_input', 'event requires a correlation')
    }
    const trace_id = requireNonEmpty(e.correlation.trace_id, 'correlation.trace_id')

    const id = forcedId ?? this.nextId()
    const at = forcedAt ?? this.clock.now()
    const prev_hash = e.prev_hash ?? this.lastHash(workspace_id)

    const envelope: EventEnvelope<T, P> = {
      id,
      schema_version: schemaVersion,
      workspace_id,
      type: e.type,
      at,
      actor: e.actor,
      ...(e.subject === undefined ? {} : { subject: e.subject }),
      correlation: e.correlation,
      payload: e.payload,
      ...(e.payload_encrypted === undefined ? {} : { payload_encrypted: e.payload_encrypted }),
      ...(prev_hash === undefined ? {} : { prev_hash }),
    }

    this.db
      .prepare(INSERT_SQL)
      .run(
        id,
        schemaVersion,
        workspace_id,
        e.type,
        at,
        e.actor.kind,
        e.actor.id,
        e.actor.run_id ?? null,
        e.subject?.type ?? null,
        e.subject?.id ?? null,
        trace_id,
        e.correlation.run_id ?? null,
        e.correlation.work_item_id ?? null,
        e.correlation.change_id ?? null,
        e.correlation.execution_id ?? null,
        canonical(e.payload),
        e.payload_encrypted === undefined ? null : canonical(e.payload_encrypted),
        prev_hash ?? null,
        hashEvent(envelope),
      )

    return envelope
  }

  private lastHash(workspace_id: WorkspaceId): string | undefined {
    const row = this.db
      .prepare('SELECT hash FROM events WHERE workspace_id = ? ORDER BY id DESC LIMIT 1')
      .get(workspace_id) as { hash: string } | undefined
    return row?.hash
  }

  /** 21 §1 的 `read`：`since` 按 ulid 序严格递增（断线续传无丢无重，28 §4 用例 4）。 */
  read(filter: {
    workspace_id: WorkspaceId
    since?: EventId
    types?: string[]
    run_id?: RunId
    limit?: number
  }): AsyncIterable<EventEnvelope> {
    return lazyAsyncIterable(() => this.readSync(filter))
  }

  readSync(filter: {
    workspace_id: WorkspaceId
    since?: EventId
    types?: string[]
    run_id?: RunId
    limit?: number
  }): EventEnvelope[] {
    const workspace_id = requireNonEmpty(filter.workspace_id, 'workspace_id')
    const where: string[] = ['workspace_id = ?']
    const params: (string | number)[] = [workspace_id]

    if (filter.since !== undefined) {
      where.push('id > ?')
      params.push(requireNonEmpty(filter.since, 'since'))
    }
    if (filter.types !== undefined) {
      if (filter.types.length === 0) return []
      where.push(`type IN (${filter.types.map(() => '?').join(',')})`)
      for (const t of filter.types) params.push(requireNonEmpty(t, 'types[]'))
    }
    if (filter.run_id !== undefined) {
      where.push('run_id = ?')
      params.push(requireNonEmpty(filter.run_id, 'run_id'))
    }

    let sql = `SELECT ${SELECT_COLUMNS} FROM events WHERE ${where.join(' AND ')} ORDER BY id ASC`
    if (filter.limit !== undefined) {
      if (!Number.isInteger(filter.limit) || filter.limit < 0) {
        throw new KernelError('invalid_input', 'limit must be a non-negative integer')
      }
      sql += ' LIMIT ?'
      params.push(filter.limit)
    }

    const rows = this.db.prepare(sql).all(...params) as EventRow[]
    return rows.map((row) => this.upcast(toEnvelope(row)))
  }

  /** 21 §1「replay(run_id) 重组 prompt」：按 ulid 序返回该运行的全部事件。 */
  replayRun(run_id: RunId): AsyncIterable<EventEnvelope> {
    return lazyAsyncIterable(() => this.replayRunSync(run_id))
  }

  replayRunSync(run_id: RunId): EventEnvelope[] {
    const id = requireNonEmpty(run_id, 'run_id')
    const rows = this.db
      .prepare(`SELECT ${SELECT_COLUMNS} FROM events WHERE run_id = ? ORDER BY id ASC`)
      .all(id) as EventRow[]
    return rows.map((row) => this.upcast(toEnvelope(row)))
  }

  /** 21 §1 链式校验：逐条重算 hash 并核对 `prev_hash` 链接。 */
  verifyChain(workspace_id: WorkspaceId): { ok: boolean; broken_at?: EventId; reason?: string } {
    const rows = this.db
      .prepare(`SELECT ${SELECT_COLUMNS} FROM events WHERE workspace_id = ? ORDER BY id ASC`)
      .all(requireNonEmpty(workspace_id, 'workspace_id')) as EventRow[]
    let previous: string | undefined
    for (const row of rows) {
      const envelope = toEnvelope(row)
      if ((envelope.prev_hash ?? undefined) !== previous) {
        return {
          ok: false,
          broken_at: row.id,
          reason: 'prev_hash does not match the previous event',
        }
      }
      const recomputed = hashEvent(envelope)
      if (recomputed !== row.hash) {
        return { ok: false, broken_at: row.id, reason: 'stored hash does not match the payload' }
      }
      previous = row.hash
    }
    return { ok: true }
  }

  /** 沿迁移器链把一条历史记录升到最新形状（21 §5）。 */
  private upcast(event: EventEnvelope): EventEnvelope {
    let current = event
    while (current.schema_version < this.schemaVersion) {
      const key = `${current.type}@${current.schema_version}`
      const up = this.upcasters.get(key)
      if (!up) {
        throw new KernelError(
          'invalid_input',
          `no upcaster registered for ${key}; the upcaster chain must be kept forever (21 §5)`,
          { details: { event_id: current.id, type: current.type, from: current.schema_version } },
        )
      }
      current = {
        ...current,
        schema_version: current.schema_version + 1,
        payload: up(current.payload, current),
      }
    }
    return current
  }
}

function toEnvelope(row: EventRow): EventEnvelope {
  const actorKind = row.actor_kind as EventEnvelope['actor']['kind']
  return {
    id: row.id,
    schema_version: row.schema_version,
    workspace_id: row.workspace_id,
    type: row.type,
    at: row.at,
    actor: {
      kind: actorKind,
      id: row.actor_id,
      ...(row.actor_run_id === null ? {} : { run_id: row.actor_run_id }),
    },
    ...(row.subject_type === null || row.subject_id === null
      ? {}
      : { subject: { type: row.subject_type, id: row.subject_id } }),
    correlation: {
      trace_id: row.trace_id,
      ...(row.run_id === null ? {} : { run_id: row.run_id }),
      ...(row.work_item_id === null ? {} : { work_item_id: row.work_item_id }),
      ...(row.change_id === null ? {} : { change_id: row.change_id }),
      ...(row.execution_id === null ? {} : { execution_id: row.execution_id }),
    },
    payload: JSON.parse(row.payload) as unknown,
    ...(row.payload_encrypted === null
      ? {}
      : {
          payload_encrypted: JSON.parse(row.payload_encrypted) as {
            key_id: string
            blob: string
          },
        }),
    ...(row.prev_hash === null ? {} : { prev_hash: row.prev_hash }),
  }
}

function hashEvent(envelope: EventEnvelope): string {
  return createHash('sha256').update(canonical(envelope)).digest('hex')
}

/** 惰性：查询与校验推迟到开始迭代时才发生，错误经 rejected promise 出来。 */
function lazyAsyncIterable<T>(produce: () => readonly T[]): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const item of produce()) yield item
    },
  }
}

/** 把 `AsyncIterable` 收成数组（测试与网关分页用）。 */
export async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const item of source) out.push(item)
  return out
}
