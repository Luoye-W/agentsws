/**
 * `@agentsws/core/sql`：换存储后端只换配置（21 §3、41 §2）。
 *
 * 一个入口 {@link openDriver}：给它一个 URL，SQLite 还是 Postgres 由 URL 决定，
 * 服务进程的其余部分一个字都不用改。
 */
export {
  boolValue,
  columnsQuery,
  dialectRules,
  jsonExtract,
  toBool,
  toBytes,
  toNumber,
  translateSql,
  upsert,
} from './dialect.js'
export {
  isSyncDriver,
  mapCode,
  rewritePlaceholders,
  type SqlDialect,
  type SqlDriver,
  SqlDriverError,
  type SqlExecutor,
  type SqlRunResult,
  type SqlStatement,
  type SqlValue,
  type SyncSqlDriver,
  type SyncSqlExecutor,
  type SyncSqlStatement,
  splitStatements,
} from './driver.js'
export {
  type MigrateOptions,
  type Migration,
  migrate,
  migrateSync,
  schemaVersion,
  schemaVersionSync,
} from './migrator.js'
export {
  openPostgresDriver,
  PostgresDriver,
  type PostgresDriverOptions,
} from './pg-driver.js'
export { openSqliteDriver, SqliteDriver, type SqliteDriverOptions } from './sqlite-driver.js'

import { type SqlDialect, type SqlDriver, SqlDriverError } from './driver.js'
import { openPostgresDriver } from './pg-driver.js'
import { openSqliteDriver } from './sqlite-driver.js'

export interface OpenDriverOptions {
  /**
   * `postgres://…` / `postgresql://…` → Postgres；
   * `sqlite:<path>`、`file:<path>` 或裸路径 → SQLite（`:memory:` 给测试）。
   */
  url: string
  /** Postgres 档：每个包一个 schema（35 §2）。SQLite 档忽略。 */
  schema?: string
  /** SQLite 档：`synchronous = FULL`（账本、审批那几张库要）。 */
  fullSync?: boolean
  max?: number
  ssl?: boolean | 'require' | 'prefer'
}

/** URL 属于哪个方言。不认识的 scheme 直接抛——猜错后端等于把数据写去别处。 */
export function dialectOf(url: string): SqlDialect {
  if (/^postgres(ql)?:\/\//i.test(url)) return 'postgres'
  if (/^sqlite:/i.test(url) || /^file:/i.test(url)) return 'sqlite'
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    throw new SqlDriverError(
      'invalid_input',
      `unsupported storage url scheme: ${url.split(':')[0]}`,
    )
  }
  return 'sqlite'
}

/** SQLite URL → 文件路径。 */
export function sqlitePath(url: string): string {
  if (/^sqlite:/i.test(url)) {
    const rest = url.slice(url.indexOf(':') + 1)
    return rest.startsWith('//') ? rest.slice(2) : rest
  }
  if (/^file:/i.test(url)) return new URL(url).pathname
  return url
}

/** 同一套服务进程换后端的那一个开关。 */
export async function openDriver(options: OpenDriverOptions): Promise<SqlDriver> {
  if (dialectOf(options.url) === 'postgres') {
    return openPostgresDriver({
      url: options.url,
      ...(options.schema === undefined ? {} : { schema: options.schema }),
      ...(options.max === undefined ? {} : { max: options.max }),
      ...(options.ssl === undefined ? {} : { ssl: options.ssl }),
    })
  }
  return openSqliteDriver({
    path: sqlitePath(options.url),
    ...(options.fullSync === undefined ? {} : { fullSync: options.fullSync }),
  })
}

/** 打给运维看的后端描述；**永不含凭据**（用户名密码在 URL 里，这里只留主机与库名）。 */
export function describeUrl(url: string): { dialect: SqlDialect; display: string } {
  const dialect = dialectOf(url)
  if (dialect === 'sqlite') return { dialect, display: sqlitePath(url) }
  try {
    const parsed = new URL(url)
    const db = parsed.pathname.replace(/^\//, '')
    return { dialect, display: `${parsed.hostname}:${parsed.port || '5432'}/${db}` }
  } catch {
    return { dialect, display: 'postgres' }
  }
}
