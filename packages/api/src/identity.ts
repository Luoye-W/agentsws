/**
 * 20 §1–§3 的 IdentityService（内存档在此，SQLite 档见 sqlite-identity.ts；曾计划的 packages/identity 已并入本包，见 docs/34 §2.1）。
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
  RangeRef,
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

/** 13 §5 会话 cookie 的默认名字。 */
export const SESSION_COOKIE = 'agentsws_session'

/**
 * `Cookie:` 头 → 某个 cookie 的值。只认最简单那种形态（`k=v; k2=v2`），
 * 不做属性解析——服务端自己签的 cookie 不会有奇怪的编码。
 */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() !== name) continue
    return decodeURIComponent(part.slice(eq + 1).trim())
  }
  return undefined
}

/**
 * HttpOnly + SameSite=Strict + Path=/ 的会话 cookie。
 *
 * 没有 `Secure`：本地档只监听 127.0.0.1 的 http，加了 `Secure` 浏览器会直接丢掉它。
 * `SameSite=Strict` 是这里真正的防线——任何第三方站点发起的请求都带不上它。
 */
export function sessionCookie(
  name: string,
  value: string,
  options: { maxAgeSeconds?: number } = {},
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Strict']
  parts.push(`Max-Age=${String(options.maxAgeSeconds ?? 0)}`)
  return parts.join('; ')
}

/** 定时安全比较（长度不同直接 false，不泄漏长度之外的东西）。 */
export function secretEquals(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8')
  const y = Buffer.from(b, 'utf8')
  if (x.length !== y.length) return false
  return timingSafeEqual(x, y)
}

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
  /** `id` 只给装配用（demo / 模拟世界要让身份的 person_id 与职责库里的人对上）。 */
  createPerson(input: { email: string; name: string; id?: PersonId }): Promise<Person>
  personByEmail(email: string): Person | undefined
  workspacesOf(person_id: PersonId): Workspace[]
  issue(
    kind: TokenKind,
    person_id: PersonId,
    workspace_id: WorkspaceId,
    ttlMs?: number,
  ): IssuedToken
  revoke(token: string): void
  // ── WP28 多人：邀请同事、按邮箱登录、离开工作区 ──────────────────────
  /** 20 §5：建一张一次性邀请（默认 24h）。明文 token 只在这里返回一次。 */
  createInvitation(input: CreateInvitationInput): Promise<IssuedInvitation>
  /** 某工作区的邀请清单（不含 token，只有状态）。 */
  listInvitations(workspace_id: WorkspaceId): Invitation[]
  /**
   * 接受邀请：邮箱对应的人不存在就建一个，然后成为该工作区成员。
   * 一次性——用过或过期的 token 一律 `not_found`（不区分，免得探测）。
   */
  acceptInvitation(token: string, input?: { name?: string }): Promise<AcceptedInvitation>
  /**
   * 20 §4 人离开：成员关系收尾 + **该人在这个工作区的全部 token 立刻失效**。
   * 分配的撤销由 roles 侧做（这里只管身份）。
   */
  leaveWorkspace(workspace_id: WorkspaceId, person_id: PersonId): Promise<Membership | undefined>
}

/** 20 §5 邀请：一次性、带期限、绑工作区。token 只存哈希。 */
export interface Invitation {
  id: string
  workspace_id: WorkspaceId
  email: string
  name?: string
  /** 接受后拿到的成员身份（20 §1 Membership.role）。 */
  role: Membership['role']
  ranges: RangeRef[]
  /** 接受后按这个岗位模板展开分配；由 org 端口解释，身份层只是原样存着。 */
  position_id?: string
  invited_by: PersonId
  created_at: Iso8601
  expires_at: Iso8601
  accepted_at?: Iso8601
  accepted_by?: PersonId
  /** 一次性：接受过就是 true，过期不改这个位。 */
  used: boolean
}

export interface CreateInvitationInput {
  workspace_id: WorkspaceId
  email: string
  name?: string
  role?: Membership['role']
  ranges?: RangeRef[]
  position_id?: string
  invited_by: PersonId
  /** 默认 24 小时。 */
  ttlMs?: number
}

export interface IssuedInvitation {
  invitation: Invitation
  /** 明文只在签发那一刻出现一次（进链接，不进日志）。 */
  token: string
}

export interface AcceptedInvitation {
  invitation: Invitation
  person: Person
  membership: Membership
  workspace: Workspace
}

/** 邀请默认有效期：24 小时（20 §5）。 */
export const DEFAULT_INVITE_TTL = 24 * 60 * 60 * 1000

const normalizeEmail = (email: string): string => email.trim().toLowerCase()

/** 邮箱 → 一个能看的名字（没填名字时的兜底，不猜真名）。 */
export function nameFromEmail(email: string): string {
  return normalizeEmail(email).split('@')[0] ?? 'member'
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
  /** 邀请：键是 token 的 sha256，明文一次都不留 */
  readonly #invites = new Map<string, Invitation>()
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

  // ── WP28 多人：邀请、接受、离开 ───────────────────────────────────────

  async createInvitation(input: CreateInvitationInput): Promise<IssuedInvitation> {
    const workspace = this.#workspaces.get(input.workspace_id)
    if (!workspace) throw new ApiError('not_found', `工作区不存在：${input.workspace_id}`)
    const email = normalizeEmail(input.email)
    if (email === '' || !email.includes('@')) throw new ApiError('invalid_input', 'email 不合法')
    const now = this.#clock.now()
    const invitation: Invitation = {
      id: this.#id('inv'),
      workspace_id: input.workspace_id,
      email,
      ...(input.name === undefined ? {} : { name: input.name }),
      role: input.role ?? 'member',
      ranges: input.ranges ?? [],
      ...(input.position_id === undefined ? {} : { position_id: input.position_id }),
      invited_by: input.invited_by,
      created_at: now,
      expires_at: new Date(Date.parse(now) + (input.ttlMs ?? DEFAULT_INVITE_TTL)).toISOString(),
      used: false,
    }
    const token = `inv_${this.#secret()}`
    this.#invites.set(hashToken(token), invitation)
    return { invitation, token }
  }

  listInvitations(workspace_id: WorkspaceId): Invitation[] {
    return [...this.#invites.values()].filter((i) => i.workspace_id === workspace_id)
  }

  async acceptInvitation(token: string, input?: { name?: string }): Promise<AcceptedInvitation> {
    const hash = hashToken(token)
    const invitation = this.#invites.get(hash)
    // 用过 / 过期 / 根本不存在，对外一律同一句话：邀请链接无效
    if (!invitation || invitation.used || this.#expired(invitation.expires_at))
      throw new ApiError('not_found', '邀请链接无效或已过期')
    const workspace = this.#workspaces.get(invitation.workspace_id)
    if (!workspace) throw new ApiError('not_found', '工作区不存在')
    const person =
      this.personByEmail(invitation.email) ??
      (await this.createPerson({
        email: invitation.email,
        name: input?.name ?? invitation.name ?? nameFromEmail(invitation.email),
      }))
    const list = this.#members.get(invitation.workspace_id) ?? []
    const active = list.find((m) => m.person_id === person.id && m.left_at === undefined)
    const membership =
      active ??
      (await this.addMember({
        workspace_id: invitation.workspace_id,
        person_id: person.id,
        role: invitation.role,
        ranges: invitation.ranges,
      }))
    const accepted: Invitation = {
      ...invitation,
      used: true,
      accepted_at: this.#clock.now(),
      accepted_by: person.id,
    }
    this.#invites.set(hash, accepted)
    return { invitation: accepted, person, membership, workspace }
  }

  async leaveWorkspace(
    workspace_id: WorkspaceId,
    person_id: PersonId,
  ): Promise<Membership | undefined> {
    const list = this.#members.get(workspace_id) ?? []
    const active = list.find((m) => m.person_id === person_id && m.left_at === undefined)
    if (active !== undefined) active.left_at = this.#clock.now()
    // 20 §6 用例 6：人离开后其 token 立刻失效
    for (const row of this.#tokens.values())
      if (row.person_id === person_id && row.workspace_id === workspace_id) row.revoked = true
    return active
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
