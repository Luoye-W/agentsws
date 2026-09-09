import type {
  ActionMeta,
  AssignmentId,
  Clock,
  Connect,
  Connection,
  ConnectToken,
  ExecuteOptions,
  ExecuteResult,
  Iso8601,
  ProviderMeta,
  WorkspaceId,
} from '@agentsws/contracts'
import { ConnectorError, OpenConnector } from '@oomol-lab/connector'
import { ConnectAdapterError, mapRuntimeError } from './errors.js'
import type { ConnectEvent, ConnectEventSink } from './events.js'
import type { FetchLike } from './http.js'
import { RuntimeHttp } from './http.js'
import { fingerprint, readSecretFromEnv } from './secrets.js'
import type { SideEffect } from './side-effects.js'
import { loadSideEffectTable, type SideEffectTable } from './side-effects.js'
import { AdapterState } from './state.js'

// ---------------------------------------------------------------- 上游线格式

interface WireProvider {
  service: string
  displayName?: string
  authTypes?: string[]
}

interface WireExecution {
  locallyExecutable?: boolean
  catalogOnly?: boolean
  needsCredential?: boolean
  noAuthRunnable?: boolean
  requiredAuthTypes?: string[]
}

interface WireAction {
  id: string
  service: string
  name?: string
  requiredScopes?: string[]
  inputSchema?: unknown
  outputSchema?: unknown
  execution?: WireExecution
}

interface WireConnection {
  id: string
  service: string
  connectionName: string
  authType?: string
  configured?: boolean
  virtual?: boolean
  default?: boolean
  profile?: { accountId?: string; displayName?: string; grantedScopes?: string[] }
}

interface WireProviderDetail {
  service: string
  auth?: {
    type: string
    fields?: { key: string; secret?: boolean; required?: boolean }[]
    extraFields?: { key: string; secret?: boolean; required?: boolean }[]
  }[]
}

interface WireTokenRecord {
  id: string
  name?: string
  allowedActions?: string[]
  allowedConnections?: string[]
  allowedProxies?: string[]
}

interface WireTokenCreated {
  token: string
  record: WireTokenRecord
}

interface WireOAuthStart {
  authorizationUrl: string
  state: string
}

// ---------------------------------------------------------------- 对外类型

/** `ActionMeta` 之外再带出上游的可执行性（18 §1 要求"带出 locallyExecutable / catalogOnly"）。 */
export interface RuntimeActionMeta extends ActionMeta {
  execution: {
    locally_executable: boolean
    catalog_only: boolean
    needs_credential: boolean
    required_auth_types: string[]
  }
}

export interface ProxyRequestLike {
  endpoint: string
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  query?: Record<string, unknown>
  headers?: Record<string, string>
  body?: unknown
}

/**
 * WP20 原生表单直填的入参（13 §4.3）。
 *
 * `fields` 的**值只在这一个对象里存在一次**：它从 server 的 `POST /v1/connections/:service/submit`
 * 直接进来，被原样 `PUT` 给 runtime 的凭据库，然后连引用都不留。
 * 它不进事件、不进日志、不进任何返回值——`submitForm` 返回的是 `Connection`，里面只有身份展示名。
 */
export interface SubmitFormInput {
  workspace_id: WorkspaceId
  ownership: Connection['ownership']
  alias: string
  /** 上游 `authType`；不给则按 provider 元数据里的第一个。 */
  auth_type?: string
  /** 字段名 → 值。**唯一持有凭据原文的地方**。 */
  fields: Readonly<Record<string, string>>
  /** `beginConnect` 给的 request_id；给了就顺带把那条 pending 结掉。 */
  request_id?: string
}

/** 契约 `Connect` 之外我们额外提供的几件事：proxy 的拒绝面、可执行性带出、表单直填与断开。 */
export interface ConnectAdapter extends Connect {
  actions(service: string): Promise<RuntimeActionMeta[]>
  /** 18 §1：role-read 的 allowedProxies 为空 → 禁 proxy；role-apply v1 也不开。一律拒。 */
  proxy(service: string, req: ProxyRequestLike, opts: { token: string }): Promise<never>
  /** 13 §4.3：把原生表单填的凭据直接写进 runtime 凭据库；本包不留、不记、不回显。 */
  submitForm(service: string, input: SubmitFormInput): Promise<Connection>
  /** 断开一条连接（凭据随之在 runtime 侧删除）。 */
  removeConnection(id: string): Promise<void>
  /** 当前进程记账的 token（只含 sha256，不含原文）——装配方做健康检查用。 */
  tokenLedger(): {
    assignment_id: AssignmentId
    kind: ConnectToken['kind']
    expires_at: Iso8601
    revoked: boolean
  }[]
}

export interface ConnectAdapterOptions {
  /** runtime 的 origin，例如 `http://127.0.0.1:3000`。不要带 `/v1`。 */
  baseUrl: string
  /** admin token 的**环境变量名**；秘密只从环境变量读。 */
  adminTokenEnv: string
  clock: Clock
  eventSink?: ConnectEventSink
  /** `action-side-effects.yml` 路径；默认用包内自带的那份。 */
  sideEffectsFile?: string
  /** 注入 fetch（fixture 录制 / 回放）。默认 `globalThis.fetch`。 */
  fetchImpl?: FetchLike
  env?: NodeJS.ProcessEnv
  /** 上游没有 workspace 概念，缺元数据的连接归到这个工作区。 */
  workspaceId?: WorkspaceId
  /** 已有的目录用 runtime token 的环境变量名；不给则按需自动签一把只读目录 token。 */
  catalogTokenEnv?: string
  /** token 默认有效期（上游 runtime token **没有**有效期，由我们记账把关）。默认 1h。 */
  tokenTtlSeconds?: number
  /** OAuth 授权窗口，默认 600s（上游 pending state 也是这个量级）。 */
  oauthWindowSeconds?: number
  requestTimeoutMs?: number
  /** 幂等键的重放窗口，默认 24h（与上游一致）。 */
  idempotencyWindowMs?: number
  /** 只关心这几个 service 时填；填了 `providers()` 会精确解析 executable。 */
  services?: readonly string[]
  /** token / 连接元数据的可选持久化文件（不含任何凭据原文）。 */
  stateFile?: string
  /** workspace → runtime baseUrl。目标工作区不在本 runtime 上时 `transferConnection` 拒绝。 */
  workspaceRuntimes?: Readonly<Record<string, string>>
}

const CATALOG_TOKEN_NAME = 'agentsws:catalog'
/** 目录 token 故意指向一个不存在的 Action 与不存在的连接：它只能读目录，执行一律被上游拒。 */
const CATALOG_UNREACHABLE_ACTION = 'agentsws_catalog_only.none'
const CATALOG_UNREACHABLE_CONNECTION = '00000000-0000-0000-0000-000000000000'

interface PendingConnect {
  request_id: string
  service: string
  alias: string
  workspace_id: WorkspaceId
  ownership: Connection['ownership']
  mode: 'own_app' | 'agentsws_connect'
  existing_ids: Set<string>
  expires_at: Iso8601
}

interface IdempotencyNote {
  action_id: string
  at: Iso8601
}

class OpenConnectorAdapter implements ConnectAdapter {
  private readonly http: RuntimeHttp
  private readonly state: AdapterState
  private readonly table: SideEffectTable
  private readonly clock: Clock
  private readonly sink: ConnectEventSink | undefined
  private readonly fetchImpl: FetchLike
  private readonly env: NodeJS.ProcessEnv
  private readonly opts: ConnectAdapterOptions
  private readonly workspaceId: WorkspaceId
  private readonly tokenTtlSeconds: number
  private readonly oauthWindowSeconds: number
  private readonly idempotencyWindowMs: number
  private readonly requestTimeoutMs: number

  private catalogToken: string | undefined
  private readonly actionCache = new Map<string, RuntimeActionMeta>()
  private readonly serviceExecutable = new Map<string, boolean>()
  private connectionCache: WireConnection[] | undefined
  private readonly pending = new Map<string, PendingConnect>()
  private readonly idempotency = new Map<string, IdempotencyNote>()
  private seq = 0

  constructor(opts: ConnectAdapterOptions) {
    this.opts = opts
    this.clock = opts.clock
    this.sink = opts.eventSink
    this.env = opts.env ?? process.env
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)
    this.workspaceId = opts.workspaceId ?? 'ws_local'
    this.tokenTtlSeconds = opts.tokenTtlSeconds ?? 3600
    this.oauthWindowSeconds = opts.oauthWindowSeconds ?? 600
    this.idempotencyWindowMs = opts.idempotencyWindowMs ?? 24 * 60 * 60 * 1000
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 30_000
    this.table = loadSideEffectTable(opts.sideEffectsFile)
    this.state = new AdapterState(opts.stateFile)
    this.http = new RuntimeHttp({
      baseUrl: opts.baseUrl,
      fetchImpl: this.fetchImpl,
      adminToken: () => readSecretFromEnv(opts.adminTokenEnv, this.env),
      timeoutMs: this.requestTimeoutMs,
    })
    this.catalogToken =
      opts.catalogTokenEnv === undefined
        ? undefined
        : readSecretFromEnv(opts.catalogTokenEnv, this.env)
  }

  // ------------------------------------------------------------ 发现

  async providers(): Promise<ProviderMeta[]> {
    const token = await this.ensureCatalogToken()
    const query =
      this.opts.services === undefined ? undefined : { service: [...this.opts.services] }
    const res = await this.http.request<WireProvider[]>('GET', '/v1/providers', {
      auth: 'runtime',
      runtimeToken: token,
      query,
    })
    const list = res.data ?? []
    const out: ProviderMeta[] = []
    for (const p of list) {
      out.push({
        service: p.service,
        auth: authKindOf(p.authTypes),
        executable: await this.resolveExecutable(p.service),
      })
    }
    return out
  }

  async actions(service: string): Promise<RuntimeActionMeta[]> {
    const token = await this.ensureCatalogToken()
    const res = await this.http.request<WireAction[]>('GET', '/v1/actions', {
      auth: 'runtime',
      runtimeToken: token,
      query: { service },
    })
    const metas = (res.data ?? []).map((a) => this.toActionMeta(a))
    for (const m of metas) this.actionCache.set(m.id, m)
    this.serviceExecutable.set(
      service,
      metas.some((m) => m.execution.locally_executable && !m.execution.catalog_only),
    )
    return metas
  }

  // ------------------------------------------------------------ 连接

  async connections(workspace_id: WorkspaceId): Promise<Connection[]> {
    const list = await this.listConnections(true)
    return list.map((c) => this.toConnection(c)).filter((c) => c.workspace_id === workspace_id)
  }

  async beginConnect(
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
  }> {
    // 先用轻量的 `/v1/providers?service=` 判 auth 类型；只有需要画表单时才去拉
    // `/api/providers/:service`（那份带全部 Action 的 schema，很沉）
    const kind = await this.providerAuthKind(service)
    const existing = new Set((await this.listConnections(true)).map((c) => c.id))

    if (kind === 'oauth2') {
      const started = await this.http.request<WireOAuthStart>('POST', '/api/oauth/authorizations', {
        auth: 'admin',
        body: { service, connectionName: opts.alias },
      })
      const request_id = started.data.state
      this.rememberPending(request_id, service, opts, existing)
      await this.emit({
        type: 'connect.connection_started',
        at: this.now(),
        payload: { service, alias: opts.alias, mode: opts.mode, auth: kind, request_id },
      })
      return { request_id, authorization_url: started.data.authorizationUrl }
    }

    // api_key / custom_credential / no_auth：**凭据不经本包**（13 §4.3）。
    // 我们只描述表单；值由不经模型的原生表单直接写进 runtime 的凭据库。
    const auth = (await this.providerDetail(service)).auth?.find((a) => a.type === kind)
    const fields: { name: string; secret: boolean }[] = []
    if (kind === 'api_key') fields.push({ name: 'apiKey', secret: true })
    for (const f of auth?.fields ?? []) fields.push({ name: f.key, secret: f.secret === true })
    for (const f of auth?.extraFields ?? []) fields.push({ name: f.key, secret: f.secret === true })
    const request_id = this.nextId('creq')
    this.rememberPending(request_id, service, opts, existing)
    await this.emit({
      type: 'connect.connection_started',
      at: this.now(),
      payload: { service, alias: opts.alias, mode: opts.mode, auth: kind, request_id },
    })
    return { request_id, secure_form: { fields } }
  }

  async pollConnect(request_id: string): Promise<'initiated' | 'connected' | 'failed' | 'expired'> {
    const p = this.pending.get(request_id)
    if (p === undefined) return 'expired'
    const list = await this.listConnections(true)
    const hit = list.find(
      (c) => c.service === p.service && c.connectionName === p.alias && !p.existing_ids.has(c.id),
    )
    if (hit !== undefined) {
      this.state.putConnectionMeta({
        connection_id: hit.id,
        workspace_id: p.workspace_id,
        ownership: p.ownership,
      })
      this.pending.delete(request_id)
      await this.emit({
        type: 'connect.connection_established',
        at: this.now(),
        payload: { service: p.service, alias: p.alias, connection_id: hit.id, request_id },
      })
      return 'connected'
    }
    if (Date.parse(this.now()) >= Date.parse(p.expires_at)) {
      this.pending.delete(request_id)
      return 'expired'
    }
    return 'initiated'
  }

  /**
   * 13 §4.3 第二道措施：不经模型的原生表单把值直接写进 runtime 的凭据库。
   *
   * 上游是 `PUT /api/connections/:service`，body `{ authType, connectionName, values }`
   * （09-09 实测形状，见包内 README）。这里**只**做一次转发：
   * `input.fields` 不进 `this.state`、不进事件 payload、不进返回值，出错时也只回字段名。
   */
  async submitForm(service: string, input: SubmitFormInput): Promise<Connection> {
    const names = Object.keys(input.fields)
    if (names.length === 0) {
      throw new ConnectAdapterError('invalid_input', '表单没有任何字段', { service })
    }
    const auth_type = input.auth_type ?? (await this.providerAuthKind(service))
    if (auth_type === 'oauth2') {
      throw new ConnectAdapterError('invalid_input', `${service} 走 OAuth 授权，不接受表单直填`, {
        service,
      })
    }
    const before = new Set((await this.listConnections(true)).map((c) => c.id))
    await this.http.request<unknown>('PUT', `/api/connections/${encodeURIComponent(service)}`, {
      auth: 'admin',
      body: { authType: auth_type, connectionName: input.alias, values: { ...input.fields } },
    })
    const after = await this.listConnections(true)
    const hit =
      after.find(
        (c) => c.service === service && c.connectionName === input.alias && !before.has(c.id),
      ) ?? after.find((c) => c.service === service && c.connectionName === input.alias)
    if (hit === undefined) {
      throw new ConnectAdapterError(
        'provider_error',
        `runtime 接受了凭据但连接没有出现：${service}/${input.alias}`,
        { service, alias: input.alias },
      )
    }
    this.state.putConnectionMeta({
      connection_id: hit.id,
      workspace_id: input.workspace_id,
      ownership: input.ownership,
    })
    if (input.request_id !== undefined) this.pending.delete(input.request_id)
    // payload 里只有**字段名**，没有任何字段值
    await this.emit({
      type: 'connect.form_submitted',
      at: this.now(),
      payload: {
        service,
        alias: input.alias,
        auth_type,
        field_names: names,
        connection_id: hit.id,
        ...(input.request_id === undefined ? {} : { request_id: input.request_id }),
      },
    })
    await this.emit({
      type: 'connect.connection_established',
      at: this.now(),
      payload: {
        service,
        alias: input.alias,
        connection_id: hit.id,
        ...(input.request_id === undefined ? {} : { request_id: input.request_id }),
      },
    })
    return this.toConnection(hit)
  }

  /**
   * 断开：runtime 侧删掉连接与它的凭据。
   *
   * **09-09 在真 runtime 的 `/openapi.json` 上核实过的形状**（WP20 那时是猜的，猜错了）：
   * `DELETE /api/connections/:service`，可选 `?connectionName=`，成功回
   * `{ service, connectionName, configured: false }`。
   *
   * 两个坑，都在这里挡住：
   *
   * 1. 路径段是 **service**，不是连接 id。拿 uuid 当路径段发过去，上游会把它当成
   *    一个不存在的 service，然后**回 200**——界面会显示"已断开"而凭据还在。
   * 2. 删一个根本不存在的 connectionName 同样回 200。所以删完必须**重新列一次**确认
   *    它真的没了，没删掉就抛出来，绝不静默当成删掉了。
   */
  async removeConnection(id: string): Promise<void> {
    const list = await this.listConnections(true)
    const wire = list.find((c) => c.id === id)
    if (wire === undefined) {
      throw new ConnectAdapterError('not_found', `连接不存在：${id}`, { connection: id })
    }
    const path = `/api/connections/${encodeURIComponent(wire.service)}?connectionName=${encodeURIComponent(wire.connectionName)}`
    await this.http.request<unknown>('DELETE', path, { auth: 'admin' })
    this.connectionCache = undefined
    // 上游对"删了个不存在的"也回 200，所以自己确认一次
    const after = await this.listConnections(true)
    if (after.some((c) => c.id === id)) {
      throw new ConnectAdapterError(
        'not_implemented',
        `这个 OpenConnector runtime 没有真的删掉 ${wire.service}/${wire.connectionName}；请在它的管理面里删除`,
        { connection: id, tried: path },
      )
    }
    await this.emit({
      type: 'connect.connection_removed',
      at: this.now(),
      payload: { connection_id: id, service: wire.service, alias: wire.connectionName },
    })
  }

  async transferConnection(id: string, to_workspace: WorkspaceId): Promise<Connection> {
    const target = this.opts.workspaceRuntimes?.[to_workspace]
    if (target !== undefined && normalizeUrl(target) !== normalizeUrl(this.opts.baseUrl)) {
      throw new ConnectAdapterError(
        'invalid_input',
        `跨 runtime 的连接转移 v1 未实现（目标工作区 ${to_workspace} 在 ${target}）`,
        { reason: 'not_implemented', to_workspace, target_runtime: target },
      )
    }
    const list = await this.listConnections(true)
    const wire = list.find((c) => c.id === id)
    if (wire === undefined) {
      throw new ConnectAdapterError('not_found', `连接不存在：${id}`, { connection: id })
    }
    const current = this.toConnection(wire)
    if (current.ownership !== 'workspace') {
      throw new ConnectAdapterError('forbidden', '只有 ownership=workspace 的连接可转移', {
        connection: id,
      })
    }
    this.state.putConnectionMeta({
      connection_id: id,
      workspace_id: to_workspace,
      ownership: 'workspace',
      ...(current.owner_person_id === undefined
        ? {}
        : { owner_person_id: current.owner_person_id }),
    })
    await this.emit({
      type: 'connect.connection_transferred',
      at: this.now(),
      payload: { connection_id: id, from: current.workspace_id, to: to_workspace },
    })
    return this.toConnection(wire)
  }

  // ------------------------------------------------------------ token

  async issueToken(input: {
    assignment_id: AssignmentId
    kind: ConnectToken['kind']
    allowed_actions: string[]
    allowed_connections: string[]
    expires_in_seconds?: number
  }): Promise<ConnectToken> {
    // 09-08：上游空列表 = **不限制**，所以空范围必须拒签，不能原样透传
    if (input.allowed_connections.length === 0) {
      throw new ConnectAdapterError(
        'invalid_input',
        '空 allowed_connections 拒签（上游把空列表当"不限制"）',
        { assignment_id: input.assignment_id },
      )
    }
    if (input.allowed_actions.length === 0) {
      throw new ConnectAdapterError(
        'invalid_input',
        '空 allowed_actions 拒签（上游把空列表当"不限制"）',
        { assignment_id: input.assignment_id },
      )
    }
    // role-read 只允许 side_effect=read；混进写直接拒签（18 §1）
    if (input.kind === 'role-read') {
      const writes = input.allowed_actions.filter((a) => this.table.resolve(a) !== 'read')
      if (writes.length > 0) {
        throw new ConnectAdapterError(
          'invalid_input',
          `role-read token 不得含写 Action（未标的按 write）：${writes.join(', ')}`,
          { assignment_id: input.assignment_id, write_actions: writes },
        )
      }
    }
    const known = new Set((await this.listConnections(true)).map((c) => c.id))
    const unknown = input.allowed_connections.filter((c) => !known.has(c))
    if (unknown.length > 0) {
      throw new ConnectAdapterError(
        'invalid_input',
        `allowed_connections 含未知连接：${unknown.join(', ')}`,
        { unknown },
      )
    }

    const created = await this.http.request<WireTokenCreated>('POST', '/api/runtime-tokens', {
      auth: 'admin',
      body: {
        name: `${input.kind}:${input.assignment_id}`,
        allowedActions: [...input.allowed_actions],
        blockedActions: [],
        // 18 §1：allowedProxies 恒空 —— 空 = 拒绝 proxy（与 allowedConnections 相反）
        allowedProxies: [],
        allowedConnections: [...input.allowed_connections],
      },
    })
    const issued_at = this.now()
    const ttl = input.expires_in_seconds ?? this.tokenTtlSeconds
    const expires_at = new Date(Date.parse(issued_at) + ttl * 1000).toISOString()
    this.state.putToken(created.data.token, {
      runtime_token_id: created.data.record.id,
      kind: input.kind,
      assignment_id: input.assignment_id,
      allowed_actions: [...input.allowed_actions],
      allowed_connections: [...input.allowed_connections],
      allowed_proxies: [],
      issued_at,
      expires_at,
      revoked: false,
    })
    await this.emit({
      type: 'connect.token_issued',
      at: issued_at,
      assignment_id: input.assignment_id,
      payload: {
        kind: input.kind,
        token_fingerprint: fingerprint(created.data.token),
        runtime_token_id: created.data.record.id,
        allowed_actions: [...input.allowed_actions],
        allowed_connections: [...input.allowed_connections],
        allowed_proxies: [],
        expires_at,
      },
    })
    return {
      token: created.data.token,
      kind: input.kind,
      assignment_id: input.assignment_id,
      expires_at,
      allowed_actions: [...input.allowed_actions],
      allowed_connections: [...input.allowed_connections],
      allowed_proxies: [],
    }
  }

  async revokeTokens(assignment_id: AssignmentId): Promise<void> {
    const records = this.state.tokensOf(assignment_id).filter((t) => !t.revoked)
    for (const r of records) {
      try {
        await this.http.request<unknown>(
          'DELETE',
          `/api/runtime-tokens/${encodeURIComponent(r.runtime_token_id)}`,
          { auth: 'admin' },
        )
      } catch (e) {
        // 上游已经没有这条记录时按已吊销处理；其余错误照抛
        if (!(e instanceof ConnectAdapterError) || e.code !== 'not_found') throw e
      }
    }
    this.state.markRevoked(assignment_id)
    await this.emit({
      type: 'connect.tokens_revoked',
      at: this.now(),
      assignment_id,
      payload: {
        revoked: records.length,
        token_fingerprints: records.map((r) => r.token_sha256.slice(0, 12)),
      },
    })
  }

  tokenLedger(): {
    assignment_id: AssignmentId
    kind: ConnectToken['kind']
    expires_at: Iso8601
    revoked: boolean
  }[] {
    return this.state.allTokens().map((t) => ({
      assignment_id: t.assignment_id,
      kind: t.kind,
      expires_at: t.expires_at,
      revoked: t.revoked,
    }))
  }

  // ------------------------------------------------------------ 执行

  async execute<T = unknown>(
    action_id: string,
    input: unknown,
    opts: ExecuteOptions,
  ): Promise<ExecuteResult<T>> {
    const at = this.now()
    const record = this.state.findToken(opts.token)
    if (record === undefined || record.revoked) {
      throw await this.failed(
        action_id,
        undefined,
        new ConnectAdapterError('forbidden', 'connect token 无效或已吊销'),
      )
    }
    const print = record.token_sha256.slice(0, 12)
    if (Date.parse(at) >= Date.parse(record.expires_at)) {
      throw await this.failed(
        action_id,
        print,
        new ConnectAdapterError('forbidden', 'connect token 已过期'),
      )
    }

    const meta = await this.actionMeta(action_id) // 未知 Action → not_found
    const side_effect = this.table.resolve(meta.id)

    if (!record.allowed_actions.includes(meta.id)) {
      throw await this.failed(
        meta.id,
        print,
        new ConnectAdapterError('forbidden', `token 不允许该 Action：${meta.id}`, {
          allowed_actions: record.allowed_actions,
        }),
      )
    }
    if (record.kind === 'role-read' && side_effect === 'write') {
      throw await this.failed(
        meta.id,
        print,
        new ConnectAdapterError('forbidden', `role-read token 不能调用写 Action：${meta.id}`),
      )
    }

    const conn = await this.resolveConnection(meta.service, opts.connection)
    if (conn.service !== meta.service) {
      throw await this.failed(
        meta.id,
        print,
        new ConnectAdapterError(
          'connection_not_allowed',
          `连接 ${conn.id} 不属于 ${meta.service}`,
          { connection: conn.id },
        ),
      )
    }
    if (!record.allowed_connections.includes(conn.id)) {
      throw await this.failed(
        meta.id,
        print,
        new ConnectAdapterError('connection_not_allowed', `token 不允许该连接：${conn.id}`, {
          allowed_connections: record.allowed_connections,
        }),
      )
    }

    const key = opts.idempotencyKey
    let replay = false
    if (key !== undefined) {
      const prior = this.idempotency.get(key)
      if (prior !== undefined) {
        if (Date.parse(at) - Date.parse(prior.at) >= this.idempotencyWindowMs) {
          this.idempotency.delete(key)
        } else if (prior.action_id !== meta.id) {
          throw await this.failed(
            meta.id,
            print,
            new ConnectAdapterError(
              'idempotency_conflict',
              `幂等键 ${key} 已用于 ${prior.action_id}`,
            ),
          )
        } else {
          replay = true
        }
      }
    }

    const started = Date.now()
    const client = new OpenConnector({
      baseUrl: this.opts.baseUrl,
      runtimeToken: opts.token,
      timeoutMs: this.requestTimeoutMs,
      // 重试由上层决定；这里保持确定性，fixture 才能一对一回放
      maxRetries: 0,
      fetch: (key === undefined
        ? this.fetchImpl
        : withHeader(this.fetchImpl, 'Idempotency-Key', key)) as unknown as typeof fetch,
    })
    let raw: { data: unknown; executionId?: string; actionId?: string }
    try {
      // 注册表为空时 SDK 的 `InputOf` 退化成 `Record<string, any>`；契约这一层的 input 是 unknown
      raw = await client.executeRaw(meta.id, input as Record<string, unknown>, {
        connectionName: conn.connectionName,
      })
    } catch (e) {
      throw await this.failed(meta.id, print, toAdapterError(e))
    }

    if (key !== undefined && !replay) this.idempotency.set(key, { action_id: meta.id, at })

    const execution_id = raw.executionId ?? this.nextId('exec')
    await this.emit({
      type: 'connect.executed',
      at,
      assignment_id: record.assignment_id,
      execution_id,
      payload: {
        action_id: meta.id,
        service: meta.service,
        side_effect,
        connection_id: conn.id,
        token_kind: record.kind,
        token_fingerprint: print,
        duration_ms: Date.now() - started,
        ...(key === undefined ? {} : { idempotency_key: key, idempotent_replay: replay }),
      },
    })
    return {
      data: raw.data as T,
      execution_id,
      meta: {
        action_id: meta.id,
        connection_id: conn.id,
        at,
        side_effect,
        ...(key === undefined ? {} : { idempotency_key: key, idempotent_replay: replay }),
      },
    }
  }

  /** 18 §1：一律拒。role-read 的 allowedProxies 恒空，role-apply v1 也不开 proxy。 */
  async proxy(service: string, _req: ProxyRequestLike, opts: { token: string }): Promise<never> {
    const record = this.state.findToken(opts.token)
    await this.emit({
      type: 'connect.proxy_denied',
      at: this.now(),
      ...(record === undefined ? {} : { assignment_id: record.assignment_id }),
      payload: {
        service,
        token_kind: record?.kind ?? 'unknown',
        ...(record === undefined ? {} : { token_fingerprint: record.token_sha256.slice(0, 12) }),
      },
    })
    throw new ConnectAdapterError(
      'forbidden',
      record?.kind === 'role-read'
        ? 'role-read token 禁 proxy（allowed_proxies 为空）'
        : 'connect-adapter v1 不开放 provider proxy，只允许目录内 Action',
      { service },
    )
  }

  // ------------------------------------------------------------ 内部

  private now(): Iso8601 {
    return this.clock.now()
  }

  private nextId(prefix: string): string {
    this.seq += 1
    return `${prefix}_${this.seq}_${fingerprint(`${prefix}:${this.seq}:${this.now()}`).slice(0, 8)}`
  }

  private async emit(event: ConnectEvent): Promise<void> {
    if (this.sink === undefined) return
    await this.sink.emit(event)
  }

  private async failed(
    action_id: string,
    print: string | undefined,
    err: ConnectAdapterError,
  ): Promise<ConnectAdapterError> {
    const details = err.details as { runtime_error_code?: string } | undefined
    await this.emit({
      type: 'connect.execute_failed',
      at: this.now(),
      payload: {
        action_id,
        code: err.code,
        ...(print === undefined ? {} : { token_fingerprint: print }),
        ...(details?.runtime_error_code === undefined
          ? {}
          : { runtime_error_code: details.runtime_error_code }),
      },
    })
    return err
  }

  private toActionMeta(a: WireAction): RuntimeActionMeta {
    const ex = a.execution ?? {}
    return {
      id: a.id,
      service: a.service,
      input_schema: a.inputSchema ?? {},
      side_effect: this.table.resolve(a.id),
      ...(a.outputSchema === undefined ? {} : { output_schema: a.outputSchema }),
      ...(a.requiredScopes === undefined ? {} : { required_scopes: [...a.requiredScopes] }),
      execution: {
        locally_executable: ex.locallyExecutable !== false,
        catalog_only: ex.catalogOnly === true,
        needs_credential: ex.needsCredential === true,
        required_auth_types: [...(ex.requiredAuthTypes ?? [])],
      },
    }
  }

  private toConnection(c: WireConnection): Connection {
    const meta = this.state.connectionMeta(c.id)
    const identity: Connection['identity'] = {
      ...(c.profile?.accountId === undefined ? {} : { account_id: c.profile.accountId }),
      ...(c.profile?.displayName === undefined ? {} : { display_name: c.profile.displayName }),
      ...(c.profile?.grantedScopes === undefined
        ? {}
        : { granted_scopes: [...c.profile.grantedScopes] }),
    }
    return {
      id: c.id,
      service: c.service,
      alias: c.connectionName,
      ownership: meta?.ownership ?? 'workspace',
      workspace_id: meta?.workspace_id ?? this.workspaceId,
      ...(meta?.owner_person_id === undefined ? {} : { owner_person_id: meta.owner_person_id }),
      ...(Object.keys(identity).length === 0 ? {} : { identity }),
      status: meta?.status_override ?? (c.configured === false ? 'reauth_required' : 'active'),
    }
  }

  private async listConnections(refresh = false): Promise<WireConnection[]> {
    if (!refresh && this.connectionCache !== undefined) return this.connectionCache
    const res = await this.http.request<WireConnection[]>('GET', '/api/connections', {
      auth: 'admin',
    })
    this.connectionCache = res.data ?? []
    return this.connectionCache
  }

  private async providerAuthKind(service: string): Promise<string> {
    const token = await this.ensureCatalogToken()
    const res = await this.http.request<WireProvider[]>('GET', '/v1/providers', {
      auth: 'runtime',
      runtimeToken: token,
      query: { service },
    })
    const hit = (res.data ?? []).find((p) => p.service === service)
    if (hit === undefined) {
      throw new ConnectAdapterError('not_found', `未知 provider：${service}`, { service })
    }
    return hit.authTypes?.[0] ?? 'no_auth'
  }

  private async providerDetail(service: string): Promise<WireProviderDetail> {
    const res = await this.http.request<WireProviderDetail>(
      'GET',
      `/api/providers/${encodeURIComponent(service)}`,
      { auth: 'admin' },
    )
    if (res.data === undefined || res.data === null) {
      throw new ConnectAdapterError('not_found', `未知 provider：${service}`, { service })
    }
    return res.data
  }

  private rememberPending(
    request_id: string,
    service: string,
    opts: {
      workspace_id: WorkspaceId
      ownership: Connection['ownership']
      alias: string
      mode: 'own_app' | 'agentsws_connect'
    },
    existing: Set<string>,
  ): void {
    this.pending.set(request_id, {
      request_id,
      service,
      alias: opts.alias,
      workspace_id: opts.workspace_id,
      ownership: opts.ownership,
      mode: opts.mode,
      existing_ids: existing,
      expires_at: new Date(Date.parse(this.now()) + this.oauthWindowSeconds * 1000).toISOString(),
    })
  }

  private async actionMeta(action_id: string): Promise<RuntimeActionMeta> {
    const cached = this.actionCache.get(action_id)
    if (cached !== undefined) return cached
    // 全名 `service.action` 时先把整个 service 的目录热一遍：一次请求换掉 N 次单条查询
    const dot = action_id.indexOf('.')
    if (dot > 0) {
      await this.actions(action_id.slice(0, dot))
      const warm = this.actionCache.get(action_id)
      if (warm !== undefined) return warm
      throw new ConnectAdapterError('not_found', `未知 Action：${action_id}`, {
        action: action_id,
      })
    }
    const token = await this.ensureCatalogToken()
    const res = await this.http.request<WireAction>(
      'GET',
      `/v1/actions/${encodeURIComponent(action_id)}`,
      { auth: 'runtime', runtimeToken: token },
    )
    if (res.data === undefined || res.data === null) {
      throw new ConnectAdapterError('not_found', `未知 Action：${action_id}`, { action: action_id })
    }
    const meta = this.toActionMeta(res.data)
    this.actionCache.set(meta.id, meta)
    return meta
  }

  private async resolveConnection(
    service: string,
    requested: string | undefined,
  ): Promise<WireConnection> {
    let list = await this.listConnections()
    let hit = pickConnection(list, service, requested)
    if (hit === undefined) {
      list = await this.listConnections(true)
      hit = pickConnection(list, service, requested)
    }
    if (hit === undefined) {
      throw new ConnectAdapterError(
        'not_found',
        requested === undefined ? `${service} 没有默认连接` : `连接不存在：${requested}`,
        { service, connection: requested },
      )
    }
    return hit
  }

  private async resolveExecutable(service: string): Promise<boolean> {
    const cached = this.serviceExecutable.get(service)
    if (cached !== undefined) return cached
    // 只在调用方声明了 services 白名单时精确解析；否则 1465 个 provider 逐个拉 Action 不现实
    if (this.opts.services === undefined || !this.opts.services.includes(service)) return true
    await this.actions(service)
    return this.serviceExecutable.get(service) ?? true
  }

  /**
   * `/v1/*` 在 runtime 有任何 token 之后就强制鉴权，而 admin token 在 `/v1` 上会被拒（实测 401）。
   * 所以目录读要有一把自己的 runtime token：allowedActions 指向一个不存在的 Action、
   * blockedActions 为 `*`、allowedProxies 为空、allowedConnections 指向一个不存在的连接
   * —— 它读得到目录，执行不了任何东西。原文只在内存里。
   */
  private async ensureCatalogToken(): Promise<string> {
    if (this.catalogToken !== undefined) return this.catalogToken
    const created = await this.http.request<WireTokenCreated>('POST', '/api/runtime-tokens', {
      auth: 'admin',
      body: {
        name: CATALOG_TOKEN_NAME,
        allowedActions: [CATALOG_UNREACHABLE_ACTION],
        blockedActions: ['*'],
        allowedProxies: [],
        allowedConnections: [CATALOG_UNREACHABLE_CONNECTION],
      },
    })
    this.catalogToken = created.data.token
    return this.catalogToken
  }
}

function pickConnection(
  list: WireConnection[],
  service: string,
  requested: string | undefined,
): WireConnection | undefined {
  if (requested === undefined) {
    return list.find((c) => c.service === service && c.default === true)
  }
  return (
    list.find((c) => c.id === requested) ??
    list.find((c) => c.service === service && c.connectionName === requested)
  )
}

function authKindOf(authTypes: string[] | undefined): ProviderMeta['auth'] {
  const first = authTypes?.[0]
  if (first === 'api_key' || first === 'oauth2' || first === 'custom_credential') return first
  return 'no_auth'
}

function normalizeUrl(u: string): string {
  return u.replace(/\/+$/, '')
}

function withHeader(base: FetchLike, name: string, value: string): FetchLike {
  return (url, init) => {
    const headers = new Headers((init?.headers ?? {}) as HeadersInit)
    headers.set(name, value)
    return base(url, { ...init, headers })
  }
}

function toAdapterError(e: unknown): ConnectAdapterError {
  if (e instanceof ConnectAdapterError) return e
  if (e instanceof ConnectorError) {
    return mapRuntimeError({
      status: e.status,
      errorCode: e.code,
      message: e.message,
      details: e.data,
    })
  }
  if (e instanceof Error && e.name === 'AbortError') {
    return new ConnectAdapterError('timeout', `OpenConnector 请求超时：${e.message}`)
  }
  return new ConnectAdapterError('internal', e instanceof Error ? e.message : String(e))
}

export function createConnectAdapter(opts: ConnectAdapterOptions): ConnectAdapter {
  return new OpenConnectorAdapter(opts)
}

export type { SideEffect }
