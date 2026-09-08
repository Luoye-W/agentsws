import type { AssignmentId, Iso8601, WorkspaceId } from './common.js'

/** 18 §1 Connect：connect-adapter 的契约。凭据永不出现在返回值里。 */
export interface ProviderMeta {
  service: string
  auth: 'no_auth' | 'api_key' | 'oauth2' | 'custom_credential'
  executable: boolean
}
export interface ActionMeta {
  id: string
  service: string
  input_schema: unknown
  output_schema?: unknown
  required_scopes?: string[]
  side_effect: 'read' | 'write'
  /** 08 §5：可执行性（来自 OpenConnector `/v1/actions` 的 execution 段）；目录只读的 Action 不能 execute。 */
  execution?: {
    locally_executable: boolean
    catalog_only: boolean
    needs_credential: boolean
    required_auth_types?: string[]
  }
}
export interface Connection {
  id: string
  service: string
  alias: string
  ownership: 'workspace' | 'person'
  workspace_id: WorkspaceId
  owner_person_id?: string
  identity?: { account_id?: string; display_name?: string; granted_scopes?: string[] }
  status: 'active' | 'reauth_required' | 'disabled'
}
export interface ConnectToken {
  token: string
  kind: 'role-read' | 'role-apply'
  assignment_id: AssignmentId
  /** 上游持久 token 无有效期，到期由适配器本地记账把关；签发时刻留给审计。 */
  issued_at?: Iso8601
  expires_at: Iso8601
  /** 签发结果回带，调用方能看到自己签了什么 */
  allowed_actions: string[]
  allowed_connections: string[]
  allowed_proxies: string[]
}
export interface ExecuteOptions {
  token: string
  connection?: string
  idempotencyKey?: string
}
export interface ExecuteResult<T = unknown> {
  data: T
  execution_id: string
  /** `idempotent_replay`：同 Idempotency-Key 24h 内重放，`execution_id` 与首次相同。 */
  meta?: Record<string, unknown> & { idempotent_replay?: boolean }
}
/** 18 §1 proxy 请求形态（v1 一律拒绝：role-read allowedProxies 恒空，role-apply 也不开）。 */
export interface ProxyRequest {
  endpoint: string
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  query?: Record<string, unknown>
  headers?: Record<string, string>
  body?: unknown
}

export interface Connect {
  providers(): Promise<ProviderMeta[]>
  actions(service: string): Promise<ActionMeta[]>
  connections(workspace_id: WorkspaceId): Promise<Connection[]>
  beginConnect(
    service: string,
    opts: {
      workspace_id: WorkspaceId
      ownership: Connection['ownership']
      alias: string
      mode: 'own_app' | 'agentsws_connect'
    },
  ): Promise<{
    authorization_url?: string
    secure_form?: { fields: { name: string; secret: boolean }[] }
    request_id: string
  }>
  pollConnect(request_id: string): Promise<'initiated' | 'connected' | 'failed' | 'expired'>
  transferConnection(id: string, to_workspace: WorkspaceId): Promise<Connection>
  /** 09-08：role-read 的 allowedConnections 必须非空、禁 proxy；空范围拒签 */
  issueToken(input: {
    assignment_id: AssignmentId
    kind: ConnectToken['kind']
    allowed_actions: string[]
    allowed_connections: string[]
    /** 上游独立的一层否决（`blockedActions`）；缺省空。 */
    blocked_actions?: string[]
    expires_in_seconds?: number
  }): Promise<ConnectToken>
  revokeTokens(assignment_id: AssignmentId): Promise<void>
  /** v1 一律 `forbidden`；留在契约上是为了一致性套件能对 mock 与真适配器同样断言。 */
  proxy?(service: string, req: ProxyRequest, opts: { token: string }): Promise<never>
  execute<T = unknown>(
    action_id: string,
    input: unknown,
    opts: ExecuteOptions,
  ): Promise<ExecuteResult<T>>
}
