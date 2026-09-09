/**
 * 受控原始材料区（18 §2.1 + 31 §4）的 SQLite 档（WP18 / WP31）。接口与内存档一致——
 * 同一份契约一致性套件对两档各跑一遍。
 *
 * 三条纪律这一档全兑现：
 * - **加密**：给了 {@link RawCipher}（`@agentsws/data` 的主体密钥环）且这条材料有
 *   `subject_ref`，载荷就以密文落 `payload_sealed` 列，明文列一个字都不写。
 *   密钥不在本库里（35 §2 不共享表），所以拿到这个库文件也读不出内容。
 * - **保留期**：`prune`，按注入的 Clock。顺带清掉迁移前留下的明文行（`legacy_plain`）。
 * - **随主体删除**：`eraseSubject` 先销毁主体密钥（备份里的密文当场作废）再删行；
 *   `erase(...refs)` 保留给「按 ref 删」的老调用。
 *
 * **这里的内容永不进模型**：管线只把 `ref` 写进 `InboundEvent.raw_ref`。
 */

import type { ChannelName, Clock, Iso8601 } from '@agentsws/contracts'
import type { RawCipher } from '@agentsws/core'
import type { Database as Db } from 'better-sqlite3'
import Database from 'better-sqlite3'
import { ChannelError } from './errors.js'
import { type Migration, migrate, schemaVersion } from './migrations.js'
import { bytesOf, type EraseSubjectResult, type RawRecord, type RawStore } from './raw-store.js'

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
  {
    // WP31：加密 + 随主体删除。跑这条迁移之前落的行都是明文，一律标 legacy_plain，
    // 下一次 prune 清掉——不在迁移里就地加密，是因为**我们不知道那些行属于谁**
    // （旧 schema 没有 subject_ref），编一个主体出来比留着明文更糟。
    version: 2,
    sql: `
ALTER TABLE raw ADD COLUMN subject_ref TEXT;
ALTER TABLE raw ADD COLUMN payload_sealed BLOB;
ALTER TABLE raw ADD COLUMN legacy_plain INTEGER NOT NULL DEFAULT 0;
UPDATE raw SET legacy_plain = 1;
CREATE INDEX IF NOT EXISTS raw_by_subject ON raw (subject_ref);
`,
  },
]

export interface SqliteRawStoreOptions {
  /** SQLite 文件路径；缺省 `:memory:`。 */
  dbPath?: string
  /** 迁移记时间与保留期清理用。 */
  clock?: Clock
  /**
   * 主体密钥环（`@agentsws/data` 的 `SubjectKeyring`）。给了就加密，
   * 不给就是明文落盘——本包不自己造一套密钥体系（35 §2）。
   */
  cipher?: RawCipher
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
  payload_sealed: Buffer | null
  subject_ref: string | null
  legacy_plain: number
  mime: string | null
  name: string | null
  secrets_scrubbed: number
}

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)

export class SqliteRawStore implements RawStore {
  readonly #db: Db
  readonly #clock: Clock | undefined
  readonly #cipher: RawCipher | undefined
  #closed = false

  constructor(options: SqliteRawStoreOptions = {}) {
    this.#clock = options.clock
    this.#cipher = options.cipher
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

  /** 有没有真在加密（装配检查用：没接上密钥环就是明文落盘）。 */
  get encrypted(): boolean {
    return this.#cipher !== undefined
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
    const common = {
      ref: row.ref,
      channel: row.channel as ChannelName,
      kind: row.kind as RawRecord['kind'],
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
        return {
          ...common,
          payload: row.is_binary === 1 ? new Uint8Array(0) : '',
          erased: true,
        }
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

  /** 能加密就加密：有 cipher 且这条材料指明了主体。 */
  #sealable(subject: string | undefined): subject is string {
    return this.#cipher !== undefined && subject !== undefined && subject !== ''
  }

  put(input: Omit<RawRecord, 'ref'>): string {
    return this.#db.transaction((): string => {
      const seq = this.#nextSeq()
      const ref = `raw://inbound/${input.channel}/${input.kind}/${seq}`
      const binary = typeof input.payload !== 'string'
      const subject = input.subject_ref
      const sealed = this.#sealable(subject)
        ? Buffer.from((this.#cipher as RawCipher).seal(subject, bytesOf(input.payload)))
        : null
      this.#db
        .prepare(
          `INSERT INTO raw (ref, channel, kind, stored_at, stored_ms, is_binary,
                            payload_text, payload_blob, payload_sealed, subject_ref,
                            mime, name, secrets_scrubbed, legacy_plain)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0)`,
        )
        .run(
          ref,
          input.channel,
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

  get(ref: string): RawRecord | undefined {
    const row = this.#db.prepare<[string], RawRow>('SELECT * FROM raw WHERE ref = ?').get(ref)
    return row === undefined ? undefined : this.#record(row)
  }

  scrub(ref: string, redact: (text: string) => string): void {
    const row = this.#db.prepare<[string], RawRow>('SELECT * FROM raw WHERE ref = ?').get(ref)
    if (row === undefined) throw new ChannelError('not_found', `原始材料不存在：${ref}`, { ref })
    if (row.is_binary === 1) return
    const current = this.#record(row)
    if (current.erased === true) return
    const text = redact(current.payload as string)
    if (row.payload_sealed !== null && this.#sealable(row.subject_ref ?? undefined)) {
      const sealed = Buffer.from(
        (this.#cipher as RawCipher).seal(row.subject_ref as string, bytesOf(text)),
      )
      this.#db
        .prepare('UPDATE raw SET payload_sealed = ?, secrets_scrubbed = 1 WHERE ref = ?')
        .run(sealed, ref)
      return
    }
    this.#db
      .prepare('UPDATE raw SET payload_text = ?, secrets_scrubbed = 1 WHERE ref = ?')
      .run(text, ref)
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

  /**
   * 保留期（18 §2.1）：丢掉 `retention_ms` 之前落进来的原始材料。
   * **迁移前留下的明文行一并清掉**，不看年龄——它们没有主体、加不了密，留着就是欠账。
   * 返回删掉的条数。
   */
  prune(retentionMs: number, clock?: Clock): number {
    const c = clock ?? this.#clock
    if (c === undefined)
      throw new ChannelError('invalid_input', 'prune 需要一个 Clock（构造时给或调用时给）')
    return this.#db
      .prepare<[number]>('DELETE FROM raw WHERE stored_ms <= ? OR legacy_plain = 1')
      .run(Date.parse(c.now()) - retentionMs).changes
  }

  /** 迁移前留下的明文行还剩几条（装配检查 / 测试用）。 */
  get legacyPlainCount(): number {
    return (
      this.#db
        .prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM raw WHERE legacy_plain = 1')
        .get()?.n ?? 0
    )
  }

  /** 按 ref 硬删（老调用；随主体删除请用 {@link eraseSubject}）。返回删掉的条数。 */
  erase(...refs: readonly string[]): number {
    if (refs.length === 0) return 0
    return this.#db
      .prepare(`DELETE FROM raw WHERE ref IN (${refs.map(() => '?').join(',')})`)
      .run(...refs).changes
  }

  /** 21 §4 随主体删除：先销毁主体密钥（备份里的密文当场作废），再删行。 */
  eraseSubject(subject: string): EraseSubjectResult {
    const shredded_at = this.#cipher?.shred(subject)
    const rows = this.#db
      .prepare<[string]>('DELETE FROM raw WHERE subject_ref = ?')
      .run(subject).changes
    return { ...(shredded_at === undefined ? {} : { shredded_at }), rows }
  }
}

export function createSqliteRawStore(options: SqliteRawStoreOptions = {}): SqliteRawStore {
  return new SqliteRawStore(options)
}
