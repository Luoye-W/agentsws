/**
 * 事件日志（21 §1）：**双方言**档，跑在 {@link SqlDriver} 上。
 *
 * 与 SQLite 档（{@link SqliteEventLog}）共用 `event-log-sql.ts` 里的
 * 全部 SQL、哈希与行映射——两边不会跑偏。差别只有两处，都在存储层兜住：
 *
 * | | SQLite | Postgres |
 * |---|---|---|
 * | 只追加 | `RAISE(ABORT)` 触发器 | plpgsql 触发器函数 `RAISE EXCEPTION`（报错文字一致）|
 * | 哈希链 | 在 JS 里算，与方言无关 | 同左 |
 *
 * 哈希链的**并发**语义在两边也一样：`prev_hash` 取的是「本工作区最后一条」，
 * 所以 append 必须串行到一个工作区上。这里用一个进程内的 per-workspace 队列
 * 兜住同进程的并发；跨进程写同一个 Postgres 的场景由 21 §1 的
 * 「一个工作区一个写入者」约束（服务进程本来就是单写者）+ 主键冲突兜底。
 */

import type { EventEnvelope, EventId, EventLog, RunId, WorkspaceId } from '@agentsws/contracts'
import type { SqlDriver } from '@agentsws/core/sql'
import type { Clock, Random } from './clock.js'
import { KernelError } from './errors.js'
import { buildEnvelope, type EventInput } from './event-log.js'
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

export interface SqlEventLogOptions {
  driver: SqlDriver
  clock: Clock
  random: Random
  /** 当前信封版本，缺省 {@link EVENT_SCHEMA_VERSION}；测试可下调以构造多级迁移链。 */
  schemaVersion?: number
}

export class SqlEventLog implements EventLog {
  readonly schemaVersion: number
  readonly #driver: SqlDriver
  readonly #nextId: () => string
  readonly #clock: Clock
  readonly #chain: UpcasterChain
  /** 每个工作区一条串行链：`prev_hash` 要的是「上一条」，并发追加会串错。 */
  readonly #serial = new Map<WorkspaceId, Promise<unknown>>()

  private constructor(options: SqlEventLogOptions) {
    this.schemaVersion = options.schemaVersion ?? EVENT_SCHEMA_VERSION
    if (!Number.isInteger(this.schemaVersion) || this.schemaVersion < 1) {
      throw new KernelError('invalid_input', `schemaVersion must be a positive integer`)
    }
    this.#driver = options.driver
    this.#clock = options.clock
    this.#nextId = createUlidFactory(options.clock, options.random)
    this.#chain = new UpcasterChain(this.schemaVersion)
  }

  /** 建表（含只追加的强制）后返回。装配时 await 一次，之后全是查询。 */
  static async open(options: SqlEventLogOptions): Promise<SqlEventLog> {
    const log = new SqlEventLog(options)
    await options.driver.exec(schemaFor(options.driver.dialect))
    return log
  }

  get dialect(): SqlDriver['dialect'] {
    return this.#driver.dialect
  }

  /** 驱动本身。只给同包一致性测试用（断言触发器行为）；业务代码不得直连 SQL（21 §3）。 */
  get driver(): SqlDriver {
    return this.#driver
  }

  async close(): Promise<void> {
    await this.#driver.close()
  }

  registerUpcaster(type: string, fromVersion: number, fn: Upcaster): void {
    this.#chain.register(type, fromVersion, fn)
  }

  async append<T extends string, P>(e: EventInput<T, P>): Promise<EventEnvelope<T, P>> {
    if (e.schema_version !== this.schemaVersion) {
      throw new KernelError(
        'invalid_input',
        `events are always written at the current schema_version ${this.schemaVersion}, got ${String(e.schema_version)}`,
        { details: { expected: this.schemaVersion, received: e.schema_version } },
      )
    }
    return this.#insert(e, this.schemaVersion)
  }

  /** 运维导入口（旧版备份 / 旧发行版）；不在 `EventLog` 契约里。 */
  async appendHistorical<T extends string, P>(
    e: EventInput<T, P> & { id?: EventId; at?: string },
  ): Promise<EventEnvelope<T, P>> {
    if (!Number.isInteger(e.schema_version) || e.schema_version < 1) {
      throw new KernelError('invalid_input', 'historical event requires a positive schema_version')
    }
    if (e.schema_version > this.schemaVersion) {
      throw new KernelError(
        'invalid_input',
        `cannot import an event newer than the current schema_version ${this.schemaVersion}`,
      )
    }
    return this.#insert(e, e.schema_version, e.id, e.at)
  }

  async #insert<T extends string, P>(
    e: EventInput<T, P>,
    schemaVersion: number,
    forcedId?: EventId,
    forcedAt?: string,
  ): Promise<EventEnvelope<T, P>> {
    return this.#serialize(e.workspace_id, async () => {
      const prev = e.prev_hash === undefined ? await this.#lastHash(e.workspace_id) : undefined
      const { envelope, trace_id } = buildEnvelope(
        e,
        schemaVersion,
        forcedId ?? this.#nextId(),
        forcedAt ?? this.#clock.now(),
        prev,
      )
      await this.#driver.prepare(INSERT_SQL).run(...insertParams(envelope, trace_id))
      return envelope
    })
  }

  /** 同一工作区的 append 排队，跨工作区并行。 */
  async #serialize<T>(workspace_id: WorkspaceId, fn: () => Promise<T>): Promise<T> {
    const previous = this.#serial.get(workspace_id) ?? Promise.resolve()
    const next = previous.then(fn, fn)
    this.#serial.set(
      workspace_id,
      next.catch(() => undefined),
    )
    return next
  }

  async #lastHash(workspace_id: WorkspaceId): Promise<string | undefined> {
    const row = await this.#driver.prepare<{ hash: string }>(LAST_HASH_SQL).get(workspace_id)
    return row?.hash
  }

  read(filter: EventReadFilter): AsyncIterable<EventEnvelope> {
    return lazyAsyncIterable(() => this.readAll(filter))
  }

  async readAll(filter: EventReadFilter): Promise<EventEnvelope[]> {
    const query = buildReadQuery(filter)
    if (query === undefined) return []
    const rows = await this.#driver.prepare<EventRow>(query.sql).all(...query.params)
    return rows.map((row) => this.#chain.upcast(toEnvelope(row)))
  }

  replayRun(run_id: RunId): AsyncIterable<EventEnvelope> {
    return lazyAsyncIterable(() => this.replayRunAll(run_id))
  }

  async replayRunAll(run_id: RunId): Promise<EventEnvelope[]> {
    const id = requireNonEmpty(run_id, 'run_id')
    const rows = await this.#driver.prepare<EventRow>(REPLAY_RUN_SQL).all(id)
    return rows.map((row) => this.#chain.upcast(toEnvelope(row)))
  }

  async verifyChain(
    workspace_id: WorkspaceId,
  ): Promise<{ ok: boolean; broken_at?: EventId; reason?: string }> {
    const rows = await this.#driver
      .prepare<EventRow>(VERIFY_SQL)
      .all(requireNonEmpty(workspace_id, 'workspace_id'))
    return verifyRows(rows)
  }
}
