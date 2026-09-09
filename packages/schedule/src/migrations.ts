/**
 * 迁移器（照 `@agentsws/txn`：内嵌 SQL 数组 + 版本号表）。
 * 本包一张自己的 `_migrations`，不共享其他包的表（35 §2）。
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

export const SCHEDULE_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    sql: `
CREATE TABLE IF NOT EXISTS tasks (
  id              TEXT PRIMARY KEY NOT NULL,
  workspace_id    TEXT NOT NULL,
  owner           TEXT NOT NULL,
  role_id         TEXT NOT NULL,
  assignment_id   TEXT NOT NULL,
  conversation_id TEXT,
  handler         TEXT,
  state           TEXT NOT NULL,
  next_fire_at    TEXT,
  json            TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS tasks_by_ws ON tasks (workspace_id, state);
CREATE INDEX IF NOT EXISTS tasks_by_due ON tasks (state, next_fire_at);
CREATE INDEX IF NOT EXISTS tasks_by_conversation ON tasks (conversation_id);

CREATE TABLE IF NOT EXISTS instances (
  id              TEXT PRIMARY KEY NOT NULL,
  workspace_id    TEXT NOT NULL,
  def_id          TEXT NOT NULL,
  state           TEXT NOT NULL,
  subject_type    TEXT NOT NULL,
  subject_id      TEXT NOT NULL,
  conversation_id TEXT,
  json            TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS instances_by_ws ON instances (workspace_id, state);
CREATE INDEX IF NOT EXISTS instances_by_def ON instances (def_id);
`,
  },
]

/** 跑到最新版；返回本次实际补跑的版本号。 */
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
