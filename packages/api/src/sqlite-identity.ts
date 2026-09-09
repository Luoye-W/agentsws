/**
 * 20 §1–§3 身份服务的 SQLite 档（WP18）。接口与 {@link MemoryIdentityService} 一致——
 * 同一份契约一致性套件对两档各跑一遍。
 *
 * 落盘的东西：人、工作区、成员、token 台账、magic-link 台账。
 * 纪律：
 * - **token 只存 sha256 哈希**，明文只在签发那一刻返回一次（21 §5 秘密不落库）
 * - 撤销是一列 `revoked`，不是删行——撤销这件事本身要留痕
 * - 时间经注入的 Clock，随机经注入的 seed；id 序号也落盘，重启后不撞号
 * - 所有 SQL 参数化；`better-sqlite3` 同步 API
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import type {
  Clock,
  Iso8601,
  Membership,
  Person,
  PersonId,
  Workspace,
  WorkspaceId,
} from '@agentsws/contracts'
import type { Database as Db } from 'better-sqlite3'
import Database from 'better-sqlite3'
import { ApiError } from './errors.js'
import {
  DEFAULT_WORKSPACE_POLICY,
  type IssuedToken,
  type LocalIdentityService,
  type TokenKind,
} from './identity.js'
import { type Migration, migrate, schemaVersion } from './sqlite-migrations.js'

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    sql: `
CREATE TABLE IF NOT EXISTS people (
  id         TEXT PRIMARY KEY NOT NULL,
  email      TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  identities TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS workspaces (
  id   TEXT PRIMARY KEY NOT NULL,
  json TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS memberships (
  workspace_id TEXT NOT NULL,
  person_id    TEXT NOT NULL,
  role         TEXT NOT NULL,
  ranges       TEXT NOT NULL,
  joined_at    TEXT NOT NULL,
  left_at      TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS memberships_by_ws     ON memberships (workspace_id);
CREATE INDEX IF NOT EXISTS memberships_by_person ON memberships (person_id);

-- token 只存哈希；撤销是一列，不是删行
CREATE TABLE IF NOT EXISTS tokens (
  hash         TEXT PRIMARY KEY NOT NULL,
  kind         TEXT NOT NULL,
  person_id    TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  expires_at   TEXT,
  revoked      INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS logins (
  hash       TEXT PRIMARY KEY NOT NULL,
  person_id  TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used       INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS counters (
  name  TEXT PRIMARY KEY NOT NULL,
  value INTEGER NOT NULL
) STRICT;
`,
  },
]

export interface SqliteIdentityOptions {
  /** SQLite 文件路径；缺省 `:memory:`。 */
  dbPath?: string
  clock: Clock
  /** 注入的随机源（seed 化），不用裸 Math.random。 */
  random: () => number
  /** magic link 有效期，默认 15 分钟。 */
  loginTtlMs?: number
  /** 会话 token 有效期，默认 12 小时。 */
  sessionTtlMs?: number
}

const DEFAULT_LOGIN_TTL = 15 * 60 * 1000
const DEFAULT_SESSION_TTL = 12 * 60 * 60 * 1000
const PREFIX: Record<TokenKind, string> = {
  session: 'sess',
  api_key: 'key',
  runtime: 'rt',
  internal: 'int',
}

const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex')

function constantTimeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8')
  const y = Buffer.from(b, 'utf8')
  if (x.length !== y.length) return false
  return timingSafeEqual(x, y)
}

interface PersonRow {
  id: string
  email: string
  name: string
  identities: string
  created_at: string
}
interface MembershipRow {
  workspace_id: string
  person_id: string
  role: string
  ranges: string
  joined_at: string
  left_at: string | null
}
interface TokenRow {
  hash: string
  kind: string
  person_id: string
  workspace_id: string
  expires_at: string | null
  revoked: number
}
interface LoginRow {
  hash: string
  person_id: string
  expires_at: string
  used: number
}

export class SqliteIdentityService implements LocalIdentityService {
  readonly #db: Db
  readonly #clock: Clock
  readonly #random: () => number
  readonly #loginTtl: number
  readonly #sessionTtl: number
  #closed = false

  constructor(options: SqliteIdentityOptions) {
    this.#clock = options.clock
    this.#random = options.random
    this.#loginTtl = options.loginTtlMs ?? DEFAULT_LOGIN_TTL
    this.#sessionTtl = options.sessionTtlMs ?? DEFAULT_SESSION_TTL
    this.#db = new Database(options.dbPath ?? ':memory:')
    this.#db.pragma('journal_mode = WAL')
    migrate(this.#db, MIGRATIONS, this.#clock.now())
  }

  get schemaVersion(): number {
    return schemaVersion(this.#db)
  }

  /** 底层连接；只给同包测试用（断言 token 只存哈希）。 */
  get database(): Db {
    return this.#db
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#db.close()
  }

  /** 自增序号也落盘：重启后接着走，不会和已有 id 撞号。 */
  #next(name: string): number {
    const row = this.#db
      .prepare<[string], { value: number }>('SELECT value FROM counters WHERE name = ?')
      .get(name)
    const next = (row?.value ?? 0) + 1
    this.#db
      .prepare(
        `INSERT INTO counters (name, value) VALUES (?,?)
         ON CONFLICT(name) DO UPDATE SET value = excluded.value`,
      )
      .run(name, next)
    return next
  }

  #id(prefix: string): string {
    const seq = this.#next('id')
    const rand = Math.floor(this.#random() * 0xffffffff)
      .toString(36)
      .padStart(7, '0')
    return `${prefix}_${rand}${seq.toString(36)}`
  }

  #secret(): string {
    let out = ''
    for (let i = 0; i < 4; i += 1)
      out += Math.floor(this.#random() * 0xffffffff)
        .toString(36)
        .padStart(7, '0')
    return `${out}${this.#next('id').toString(36)}`
  }

  #expired(at: Iso8601 | undefined | null): boolean {
    if (at === undefined || at === null) return false
    return Date.parse(this.#clock.now()) >= Date.parse(at)
  }

  #person(row: PersonRow): Person {
    return {
      id: row.id,
      email: row.email,
      name: row.name,
      identities: JSON.parse(row.identities) as Person['identities'],
      created_at: row.created_at,
    }
  }

  #membership(row: MembershipRow): Membership {
    return {
      workspace_id: row.workspace_id,
      person_id: row.person_id,
      role: row.role as Membership['role'],
      ranges: JSON.parse(row.ranges) as Membership['ranges'],
      joined_at: row.joined_at,
      ...(row.left_at === null ? {} : { left_at: row.left_at }),
    }
  }

  #getPersonRow(id: PersonId): PersonRow | undefined {
    return this.#db.prepare<[string], PersonRow>('SELECT * FROM people WHERE id = ?').get(id)
  }

  #getWorkspace(id: WorkspaceId): Workspace | undefined {
    const row = this.#db
      .prepare<[string], { json: string }>('SELECT json FROM workspaces WHERE id = ?')
      .get(id)
    return row === undefined ? undefined : (JSON.parse(row.json) as Workspace)
  }

  // ───────────────────────────── 人

  async createPerson(input: { email: string; name: string }): Promise<Person> {
    const email = input.email.trim().toLowerCase()
    if (email === '' || !email.includes('@')) throw new ApiError('invalid_input', 'email 不合法')
    const existing = this.#db
      .prepare<[string], PersonRow>('SELECT * FROM people WHERE email = ?')
      .get(email)
    if (existing !== undefined) return this.#person(existing)
    const person: Person = {
      id: this.#id('per'),
      email,
      name: input.name,
      identities: [{ provider: 'local', external_id: email, verified_at: this.#clock.now() }],
      created_at: this.#clock.now(),
    }
    this.#db
      .prepare('INSERT INTO people (id, email, name, identities, created_at) VALUES (?,?,?,?,?)')
      .run(
        person.id,
        person.email,
        person.name,
        JSON.stringify(person.identities),
        person.created_at,
      )
    return person
  }

  async getPerson(id: PersonId): Promise<Person | undefined> {
    const row = this.#getPersonRow(id)
    return row === undefined ? undefined : this.#person(row)
  }

  personByEmail(email: string): Person | undefined {
    const row = this.#db
      .prepare<[string], PersonRow>('SELECT * FROM people WHERE email = ?')
      .get(email.trim().toLowerCase())
    return row === undefined ? undefined : this.#person(row)
  }

  // ───────────────────────────── 工作区与成员

  async createWorkspace(input: {
    name: string
    owner_id: PersonId
    kind: Workspace['kind']
    tz?: string
    base_currency?: string
  }): Promise<Workspace> {
    if (this.#getPersonRow(input.owner_id) === undefined)
      throw new ApiError('not_found', `owner 不存在：${input.owner_id}`)
    if (input.name.trim() === '') throw new ApiError('invalid_input', 'name 不能为空')
    const id = this.#id('ws')
    const workspace: Workspace = {
      id,
      schema_version: 1,
      kind: input.kind,
      name: input.name,
      tz: input.tz ?? 'Asia/Shanghai',
      base_currency: input.base_currency ?? 'USD',
      runtime: { mode: 'local', endpoint: 'local' },
      owner_id: input.owner_id,
      policy: DEFAULT_WORKSPACE_POLICY(id),
      registries: [],
      status: 'active',
    }
    const joined_at = this.#clock.now()
    this.#db.transaction(() => {
      this.#db
        .prepare('INSERT INTO workspaces (id, json) VALUES (?,?)')
        .run(id, JSON.stringify(workspace))
      this.#db
        .prepare(
          `INSERT INTO memberships (workspace_id, person_id, role, ranges, joined_at, left_at)
           VALUES (?,?,?,?,?,NULL)`,
        )
        .run(id, input.owner_id, 'owner', '[]', joined_at)
    })()
    return workspace
  }

  async getWorkspace(id: WorkspaceId): Promise<Workspace | undefined> {
    return this.#getWorkspace(id)
  }

  async addMember(m: Omit<Membership, 'joined_at'>): Promise<Membership> {
    if (this.#getWorkspace(m.workspace_id) === undefined)
      throw new ApiError('not_found', `工作区不存在：${m.workspace_id}`)
    if (this.#getPersonRow(m.person_id) === undefined)
      throw new ApiError('not_found', `人不存在：${m.person_id}`)
    const active = this.#db
      .prepare<[string, string], { one: number }>(
        `SELECT 1 AS one FROM memberships
          WHERE workspace_id = ? AND person_id = ? AND left_at IS NULL`,
      )
      .get(m.workspace_id, m.person_id)
    if (active !== undefined) throw new ApiError('conflict', `已是成员：${m.person_id}`)
    const membership: Membership = { ...m, joined_at: this.#clock.now() }
    this.#db
      .prepare(
        `INSERT INTO memberships (workspace_id, person_id, role, ranges, joined_at, left_at)
         VALUES (?,?,?,?,?,?)`,
      )
      .run(
        membership.workspace_id,
        membership.person_id,
        membership.role,
        JSON.stringify(membership.ranges),
        membership.joined_at,
        membership.left_at ?? null,
      )
    return membership
  }

  async members(workspace_id: WorkspaceId): Promise<Membership[]> {
    return this.#db
      .prepare<[string], MembershipRow>(
        'SELECT * FROM memberships WHERE workspace_id = ? ORDER BY rowid',
      )
      .all(workspace_id)
      .map((r) => this.#membership(r))
  }

  workspacesOf(person_id: PersonId): Workspace[] {
    return this.#db
      .prepare<[string], { json: string }>(
        `SELECT w.json AS json FROM workspaces w
           JOIN memberships m ON m.workspace_id = w.id
          WHERE m.person_id = ? AND m.left_at IS NULL
          ORDER BY m.rowid`,
      )
      .all(person_id)
      .map((r) => JSON.parse(r.json) as Workspace)
  }

  // ───────────────────────────── magic link（20 §2）

  async issueLogin(email: string): Promise<{ token: string; expires_at: Iso8601 }> {
    const person = this.personByEmail(email)
    if (!person) throw new ApiError('not_found', '未知邮箱')
    const token = `ml_${this.#secret()}`
    const expires_at = new Date(Date.parse(this.#clock.now()) + this.#loginTtl).toISOString()
    this.#db
      .prepare('INSERT INTO logins (hash, person_id, expires_at, used) VALUES (?,?,?,0)')
      .run(hashToken(token), person.id, expires_at)
    return { token, expires_at }
  }

  async verifyLogin(token: string): Promise<{ person: Person; session_token: string } | undefined> {
    const row = this.#db
      .prepare<[string], LoginRow>('SELECT * FROM logins WHERE hash = ?')
      .get(hashToken(token))
    if (row === undefined || row.used === 1 || this.#expired(row.expires_at)) return undefined
    const personRow = this.#getPersonRow(row.person_id)
    if (personRow === undefined) return undefined
    this.#db.prepare('UPDATE logins SET used = 1 WHERE hash = ?').run(row.hash)
    const workspace = this.workspacesOf(row.person_id)[0]
    if (!workspace) throw new ApiError('not_found', '该人还没有工作区')
    const session = this.issue('session', row.person_id, workspace.id, this.#sessionTtl)
    return { person: this.#person(personRow), session_token: session.token }
  }

  // ───────────────────────────── token 台账（20 §3）

  issue(
    kind: TokenKind,
    person_id: PersonId,
    workspace_id: WorkspaceId,
    ttlMs?: number,
  ): IssuedToken {
    if (this.#getPersonRow(person_id) === undefined)
      throw new ApiError('not_found', `人不存在：${person_id}`)
    if (this.#getWorkspace(workspace_id) === undefined)
      throw new ApiError('not_found', `工作区不存在：${workspace_id}`)
    const token = `${PREFIX[kind]}_${this.#secret()}`
    const expires_at =
      ttlMs === undefined
        ? undefined
        : new Date(Date.parse(this.#clock.now()) + ttlMs).toISOString()
    this.#db
      .prepare(
        `INSERT INTO tokens (hash, kind, person_id, workspace_id, expires_at, revoked)
         VALUES (?,?,?,?,?,0)`,
      )
      .run(hashToken(token), kind, person_id, workspace_id, expires_at ?? null)
    return {
      token,
      kind,
      person_id,
      workspace_id,
      ...(expires_at === undefined ? {} : { expires_at }),
    }
  }

  revoke(token: string): void {
    this.#db.prepare('UPDATE tokens SET revoked = 1 WHERE hash = ?').run(hashToken(token))
  }

  async authenticate(bearer: string): Promise<
    | {
        person_id: PersonId
        workspace_id: WorkspaceId
        kind: 'session' | 'api_key' | 'runtime' | 'internal'
      }
    | undefined
  > {
    const raw = bearer.startsWith('Bearer ') ? bearer.slice('Bearer '.length).trim() : bearer.trim()
    if (raw === '') return undefined
    const hash = hashToken(raw)
    const row = this.#db
      .prepare<[string], TokenRow>('SELECT * FROM tokens WHERE hash = ?')
      .get(hash)
    if (row === undefined) return undefined
    if (!constantTimeEqual(row.hash, hash)) return undefined
    if (row.revoked === 1 || this.#expired(row.expires_at)) return undefined
    return {
      person_id: row.person_id,
      workspace_id: row.workspace_id,
      kind: row.kind as TokenKind,
    }
  }
}

export function createSqliteIdentity(options: SqliteIdentityOptions): SqliteIdentityService {
  return new SqliteIdentityService(options)
}
