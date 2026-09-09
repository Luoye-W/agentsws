/**
 * 受控原始材料区的 SQLite 档。接口与内存档一致——同一份一致性套件对两档各跑一遍。
 *
 * 三条纪律这一档全兑现：**加密**（{@link RawCipher}，密钥环在 `@agentsws/data`，
 * 本包不复制一套密钥体系、也不共享它的表，35 §2）、**保留期**（`prune`）、
 * **随主体删除**（`eraseSubject` 先销毁密钥再删行；`erase(...refs)` 按 ref 删）。
 */
import type { Clock, Iso8601 } from '@agentsws/contracts'
import type { RawCipher } from '@agentsws/core'
import type { Database as Db } from 'better-sqlite3'
import Database from 'better-sqlite3'
import { MeetingError } from './errors.js'
import { type Migration, migrate, schemaVersion } from './migrations.js'
import {
  bytesOfPayload,
  type MeetingEraseSubjectResult,
  type MeetingRawKind,
  type MeetingRawRecord,
  type MeetingRawStore,
} from './raw-store.js'

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
  {
    // WP31：加密 + 随主体删除。迁移之前落的行都是明文，标 legacy_plain，下次 prune 清掉——
    // 旧 schema 没有 subject_ref，不知道那些行属于谁，编一个主体出来比留着明文更糟。
    version: 2,
    sql: `
ALTER TABLE meeting_raw ADD COLUMN subject_ref TEXT;
ALTER TABLE meeting_raw ADD COLUMN payload_sealed BLOB;
ALTER TABLE meeting_raw ADD COLUMN legacy_plain INTEGER NOT NULL DEFAULT 0;
UPDATE meeting_raw SET legacy_plain = 1;
CREATE INDEX IF NOT EXISTS meeting_raw_by_subject ON meeting_raw (subject_ref);
`,
  },
]

export interface SqliteMeetingRawStoreOptions {
  dbPath?: string
  clock?: Clock
  /** 主体密钥环（`@agentsws/data` 的 `SubjectKeyring`）；不给就是明文落盘。 */
  cipher?: RawCipher
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
  payload_sealed: Buffer | null
  subject_ref: string | null
  legacy_plain: number
  mime: string | null
  name: string | null
  secrets_scrubbed: number
}

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)

export class SqliteMeetingRawStore implements MeetingRawStore {
  readonly #db: Db
  readonly #cipher: RawCipher | undefined
  #closed = false

  constructor(options: SqliteMeetingRawStoreOptions = {}) {
    this.#cipher = options.cipher
    this.#db = new Database(options.dbPath ?? ':memory:')
    this.#db.pragma('journal_mode = WAL')
    migrate(this.#db, MIGRATIONS, options.clock?.now() ?? EPOCH)
  }

  get schemaVersion(): number {
    return schemaVersion(this.#db)
  }

  /** 有没有真在加密（装配检查用：没接上密钥环就是明文落盘）。 */
  get encrypted(): boolean {
    return this.#cipher !== undefined
  }

  /** 底层连接；只给同包测试用。 */
  get database(): Db {
    return this.#db
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
    const common = {
      ref: row.ref,
      workspace_id: row.workspace_id,
      kind: row.kind as MeetingRawKind,
      stored_at: row.stored_at as Iso8601,
      ...(row.mime === null ? {} : { mime: row.mime }),
      ...(row.name === null ? {} : { name: row.name }),
      ...(row.secrets_scrubbed === 1 ? { secrets_scrubbed: true } : {}),
      ...(row.subject_ref === null ? {} : { subject_ref: row.subject_ref }),
    }
    if (row.payload_sealed !== null) {
      const plain =
        this.#cipher === undefined
          ? undefined
          : this.#cipher.open(row.subject_ref ?? '', new Uint8Array(row.payload_sealed))
      if (plain === undefined)
        return { ...common, payload: row.is_binary === 1 ? new Uint8Array(0) : '', erased: true }
      return { ...common, payload: row.is_binary === 1 ? plain : decode(plain) }
    }
    return {
      ...common,
      payload:
        row.is_binary === 1
          ? new Uint8Array(row.payload_blob ?? Buffer.alloc(0))
          : (row.payload_text ?? ''),
    }
  }

  #sealable(subject: string | undefined): subject is string {
    return this.#cipher !== undefined && subject !== undefined && subject !== ''
  }

  put(input: Omit<MeetingRawRecord, 'ref'>): string {
    return this.#db.transaction((): string => {
      const seq = this.#nextSeq()
      const ref = `raw://meetings/${input.workspace_id}/${input.kind}/${seq}`
      const binary = typeof input.payload !== 'string'
      const subject = input.subject_ref
      const sealed = this.#sealable(subject)
        ? Buffer.from((this.#cipher as RawCipher).seal(subject, bytesOfPayload(input.payload)))
        : null
      this.#db
        .prepare(
          `INSERT INTO meeting_raw (ref, workspace_id, kind, stored_at, stored_ms, is_binary,
                                    payload_text, payload_blob, payload_sealed, subject_ref,
                                    mime, name, secrets_scrubbed, legacy_plain)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0)`,
        )
        .run(
          ref,
          input.workspace_id,
          input.kind,
          input.stored_at,
          Date.parse(input.stored_at),
          binary ? 1 : 0,
          sealed !== null || binary ? null : (input.payload as string),
          sealed !== null || !binary ? null : Buffer.from(input.payload as Uint8Array),
          sealed,
          subject ?? null,
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

  /** 21 §4 随主体删除：先销毁主体密钥（备份里的密文当场作废），再删行。 */
  eraseSubject(subject: string): MeetingEraseSubjectResult {
    const shredded_at = this.#cipher?.shred(subject)
    const rows = this.#db
      .prepare<[string]>('DELETE FROM meeting_raw WHERE subject_ref = ?')
      .run(subject).changes
    return { ...(shredded_at === undefined ? {} : { shredded_at }), rows }
  }

  /** 保留期；顺带清掉迁移前留下的明文行（它们没有主体、加不了密，留着就是欠账）。 */
  prune(retentionMs: number, now: Iso8601): number {
    return this.#db
      .prepare<[number]>('DELETE FROM meeting_raw WHERE stored_ms <= ? OR legacy_plain = 1')
      .run(Date.parse(now) - retentionMs).changes
  }

  /** 迁移前留下的明文行还剩几条（装配检查 / 测试用）。 */
  get legacyPlainCount(): number {
    return (
      this.#db
        .prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM meeting_raw WHERE legacy_plain = 1')
        .get()?.n ?? 0
    )
  }

  scrub(ref: string, redact: (text: string) => string): void {
    const row = this.#db
      .prepare<[string], RawRow>('SELECT * FROM meeting_raw WHERE ref = ?')
      .get(ref)
    if (row === undefined) throw new MeetingError('not_found', `原始材料不存在：${ref}`, { ref })
    if (row.is_binary === 1) return
    const current = this.#record(row)
    if (current.erased === true) return
    const text = redact(current.payload as string)
    if (row.payload_sealed !== null && this.#sealable(row.subject_ref ?? undefined)) {
      const sealed = Buffer.from(
        (this.#cipher as RawCipher).seal(row.subject_ref as string, bytesOfPayload(text)),
      )
      this.#db
        .prepare('UPDATE meeting_raw SET payload_sealed = ?, secrets_scrubbed = 1 WHERE ref = ?')
        .run(sealed, ref)
      return
    }
    this.#db
      .prepare('UPDATE meeting_raw SET payload_text = ?, secrets_scrubbed = 1 WHERE ref = ?')
      .run(text, ref)
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
