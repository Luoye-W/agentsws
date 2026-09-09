/**
 * 受控原始材料区的 SQLite 档。接口与内存档一致——同一份一致性套件对两档各跑一遍。
 *
 * 三条纪律里这一档兑现两条：**保留期**（`prune`）与**随主体删除**（`erase`）。
 * 第三条**加密**留给宿主：`packages/data` 的主体密钥环是唯一出处，本包不复制一套密钥体系，
 * 也不共享它的表（35 §2）。
 */
import type { Clock, Iso8601 } from '@agentsws/contracts'
import type { Database as Db } from 'better-sqlite3'
import Database from 'better-sqlite3'
import { MeetingError } from './errors.js'
import { type Migration, migrate, schemaVersion } from './migrations.js'
import type { MeetingRawKind, MeetingRawRecord, MeetingRawStore } from './raw-store.js'

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    sql: `
CREATE TABLE IF NOT EXISTS meeting_raw (
  ref              TEXT PRIMARY KEY NOT NULL,
  workspace_id     TEXT NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('audio','video','transcript','document')),
  stored_at        TEXT NOT NULL,
  stored_ms        INTEGER NOT NULL,
  is_binary        INTEGER NOT NULL,
  payload_text     TEXT,
  payload_blob     BLOB,
  mime             TEXT,
  name             TEXT,
  secrets_scrubbed INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS meeting_raw_by_age ON meeting_raw (stored_ms);

CREATE TABLE IF NOT EXISTS meeting_raw_counter (
  name  TEXT PRIMARY KEY NOT NULL,
  value INTEGER NOT NULL
) STRICT;
`,
  },
]

export interface SqliteMeetingRawStoreOptions {
  dbPath?: string
  clock?: Clock
}

const EPOCH = '1970-01-01T00:00:00.000Z'

interface RawRow {
  ref: string
  workspace_id: string
  kind: string
  stored_at: string
  is_binary: number
  payload_text: string | null
  payload_blob: Buffer | null
  mime: string | null
  name: string | null
  secrets_scrubbed: number
}

export class SqliteMeetingRawStore implements MeetingRawStore {
  readonly #db: Db
  #closed = false

  constructor(options: SqliteMeetingRawStoreOptions = {}) {
    this.#db = new Database(options.dbPath ?? ':memory:')
    this.#db.pragma('journal_mode = WAL')
    migrate(this.#db, MIGRATIONS, options.clock?.now() ?? EPOCH)
  }

  get schemaVersion(): number {
    return schemaVersion(this.#db)
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#db.close()
  }

  #nextSeq(): number {
    const row = this.#db
      .prepare<[string], { value: number }>('SELECT value FROM meeting_raw_counter WHERE name = ?')
      .get('ref')
    const next = (row?.value ?? 0) + 1
    this.#db
      .prepare(
        `INSERT INTO meeting_raw_counter (name, value) VALUES (?,?)
         ON CONFLICT(name) DO UPDATE SET value = excluded.value`,
      )
      .run('ref', next)
    return next
  }

  #record(row: RawRow): MeetingRawRecord {
    const payload: string | Uint8Array =
      row.is_binary === 1
        ? new Uint8Array(row.payload_blob ?? Buffer.alloc(0))
        : (row.payload_text ?? '')
    return {
      ref: row.ref,
      workspace_id: row.workspace_id,
      kind: row.kind as MeetingRawKind,
      stored_at: row.stored_at as Iso8601,
      payload,
      ...(row.mime === null ? {} : { mime: row.mime }),
      ...(row.name === null ? {} : { name: row.name }),
      ...(row.secrets_scrubbed === 1 ? { secrets_scrubbed: true } : {}),
    }
  }

  put(input: Omit<MeetingRawRecord, 'ref'>): string {
    return this.#db.transaction((): string => {
      const seq = this.#nextSeq()
      const ref = `raw://meetings/${input.workspace_id}/${input.kind}/${seq}`
      const binary = typeof input.payload !== 'string'
      this.#db
        .prepare(
          `INSERT INTO meeting_raw (ref, workspace_id, kind, stored_at, stored_ms, is_binary,
                                    payload_text, payload_blob, mime, name, secrets_scrubbed)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          ref,
          input.workspace_id,
          input.kind,
          input.stored_at,
          Date.parse(input.stored_at),
          binary ? 1 : 0,
          binary ? null : (input.payload as string),
          binary ? Buffer.from(input.payload as Uint8Array) : null,
          input.mime ?? null,
          input.name ?? null,
          input.secrets_scrubbed === true ? 1 : 0,
        )
      return ref
    })()
  }

  get(ref: string): MeetingRawRecord | undefined {
    const row = this.#db
      .prepare<[string], RawRow>('SELECT * FROM meeting_raw WHERE ref = ?')
      .get(ref)
    return row === undefined ? undefined : this.#record(row)
  }

  erase(...refs: readonly string[]): number {
    if (refs.length === 0) return 0
    return this.#db
      .prepare(`DELETE FROM meeting_raw WHERE ref IN (${refs.map(() => '?').join(',')})`)
      .run(...refs).changes
  }

  prune(retentionMs: number, now: Iso8601): number {
    return this.#db
      .prepare<[number]>('DELETE FROM meeting_raw WHERE stored_ms <= ?')
      .run(Date.parse(now) - retentionMs).changes
  }

  scrub(ref: string, redact: (text: string) => string): void {
    const row = this.#db
      .prepare<[string], RawRow>('SELECT * FROM meeting_raw WHERE ref = ?')
      .get(ref)
    if (row === undefined) throw new MeetingError('not_found', `原始材料不存在：${ref}`, { ref })
    if (row.is_binary === 1) return
    this.#db
      .prepare('UPDATE meeting_raw SET payload_text = ?, secrets_scrubbed = 1 WHERE ref = ?')
      .run(redact(row.payload_text ?? ''), ref)
  }

  all(): MeetingRawRecord[] {
    return this.#db
      .prepare<[], RawRow>('SELECT * FROM meeting_raw ORDER BY rowid')
      .all()
      .map((r) => this.#record(r))
  }

  get size(): number {
    return (
      this.#db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM meeting_raw').get()?.n ?? 0
    )
  }
}

export function createSqliteMeetingRawStore(
  options: SqliteMeetingRawStoreOptions = {},
): SqliteMeetingRawStore {
  return new SqliteMeetingRawStore(options)
}
