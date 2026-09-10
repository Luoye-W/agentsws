/**
 * SQLite 档的 {@link SqlDriver}（better-sqlite3）。
 *
 * better-sqlite3 是同步的，所以这里做两件事：
 * 1. 把同步调用**包成 Promise**，对上异步接口——没有线程池，没有排队，
 *    延迟与原来一模一样，只是多了一次微任务。
 * 2. 额外露出 {@link SyncSqlDriver} 的同步面，给还没转异步的老 store 用
 *    （`TxnStore`、`RawCipher`、模拟世界的 `appendSync`）。
 *
 * 规范 SQL 就是 SQLite 那一份，所以这个驱动**不做任何方言改写**（`translateSql` 是恒等）。
 */
import Database from 'better-sqlite3'
import { translateSql } from './dialect.js'
import type {
  SqlDriver,
  SqlExecutor,
  SqlRunResult,
  SqlStatement,
  SqlValue,
  SyncSqlDriver,
  SyncSqlStatement,
} from './driver.js'

export interface SqliteDriverOptions {
  /** 文件路径；`:memory:` 给测试。 */
  path?: string
  /** 默认开 WAL；备份 / 只读挂载时可以关。 */
  wal?: boolean
  /** `synchronous = FULL`：崩溃中途不留半个事务（15 §5.8）。默认 NORMAL。 */
  fullSync?: boolean
  readonly?: boolean
}

type Params = readonly SqlValue[]

/** better-sqlite3 只吃这几种绑定值；布尔要转 0 / 1。 */
function bind(params: Params): unknown[] {
  return params.map((p) => {
    if (typeof p === 'boolean') return p ? 1 : 0
    if (p instanceof Uint8Array) return Buffer.isBuffer(p) ? p : Buffer.from(p)
    return p
  })
}

class SqliteStatement<R> implements SqlStatement<R>, SyncSqlStatement<R> {
  readonly #stmt: Database.Statement

  constructor(db: Database.Database, sql: string) {
    this.#stmt = db.prepare(sql)
  }

  runSync(...params: Params): SqlRunResult {
    const info = this.#stmt.run(...bind(params))
    return { changes: info.changes }
  }

  getSync(...params: Params): R | undefined {
    return this.#stmt.get(...bind(params)) as R | undefined
  }

  allSync(...params: Params): R[] {
    return this.#stmt.all(...bind(params)) as R[]
  }

  async run(...params: Params): Promise<SqlRunResult> {
    return this.runSync(...params)
  }

  async get(...params: Params): Promise<R | undefined> {
    return this.getSync(...params)
  }

  async all(...params: Params): Promise<R[]> {
    return this.allSync(...params)
  }
}

export class SqliteDriver implements SyncSqlDriver, SqlDriver {
  readonly dialect = 'sqlite' as const
  readonly #db: Database.Database
  #closed = false

  constructor(options: SqliteDriverOptions = {}) {
    this.#db = new Database(options.path ?? ':memory:', {
      ...(options.readonly === true ? { readonly: true } : {}),
    })
    if (options.readonly !== true) {
      this.#db.pragma(`journal_mode = ${options.wal === false ? 'DELETE' : 'WAL'}`)
      this.#db.pragma('foreign_keys = ON')
      if (options.fullSync === true) this.#db.pragma('synchronous = FULL')
    }
  }

  /**
   * 底层连接。只给**同包的一致性测试**与还没转异步的老实现用；
   * 业务代码不得直连 SQL（21 §3）。
   */
  get database(): Database.Database {
    return this.#db
  }

  prepare<R = Record<string, unknown>>(sql: string): SqlStatement<R> {
    return new SqliteStatement<R>(this.#db, translateSql(sql, 'sqlite'))
  }

  prepareSync<R = Record<string, unknown>>(sql: string): SyncSqlStatement<R> {
    return new SqliteStatement<R>(this.#db, translateSql(sql, 'sqlite'))
  }

  execSync(sql: string): void {
    this.#db.exec(sql)
  }

  async exec(sql: string): Promise<void> {
    this.execSync(sql)
  }

  transactionSync<T>(fn: () => T): T {
    // 已在事务里（嵌套）就直接跑：外层已经保证原子性。
    if (this.#db.inTransaction) return fn()
    return this.#db.transaction(fn)()
  }

  /**
   * 异步事务。**不能**用 better-sqlite3 的 `db.transaction()`（它只吃同步回调），
   * 所以显式 BEGIN / COMMIT / ROLLBACK。回调里的 await 期间不会有别的语句插进来——
   * 这个进程里 SQLite 连接是单条、同步执行的。
   */
  async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    if (this.#db.inTransaction) return fn(this)
    this.#db.exec('BEGIN')
    try {
      const value = await fn(this)
      this.#db.exec('COMMIT')
      return value
    } catch (error) {
      if (this.#db.inTransaction) this.#db.exec('ROLLBACK')
      throw error
    }
  }

  closeSync(): void {
    if (this.#closed) return
    this.#closed = true
    this.#db.close()
  }

  async close(): Promise<void> {
    this.closeSync()
  }
}

/** 开一个 SQLite 驱动（同步构造：文件档不需要握手）。 */
export function openSqliteDriver(options: SqliteDriverOptions = {}): SqliteDriver {
  return new SqliteDriver(options)
}
