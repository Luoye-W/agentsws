/**
 * Postgres 档的 {@link SqlDriver}（`postgres` / porsager，纯 JS、无原生构建）。
 *
 * 为什么是 `postgres` 不是 `pg`：`pg` 拖 `pg-native` 的可选原生路径与一串子包，
 * `postgres` 一个包、零依赖、自带连接池与事务，装在 NAS 的 Docker 里不用编译工具链。
 * 只准新增一个依赖（35 §2），这一个就用在这里。
 *
 * 三处方言由驱动兜住，业务代码里看不见：
 * - 占位符：SQL 里写 `?`，这里改写成 `$n`
 * - 类型名：`INTEGER` / `BLOB` / `STRICT` / `datetime('now')` 经 `translateSql` 翻过来
 * - int8：Postgres 默认把 BIGINT 回成字符串，这里装一个解析钩子回成 number，
 *   与 SQLite 的行为对齐（毫秒时间戳、changes、围栏号全是这个类型）
 */
import postgres from 'postgres'
import { translateSql } from './dialect.js'
import {
  rewritePlaceholders,
  type SqlDriver,
  SqlDriverError,
  type SqlExecutor,
  type SqlRunResult,
  type SqlStatement,
  type SqlValue,
  splitStatements,
} from './driver.js'

export interface PostgresDriverOptions {
  /** `postgres://user:pass@host:5432/db`。凭据只从环境变量 / 本机加密库来（35 §2）。 */
  url: string
  /** 连接池大小；NAS 上默认小一点。 */
  max?: number
  /** 建连超时（秒）。 */
  connectTimeout?: number
  /** 强制 TLS（云上的托管库基本都要）。 */
  ssl?: boolean | 'require' | 'prefer'
  /**
   * 每个包一个 schema（35 §2「不共享其他包的表」在 Postgres 上的兑现方式）。
   *
   * SQLite 档下「一个包一个库文件」天然隔离；Postgres 档下用户只会给**一个**
   * `DATABASE_URL`，所以隔离落在 schema 上：`kernel` / `data` / `txn` 各一个，
   * 表名（含 `_migrations`）与 SQLite 档逐字相同，迁移集也就还是同一份。
   */
  schema?: string
}

type Params = readonly SqlValue[]
type Sql = ReturnType<typeof postgres>

/**
 * postgres.js 的绑定：布尔转 0/1（列是 BIGINT），字节要**是 Buffer**——
 * 裸 Uint8Array 会被当成普通对象序列化，写进 bytea 的就是一串 JSON。
 */
function bind(params: Params): unknown[] {
  return params.map((p) => {
    if (typeof p === 'boolean') return p ? 1 : 0
    if (p instanceof Uint8Array) return Buffer.isBuffer(p) ? p : Buffer.from(p)
    return p
  })
}

function wrapError(error: unknown): never {
  const code = (error as { code?: string } | null)?.code
  if (code === '23505' || code === '23P01') {
    throw new SqlDriverError('conflict', String((error as Error).message), { cause: error })
  }
  throw new SqlDriverError('backend_error', String((error as Error)?.message ?? error), {
    cause: error,
  })
}

class PgStatement<R> implements SqlStatement<R> {
  readonly #sql: Sql
  readonly #text: string

  constructor(sql: Sql, text: string) {
    this.#sql = sql
    this.#text = text
  }

  async #exec(params: Params): Promise<{ rows: R[]; count: number }> {
    try {
      const result = (await this.#sql.unsafe(
        this.#text,
        bind(params) as never,
      )) as unknown as R[] & {
        count: number
      }
      return { rows: [...result], count: result.count }
    } catch (error) {
      return wrapError(error)
    }
  }

  async run(...params: Params): Promise<SqlRunResult> {
    const { count } = await this.#exec(params)
    return { changes: count }
  }

  async get(...params: Params): Promise<R | undefined> {
    const { rows } = await this.#exec(params)
    return rows[0]
  }

  async all(...params: Params): Promise<R[]> {
    const { rows } = await this.#exec(params)
    return rows
  }
}

class PgExecutor implements SqlExecutor {
  readonly dialect = 'postgres' as const
  protected readonly sql: Sql

  constructor(sql: Sql) {
    this.sql = sql
  }

  prepare<R = Record<string, unknown>>(text: string): SqlStatement<R> {
    return new PgStatement<R>(this.sql, rewritePlaceholders(translateSql(text, 'postgres')))
  }

  /**
   * 多条 DDL。postgres.js 的 simple query 一次只吃一条，所以先切开再逐条跑；
   * 切分与占位符改写共用同一套扫描（字面量 / 注释里的分号不算数）。
   */
  async exec(text: string): Promise<void> {
    const translated = translateSql(text, 'postgres')
    for (const statement of splitStatements(translated)) {
      try {
        await this.sql.unsafe(statement)
      } catch (error) {
        wrapError(error)
      }
    }
  }
}

export class PostgresDriver extends PgExecutor implements SqlDriver {
  #closed = false

  /**
   * 回调抛出的错误**原样**往上抛（回滚已经由 postgres.js 做掉了）。
   * 不在这里包一层：业务错误（乐观锁 conflict、权限 forbidden）经过事务边界
   * 不该变成 `SqlDriverError`，否则调用方的 `instanceof` 判断在 Postgres 档上会全错。
   */
  async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    return (await this.sql.begin(async (tx) => fn(new PgExecutor(tx as unknown as Sql)))) as T
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    await this.sql.end({ timeout: 5 })
  }
}

const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/

function baseOptions(options: PostgresDriverOptions): Record<string, unknown> {
  return {
    max: options.max ?? 8,
    connect_timeout: options.connectTimeout ?? 10,
    ...(options.ssl === undefined ? {} : { ssl: options.ssl }),
    onnotice: () => {},
    // BIGINT（int8）默认回字符串；回成 number，与 SQLite 的 INTEGER 对齐。
    types: {
      bigint: {
        to: 20,
        from: [20],
        serialize: (x: number | bigint) => String(x),
        parse: (x: string) => Number(x),
      },
    },
  }
}

/** 开一个 Postgres 驱动。连不上就抛——装配时就该红，别等第一条查询。 */
export async function openPostgresDriver(options: PostgresDriverOptions): Promise<PostgresDriver> {
  const schema = options.schema
  if (schema !== undefined && !SCHEMA_NAME.test(schema)) {
    throw new SqlDriverError('invalid_input', `illegal postgres schema name: ${schema}`)
  }
  if (schema !== undefined) {
    // schema 要先存在，连接池的 search_path 才有意义；一条一次性连接建它。
    const boot = postgres(options.url, { ...baseOptions(options), max: 1 } as never)
    try {
      await boot.unsafe(`CREATE SCHEMA IF NOT EXISTS ${schema}`)
    } catch (error) {
      await boot.end({ timeout: 1 }).catch(() => {})
      throw new SqlDriverError('backend_error', `cannot reach postgres: ${String(error)}`, {
        cause: error,
      })
    }
    await boot.end({ timeout: 1 }).catch(() => {})
  }
  const sql = postgres(options.url, {
    ...baseOptions(options),
    ...(schema === undefined ? {} : { connection: { search_path: schema } }),
  } as never)
  const driver = new PostgresDriver(sql)
  try {
    await sql.unsafe('SELECT 1')
  } catch (error) {
    await sql.end({ timeout: 1 }).catch(() => {})
    throw new SqlDriverError('backend_error', `cannot reach postgres: ${String(error)}`, {
      cause: error,
    })
  }
  return driver
}
