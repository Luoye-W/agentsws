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

/**
 * WP40：数据后端的凭据（Postgres 连接串 + S3 兼容的 access key）在这个库里的 key。
 *
 * 与连接面（`conn:*`）、模型面（`model:*`）同一个库、同一把密钥、同一条纪律；
 * 靠前缀分开，谁也读不到谁的（41 §2.2「凭据进本机加密库，不经模型」）。
 * 这一条不是「一条连接」，所以用一个固定 id，不带工作区——
 * 数据后端是**整台机器**的事，与工作区无关。
 */
export const STORAGE_SECRET_ID = 'storage:backend'

const NONCE_BYTES = 12
const TAG_BYTES = 16
const KEY_BYTES = 32

export type SecretStoreErrorCode = 'key_missing' | 'key_invalid' | 'decrypt_failed' | 'not_found'

/** {@link SecretStore.rotate} 的结果。密钥本身永远不在返回值里。 */
export interface SecretRotationResult {
  /** 重新加密了几条连接的凭据。 */
  rotated: number
  at: Iso8601
}

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
  /**
   * 换一把密钥：**整库重加密**，旧密钥当场零化。
   *
   * 一个事务里做完——中途失败就一行都不改，绝不留下「一半旧钥一半新钥」的库
   * （那种库谁也读不全，只能让用户把所有邮箱凭据重填一遍）。
   *
   * 调用方的责任：先把新密钥落进 safeStorage / 环境变量，再调这里；
   * 顺序反了会得到一个解不开的库。密钥只从参数进来一次，不落日志、不进响应体。
   */
  rotate(newKey: string): SecretRotationResult
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
  // 换密钥要能就地生效，所以它是 let——但值只在这个闭包里，出不去。
  let key = parseSecretsKey((options.env ?? process.env)[SECRETS_KEY_ENV])
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

    rotate(newKey) {
      const old = requireKey()
      const next = parseSecretsKey(newKey)
      if (next === undefined)
        throw new SecretStoreError('key_invalid', '新密钥是空的；轮换需要一把 32 字节密钥')
      if (sameKey(old, next))
        throw new SecretStoreError('key_invalid', '新密钥和现在这把一样，没什么可轮换的')

      const at = options.clock.now()
      // 先在内存里全部解开再全部封回去：任何一条解不开就整体不动
      const reencrypt = db.transaction((rows: Row[]): number => {
        for (const row of rows) {
          const buf = Buffer.from(row.ciphertext)
          if (buf.byteLength <= TAG_BYTES)
            throw new SecretStoreError('decrypt_failed', `密文长度不合法：${row.connection_id}`)
          let plain: Buffer
          try {
            const decipher = createDecipheriv('aes-256-gcm', old, Buffer.from(row.nonce))
            decipher.setAAD(Buffer.from(row.connection_id, 'utf8'))
            decipher.setAuthTag(buf.subarray(buf.byteLength - TAG_BYTES))
            plain = Buffer.concat([
              decipher.update(buf.subarray(0, buf.byteLength - TAG_BYTES)),
              decipher.final(),
            ])
          } catch {
            throw new SecretStoreError(
              'decrypt_failed',
              `轮换中止：${row.connection_id} 用现在这把密钥解不开（库里可能混着更早的密钥）。` +
                '先把这条连接断开重填，再轮换。',
            )
          }
          const nonce = rand(NONCE_BYTES)
          const cipher = createCipheriv('aes-256-gcm', next, nonce)
          cipher.setAAD(Buffer.from(row.connection_id, 'utf8'))
          const body = Buffer.concat([cipher.update(plain), cipher.final()])
          plain.fill(0)
          db.prepare(
            'UPDATE secrets SET nonce = ?, ciphertext = ?, updated_at = ? WHERE connection_id = ?',
          ).run(nonce, Buffer.concat([body, cipher.getAuthTag()]), at, row.connection_id)
        }
        return rows.length
      })

      const rotated = reencrypt(selectAll.all())
      // 旧密钥零化：这一刻起进程内存里也没有它了
      old.fill(0)
      key = next
      return { rotated, at }
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
