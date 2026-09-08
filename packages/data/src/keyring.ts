import type { Clock } from '@agentsws/contracts'
import type { Database } from 'better-sqlite3'
import { newSubjectKey } from './crypto.js'
import { forbidden } from './errors.js'

interface KeyRow {
  subject_id: string
  key: Buffer | null
  created_at: string
  destroyed_at: string | null
}

/**
 * 21 §4：每个主体一把独立随机生成、不可从主密钥重派生的密钥。销毁 = 把 key 置空并记 destroyed_at；
 * 行保留，保证销毁后不会又给同一主体发新钥（否则「删除」可被下一次写入撤销）。
 */
export class SubjectKeyring {
  readonly #db: Database
  readonly #clock: Clock
  readonly #cache = new Map<string, Buffer>()

  constructor(db: Database, clock: Clock) {
    this.#db = db
    this.#clock = clock
    db.exec(
      `CREATE TABLE IF NOT EXISTS _subject_keys (
        subject_id TEXT PRIMARY KEY,
        key BLOB,
        created_at TEXT NOT NULL,
        destroyed_at TEXT
      )`,
    )
  }

  #row(subject: string): KeyRow | undefined {
    return this.#db
      .prepare<[string], KeyRow>('SELECT * FROM _subject_keys WHERE subject_id = ?')
      .get(subject)
  }

  /** 写 PII 时取密钥；已销毁的主体拒绝再发新钥。 */
  ensure(subject: string): Buffer {
    const cached = this.#cache.get(subject)
    if (cached !== undefined) return cached
    const row = this.#row(subject)
    if (row !== undefined) {
      if (row.key === null)
        throw forbidden(`subject key destroyed; cannot write personal data: ${subject}`)
      const key = Buffer.from(row.key)
      this.#cache.set(subject, key)
      return key
    }
    const key = newSubjectKey()
    this.#db
      .prepare('INSERT INTO _subject_keys (subject_id, key, created_at) VALUES (?, ?, ?)')
      .run(subject, key, this.#clock.now())
    this.#cache.set(subject, key)
    return key
  }

  /** 读 PII 时取密钥；不存在或已销毁 → undefined（读出 `[erased]`）。 */
  get(subject: string): Buffer | undefined {
    const cached = this.#cache.get(subject)
    if (cached !== undefined) return cached
    const row = this.#row(subject)
    if (row === undefined || row.key === null) return undefined
    const key = Buffer.from(row.key)
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
}
