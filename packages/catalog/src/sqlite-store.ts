/**
 * `CatalogStore` 的 SQLite 档。与 {@link MemoryCatalogStore} 行为逐字一致——
 * 同一份用例对两档各跑一遍。
 *
 * 纪律（35 §2）：SQL 全参数化；`better-sqlite3` 同步 API；只用自己这张库里的表；
 * 迁移器自带版本表，不共享其他包的 `_migrations`。
 */
import type { Clock, WorkspaceId } from '@agentsws/contracts'
import type { Database as Db } from 'better-sqlite3'
import Database from 'better-sqlite3'
import { type CatalogStore, mergeNote } from './store.js'
import type { CatalogNote } from './types.js'

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

export const CATALOG_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    sql: `
CREATE TABLE IF NOT EXISTS catalog_notes (
  workspace_id TEXT NOT NULL,
  entry_id     TEXT NOT NULL,
  json         TEXT NOT NULL,
  at           TEXT NOT NULL,
  PRIMARY KEY (workspace_id, entry_id)
) STRICT;
CREATE INDEX IF NOT EXISTS catalog_notes_ws ON catalog_notes (workspace_id);
`,
  },
]

export function migrate(db: Db, migrations: readonly Migration[], at: string): number[] {
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

export interface SqliteCatalogStoreOptions {
  /** 缺省 `:memory:`（测试与一次性任务） */
  dbPath?: string
  clock?: Clock
}

export class SqliteCatalogStore implements CatalogStore {
  readonly db: Db

  constructor(options: SqliteCatalogStoreOptions = {}) {
    this.db = new Database(options.dbPath ?? ':memory:')
    this.db.pragma('journal_mode = WAL')
    migrate(this.db, CATALOG_MIGRATIONS, options.clock?.now() ?? '1970-01-01T00:00:00.000Z')
  }

  put(note: CatalogNote): void {
    const merged = mergeNote(this.get(note.workspace_id, note.entry_id), note)
    this.db
      .prepare(
        'INSERT INTO catalog_notes (workspace_id, entry_id, json, at) VALUES (?, ?, ?, ?) ' +
          'ON CONFLICT (workspace_id, entry_id) DO UPDATE SET json = excluded.json, at = excluded.at',
      )
      .run(merged.workspace_id, merged.entry_id, JSON.stringify(merged), merged.at)
  }

  get(workspace_id: WorkspaceId, entry_id: string): CatalogNote | undefined {
    const row = this.db
      .prepare<[string, string], { json: string }>(
        'SELECT json FROM catalog_notes WHERE workspace_id = ? AND entry_id = ?',
      )
      .get(workspace_id, entry_id)
    return row === undefined ? undefined : (JSON.parse(row.json) as CatalogNote)
  }

  list(workspace_id: WorkspaceId): CatalogNote[] {
    return this.db
      .prepare<[string], { json: string }>(
        'SELECT json FROM catalog_notes WHERE workspace_id = ? ORDER BY entry_id',
      )
      .all(workspace_id)
      .map((r) => JSON.parse(r.json) as CatalogNote)
  }

  close(): void {
    this.db.close()
  }
}
