/**
 * 20 §1–§3 的内存 IdentityService（本波先做内存档；`packages/identity` 尚未实现）。
 *
 * - magic link：一次性登录 token，默认 15 分钟过期，验证后换会话 token
 * - 所有 token 绑 `workspace_id`（20 §3）；跨工作区一律显式切换
 * - token 只存哈希，明文只在签发那一刻返回一次（21 §5 秘密不落库）
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import type {
  Clock,
  IdentityService,
  Iso8601,
  Membership,
  Person,
  PersonId,
  Workspace,
  WorkspaceId,
  WorkspacePolicy,
} from '@agentsws/contracts'
import { ApiError } from './errors.js'

export type TokenKind = 'session' | 'api_key' | 'runtime' | 'internal'

export interface IssuedToken {
  token: string
  kind: TokenKind
  person_id: PersonId
  workspace_id: WorkspaceId
  expires_at?: Iso8601
}

interface TokenRow {
  hash: string
  kind: TokenKind
  person_id: PersonId
  workspace_id: WorkspaceId
  expires_at?: Iso8601
  revoked: boolean
}

interface LoginRow {
  hash: string
  person_id: PersonId
  expires_at: Iso8601
  used: boolean
}

export interface MemoryIdentityOptions {
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

const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex')

function constantTimeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8')
  const y = Buffer.from(b, 'utf8')
  if (x.length !== y.length) return false
  return timingSafeEqual(x, y)
}

/**
 * 本地档身份服务的公共面（内存 / SQLite 两档都实现）：
 * 契约 `IdentityService` 之外，本地档还提供同步的 `issue` / `revoke` 与两个查询，
 * 一致性套件与 `apps/server` 都按这个接口写，换档不改调用方。
 */
export interface LocalIdentityService extends IdentityService {
  personByEmail(email: string): Person | undefined
  workspacesOf(person_id: PersonId): Workspace[]
  issue(
    kind: TokenKind,
    person_id: PersonId,
    workspace_id: WorkspaceId,
    ttlMs?: number,
  ): IssuedToken
  revoke(token: string): void
}

export const DEFAULT_WORKSPACE_POLICY = (workspace_id: WorkspaceId): WorkspacePolicy => ({
  workspace_id,
  mandates: {},
  global_caps: {},
})

/** 20 §1 单工作区本地档的身份服务；换成 SQLite 实现时接口不变。 */
export class MemoryIdentityService implements LocalIdentityService {
  readonly #clock: Clock
  readonly #random: () => number
  readonly #loginTtl: number
  readonly #sessionTtl: number
  readonly #people = new Map<PersonId, Person>()
  readonly #byEmail = new Map<string, PersonId>()
  readonly #workspaces = new Map<WorkspaceId, Workspace>()
  readonly #members = new Map<WorkspaceId, Membership[]>()
  readonly #tokens = new Map<string, TokenRow>()
  readonly #logins = new Map<string, LoginRow>()
  #seq = 0

  constructor(options: MemoryIdentityOptions) {
    this.#clock = options.clock
    this.#random = options.random
    this.#loginTtl = options.loginTtlMs ?? DEFAULT_LOGIN_TTL
    this.#sessionTtl = options.sessionTtlMs ?? DEFAULT_SESSION_TTL
  }

  #id(prefix: string): string {
    this.#seq += 1
    const rand = Math.floor(this.#random() * 0xffffffff)
      .toString(36)
      .padStart(7, '0')
    return `${prefix}_${rand}${this.#seq.toString(36)}`
  }

  #secret(): string {
    let out = ''
    for (let i = 0; i < 4; i += 1)
      out += Math.floor(this.#random() * 0xffffffff)
        .toString(36)
        .padStart(7, '0')
    this.#seq += 1
    return `${out}${this.#seq.toString(36)}`
  }

  #expired(at: Iso8601 | undefined): boolean {
    if (at === undefined) return false
    return Date.parse(this.#clock.now()) >= Date.parse(at)
  }

  /** `id` 只给装配用（demo 要让身份的 person_id 与职责库里的 person 对上）；平时不传。 */
  async createPerson(input: { email: string; name: string; id?: PersonId }): Promise<Person> {
    const email = input.email.trim().toLowerCase()
    if (email === '' || !email.includes('@')) throw new ApiError('invalid_input', 'email 不合法')
    const existing = this.#byEmail.get(email)
    if (existing !== undefined) {
      const person = this.#people.get(existing)
      if (person) return person
    }
    const person: Person = {
      id: input.id ?? this.#id('per'),
      email,
      name: input.name,
      identities: [{ provider: 'local', external_id: email, verified_at: this.#clock.now() }],
      created_at: this.#clock.now(),
    }
    this.#people.set(person.id, person)
    this.#byEmail.set(email, person.id)
    return person
  }

  async getPerson(id: PersonId): Promise<Person | undefined> {
    return this.#people.get(id)
  }

  personByEmail(email: string): Person | undefined {
    const id = this.#byEmail.get(email.trim().toLowerCase())
    return id === undefined ? undefined : this.#people.get(id)
  }

  async createWorkspace(input: {
    name: string
    owner_id: PersonId
    kind: Workspace['kind']
    tz?: string
    base_currency?: string
    /** 同 `createPerson.id`：只给装配用。 */
    id?: WorkspaceId
  }): Promise<Workspace> {
    if (!this.#people.has(input.owner_id))
      throw new ApiError('not_found', `owner 不存在：${input.owner_id}`)
    if (input.name.trim() === '') throw new ApiError('invalid_input', 'name 不能为空')
    const id = input.id ?? this.#id('ws')
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
    this.#workspaces.set(id, workspace)
    this.#members.set(id, [
      {
        workspace_id: id,
        person_id: input.owner_id,
        role: 'owner',
        ranges: [],
        joined_at: this.#clock.now(),
      },
    ])
    return workspace
  }

  async getWorkspace(id: WorkspaceId): Promise<Workspace | undefined> {
    return this.#workspaces.get(id)
  }

  async addMember(m: Omit<Membership, 'joined_at'>): Promise<Membership> {
    if (!this.#workspaces.has(m.workspace_id))
      throw new ApiError('not_found', `工作区不存在：${m.workspace_id}`)
    if (!this.#people.has(m.person_id)) throw new ApiError('not_found', `人不存在：${m.person_id}`)
    const list = this.#members.get(m.workspace_id) ?? []
    if (list.some((x) => x.person_id === m.person_id && x.left_at === undefined))
      throw new ApiError('conflict', `已是成员：${m.person_id}`)
    const membership: Membership = { ...m, joined_at: this.#clock.now() }
    list.push(membership)
    this.#members.set(m.workspace_id, list)
    return membership
  }

  async members(workspace_id: WorkspaceId): Promise<Membership[]> {
    return [...(this.#members.get(workspace_id) ?? [])]
  }

  /** 该人在哪些工作区（用于登录后挑默认工作区）。 */
  workspacesOf(person_id: PersonId): Workspace[] {
    const out: Workspace[] = []
    for (const [ws, list] of this.#members)
      if (list.some((m) => m.person_id === person_id && m.left_at === undefined)) {
        const workspace = this.#workspaces.get(ws)
        if (workspace) out.push(workspace)
      }
    return out
  }

  async issueLogin(email: string): Promise<{ token: string; expires_at: Iso8601 }> {
    const person = this.personByEmail(email)
    if (!person) throw new ApiError('not_found', '未知邮箱')
    const token = `ml_${this.#secret()}`
    const expires_at = new Date(Date.parse(this.#clock.now()) + this.#loginTtl).toISOString()
    this.#logins.set(hashToken(token), {
      hash: hashToken(token),
      person_id: person.id,
      expires_at,
      used: false,
    })
    return { token, expires_at }
  }

  async verifyLogin(token: string): Promise<{ person: Person; session_token: string } | undefined> {
    const row = this.#logins.get(hashToken(token))
    if (!row || row.used || this.#expired(row.expires_at)) return undefined
    const person = this.#people.get(row.person_id)
    if (!person) return undefined
    row.used = true
    const workspace = this.workspacesOf(person.id)[0]
    if (!workspace) throw new ApiError('not_found', '该人还没有工作区')
    const session = this.issue('session', person.id, workspace.id, this.#sessionTtl)
    return { person, session_token: session.token }
  }

  /** 签发一个绑工作区的 token；明文只在这里返回一次。 */
  issue(
    kind: TokenKind,
    person_id: PersonId,
    workspace_id: WorkspaceId,
    ttlMs?: number,
  ): IssuedToken {
    if (!this.#people.has(person_id)) throw new ApiError('not_found', `人不存在：${person_id}`)
    if (!this.#workspaces.has(workspace_id))
      throw new ApiError('not_found', `工作区不存在：${workspace_id}`)
    const prefix = { session: 'sess', api_key: 'key', runtime: 'rt', internal: 'int' }[kind]
    const token = `${prefix}_${this.#secret()}`
    const expires_at =
      ttlMs === undefined
        ? undefined
        : new Date(Date.parse(this.#clock.now()) + ttlMs).toISOString()
    this.#tokens.set(hashToken(token), {
      hash: hashToken(token),
      kind,
      person_id,
      workspace_id,
      revoked: false,
      ...(expires_at === undefined ? {} : { expires_at }),
    })
    return {
      token,
      kind,
      person_id,
      workspace_id,
      ...(expires_at === undefined ? {} : { expires_at }),
    }
  }

  revoke(token: string): void {
    const row = this.#tokens.get(hashToken(token))
    if (row) row.revoked = true
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
    const row = this.#tokens.get(hashToken(raw))
    if (!row) return undefined
    if (!constantTimeEqual(row.hash, hashToken(raw))) return undefined
    if (row.revoked || this.#expired(row.expires_at)) return undefined
    return { person_id: row.person_id, workspace_id: row.workspace_id, kind: row.kind }
  }
}

export function createMemoryIdentity(options: MemoryIdentityOptions): MemoryIdentityService {
  return new MemoryIdentityService(options)
}
