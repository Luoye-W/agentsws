import type { Clock } from '@agentsws/contracts'
import type { RawCipher } from '@agentsws/core'
import type { Database } from 'better-sqlite3'
import {
  decryptValue,
  type EncryptedField,
  encryptValue,
  newSubjectKey,
  openBytes,
  sealBytes,
  unwrapKey,
  wrapKey,
} from './crypto.js'
import { forbidden } from './errors.js'

interface KeyRow {
  subject_id: string
  key: Buffer | null
  created_at: string
  destroyed_at: string | null
  wrapped: number
}

export interface SubjectKeyringOptions {
  /**
   * 根密钥（`AGENTSWS_DATA_KEY`，见 `parseDataKey`）。给了就把主体密钥**包一层**再落盘：
   * 拿到库文件也拿不到主体密钥。不给也能跑——主体密钥本来就是每主体一把独立随机的，
   * 根密钥只是让「库文件泄漏 ≠ 明文泄漏」这一条也成立。
   *
   * 换根密钥不影响老行：老行 `wrapped = 0`，照旧直接读。
   */
  rootKey?: Buffer
}

/**
 * 21 §4：每个主体一把独立随机生成、不可从主密钥重派生的密钥。销毁 = 把 key 置空并记 destroyed_at；
 * 行保留，保证销毁后不会又给同一主体发新钥（否则「删除」可被下一次写入撤销）。
 *
 * WP31 起它同时是**受控原始材料区**（18 §2.1）的加密出处：实现 `@agentsws/core` 的
 * {@link RawCipher} 端口，`@agentsws/channels` 与 `@agentsws/meetings` 拿这个端口去封装
 * 邮件原文与录音——**它们不共享这张表**（35 §2），只调这几个方法。
 * 于是「随主体删除」在三个库里是同一件事：{@link shred} 一次，谁也读不出来了。
 */
export class SubjectKeyring implements RawCipher {
  readonly #db: Database
  readonly #clock: Clock
  readonly #rootKey: Buffer | undefined
  readonly #cache = new Map<string, Buffer>()

  constructor(db: Database, clock: Clock, options: SubjectKeyringOptions = {}) {
    this.#db = db
    this.#clock = clock
    this.#rootKey = options.rootKey
    db.exec(
      `CREATE TABLE IF NOT EXISTS _subject_keys (
        subject_id TEXT PRIMARY KEY,
        key BLOB,
        created_at TEXT NOT NULL,
        destroyed_at TEXT
      )`,
    )
    // WP31：老库没有 wrapped 列，补一列（默认 0 = 直接存的主体密钥，照旧读）。
    const columns = db
      .prepare<[string], { name: string }>('SELECT name FROM pragma_table_info(?)')
      .all('_subject_keys')
      .map((r) => r.name)
    if (!columns.includes('wrapped'))
      db.exec('ALTER TABLE _subject_keys ADD COLUMN wrapped INTEGER NOT NULL DEFAULT 0')
  }

  #row(subject: string): KeyRow | undefined {
    return this.#db
      .prepare<[string], KeyRow>('SELECT * FROM _subject_keys WHERE subject_id = ?')
      .get(subject)
  }

  /** 落盘形态：有根密钥就包一层。 */
  #store(subject: string, key: Buffer): { blob: Buffer; wrapped: number } {
    return this.#rootKey === undefined
      ? { blob: key, wrapped: 0 }
      : { blob: wrapKey(this.#rootKey, subject, key), wrapped: 1 }
  }

  #load(row: KeyRow): Buffer {
    const blob = Buffer.from(row.key as Buffer)
    if (row.wrapped !== 1) return blob
    if (this.#rootKey === undefined)
      throw forbidden(
        `主体密钥是包裹存的，但这台机器没有根密钥（AGENTSWS_DATA_KEY）：${row.subject_id}`,
      )
    return unwrapKey(this.#rootKey, row.subject_id, blob)
  }

  /** 写 PII 时取密钥；已销毁的主体拒绝再发新钥。 */
  ensure(subject: string): Buffer {
    const cached = this.#cache.get(subject)
    if (cached !== undefined) return cached
    const row = this.#row(subject)
    if (row !== undefined) {
      if (row.key === null)
        throw forbidden(`subject key destroyed; cannot write personal data: ${subject}`)
      const key = this.#load(row)
      this.#cache.set(subject, key)
      return key
    }
    const key = newSubjectKey()
    const stored = this.#store(subject, key)
    this.#db
      .prepare(
        'INSERT INTO _subject_keys (subject_id, key, created_at, wrapped) VALUES (?, ?, ?, ?)',
      )
      .run(subject, stored.blob, this.#clock.now(), stored.wrapped)
    this.#cache.set(subject, key)
    return key
  }

  /** 读 PII 时取密钥；不存在或已销毁 → undefined（读出 `[erased]`）。 */
  get(subject: string): Buffer | undefined {
    const cached = this.#cache.get(subject)
    if (cached !== undefined) return cached
    const row = this.#row(subject)
    if (row === undefined || row.key === null) return undefined
    const key = this.#load(row)
    this.#cache.set(subject, key)
    return key
  }

  isDestroyed(subject: string): boolean {
    const row = this.#row(subject)
    return row !== undefined && row.key === null
  }

  /** 销毁；返回销毁时间。幂等：已销毁的返回原时间。 */
  destroy(subject: string, at: string = this.#clock.now()): string {
    this.#cache.delete(subject)
    const row = this.#row(subject)
    if (row !== undefined && row.key === null) return row.destroyed_at ?? at
    if (row === undefined) {
      this.#db
        .prepare(
          'INSERT INTO _subject_keys (subject_id, key, created_at, destroyed_at) VALUES (?, NULL, ?, ?)',
        )
        .run(subject, at, at)
      return at
    }
    this.#db
      .prepare('UPDATE _subject_keys SET key = NULL, destroyed_at = ? WHERE subject_id = ?')
      .run(at, subject)
    return at
  }

  // ── RawCipher（`@agentsws/core`）：跨包接线的那几个方法 ────────────────

  /** 21 §4 / 18 §2.1：为某个主体加密一段字节。已销毁的主体拒绝再写。 */
  seal(subject: string, plaintext: Uint8Array): Uint8Array {
    return sealBytes(this.ensure(subject), subject, plaintext)
  }

  /** 解不开（密钥已销毁 / 从没有过 / 密文被改动）→ undefined，调用方读出 `[erased]`。 */
  open(subject: string, sealed: Uint8Array): Uint8Array | undefined {
    const key = this.get(subject)
    return key === undefined ? undefined : openBytes(key, subject, sealed)
  }

  /** 加密一个结构化值（记录 body 里的 PII 字段用的那种形态）。 */
  encryptFor(subject: string, value: unknown): EncryptedField {
    return encryptValue(this.ensure(subject), subject, value)
  }

  /** 主体密钥已销毁 → undefined。 */
  decryptFor(subject: string, field: EncryptedField): unknown {
    const key = this.get(subject)
    return key === undefined ? undefined : decryptValue(key, field)
  }

  /** crypto-shredding：销毁主体密钥 = 这个主体的所有密文当场不可读。{@link destroy} 的别名。 */
  shred(subject: string, at?: string): string {
    return at === undefined ? this.destroy(subject) : this.destroy(subject, at)
  }

  isShredded(subject: string): boolean {
    return this.isDestroyed(subject)
  }
}
