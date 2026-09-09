/**
 * 迁移器（照 `packages/txn` 的做法：内嵌 SQL 数组 + 版本号表）。
 *
 * - 本包一张自己的 `_migrations`，**不共享其他包的表**（35 §2）
 * - 幂等：同一个库开两次只补跑没跑过的版本
 * - 全程一个事务：中途失败不会留下半张表
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

export const WORK_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    sql: `
CREATE TABLE IF NOT EXISTS matters (
  id            TEXT PRIMARY KEY NOT NULL,
  workspace_id  TEXT NOT NULL,
  position_id   TEXT,
  kind          TEXT NOT NULL,
  status        TEXT NOT NULL,
  goal_id       TEXT,
  last_activity INTEGER NOT NULL,
  json          TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS matters_by_ws ON matters (workspace_id, status);
CREATE INDEX IF NOT EXISTS matters_by_activity ON matters (workspace_id, last_activity DESC);

CREATE TABLE IF NOT EXISTS matter_events (
  id        TEXT PRIMARY KEY NOT NULL,
  matter_id TEXT NOT NULL,
  at_ms     INTEGER NOT NULL,
  json      TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS matter_events_by_matter ON matter_events (matter_id, at_ms);

CREATE TABLE IF NOT EXISTS goals (
  id           TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  level        TEXT NOT NULL,
  parent_id    TEXT,
  position_id  TEXT,
  owner        TEXT NOT NULL,
  status       TEXT NOT NULL,
  created_ms   INTEGER NOT NULL,
  json         TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS goals_by_ws ON goals (workspace_id, status);

CREATE TABLE IF NOT EXISTS todos (
  id           TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  owner        TEXT NOT NULL,
  position_id  TEXT,
  matter_id    TEXT,
  goal_id      TEXT,
  parent_id    TEXT,
  horizon      TEXT NOT NULL,
  status       TEXT NOT NULL,
  scheduled_ms INTEGER,
  due_ms       INTEGER,
  created_ms   INTEGER NOT NULL,
  json         TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS todos_by_ws ON todos (workspace_id, status, horizon);
CREATE INDEX IF NOT EXISTS todos_by_matter ON todos (matter_id);
CREATE INDEX IF NOT EXISTS todos_by_when ON todos (workspace_id, scheduled_ms, due_ms);

CREATE TABLE IF NOT EXISTS plans (
  id           TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  person_id    TEXT NOT NULL,
  date         TEXT NOT NULL,
  json         TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS plans_by_day ON plans (workspace_id, person_id, date);

CREATE TABLE IF NOT EXISTS reviews (
  id           TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  person_id    TEXT NOT NULL,
  kind         TEXT NOT NULL,
  created_ms   INTEGER NOT NULL,
  json         TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS reviews_by_ws ON reviews (workspace_id, created_ms DESC);
`,
  },
]
