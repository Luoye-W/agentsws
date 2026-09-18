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

const VERSION_TABLE = `
CREATE TABLE IF NOT EXISTS _migrations (
  version    INTEGER PRIMARY KEY NOT NULL,
  applied_at TEXT    NOT NULL
) STRICT;
`

/** 跑到最新版；返回本次实际补跑的版本号（已是最新则空数组）。 */
export function migrate(db: SyncDb, migrations: readonly Migration[], at: string): number[] {
  db.exec(VERSION_TABLE)
  const done = new Set(
    db
      .prepare<{ version: number }>('SELECT version FROM _migrations')
      .all()
      .map((r) => r.version),
  )
  const record = db.prepare('INSERT INTO _migrations (version, applied_at) VALUES (?, ?)')
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
export function schemaVersion(db: SyncDb): number {
  db.exec(VERSION_TABLE)
  const row = db.prepare<{ v: number | null }>('SELECT MAX(version) AS v FROM _migrations').get()
  return row?.v ?? 0
}
