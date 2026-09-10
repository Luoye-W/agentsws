/**
 * 主体密钥环的**双方言**档（21 §4），跑在 {@link SqlDriver} 上。
 *
 * 与 {@link SubjectKeyring}（同步、better-sqlite3）共用 `store-sql.ts` 里的表与语句；
 * 差别只有「同步 / 异步」。它**不实现** `@agentsws/core` 的 `RawCipher`——
 * 那个端口是同步的，受控原始材料区（channels / meetings）目前只在 SQLite 档上，
 * 等那两个包转异步再把端口一起改（见报告「其余包上 Postgres 的改点」）。
 *
 * 纪律与同步档逐字相同：
 * - 已销毁的主体**拒绝**再发新钥（否则删除可被下一次写入撤销）
 * - 有根密钥就把主体密钥包一层再落盘；换根密钥不影响老行（`wrapped = 0`）
 */

import type { Clock } from '@agentsws/contracts'
import type { SqlDriver } from '@agentsws/core/sql'
import { toBytes, toNumber } from '@agentsws/core/sql'
import {
  decryptValue,
  type EncryptedField,
  encryptValue,
  newSubjectKey,
  unwrapKey,
  wrapKey,
} from './crypto.js'
import { forbidden } from './errors.js'
import type { KeyringPort } from './keyring.js'
import {
  DESTROY_KEY_SQL,
  INSERT_DESTROYED_KEY_SQL,
  INSERT_KEY_SQL,
  SELECT_KEY_SQL,
  SUBJECT_KEYS_DDL,
} from './store-sql.js'

interface KeyRow {
  subject_id: string
  key: Uint8Array | null
  created_at: string
  destroyed_at: string | null
  wrapped: number
}

export interface SqlSubjectKeyringOptions {
  rootKey?: Buffer
}

export class SqlSubjectKeyring implements KeyringPort {
  readonly #driver: SqlDriver
  readonly #clock: Clock
  readonly #rootKey: Buffer | undefined
  readonly #cache = new Map<string, Buffer>()

  private constructor(driver: SqlDriver, clock: Clock, options: SqlSubjectKeyringOptions) {
    this.#driver = driver
    this.#clock = clock
    this.#rootKey = options.rootKey
  }

  static async open(
    driver: SqlDriver,
    clock: Clock,
    options: SqlSubjectKeyringOptions = {},
  ): Promise<SqlSubjectKeyring> {
    await driver.exec(SUBJECT_KEYS_DDL)
    return new SqlSubjectKeyring(driver, clock, options)
  }

  async #row(subject: string): Promise<KeyRow | undefined> {
    return this.#driver.prepare<KeyRow>(SELECT_KEY_SQL).get(subject)
  }

  #store(subject: string, key: Buffer): { blob: Buffer; wrapped: number } {
    return this.#rootKey === undefined
      ? { blob: key, wrapped: 0 }
      : { blob: wrapKey(this.#rootKey, subject, key), wrapped: 1 }
  }

  #load(row: KeyRow): Buffer {
    const bytes = toBytes(row.key)
    if (bytes === undefined) throw forbidden(`subject key is empty: ${row.subject_id}`)
    const blob = Buffer.from(bytes)
    if (toNumber(row.wrapped) !== 1) return blob
    if (this.#rootKey === undefined)
      throw forbidden(
        `主体密钥是包裹存的，但这台机器没有根密钥（AGENTSWS_DATA_KEY）：${row.subject_id}`,
      )
    return unwrapKey(this.#rootKey, row.subject_id, blob)
  }

  async ensure(subject: string): Promise<Buffer> {
    const cached = this.#cache.get(subject)
    if (cached !== undefined) return cached
    const row = await this.#row(subject)
    if (row !== undefined) {
      if (row.key === null)
        throw forbidden(`subject key destroyed; cannot write personal data: ${subject}`)
      const key = this.#load(row)
      this.#cache.set(subject, key)
      return key
    }
    const key = newSubjectKey()
    const stored = this.#store(subject, key)
    await this.#driver
      .prepare(INSERT_KEY_SQL)
      .run(subject, stored.blob, this.#clock.now(), stored.wrapped)
    this.#cache.set(subject, key)
    return key
  }

  async get(subject: string): Promise<Buffer | undefined> {
    const cached = this.#cache.get(subject)
    if (cached !== undefined) return cached
    const row = await this.#row(subject)
    if (row === undefined || row.key === null) return undefined
    const key = this.#load(row)
    this.#cache.set(subject, key)
    return key
  }

  async isDestroyed(subject: string): Promise<boolean> {
    const row = await this.#row(subject)
    return row !== undefined && row.key === null
  }

  /** 销毁；返回销毁时间。幂等：已销毁的返回原时间。 */
  async destroy(subject: string, at: string = this.#clock.now()): Promise<string> {
    this.#cache.delete(subject)
    const row = await this.#row(subject)
    if (row !== undefined && row.key === null) return row.destroyed_at ?? at
    if (row === undefined) {
      await this.#driver.prepare(INSERT_DESTROYED_KEY_SQL).run(subject, at, at)
      return at
    }
    await this.#driver.prepare(DESTROY_KEY_SQL).run(at, subject)
    return at
  }

  async encryptFor(subject: string, value: unknown): Promise<EncryptedField> {
    return encryptValue(await this.ensure(subject), subject, value)
  }

  async decryptFor(subject: string, field: EncryptedField): Promise<unknown> {
    const key = await this.get(subject)
    return key === undefined ? undefined : decryptValue(key, field)
  }
}
