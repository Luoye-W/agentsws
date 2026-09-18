/**
 * 网关自己的迁移器（做法照 kernel 事件日志：内嵌 SQL 数组 + 版本号表）。
 *
 * 本包有两张互不相干的库——幂等表与身份表——**各自一份 `_migrations`**，
 * 也不碰其他包的表（35 §2）。幂等：同一个库开两次只补跑没跑过的版本。
 *
 * WP114 把入参从 better-sqlite3 的 `Database` 换成 {@link SyncDb}（同步 SQL 口）：
 * 同一份迁移 SQL 现在也能在 Cloudflare Durable Object 的 SQLite 上跑，
 * **一个字都不用改**。行为一比一（原来 `db.transaction(list => …)` 那一层
 * 只是 better-sqlite3 的写法，语义还是"一个事务里跑完待补的那几版"）。
 */
import type { SyncDb } from '@agentsws/core/sql/sync-db'

export interface Migration {
  version: number
  sql: string
}

/** 版本号表的默认名字。 */
export const DEFAULT_MIGRATIONS_TABLE = '_migrations'

/**
 * 版本号表叫什么。
 *
 * WP114 加的这个参数只有一个用处：**两张逻辑上不相干的表挤在同一个库里**。
 * Compose 形态下幂等表与身份表各一个文件，各自的 `_migrations` 互不相干；
 * 而 Cloudflare 的 Durable Object 一个对象只有一张库，账号库与幂等表住在
 * 同一张里——两边都用 `_migrations` 的话，先跑的那个记下 version 1，
 * 后跑的那个就以为自己也跑过了，表根本不会建。这个坑不写成参数是发现不了的。
 *
 * 不给就是 `_migrations`，所以现有调用方一个字都不用改。
 */
export interface MigrateOptions {
  table?: string
}

/** 表名只允许标识符字符——它是代码里的常量，但这道闸不花钱。 */
function versionTable(options: MigrateOptions | undefined): string {
  const name = options?.table ?? DEFAULT_MIGRATIONS_TABLE
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`版本号表的名字只能是标识符：${name}`)
  return name
}

const versionDdl = (table: string): string => `
CREATE TABLE IF NOT EXISTS ${table} (
  version    INTEGER PRIMARY KEY NOT NULL,
  applied_at TEXT    NOT NULL
) STRICT;
`

/** 跑到最新版；返回本次实际补跑的版本号（已是最新则空数组）。 */
export function migrate(
  db: SyncDb,
  migrations: readonly Migration[],
  at: string,
  options?: MigrateOptions,
): number[] {
  const table = versionTable(options)
  db.exec(versionDdl(table))
  const done = new Set(
    db
      .prepare<{ version: number }>(`SELECT version FROM ${table}`)
      .all()
      .map((r) => r.version),
  )
  const record = db.prepare(`INSERT INTO ${table} (version, applied_at) VALUES (?, ?)`)
  const applied: number[] = []
  const pending = [...migrations]
    .filter((m) => !done.has(m.version))
    .sort((a, b) => a.version - b.version)
  db.transaction(() => {
    for (const m of pending) {
      db.exec(m.sql)
      record.run(m.version, at)
      applied.push(m.version)
    }
  })
  return applied
}

/** 已应用的最高版本（0 = 空库）。 */
export function schemaVersion(db: SyncDb, options?: MigrateOptions): number {
  const table = versionTable(options)
  db.exec(versionDdl(table))
  const row = db.prepare<{ v: number | null }>(`SELECT MAX(version) AS v FROM ${table}`).get()
  return row?.v ?? 0
}
