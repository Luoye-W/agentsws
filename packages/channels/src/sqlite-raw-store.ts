/**
 * 受控原始材料区（18 §2.1 + 31 §4）的 SQLite 档（WP18）。接口与内存档一致——
 * 同一份契约一致性套件对两档各跑一遍。
 *
 * 三条纪律里这一档兑现两条：**保留期**（`prune`，按注入的 Clock）与
 * **随主体删除**（`erase`，按 ref 硬删）。第三条**加密**留给宿主：
 * `packages/data` 的主体密钥环是加密与"密钥销毁 = 不可读"的唯一出处，
 * 本包不复制一套密钥体系，也不共享它的表（35 §2）——见报告 §3。
 *
 * **这里的内容永不进模型**：管线只把 `ref` 写进 `InboundEvent.raw_ref`。
 */

import type { ChannelName, Clock, Iso8601 } from '@agentsws/contracts'
import type { Database as Db } from 'better-sqlite3'
import Database from 'better-sqlite3'
import { ChannelError } from './errors.js'
import { type Migration, migrate, schemaVersion } from './migrations.js'
import type { RawRecord, RawStore } from './raw-store.js'

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    sql: `
CREATE TABLE IF NOT EXISTS raw (
  ref              TEXT PRIMARY KEY NOT NULL,
  channel          TEXT NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('message','attachment')),
  stored_at        TEXT NOT NULL,
  stored_ms        INTEGER NOT NULL,
  is_binary        INTEGER NOT NULL,
  payload_text     TEXT,
  payload_blob     BLOB,
  mime             TEXT,
  name             TEXT,
  secrets_scrubbed INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS raw_by_age ON raw (stored_ms);

CREATE TABLE IF NOT EXISTS raw_counter (
  name  TEXT PRIMARY KEY NOT NULL,
  value INTEGER NOT NULL
) STRICT;
`,
  },
]

export interface SqliteRawStoreOptions {
  /** SQLite 文件路径；缺省 `:memory:`。 */
  dbPath?: string
  /** 迁移记时间与保留期清理用。 */
  clock?: Clock
}

const EPOCH = '1970-01-01T00:00:00.000Z'

interface RawRow {
  ref: string
  channel: string
  kind: string
  stored_at: string
  is_binary: number
  payload_text: string | null
  payload_blob: Buffer | null
  mime: string | null
  name: string | null
  secrets_scrubbed: number
}

export class SqliteRawStore implements RawStore {
  readonly #db: Db
  readonly #clock: Clock | undefined
  #closed = false

  constructor(options: SqliteRawStoreOptions = {}) {
    this.#clock = options.clock
    this.#db = new Database(options.dbPath ?? ':memory:')
    this.#db.pragma('journal_mode = WAL')
    migrate(this.#db, MIGRATIONS, options.clock?.now() ?? EPOCH)
  }

  get schemaVersion(): number {
    return schemaVersion(this.#db)
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
      .prepare<[string], { value: number }>('SELECT value FROM raw_counter WHERE name = ?')
      .get('ref')
    const next = (row?.value ?? 0) + 1
    this.#db
      .prepare(
        `INSERT INTO raw_counter (name, value) VALUES (?,?)
         ON CONFLICT(name) DO UPDATE SET value = excluded.value`,
      )
      .run('ref', next)
    return next
  }

  #record(row: RawRow): RawRecord {
    const payload: string | Uint8Array =
      row.is_binary === 1
        ? new Uint8Array(row.payload_blob ?? Buffer.alloc(0))
        : (row.payload_text ?? '')
    return {
      ref: row.ref,
      channel: row.channel as ChannelName,
      kind: row.kind as RawRecord['kind'],
      stored_at: row.stored_at as Iso8601,
      payload,
      ...(row.mime === null ? {} : { mime: row.mime }),
      ...(row.name === null ? {} : { name: row.name }),
      ...(row.secrets_scrubbed === 1 ? { secrets_scrubbed: true } : {}),
    }
  }

  put(input: Omit<RawRecord, 'ref'>): string {
    return this.#db.transaction((): string => {
      const seq = this.#nextSeq()
      const ref = `raw://inbound/${input.channel}/${input.kind}/${seq}`
      const binary = typeof input.payload !== 'string'
      this.#db
        .prepare(
          `INSERT INTO raw (ref, channel, kind, stored_at, stored_ms, is_binary,
                            payload_text, payload_blob, mime, name, secrets_scrubbed)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          ref,
          input.channel,
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

  get(ref: string): RawRecord | undefined {
    const row = this.#db.prepare<[string], RawRow>('SELECT * FROM raw WHERE ref = ?').get(ref)
    return row === undefined ? undefined : this.#record(row)
  }

  scrub(ref: string, redact: (text: string) => string): void {
    const row = this.#db.prepare<[string], RawRow>('SELECT * FROM raw WHERE ref = ?').get(ref)
    if (row === undefined) throw new ChannelError('not_found', `原始材料不存在：${ref}`, { ref })
    if (row.is_binary === 1) return
    this.#db
      .prepare('UPDATE raw SET payload_text = ?, secrets_scrubbed = 1 WHERE ref = ?')
      .run(redact(row.payload_text ?? ''), ref)
  }

  /** 观察面：受控区里现有的全部记录（测试用）。 */
  all(): RawRecord[] {
    return this.#db
      .prepare<[], RawRow>('SELECT * FROM raw ORDER BY rowid')
      .all()
      .map((r) => this.#record(r))
  }

  get size(): number {
    return this.#db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM raw').get()?.n ?? 0
  }

  /** 保留期（18 §2.1）：丢掉 `retention_ms` 之前落进来的原始材料。返回删掉的条数。 */
  prune(retentionMs: number, clock?: Clock): number {
    const c = clock ?? this.#clock
    if (c === undefined)
      throw new ChannelError('invalid_input', 'prune 需要一个 Clock（构造时给或调用时给）')
    return this.#db
      .prepare<[number]>('DELETE FROM raw WHERE stored_ms <= ?')
      .run(Date.parse(c.now()) - retentionMs).changes
  }

  /** 随主体删除（31 §4）：按 ref 硬删。返回删掉的条数。 */
  erase(...refs: readonly string[]): number {
    if (refs.length === 0) return 0
    return this.#db
      .prepare(`DELETE FROM raw WHERE ref IN (${refs.map(() => '?').join(',')})`)
      .run(...refs).changes
  }
}

export function createSqliteRawStore(options: SqliteRawStoreOptions = {}): SqliteRawStore {
  return new SqliteRawStore(options)
}
