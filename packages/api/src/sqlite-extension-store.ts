/**
 * WP119b（docs/76）：配对表与插件令牌的 **SQLite 档**。
 *
 * WP119 留尾的那一条：内存档重启就忘，用户要重新配对。本档把配对与令牌落到
 * 本机的 SQLite（一张表一对）：**语义与 {@link MemoryExtensionStore} 逐条一致**
 * ——6 位 / 5 分钟 / 一次性；扩展 id 只从 Origin 来；明文只在兑换那一次出现；
 * 令牌 + Origin 双校验；撤销是写 `revoked_at` 不是删行。一致性由
 * `test/sqlite-extension-store.test.ts` 对两档各跑同一组用例钉住。
 *
 * 只在本机跑（better-sqlite3），不上 Workers——插件打到的是本机服务。
 */

import { createHash } from 'node:crypto'
import type { Clock, Iso8601, PersonId, WorkspaceId } from '@agentsws/contracts'
import type { Database as Db } from 'better-sqlite3'
import Database from 'better-sqlite3'
import {
  EXTENSION_SCOPES,
  EXTENSION_TOKEN_TTL_MS,
  type ExtensionSession,
  type ExtensionStore,
  type ExtensionTokenView,
  extensionIdOfOrigin,
  PAIRING_TTL_MS,
  type PairingView,
  type RedeemedToken,
  type RedeemFailure,
} from './extension-store.js'

/** 与内存档同一把尺：库里只存哈希。 */
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

const SCHEMA_VERSION = 1

interface PairingRow {
  code_hash: string
  workspace_id: WorkspaceId
  person_id: PersonId
  label: string
  expires_at_ms: number
  used: number
}

interface TokenRow {
  id: string
  token_hash: string
  label: string
  extension_id: string
  workspace_id: WorkspaceId
  person_id: PersonId
  scopes: string
  created_at: string
  expires_at: string
  last_used_at: string | null
  revoked_at: string | null
}

/** 6 位数字，前导零保留——与内存档同一把尺。 */
function sixDigits(random: () => number): string {
  let out = ''
  for (let i = 0; i < 6; i += 1) out += String(Math.floor(random() * 10) % 10)
  return out
}

function hex(random: () => number, bytes: number): string {
  let out = ''
  for (let i = 0; i < bytes; i += 1) {
    out += Math.floor(random() * 256)
      .toString(16)
      .padStart(2, '0')
  }
  return out
}

export interface SqliteExtensionStoreOptions {
  /** SQLite 文件路径；缺省 `:memory:`（测试用）。 */
  dbPath?: string
  clock: Clock
  random: () => number
  pairingTtlMs?: number
  tokenTtlMs?: number
}

export class SqliteExtensionStore implements ExtensionStore {
  readonly #db: Db
  readonly #clock: Clock
  readonly #random: () => number
  readonly #pairingTtlMs: number
  readonly #tokenTtlMs: number
  #closed = false

  constructor(options: SqliteExtensionStoreOptions) {
    this.#db = new Database(options.dbPath ?? ':memory:')
    this.#db.pragma('journal_mode = WAL')
    this.#clock = options.clock
    this.#random = options.random
    this.#pairingTtlMs = options.pairingTtlMs ?? 5 * 60 * 1000
    this.#tokenTtlMs = options.tokenTtlMs ?? EXTENSION_TOKEN_TTL_MS
    this.#db.exec('PRAGMA journal_mode = WAL;')
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS extension_pairings (
        code_hash TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        person_id TEXT NOT NULL,
        label TEXT NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        used INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS extension_tokens (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL,
        extension_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        person_id TEXT NOT NULL,
        scopes TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        last_used_at TEXT,
        revoked_at TEXT
      );
    `)
    this.#db
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING')
      .run('schema_version', String(SCHEMA_VERSION))
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#db.close()
  }

  #nowMs(): number {
    return Date.parse(this.#clock.now())
  }

  /** 令牌 id 的序号：跨重启接着数（meta 表），重号是唯一索引兜底。 */
  #nextSeq(): number {
    const row = this.#db.prepare('SELECT value FROM meta WHERE key = ?').get('token_seq') as
      | { value: string }
      | undefined
    const next = (row === undefined ? 0 : Number(row.value)) + 1
    this.#db
      .prepare(
        'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run('token_seq', String(next))
    return next
  }

  createPairing(input: {
    workspace_id: WorkspaceId
    person_id: PersonId
    label?: string | undefined
  }): PairingView {
    const code = sixDigits(this.#random)
    const expires_at_ms = this.#nowMs() + this.#pairingTtlMs
    // 一个工作区同时只有一个待用的码：再生成一次，上一码当场作废。
    this.#db
      .prepare('DELETE FROM extension_pairings WHERE workspace_id = ?')
      .run(input.workspace_id)
    this.#db
      .prepare(
        'INSERT INTO extension_pairings (code_hash, workspace_id, person_id, label, expires_at_ms, used) VALUES (?,?,?,?,?,0)',
      )
      .run(
        sha256(code),
        input.workspace_id,
        input.person_id,
        input.label ?? '浏览器插件',
        expires_at_ms,
      )
    return { code, expires_at: new Date(expires_at_ms).toISOString() as Iso8601 }
  }

  redeem(input: {
    code: string
    origin: string | undefined
  }): { ok: true; issued: RedeemedToken } | { ok: false; reason: RedeemFailure } {
    const extension_id = extensionIdOfOrigin(input.origin)
    if (extension_id === undefined) return { ok: false, reason: 'bad_origin' }
    const code = input.code.trim()
    if (!/^\d{6}$/.test(code)) return { ok: false, reason: 'bad_code' }

    const now = this.#nowMs()
    const hit = this.#db
      .prepare('SELECT * FROM extension_pairings WHERE code_hash = ?')
      .get(sha256(code)) as PairingRow | undefined
    if (hit === undefined) return { ok: false, reason: 'no_pairing' }
    if (hit.used === 1) return { ok: false, reason: 'used' }
    if (hit.expires_at_ms <= now) return { ok: false, reason: 'expired' }

    this.#db
      .prepare('UPDATE extension_pairings SET used = 1 WHERE code_hash = ?')
      .run(hit.code_hash)
    const id = `ext_${String(this.#nextSeq()).padStart(4, '0')}`
    const token = `ext_${hex(this.#random, 24)}`
    const expires_at = new Date(now + this.#tokenTtlMs).toISOString() as Iso8601
    this.#db
      .prepare(
        'INSERT INTO extension_tokens (id, token_hash, label, extension_id, workspace_id, person_id, scopes, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?)',
      )
      .run(
        id,
        sha256(token),
        hit.label,
        extension_id,
        hit.workspace_id,
        hit.person_id,
        JSON.stringify([...EXTENSION_SCOPES]),
        this.#clock.now(),
        expires_at,
      )
    return {
      ok: true,
      issued: {
        token,
        token_id: id,
        workspace_id: hit.workspace_id,
        scopes: [...EXTENSION_SCOPES],
        expires_at,
      },
    }
  }

  list(workspace_id: WorkspaceId): ExtensionTokenView[] {
    const rows = this.#db
      .prepare('SELECT * FROM extension_tokens WHERE workspace_id = ? ORDER BY created_at')
      .all(workspace_id) as unknown as TokenRow[]
    return rows.map(viewOf)
  }

  revoke(workspace_id: WorkspaceId, id: string): ExtensionTokenView | undefined {
    const row = this.#db
      .prepare('SELECT * FROM extension_tokens WHERE workspace_id = ? AND id = ?')
      .get(workspace_id, id) as TokenRow | undefined
    if (row === undefined) return undefined
    if (row.revoked_at === null) {
      this.#db
        .prepare('UPDATE extension_tokens SET revoked_at = ? WHERE id = ?')
        .run(this.#clock.now(), id)
      row.revoked_at = this.#clock.now()
    }
    return viewOf(row)
  }

  authenticate(raw: string, origin: string | undefined): ExtensionSession | undefined {
    const token = raw.startsWith('Bearer ') ? raw.slice('Bearer '.length).trim() : raw.trim()
    if (token === '') return undefined
    const extension_id = extensionIdOfOrigin(origin)
    if (extension_id === undefined) return undefined
    const row = this.#db
      .prepare('SELECT * FROM extension_tokens WHERE token_hash = ?')
      .get(sha256(token)) as TokenRow | undefined
    if (row === undefined) return undefined
    if (row.revoked_at !== null) return undefined
    // 令牌与 Origin 绑的不是一个扩展 = 令牌被搬走了，不认。
    if (row.extension_id !== extension_id) return undefined
    if (Date.parse(row.expires_at) <= this.#nowMs()) return undefined
    this.#db
      .prepare('UPDATE extension_tokens SET last_used_at = ? WHERE id = ?')
      .run(this.#clock.now(), row.id)
    return {
      token_id: row.id,
      workspace_id: row.workspace_id,
      person_id: row.person_id,
      extension_id: row.extension_id,
      scopes: JSON.parse(row.scopes) as ExtensionTokenView['scopes'],
    }
  }
}

/** `authenticate` 的返回形状（与内存档同一份 `ExtensionSession`）。 */
type MemoryAuth = (
  raw: string,
  origin: string | undefined,
) =>
  | {
      token_id: string
      workspace_id: WorkspaceId
      person_id: PersonId
      extension_id: string
      scopes: ExtensionTokenView['scopes']
    }
  | undefined

function viewOf(row: TokenRow): ExtensionTokenView {
  return {
    id: row.id,
    label: row.label,
    extension_id: row.extension_id,
    scopes: JSON.parse(row.scopes) as ExtensionTokenView['scopes'],
    created_at: row.created_at as Iso8601,
    expires_at: row.expires_at as Iso8601,
    ...(row.last_used_at === null ? {} : { last_used_at: row.last_used_at as Iso8601 }),
    ...(row.revoked_at === null ? {} : { revoked_at: row.revoked_at as Iso8601 }),
  }
}
