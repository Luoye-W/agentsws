/**
 * SQL 驱动端口（41 §2「共同底座」的第一个抽象；21 §3「存储档切换只换配置」）。
 *
 * 一条纪律定住整个抽象：**接口是异步的**。SQLite 档内部是同步的（better-sqlite3），
 * 外面包成 Promise；Postgres 档天生异步。反过来（同步接口 + Postgres）做不到，
 * 所以谁想上 Postgres，谁就得先把自己的 store 换成异步面。
 *
 * 占位符统一写 `?`，由驱动改写成 `$n`（见 {@link rewritePlaceholders}）——
 * 业务代码里一处方言都不许出现。类型差异（`INTEGER PRIMARY KEY AUTOINCREMENT` /
 * `BLOB` / `datetime('now')` / `STRICT`）由 `dialect.ts` 的方言表处理。
 */

/** 支持的两个方言。第三个方言进来之前，这个联合类型就是全部真相。 */
export type SqlDialect = 'sqlite' | 'postgres'

/** 能进出 SQL 的标量。布尔在 SQLite 里没有原生类型，一律 0 / 1。 */
export type SqlValue = string | number | bigint | boolean | null | Uint8Array

/** `run` 的返回：受影响行数。两个驱动都保证这一个数字可信（乐观锁靠它）。 */
export interface SqlRunResult {
  changes: number
}

export interface SqlStatement<R = Record<string, unknown>> {
  run(...params: readonly SqlValue[]): Promise<SqlRunResult>
  get(...params: readonly SqlValue[]): Promise<R | undefined>
  all(...params: readonly SqlValue[]): Promise<R[]>
}

/**
 * 能执行语句的东西：驱动本身，或一次事务里的句柄。
 * 事务回调拿到的是这个窄面——里面不能再开事务、不能 close。
 */
export interface SqlExecutor {
  readonly dialect: SqlDialect
  prepare<R = Record<string, unknown>>(sql: string): SqlStatement<R>
  /** 多条语句（DDL 用）。不带参数。 */
  exec(sql: string): Promise<void>
}

export interface SqlDriver extends SqlExecutor {
  /**
   * 一个事务边界。回调抛错 → 回滚并把错误原样抛出去。
   * 嵌套调用（已经在事务里）由实现决定：SQLite 直接执行，Postgres 用 savepoint。
   */
  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>
  close(): Promise<void>
}

/**
 * SQLite 档额外给出的同步面。
 *
 * 存在的唯一理由：仓库里已经有一批**同步契约**的 store（`TxnStore`、`RawCipher`、
 * 模拟世界里的 `appendSync`），它们短期内换不成异步。这些地方继续走同步面，
 * 但 SQL 文本与行映射与异步面**共用同一份**，两边就不会跑偏。
 * Postgres 永远没有这个面——这正是「上 Postgres = 先转异步」的物理约束。
 */
export interface SyncSqlStatement<R = Record<string, unknown>> {
  runSync(...params: readonly SqlValue[]): SqlRunResult
  getSync(...params: readonly SqlValue[]): R | undefined
  allSync(...params: readonly SqlValue[]): R[]
}

export interface SyncSqlExecutor extends SqlExecutor {
  readonly dialect: 'sqlite'
  prepareSync<R = Record<string, unknown>>(sql: string): SyncSqlStatement<R>
  execSync(sql: string): void
}

export interface SyncSqlDriver extends SyncSqlExecutor {
  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>
  close(): Promise<void>
  transactionSync<T>(fn: () => T): T
  closeSync(): void
}

export function isSyncDriver(driver: SqlDriver): driver is SyncSqlDriver {
  return driver.dialect === 'sqlite' && typeof (driver as SyncSqlDriver).prepareSync === 'function'
}

/** 驱动层的错误；`code` 给调用方分派（`conflict` 用于唯一键冲突）。 */
export class SqlDriverError extends Error {
  readonly code: 'invalid_input' | 'conflict' | 'backend_error'

  constructor(
    code: 'invalid_input' | 'conflict' | 'backend_error',
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options === undefined ? undefined : { cause: options.cause })
    this.name = 'SqlDriverError'
    this.code = code
  }
}

/**
 * `?` → `$1..$n`。
 *
 * 扫描时跳过字符串字面量（`'…'`，`''` 转义）、标识符（双引号）、行注释（两个减号）与块注释——
 * 那里面的 `?` 是数据不是占位符。`$$` 美元引号在我们写的 SQL 里
 * 只出现在 Postgres 的触发器函数体，也一并跳过。
 */
export function rewritePlaceholders(sql: string): string {
  let index = 0
  return mapCode(sql, (code) =>
    code.replace(/\?/g, () => {
      index += 1
      return `$${index}`
    }),
  )
}

/**
 * 对 SQL 里**不是字面量 / 注释**的部分逐段做一次改写。
 *
 * 方言改写与占位符改写都要用它：`'a ? b'` 里的问号是数据，
 * `-- INTEGER` 里的词是注释，两者都不许被动到。
 */
export function mapCode(sql: string, fn: (code: string) => string): string {
  let out = ''
  let code = ''
  let i = 0
  const flush = (): void => {
    if (code !== '') {
      out += fn(code)
      code = ''
    }
  }
  while (i < sql.length) {
    const ch = sql[i] as string
    const verbatim = spanEnd(sql, i)
    if (verbatim !== undefined) {
      flush()
      out += sql.slice(i, verbatim)
      i = verbatim
      continue
    }
    code += ch
    i += 1
  }
  flush()
  return out
}

/** 从 `i` 起如果是字面量 / 注释，返回它的结束下标；否则 undefined。 */
function spanEnd(sql: string, i: number): number | undefined {
  const ch = sql[i]
  if (ch === "'" || ch === '"') return skipQuoted(sql, i, ch)
  if (ch === '-' && sql[i + 1] === '-') {
    const nl = sql.indexOf('\n', i)
    return nl === -1 ? sql.length : nl
  }
  if (ch === '/' && sql[i + 1] === '*') {
    const close = sql.indexOf('*/', i + 2)
    return close === -1 ? sql.length : close + 2
  }
  if (ch === '$' && sql[i + 1] === '$') {
    const close = sql.indexOf('$$', i + 2)
    return close === -1 ? sql.length : close + 2
  }
  return undefined
}

function skipQuoted(sql: string, start: number, quote: string): number {
  let i = start + 1
  while (i < sql.length) {
    if (sql[i] === quote) {
      if (sql[i + 1] === quote) {
        i += 2
        continue
      }
      return i + 1
    }
    i += 1
  }
  return sql.length
}

/** 把多条语句切开（`exec` 用）。与 {@link rewritePlaceholders} 同一套扫描规则。 */
export function splitStatements(sql: string): string[] {
  const out: string[] = []
  let current = ''
  let i = 0
  while (i < sql.length) {
    const verbatim = spanEnd(sql, i)
    if (verbatim !== undefined) {
      current += sql.slice(i, verbatim)
      i = verbatim
      continue
    }
    if (sql[i] === ';') {
      if (current.trim() !== '') out.push(current.trim())
      current = ''
      i += 1
      continue
    }
    current += sql[i] as string
    i += 1
  }
  if (current.trim() !== '') out.push(current.trim())
  return out
}
