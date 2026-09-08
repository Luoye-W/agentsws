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
  meta?: Record<string, unknown>
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
    expires_in_seconds?: number
  }): Promise<ConnectToken>
  revokeTokens(assignment_id: AssignmentId): Promise<void>
  execute<T = unknown>(
    action_id: string,
    input: unknown,
    opts: ExecuteOptions,
  ): Promise<ExecuteResult<T>>
}
