import type { Iso8601, MaybePromise, PersonId, RangeRef, WorkspaceId } from './common.js'
import type { WorkspacePolicy } from './roles.js'

/** 20 身份与工作区（v1：local provider、单工作区；Join 只定类型） */
export interface Person {
  id: PersonId
  email: string
  name: string
  identities: {
    provider: 'local' | 'feishu' | 'wecom' | 'dingtalk'
    external_id: string
    verified_at?: Iso8601
  }[]
  created_at: Iso8601
}
export interface Workspace {
  id: WorkspaceId
  schema_version: 1
  kind: 'personal' | 'shared'
  name: string
  tz: string
  base_currency: string
  parent_id?: WorkspaceId
  runtime: { mode: 'local' | 'docker' | 'hosted'; endpoint: string }
  owner_id: PersonId
  policy: WorkspacePolicy
  registries: string[]
  status: 'active' | 'joined' | 'archived'
}
export interface Membership {
  workspace_id: WorkspaceId
  person_id: PersonId
  role: 'owner' | 'manager' | 'member'
  ranges: RangeRef[]
  joined_at: Iso8601
  left_at?: Iso8601
}

/**
 * 20 §3：一张 token 的状态。`GET /v1/auth/session` 要报「还剩多久」，
 * 靠的就是它——签发时给了 `expires_at`，之后没人能再问一遍，是 20 的一个洞。
 */
export interface TokenInfo {
  kind: 'session' | 'api_key' | 'runtime' | 'internal'
  person_id: PersonId
  workspace_id: WorkspaceId
  expires_at?: Iso8601
  revoked: boolean
}

export interface IdentityService {
  createPerson(input: { email: string; name: string }): Promise<Person>
  getPerson(id: PersonId): Promise<Person | undefined>
  createWorkspace(input: {
    name: string
    owner_id: PersonId
    kind: Workspace['kind']
    tz?: string
    base_currency?: string
  }): Promise<Workspace>
  getWorkspace(id: WorkspaceId): Promise<Workspace | undefined>
  addMember(m: Omit<Membership, 'joined_at'>): Promise<Membership>
  members(workspace_id: WorkspaceId): Promise<Membership[]>
  /** magic link：签发一次性登录 token；验证后返回会话 */
  issueLogin(email: string): Promise<{ token: string; expires_at: Iso8601 }>
  verifyLogin(token: string): Promise<{ person: Person; session_token: string } | undefined>
  /** 20 §3：签发 API key / 运行时短期 token / 内部凭据；全部绑 workspace，可撤销 */
  issue(
    kind: 'session' | 'api_key' | 'runtime' | 'internal',
    person_id: PersonId,
    workspace_id: WorkspaceId,
    ttl_ms?: number,
  ): MaybePromise<{ token: string; expires_at?: Iso8601 }>
  revoke(token: string): MaybePromise<void>
  personByEmail(email: string): MaybePromise<Person | undefined>
  workspacesOf(person_id: PersonId): MaybePromise<Workspace[]>
  /**
   * 查一张 token 的状态（20 §3）。**可选**：不属于「身份」的最小面，
   * 换一个只实现必需方法的身份服务时 `GET /v1/auth/session` 少一个 `expires_at`，其余照常。
   */
  tokenInfo?(token: string): MaybePromise<TokenInfo | undefined>
  /** 所有 token 绑 workspace；入参为 Bearer 后的 token 本身 */
  authenticate(bearer: string): Promise<
    | {
        person_id: PersonId
        workspace_id: WorkspaceId
        kind: 'session' | 'api_key' | 'runtime' | 'internal'
      }
    | undefined
  >
}

/** 20 §1 补（WP28）：邀请同事。token 只存 sha256，一次性、24h；接受后成为 member 并可被分配。 */
export interface Invitation {
  id: string
  workspace_id: WorkspaceId
  email: string
  invited_by: PersonId
  position_id?: string
  token_sha256: string
  expires_at: Iso8601
  used_at?: Iso8601
  created_at: Iso8601
}
