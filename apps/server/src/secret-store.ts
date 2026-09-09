/**
 * 本地加密秘密库（13 §4.3「凭据永远不进对话、不进模型、不进日志」）。
 *
 * 用途只有一个：**上游 OpenConnector 没有的 provider**——通用 IMAP / SMTP 邮箱
 * （08 §3 的覆盖对照里明写"通用 IMAP / SMTP 没有"，是我们要贡献上游的第四项）。
 * 有 provider 的（Shopify、Gmail OAuth、GA4…）一律走 OpenConnector 的凭据库，
 * 值经 `PUT /api/connections/:service` 一次性转发，不落这里。
 *
 * 五条纪律：
 * 1. **AES-256-GCM**，每条记录一个随机 12 字节 nonce；密文里带 16 字节 tag。
 * 2. 密钥只从环境变量 `AGENTSWS_SECRETS_KEY` 读（桌面壳生成、经环境变量给）；
 *    没有密钥就**拒绝保存**并说明原因，绝不退化成明文落盘。
 * 3. AAD 绑 `connection_id`：把一行的密文搬到另一行的 id 下会解不开。
 * 4. 明文只在 `put` 的入参与 `get` 的返回值里出现，不进事件、不进日志、不进任何响应体。
 * 5. 所有 SQL 参数化；`better-sqlite3` 同步 API；时间经注入的 Clock。
 */
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Clock, Iso8601 } from '@agentsws/contracts'
import type { Database as Db } from 'better-sqlite3'
import Database from 'better-sqlite3'

/** 环境变量名。秘密只从环境变量名读，不接受直接传值（35 §2）。 */
export const SECRETS_KEY_ENV = 'AGENTSWS_SECRETS_KEY'

const NONCE_BYTES = 12
const TAG_BYTES = 16
const KEY_BYTES = 32

export type SecretStoreErrorCode = 'key_missing' | 'key_invalid' | 'decrypt_failed' | 'not_found'

export class SecretStoreError extends Error {
  readonly code: SecretStoreErrorCode

  constructor(code: SecretStoreErrorCode, message: string) {
    super(message)
    this.name = 'SecretStoreError'
    this.code = code
  }
}

/** 一条连接的凭据：字段名 → 值。值只在进程内存里活一瞬。 */
export type SecretFields = Record<string, string>

export interface SecretRecord {
  connection_id: string
  /** 只有字段名可以对外说；值永远不出这个模块。 */
  field_names: string[]
  created_at: Iso8601
  updated_at: Iso8601
}

export interface SecretStore {
  /** 有没有可用的密钥（没有时 `put` 会抛 `key_missing`）。 */
  readonly available: boolean
  put(connection_id: string, fields: SecretFields): SecretRecord
  get(connection_id: string): SecretFields | undefined
  /** 列出有哪些连接存了凭据、各存了哪些**字段名**——不含值。 */
  list(): SecretRecord[]
  record(connection_id: string): SecretRecord | undefined
  remove(connection_id: string): boolean
  close(): void
}

/**
 * 密钥：64 位十六进制（桌面壳 `randomBytes(32).toString('hex')` 的形状），
 * 或任何 base64 / base64url 的 32 字节。长度不对就拒绝——不做 KDF 拉伸，
 * 免得一个弱口令看起来像一把 256 位密钥。
 */
export function parseSecretsKey(raw: string | undefined): Buffer | undefined {
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  if (trimmed === '') return undefined
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return Buffer.from(trimmed, 'hex')
  const b64 = Buffer.from(trimmed, 'base64')
  if (b64.byteLength === KEY_BYTES) return b64
  throw new SecretStoreError(
    'key_invalid',
    `${SECRETS_KEY_ENV} 必须是 32 字节密钥（64 位十六进制，或 base64）；当前长度不对`,
  )
}

export interface SecretStoreOptions {
  /** `secrets.sqlite` 的路径；`:memory:` 表示不落盘（测试与一次性任务）。 */
  dbPath: string
  clock: Clock
  /** 只传环境变量表；密钥由本模块从 `AGENTSWS_SECRETS_KEY` 里取。 */
  env?: NodeJS.ProcessEnv
  /** 随机 nonce 的注入点（测试用）。默认 `node:crypto` 的 randomBytes。 */
  randomBytes?: (n: number) => Buffer
}

interface Row {
  connection_id: string
  field_names: string
  nonce: Buffer
  ciphertext: Buffer
  created_at: string
  updated_at: string
}

/**
 * 建库。**没有密钥也能建**——这样 `GET /v1/connections` 仍然列得出已有连接、
 * 界面能明确告诉用户"这台机器没有秘密库密钥，邮箱凭据存不了"，
 * 而不是整个服务起不来。真正被拒的只有 `put`。
 */
export function createSecretStore(options: SecretStoreOptions): SecretStore {
  const key = parseSecretsKey((options.env ?? process.env)[SECRETS_KEY_ENV])
  const rand = options.randomBytes ?? randomBytes
  if (options.dbPath !== ':memory:') mkdirSync(dirname(options.dbPath), { recursive: true })
  const db: Db = new Database(options.dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(`
CREATE TABLE IF NOT EXISTS secrets (
  connection_id TEXT PRIMARY KEY NOT NULL,
  field_names   TEXT NOT NULL,
  nonce         BLOB NOT NULL,
  ciphertext    BLOB NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
) STRICT;
`)

  const requireKey = (): Buffer => {
    if (key === undefined) {
      throw new SecretStoreError(
        'key_missing',
        `这台机器没有秘密库密钥（环境变量 ${SECRETS_KEY_ENV} 未设置），` +
          '邮箱账号密码无处安全存放。桌面壳会在首次启动时生成它；' +
          '直接跑服务进程时请自己生成一把 32 字节密钥再启动。',
      )
    }
    return key
  }

  const toRecord = (row: Row): SecretRecord => ({
    connection_id: row.connection_id,
    field_names: JSON.parse(row.field_names) as string[],
    created_at: row.created_at,
    updated_at: row.updated_at,
  })

  const selectOne = db.prepare<[string], Row>('SELECT * FROM secrets WHERE connection_id = ?')
  const selectAll = db.prepare<[], Row>('SELECT * FROM secrets ORDER BY connection_id')

  return {
    get available() {
      return key !== undefined
    },

    put(connection_id, fields) {
      const k = requireKey()
      const names = Object.keys(fields)
      if (names.length === 0) throw new SecretStoreError('not_found', '没有任何字段可存')
      const nonce = rand(NONCE_BYTES)
      const cipher = createCipheriv('aes-256-gcm', k, nonce)
      // AAD 绑 connection_id：密文搬家就解不开
      cipher.setAAD(Buffer.from(connection_id, 'utf8'))
      const body = Buffer.concat([
        cipher.update(Buffer.from(JSON.stringify(fields), 'utf8')),
        cipher.final(),
      ])
      const ciphertext = Buffer.concat([body, cipher.getAuthTag()])
      const at = options.clock.now()
      const existing = selectOne.get(connection_id)
      db.prepare(
        `INSERT INTO secrets (connection_id, field_names, nonce, ciphertext, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(connection_id) DO UPDATE SET
           field_names = excluded.field_names,
           nonce       = excluded.nonce,
           ciphertext  = excluded.ciphertext,
           updated_at  = excluded.updated_at`,
      ).run(connection_id, JSON.stringify(names), nonce, ciphertext, existing?.created_at ?? at, at)
      const row = selectOne.get(connection_id)
      if (row === undefined) throw new SecretStoreError('not_found', '写入后读不回来')
      return toRecord(row)
    },

    get(connection_id) {
      const row = selectOne.get(connection_id)
      if (row === undefined) return undefined
      const k = requireKey()
      const buf = Buffer.from(row.ciphertext)
      if (buf.byteLength <= TAG_BYTES) {
        throw new SecretStoreError('decrypt_failed', `密文长度不合法：${connection_id}`)
      }
      const tag = buf.subarray(buf.byteLength - TAG_BYTES)
      const body = buf.subarray(0, buf.byteLength - TAG_BYTES)
      try {
        const decipher = createDecipheriv('aes-256-gcm', k, Buffer.from(row.nonce))
        decipher.setAAD(Buffer.from(connection_id, 'utf8'))
        decipher.setAuthTag(tag)
        const plain = Buffer.concat([decipher.update(body), decipher.final()])
        return JSON.parse(plain.toString('utf8')) as SecretFields
      } catch {
        // 换过密钥 / 被人改过文件：明确报错，不猜、不返回半截
        throw new SecretStoreError(
          'decrypt_failed',
          `凭据解不开：${connection_id}（密钥换过，或文件被改动）。断开这条连接重新填一次即可。`,
        )
      }
    },

    list() {
      return selectAll.all().map(toRecord)
    },

    record(connection_id) {
      const row = selectOne.get(connection_id)
      return row === undefined ? undefined : toRecord(row)
    },

    remove(connection_id) {
      return (
        db.prepare('DELETE FROM secrets WHERE connection_id = ?').run(connection_id).changes > 0
      )
    },

    close() {
      db.close()
    },
  }
}

/** 两把密钥是不是同一把（换机迁移时用；不泄漏任何一位）。 */
export function sameKey(a: Buffer | undefined, b: Buffer | undefined): boolean {
  if (a === undefined || b === undefined) return false
  if (a.byteLength !== b.byteLength) return false
  return timingSafeEqual(a, b)
}
