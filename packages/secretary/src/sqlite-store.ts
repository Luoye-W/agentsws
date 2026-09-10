/**
 * `SecretaryStore` 的 SQLite 档。与 `MemorySecretaryStore` 行为逐字一致——
 * 同一份用例对两档各跑一遍（`test/store-conformance.ts`）。
 *
 * 纪律（35 §2）：SQL 全参数化；`better-sqlite3` 同步 API；只用自己这张库里的表；
 * 迁移器自带版本表，不共享其他包的 `_migrations`。
 */
import type { Clock, PersonId, WorkspaceId } from '@agentsws/contracts'
import type { Database as Db } from 'better-sqlite3'
import Database from 'better-sqlite3'
import type { AskedFilter, MeetFilter, SecretaryStore } from './store.js'
import type { AskedRecord, MeetProposal, ProfileRecord } from './types.js'

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

export const SECRETARY_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    sql: `
CREATE TABLE IF NOT EXISTS secretary_profiles (
  workspace_id TEXT NOT NULL,
  person_id    TEXT NOT NULL,
  json         TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (workspace_id, person_id)
) STRICT;

CREATE TABLE IF NOT EXISTS secretary_asked (
  id           TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  person_id    TEXT NOT NULL,
  asked_by     TEXT NOT NULL,
  at           TEXT NOT NULL,
  json         TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS secretary_asked_owner
  ON secretary_asked (workspace_id, person_id, at DESC);

CREATE TABLE IF NOT EXISTS secretary_meets (
  id           TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  from_person  TEXT NOT NULL,
  to_person    TEXT NOT NULL,
  state        TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  json         TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS secretary_meets_to
  ON secretary_meets (workspace_id, to_person, created_at DESC);
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

export interface SqliteSecretaryStoreOptions {
  /** 缺省 `:memory:`（测试与一次性任务） */
  dbPath?: string
  clock?: Clock
}

export class SqliteSecretaryStore implements SecretaryStore {
  readonly db: Db

  constructor(options: SqliteSecretaryStoreOptions = {}) {
    this.db = new Database(options.dbPath ?? ':memory:')
    this.db.pragma('journal_mode = WAL')
    migrate(this.db, SECRETARY_MIGRATIONS, options.clock?.now() ?? '1970-01-01T00:00:00.000Z')
  }

  getProfile(workspace_id: WorkspaceId, person_id: PersonId): ProfileRecord | undefined {
    const row = this.db
      .prepare<[string, string], { json: string }>(
        'SELECT json FROM secretary_profiles WHERE workspace_id = ? AND person_id = ?',
      )
      .get(workspace_id, person_id)
    return row === undefined ? undefined : (JSON.parse(row.json) as ProfileRecord)
  }

  putProfile(record: ProfileRecord): void {
    this.db
      .prepare(
        'INSERT INTO secretary_profiles (workspace_id, person_id, json, updated_at) VALUES (?, ?, ?, ?) ' +
          'ON CONFLICT (workspace_id, person_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at',
      )
      .run(record.workspace_id, record.person_id, JSON.stringify(record), record.updated_at)
  }

  listProfiles(workspace_id: WorkspaceId): ProfileRecord[] {
    return this.db
      .prepare<[string], { json: string }>(
        'SELECT json FROM secretary_profiles WHERE workspace_id = ? ORDER BY person_id',
      )
      .all(workspace_id)
      .map((r) => JSON.parse(r.json) as ProfileRecord)
  }

  appendAsked(record: AskedRecord): void {
    this.db
      .prepare(
        'INSERT INTO secretary_asked (id, workspace_id, person_id, asked_by, at, json) ' +
          'VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING',
      )
      .run(
        record.id,
        record.workspace_id,
        record.person_id,
        record.asked_by,
        record.at,
        JSON.stringify(record),
      )
  }

  listAsked(
    workspace_id: WorkspaceId,
    person_id: PersonId,
    filter: AskedFilter = {},
  ): AskedRecord[] {
    const limit = filter.limit ?? 50
    const rows =
      filter.asked_by === undefined
        ? this.db
            .prepare<[string, string, number], { json: string }>(
              'SELECT json FROM secretary_asked WHERE workspace_id = ? AND person_id = ? ' +
                'ORDER BY at DESC, id DESC LIMIT ?',
            )
            .all(workspace_id, person_id, limit)
        : this.db
            .prepare<[string, string, string, number], { json: string }>(
              'SELECT json FROM secretary_asked WHERE workspace_id = ? AND person_id = ? AND asked_by = ? ' +
                'ORDER BY at DESC, id DESC LIMIT ?',
            )
            .all(workspace_id, person_id, filter.asked_by, limit)
    return rows.map((r) => JSON.parse(r.json) as AskedRecord)
  }

  putMeet(proposal: MeetProposal): void {
    this.db
      .prepare(
        'INSERT INTO secretary_meets (id, workspace_id, from_person, to_person, state, created_at, json) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET ' +
          'state = excluded.state, json = excluded.json',
      )
      .run(
        proposal.id,
        proposal.workspace_id,
        proposal.from,
        proposal.to,
        proposal.state,
        proposal.created_at,
        JSON.stringify(proposal),
      )
  }

  getMeet(id: string): MeetProposal | undefined {
    const row = this.db
      .prepare<[string], { json: string }>('SELECT json FROM secretary_meets WHERE id = ?')
      .get(id)
    return row === undefined ? undefined : (JSON.parse(row.json) as MeetProposal)
  }

  listMeets(workspace_id: WorkspaceId, filter: MeetFilter = {}): MeetProposal[] {
    // 过滤条件是可选的组合，与其拼 SQL 不如把这个工作区的取出来在内存里筛：
    // 一个工作区的"约时间"卡是几十条量级，不值得为它写一个查询构造器。
    return this.db
      .prepare<[string], { json: string }>(
        'SELECT json FROM secretary_meets WHERE workspace_id = ? ORDER BY created_at DESC, id DESC',
      )
      .all(workspace_id)
      .map((r) => JSON.parse(r.json) as MeetProposal)
      .filter(
        (m) =>
          (filter.from === undefined || m.from === filter.from) &&
          (filter.to === undefined || m.to === filter.to) &&
          (filter.state === undefined || filter.state.includes(m.state)),
      )
      .slice(0, filter.limit ?? 100)
  }

  erasePerson(workspace_id: WorkspaceId, person_id: PersonId): number {
    const run = this.db.transaction((): number => {
      let removed = 0
      removed += this.db
        .prepare('DELETE FROM secretary_profiles WHERE workspace_id = ? AND person_id = ?')
        .run(workspace_id, person_id).changes
      removed += this.db
        .prepare(
          'DELETE FROM secretary_asked WHERE workspace_id = ? AND (person_id = ? OR asked_by = ?)',
        )
        .run(workspace_id, person_id, person_id).changes
      removed += this.db
        .prepare(
          'DELETE FROM secretary_meets WHERE workspace_id = ? AND (from_person = ? OR to_person = ?)',
        )
        .run(workspace_id, person_id, person_id).changes
      return removed
    })
    return run()
  }

  close(): void {
    this.db.close()
  }
}

export function createSqliteSecretaryStore(
  options: SqliteSecretaryStoreOptions = {},
): SqliteSecretaryStore {
  return new SqliteSecretaryStore(options)
}
