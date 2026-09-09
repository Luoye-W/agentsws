/**
 * 会议包自己的迁移器（做法照 kernel 事件日志：内嵌 SQL 数组 + 版本号表）。
 * 本包只用自己这张库里的表，不共享其他包的表（35 §2）；同一个库开两次幂等。
 */
import type { Database } from 'better-sqlite3'

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
export function migrate(db: Database, migrations: readonly Migration[], at: string): number[] {
  db.exec(VERSION_TABLE)
  const done = new Set(
    db
      .prepare<[], { version: number }>('SELECT version FROM _migrations')
      .all()
      .map((r) => r.version),
  )
  const record = db.prepare('INSERT INTO _migrations (version, applied_at) VALUES (?, ?)')
  const applied: number[] = []
  const run = db.transaction((list: readonly Migration[]) => {
    for (const m of list) {
      db.exec(m.sql)
      record.run(m.version, at)
      applied.push(m.version)
    }
  })
  run([...migrations].filter((m) => !done.has(m.version)).sort((a, b) => a.version - b.version))
  return applied
}

/** 已应用的最高版本（0 = 空库）。 */
export function schemaVersion(db: Database): number {
  db.exec(VERSION_TABLE)
  const row = db
    .prepare<[], { v: number | null }>('SELECT MAX(version) AS v FROM _migrations')
    .get()
  return row?.v ?? 0
}
