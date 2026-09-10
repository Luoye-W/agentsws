/**
 * 事件日志的 **SQL 与纯函数**（21 §1）——SQLite 档与 Postgres 档共用这一份。
 *
 * 拆出来的理由只有一个：两个方言各写一份 SQL，第三个月就会跑偏，
 * 而这张表恰好是「不可篡改」这条纪律的落点，跑偏了没人看得见。
 * 所以列、插入语句、读查询、哈希、行 ↔ 信封映射全在这里；
 * 两个实现各自只剩「怎么把参数递给驱动」。
 */

import { createHash } from 'node:crypto'
import type { EventEnvelope, EventLog } from '@agentsws/contracts'
import type { SqlDialect, SqlValue } from '@agentsws/core/sql'
import { KernelError } from './errors.js'

/** 当前事件信封版本；`append` 只接受这个版本（21 §5「写入永远最新版」）。 */
export const EVENT_SCHEMA_VERSION = 1

/**
 * 迁移器（upcaster）：把 `type` 在 `fromVersion` 上的 payload 升到 `fromVersion + 1`。
 * 链永久保留（21 §5），任何历史版本都能读到最新形状。
 */
export type Upcaster = (payload: unknown, event: Readonly<EventEnvelope>) => unknown

export interface EventRow {
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

/**
 * 表结构。列定义两个方言逐字相同（`INTEGER` / `STRICT` 由方言表翻译）；
 * 不同的只有**只追加**怎么强制：SQLite 用 `RAISE(ABORT)` 触发器，
 * Postgres 用 plpgsql 触发器函数 `RAISE EXCEPTION`。语义一样：
 * 任何路径（含直连 SQL）都 UPDATE / DELETE 不动这张表（21 §6 用例 1）。
 */
const TABLE = `
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
`

const APPEND_ONLY_SQLITE = `
-- 21 §1「从不 UPDATE / DELETE」：在存储层强制，任何路径（含直连 SQL）都改不动。
CREATE TRIGGER IF NOT EXISTS events_append_only_update
BEFORE UPDATE ON events
BEGIN SELECT RAISE(ABORT, 'event log is append-only: UPDATE rejected'); END;

CREATE TRIGGER IF NOT EXISTS events_append_only_delete
BEFORE DELETE ON events
BEGIN SELECT RAISE(ABORT, 'event log is append-only: DELETE rejected'); END;
`

/**
 * Postgres 上的等价物。Postgres 的 `CREATE TRIGGER` 没有 `IF NOT EXISTS`，
 * 所以先 DROP 再建（幂等），触发器函数用 `CREATE OR REPLACE`。
 * 报错文字与 SQLite 那份对齐，一致性套件两边用同一个断言。
 */
const APPEND_ONLY_POSTGRES = `
CREATE OR REPLACE FUNCTION events_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'event log is append-only: UPDATE rejected';
  ELSE
    RAISE EXCEPTION 'event log is append-only: DELETE rejected';
  END IF;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS events_append_only_update ON events;
CREATE TRIGGER events_append_only_update
BEFORE UPDATE ON events FOR EACH ROW EXECUTE FUNCTION events_append_only();

DROP TRIGGER IF EXISTS events_append_only_delete ON events;
CREATE TRIGGER events_append_only_delete
BEFORE DELETE ON events FOR EACH ROW EXECUTE FUNCTION events_append_only();
`

export function schemaFor(dialect: SqlDialect): string {
  return `${TABLE}\n${dialect === 'sqlite' ? APPEND_ONLY_SQLITE : APPEND_ONLY_POSTGRES}`
}

export const INSERT_SQL = `
INSERT INTO events (
  id, schema_version, workspace_id, type, at,
  actor_kind, actor_id, actor_run_id,
  subject_type, subject_id,
  trace_id, run_id, work_item_id, change_id, execution_id,
  payload, payload_encrypted, prev_hash, hash
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
`

export const SELECT_COLUMNS = `
  id, schema_version, workspace_id, type, at,
  actor_kind, actor_id, actor_run_id,
  subject_type, subject_id,
  trace_id, run_id, work_item_id, change_id, execution_id,
  payload, payload_encrypted, prev_hash, hash
`

export const LAST_HASH_SQL =
  'SELECT hash FROM events WHERE workspace_id = ? ORDER BY id DESC LIMIT 1'

export const REPLAY_RUN_SQL = `SELECT ${SELECT_COLUMNS} FROM events WHERE run_id = ? ORDER BY id ASC`

export const VERIFY_SQL = `SELECT ${SELECT_COLUMNS} FROM events WHERE workspace_id = ? ORDER BY id ASC`

/** 稳定序列化（键排序），保证 hash 与 payload 存储不受属性顺序影响。 */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
}

export function hashEvent(envelope: EventEnvelope): string {
  return createHash('sha256').update(canonical(envelope)).digest('hex')
}

export function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new KernelError('invalid_input', `event requires a non-empty ${field}`)
  }
  return value
}

/** `EventLog.read` 的过滤器（契约的那一份，抽出来给两个实现共用）。 */
export type EventReadFilter = Parameters<EventLog['read']>[0]

/**
 * 读查询：三个过滤条件全下推到 SQL——时间范围在调用方那一层过滤等于
 * 把整段日志读进内存再扔掉大半。`types: []` 返回 `undefined`（空结果，不查库）。
 */
export function buildReadQuery(
  filter: EventReadFilter,
): { sql: string; params: SqlValue[] } | undefined {
  const workspace_id = requireNonEmpty(filter.workspace_id, 'workspace_id')
  const where: string[] = ['workspace_id = ?']
  const params: SqlValue[] = [workspace_id]

  if (filter.since !== undefined) {
    where.push('id > ?')
    params.push(requireNonEmpty(filter.since, 'since'))
  }
  if (filter.since_at !== undefined) {
    where.push('at >= ?')
    params.push(requireNonEmpty(filter.since_at, 'since_at'))
  }
  if (filter.until_at !== undefined) {
    where.push('at <= ?')
    params.push(requireNonEmpty(filter.until_at, 'until_at'))
  }
  if (filter.types !== undefined) {
    if (filter.types.length === 0) return undefined
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
  return { sql, params }
}

/** 信封 → INSERT 的 19 个参数。两个实现都走这里，列顺序不会各写各的。 */
export function insertParams(envelope: EventEnvelope, trace_id: string): SqlValue[] {
  return [
    envelope.id,
    envelope.schema_version,
    envelope.workspace_id,
    envelope.type,
    envelope.at,
    envelope.actor.kind,
    envelope.actor.id,
    envelope.actor.run_id ?? null,
    envelope.subject?.type ?? null,
    envelope.subject?.id ?? null,
    trace_id,
    envelope.correlation.run_id ?? null,
    envelope.correlation.work_item_id ?? null,
    envelope.correlation.change_id ?? null,
    envelope.correlation.execution_id ?? null,
    canonical(envelope.payload),
    envelope.payload_encrypted === undefined ? null : canonical(envelope.payload_encrypted),
    envelope.prev_hash ?? null,
    hashEvent(envelope),
  ]
}

export function toEnvelope(row: EventRow): EventEnvelope {
  const actorKind = row.actor_kind as EventEnvelope['actor']['kind']
  return {
    id: row.id,
    schema_version: Number(row.schema_version),
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

/** 21 §1 链式校验：逐条重算 hash 并核对 `prev_hash` 链接。两个实现共用这一段判定。 */
export function verifyRows(rows: readonly EventRow[]): {
  ok: boolean
  broken_at?: string
  reason?: string
} {
  let previous: string | undefined
  for (const row of rows) {
    const envelope = toEnvelope(row)
    if ((envelope.prev_hash ?? undefined) !== previous) {
      return { ok: false, broken_at: row.id, reason: 'prev_hash does not match the previous event' }
    }
    if (hashEvent(envelope) !== row.hash) {
      return { ok: false, broken_at: row.id, reason: 'stored hash does not match the payload' }
    }
    previous = row.hash
  }
  return { ok: true }
}

/** 迁移器链（21 §5）。注册与查找的规矩两个实现共用。 */
export class UpcasterChain {
  readonly #map = new Map<string, Upcaster>()
  readonly #schemaVersion: number

  constructor(schemaVersion: number) {
    this.#schemaVersion = schemaVersion
  }

  register(type: string, fromVersion: number, fn: Upcaster): void {
    requireNonEmpty(type, 'upcaster type')
    if (!Number.isInteger(fromVersion) || fromVersion < 1) {
      throw new KernelError('invalid_input', `upcaster fromVersion must be a positive integer`)
    }
    if (fromVersion >= this.#schemaVersion) {
      throw new KernelError(
        'invalid_input',
        `upcaster fromVersion ${fromVersion} must be below the current schema_version ${this.#schemaVersion}`,
      )
    }
    const key = `${type}@${fromVersion}`
    if (this.#map.has(key)) {
      throw new KernelError('conflict', `upcaster already registered for ${key}`)
    }
    this.#map.set(key, fn)
  }

  /** 沿链把一条历史记录升到最新形状。 */
  upcast(event: EventEnvelope): EventEnvelope {
    let current = event
    while (current.schema_version < this.#schemaVersion) {
      const key = `${current.type}@${current.schema_version}`
      const up = this.#map.get(key)
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

/** 惰性：查询与校验推迟到开始迭代时才发生，错误经 rejected promise 出来。 */
export function lazyAsyncIterable<T>(
  produce: () => readonly T[] | Promise<readonly T[]>,
): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const item of await produce()) yield item
    },
  }
}

/** 把 `AsyncIterable` 收成数组（测试与网关分页用）。 */
export async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const item of source) out.push(item)
  return out
}
