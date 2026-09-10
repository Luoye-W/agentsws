/**
 * 事件日志（21 §1）：SQLite 档。
 *
 * - **只追加**：SQLite 触发器把 UPDATE / DELETE 直接 ABORT（21 §6 用例 1），应用层删不掉也改不掉；
 *   删除请求走 21 §4（销毁主体密钥 + `privacy.erased` 墓碑），不动这张表。
 * - **版本**：写入永远最新版（用例 2 前半）；旧版记录读出来经迁移器链升到最新形状（用例 2 后半、21 §5）。
 * - **信封**：无 `workspace_id` 拒写（用例 3），列上另有 NOT NULL + CHECK 兜底。
 * - **链式校验**：每条存 `hash`，并把上一条的 hash 写进 `prev_hash`（21 §1「可选链式校验」）。
 *
 * WP40 起 SQL、哈希、行映射搬去了 `event-log-sql.ts`，与 Postgres 档
 * （`SqlEventLog`）共用同一份——这里只剩「同步地把参数递给 better-sqlite3」。
 * 同步面留着是因为模拟世界与服务进程还在用 `appendSync` / `readSync`。
 */

import type { EventEnvelope, EventId, EventLog, RunId, WorkspaceId } from '@agentsws/contracts'
import { openSqliteDriver, type SqliteDriver } from '@agentsws/core/sql'
import type Database from 'better-sqlite3'
import type { Clock, Random } from './clock.js'
import { KernelError } from './errors.js'
import {
  buildReadQuery,
  EVENT_SCHEMA_VERSION,
  type EventReadFilter,
  type EventRow,
  INSERT_SQL,
  insertParams,
  LAST_HASH_SQL,
  lazyAsyncIterable,
  REPLAY_RUN_SQL,
  requireNonEmpty,
  schemaFor,
  toEnvelope,
  type Upcaster,
  UpcasterChain,
  VERIFY_SQL,
  verifyRows,
} from './event-log-sql.js'
import { createUlidFactory } from './ulid.js'

export type { EventReadFilter } from './event-log-sql.js'
export { collect, EVENT_SCHEMA_VERSION, type Upcaster } from './event-log-sql.js'

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

export class SqliteEventLog implements EventLog {
  readonly schemaVersion: number
  private readonly driver: SqliteDriver
  private readonly nextId: () => string
  private readonly clock: Clock
  private readonly chain: UpcasterChain
  private closed = false

  constructor(options: SqliteEventLogOptions) {
    this.schemaVersion = options.schemaVersion ?? EVENT_SCHEMA_VERSION
    if (!Number.isInteger(this.schemaVersion) || this.schemaVersion < 1) {
      throw new KernelError('invalid_input', `schemaVersion must be a positive integer`)
    }
    this.clock = options.clock
    this.nextId = createUlidFactory(options.clock, options.random)
    this.chain = new UpcasterChain(this.schemaVersion)
    this.driver = openSqliteDriver({ path: options.dbPath ?? ':memory:' })
    this.driver.execSync(schemaFor('sqlite'))
  }

  /** 底层连接；只给同包的一致性测试用（断言触发器行为），业务代码不得直连 SQL（21 §3）。 */
  get database(): Database.Database {
    return this.driver.database
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.driver.closeSync()
  }

  /**
   * 注册迁移器（21 §5）。`type@fromVersion` 唯一，链永久保留，不允许覆盖已注册的一环——
   * 覆盖等于悄悄改写历史读法。
   */
  registerUpcaster(type: string, fromVersion: number, fn: Upcaster): void {
    this.chain.register(type, fromVersion, fn)
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
    const { envelope, trace_id } = buildEnvelope(
      e,
      schemaVersion,
      forcedId ?? this.nextId(),
      forcedAt ?? this.clock.now(),
      e.prev_hash === undefined ? this.lastHash(e.workspace_id) : undefined,
    )
    this.driver.prepareSync(INSERT_SQL).runSync(...insertParams(envelope, trace_id))
    return envelope
  }

  private lastHash(workspace_id: WorkspaceId): string | undefined {
    const row = this.driver.prepareSync<{ hash: string }>(LAST_HASH_SQL).getSync(workspace_id)
    return row?.hash
  }

  /**
   * 21 §1 的 `read`：`since` 按 ulid 序严格递增（断线续传无丢无重，28 §4 用例 4）；
   * `since_at` / `until_at` 是时间闭区间，与 `since` 同给取交集。三个都下推到 SQL。
   */
  read(filter: EventReadFilter): AsyncIterable<EventEnvelope> {
    return lazyAsyncIterable(() => this.readSync(filter))
  }

  readSync(filter: EventReadFilter): EventEnvelope[] {
    const query = buildReadQuery(filter)
    if (query === undefined) return []
    const rows = this.driver.prepareSync<EventRow>(query.sql).allSync(...query.params)
    return rows.map((row) => this.chain.upcast(toEnvelope(row)))
  }

  /** 21 §1「replay(run_id) 重组 prompt」：按 ulid 序返回该运行的全部事件。 */
  replayRun(run_id: RunId): AsyncIterable<EventEnvelope> {
    return lazyAsyncIterable(() => this.replayRunSync(run_id))
  }

  replayRunSync(run_id: RunId): EventEnvelope[] {
    const id = requireNonEmpty(run_id, 'run_id')
    const rows = this.driver.prepareSync<EventRow>(REPLAY_RUN_SQL).allSync(id)
    return rows.map((row) => this.chain.upcast(toEnvelope(row)))
  }

  /** 21 §1 链式校验：逐条重算 hash 并核对 `prev_hash` 链接。 */
  verifyChain(workspace_id: WorkspaceId): { ok: boolean; broken_at?: EventId; reason?: string } {
    const rows = this.driver
      .prepareSync<EventRow>(VERIFY_SQL)
      .allSync(requireNonEmpty(workspace_id, 'workspace_id'))
    return verifyRows(rows)
  }
}

/**
 * 信封组装 + 入参校验（21 §6 用例 3：无 workspace_id 拒写）。
 * 两个档共用；上一条的 hash 由调用方取（同步 / 异步各取所需）。
 */
export function buildEnvelope<T extends string, P>(
  e: EventInput<T, P>,
  schemaVersion: number,
  id: string,
  at: string,
  prevHash: string | undefined,
): { envelope: EventEnvelope<T, P>; trace_id: string } {
  requireNonEmpty(e.workspace_id, 'workspace_id')
  requireNonEmpty(e.type, 'type')
  if (e.actor === null || typeof e.actor !== 'object') {
    throw new KernelError('invalid_input', 'event requires an actor')
  }
  requireNonEmpty(e.actor.id, 'actor.id')
  if (e.correlation === null || typeof e.correlation !== 'object') {
    throw new KernelError('invalid_input', 'event requires a correlation')
  }
  const trace_id = requireNonEmpty(e.correlation.trace_id, 'correlation.trace_id')
  const prev_hash = e.prev_hash ?? prevHash

  const envelope: EventEnvelope<T, P> = {
    id,
    schema_version: schemaVersion,
    workspace_id: e.workspace_id,
    type: e.type,
    at,
    actor: e.actor,
    ...(e.subject === undefined ? {} : { subject: e.subject }),
    correlation: e.correlation,
    payload: e.payload,
    ...(e.payload_encrypted === undefined ? {} : { payload_encrypted: e.payload_encrypted }),
    ...(prev_hash === undefined ? {} : { prev_hash }),
  }
  return { envelope, trace_id }
}
