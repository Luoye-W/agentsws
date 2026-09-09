/**
 * 连接面（WP20 连接向导）：18 §1 Connect 契约的 HTTP 投影 + 13 §4.3 的"凭据不经模型"。
 *
 * 三条不可让步的边界：
 *
 * 1. **凭据只走 `POST /v1/connections/:service/submit` 这一条路，而且只走一次。**
 *    请求体里的字段值由处理器原样交给端口，端口转给 OpenConnector 的凭据库或本机加密库，
 *    然后**没有任何一处**再持有它：不进事件日志、不进 trace、不进响应体、不进 OpenAPI 示例、
 *    也永远不会出现在 `GET /v1/connections` 里。处理器自己不读、不记、不打印字段值——
 *    连校验失败的 `details` 里也只有字段名（zod 的 issue 只带 path 与 message）。
 * 2. **`GET /v1/connections` 永不含凭据。** 返回的是 id / service / alias / ownership /
 *    status / 身份展示名 / 上次测试结果，仅此而已。
 * 3. **网关里不写业务**（28 §2）：怎么连、连去哪、怎么测，全在 `apps/server` 装配的
 *    `ConnectionsPort` 里；这一层只做路由声明、权限判定与信封。
 *
 * 权限（31 §3.1 完整元组）：读走 `store_config.read@workspace`，改走
 * `policy.stage@workspace`——05 里"连接器授权"（`authorize_connector`）是 owner 专属动作，
 * 客服岗位看不到也改不了别人家的店铺凭据。
 */
import type { MaybePromise } from '@agentsws/contracts'
import { z } from 'zod'
import { ApiError } from '../errors.js'
import { body, ok, param, principalOf } from '../helpers.js'
import { type Route, route } from '../route-spec.js'
import type { GatewayDeps } from '../types.js'

/** 读连接清单：owner 的 `store_config.read@workspace`。 */
const READ = {
  domain: 'store_config',
  op: 'read',
  range: 'workspace',
  sensitivity: 'internal',
} as const

/** 建 / 删 / 测连接：05 owner 的 `authorize_connector` 属策略层，永远 L1。 */
const WRITE = {
  domain: 'policy',
  op: 'stage',
  range: 'workspace',
  sensitivity: 'restricted',
} as const

const TAG = 'connections'

// ── 端口类型（apps/server 实现）────────────────────────────────────────

export type ConnectionOwnership = 'workspace' | 'person'
export type ConnectionStatus = 'active' | 'reauth_required' | 'disabled'
export type ProviderAuthKind = 'no_auth' | 'api_key' | 'oauth2' | 'custom_credential'

/** 凭据存在哪——界面上要说清楚，用户才知道"断开"删的是什么。 */
export type CredentialStore = 'openconnector' | 'local_vault'

/** 一条连接的对外形状。**这里没有、也不会有任何凭据字段。** */
export interface ConnectionView {
  id: string
  service: string
  service_label: string
  alias: string
  ownership: ConnectionOwnership
  status: ConnectionStatus
  /** 只有展示名与账号 id 这类"给人看的身份"，没有 token、没有密码。 */
  identity?: { account_id?: string; display_name?: string }
  credential_store: CredentialStore
  /** 这条连接喂哪些工作台数据源（deck 的 DataSourceId）。 */
  data_sources: string[]
  last_tested_at?: string
  last_test?: ConnectTestResult
}

/** 原生表单的一个字段。`secret: true` 的在前端一律 `type=password` + `autocomplete=off`。 */
export interface ProviderFieldSpec {
  name: string
  label: string
  secret: boolean
  required: boolean
  kind?: 'text' | 'password' | 'email' | 'number' | 'url'
  placeholder?: string
  hint?: string
  /** 非秘密字段的预填值（端口号之类）；秘密字段永远没有默认值。 */
  default?: string
}

/** 非技术用户的"要准备什么"：≤ 5 步 + 外链（31 §3「v1 只做不需平台审核的路径」）。 */
export interface ProviderSetupGuide {
  summary: string
  steps: string[]
  links: { label: string; url: string }[]
}

export interface ProviderView {
  service: string
  label: string
  auth: ProviderAuthKind
  /** 表单类 provider 的字段；OAuth 类为空数组。 */
  fields: ProviderFieldSpec[]
  /** 这台机器上现在能不能连（runtime 没起、秘密库没密钥都会是 false）。 */
  available: boolean
  unavailable_reason?: string
  data_sources: string[]
  setup_guide: ProviderSetupGuide
  /** 「已连接，数据接入下一版」之类的诚实说明。 */
  data_note?: string
}

export interface BeginConnectResult {
  request_id: string
  /** OAuth 类：把用户送到平台的授权页。 */
  authorization_url?: string
  /** 表单类：字段描述。值永远不经这条路回来。 */
  secure_form?: { fields: ProviderFieldSpec[] }
}

export type ConnectRequestStatus = 'initiated' | 'connected' | 'failed' | 'expired'

export interface ConnectTestResult {
  ok: boolean
  /** 机器读的原因码（`bad_credentials` / `host_not_found` / …）。 */
  reason?: string
  /** 人话（"密码不对"）；前端还会按 reason 出自己的文案。 */
  detail?: string
  checked_at: string
}

export interface RuntimeStatusView {
  /** `stand_in` = 这台机器没配 OpenConnector，用的是替身（开发 / demo）。 */
  state: 'absent' | 'unhardened' | 'ready' | 'stand_in'
  base_url?: string
  reasons: string[]
  checks: { name: string; ok: boolean; detail: string }[]
  checked_at: string
  /** 本机加密秘密库（通用 IMAP / SMTP 凭据存这里）。 */
  secrets_vault: { available: boolean; reason?: string }
}

export interface ConnectionsActor {
  workspace_id: string
  person_id: string
}

/** 原生表单直填的入参。`fields` 的值只在这一个对象里活一次。 */
export interface SubmitConnectionInput {
  alias: string
  ownership: ConnectionOwnership
  request_id?: string
  fields: Record<string, string>
}

export interface ConnectionsPort {
  providers(actor: ConnectionsActor): MaybePromise<ProviderView[]>
  list(actor: ConnectionsActor): MaybePromise<ConnectionView[]>
  begin(
    actor: ConnectionsActor,
    service: string,
    input: { alias: string; ownership: ConnectionOwnership; mode: 'own_app' | 'agentsws_connect' },
  ): MaybePromise<BeginConnectResult>
  pollRequest(
    actor: ConnectionsActor,
    request_id: string,
  ): MaybePromise<{ status: ConnectRequestStatus; connection?: ConnectionView }>
  /** **唯一**接触凭据原文的方法。实现必须转发后立即遗忘。 */
  submit(
    actor: ConnectionsActor,
    service: string,
    input: SubmitConnectionInput,
  ): MaybePromise<{ connection: ConnectionView; test: ConnectTestResult }>
  remove(actor: ConnectionsActor, id: string): MaybePromise<void>
  test(actor: ConnectionsActor, id: string): MaybePromise<ConnectTestResult>
  runtime(): MaybePromise<RuntimeStatusView>
}

// ── 校验 ───────────────────────────────────────────────────────────────

const OWNERSHIP = z.enum(['workspace', 'person'])

const BeginBody = z.object({
  alias: z.string().min(1).max(64).optional(),
  ownership: OWNERSHIP.optional(),
  mode: z.enum(['own_app', 'agentsws_connect']).optional(),
})

/**
 * 表单直填的请求体。
 *
 * `fields` 只允许"字段名 → 字符串"，值不设内容约束（密码里什么字符都可能有），
 * 但**长度封顶**，免得有人把一个文件塞进来。校验失败时 zod 的 issue 只有 path 与
 * message——不会把值抄进错误信封，这一点是"凭据零泄漏"断言的一条。
 */
const SubmitBody = z.object({
  alias: z.string().min(1).max(64).optional(),
  ownership: OWNERSHIP.optional(),
  request_id: z.string().min(1).max(128).optional(),
  fields: z.record(z.string().min(1).max(64), z.string().max(4096)),
})

function portOf(deps: GatewayDeps): ConnectionsPort {
  const p = deps.connections
  if (p === undefined)
    throw new ApiError('not_implemented', '这个服务进程没有装配连接面（GatewayDeps.connections）')
  return p
}

function actorOf(c: Parameters<typeof principalOf>[0]): ConnectionsActor {
  const p = principalOf(c)
  return { workspace_id: p.workspace_id, person_id: p.person_id }
}

const SERVICE_PARAM = {
  name: 'service',
  in: 'path',
  required: true,
  description: 'provider 的 service id（shopify_admin / gmail / imap_smtp / ga4 / gsc / meta_ads）',
} as const

const ID_PARAM = {
  name: 'id',
  in: 'path',
  required: true,
  description: '连接 id（GET /v1/connections 里的 id）',
} as const

export function connectionRoutes(): Route[] {
  return [
    // `providers` / `runtime` / `requests` 都在 `/v1/connections/` 之下且是定值段，
    // 与 `/v1/connections/:service/...` 不冲突（后者第二段之后还有一段）。
    route(
      {
        method: 'get',
        path: '/v1/connections',
        operationId: 'listConnections',
        summary:
          '本工作区已建立的连接（**永不含凭据**：只有 service / alias / 归属 / 状态 / 身份展示名）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: '{ connections: ConnectionView[] }',
      },
      async (c, deps) => ok(c, { connections: await portOf(deps).list(actorOf(c)) }),
    ),
    route(
      {
        method: 'get',
        path: '/v1/connections/providers',
        operationId: 'listConnectionProviders',
        summary: '可连的服务：各自的授权方式、所需字段描述、给非技术用户的准备步骤',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: '{ providers: ProviderView[] }',
      },
      async (c, deps) => ok(c, { providers: await portOf(deps).providers(actorOf(c)) }),
    ),
    route(
      {
        method: 'get',
        path: '/v1/connections/runtime',
        operationId: 'getConnectRuntimeStatus',
        summary:
          'OpenConnector runtime 的加固检查（08 §5 安装器策略）：absent / unhardened / ready',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: 'RuntimeStatusView',
      },
      async (c, deps) => ok(c, await portOf(deps).runtime()),
    ),
    route(
      {
        method: 'get',
        path: '/v1/connections/requests/:id',
        operationId: 'pollConnectRequest',
        summary: '轮询一次授权请求（OAuth 回来了没有）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [
          { name: 'id', in: 'path', required: true, description: 'begin 返回的 request_id' },
        ],
        returns: '{ status: initiated|connected|failed|expired, connection? }',
      },
      async (c, deps) => ok(c, await portOf(deps).pollRequest(actorOf(c), param(c, 'id'))),
    ),
    route(
      {
        method: 'post',
        path: '/v1/connections/:service/begin',
        operationId: 'beginConnect',
        summary: '发起连接：OAuth 类回授权地址，表单类回字段描述（值不经这条路）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        params: [SERVICE_PARAM],
        body: BeginBody,
        returns: '{ request_id, authorization_url? , secure_form? }',
      },
      async (c, deps) => {
        const input = await body(c, BeginBody)
        const service = param(c, 'service')
        return ok(
          c,
          await portOf(deps).begin(actorOf(c), service, {
            alias: input.alias ?? 'default',
            ownership: input.ownership ?? 'workspace',
            mode: input.mode ?? 'own_app',
          }),
        )
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/connections/:service/submit',
        operationId: 'submitConnectionForm',
        summary:
          '原生表单直填（13 §4.3）：字段值只走这一条 HTTPS 到本机服务进程，转给凭据库后即遗忘；不进事件日志、不进 trace、不进模型',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        params: [SERVICE_PARAM],
        body: SubmitBody,
        returns: '{ connection: ConnectionView（无凭据）, test: ConnectTestResult }',
      },
      async (c, deps) => {
        const input = await body(c, SubmitBody)
        const service = param(c, 'service')
        const names = Object.keys(input.fields)
        if (names.length === 0)
          throw new ApiError('invalid_input', '表单没有任何字段', { details: { service } })
        // 处理器只把值往下传一次，自己不读、不记、不回显。
        return ok(
          c,
          await portOf(deps).submit(actorOf(c), service, {
            alias: input.alias ?? 'default',
            ownership: input.ownership ?? 'workspace',
            ...(input.request_id === undefined ? {} : { request_id: input.request_id }),
            fields: input.fields,
          }),
        )
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/connections/:id/test',
        operationId: 'testConnection',
        summary: '连通性冒烟（Shopify 读店铺信息 / 邮箱 IMAP 登录 + SMTP NOOP）：只回 ok 与原因',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        params: [ID_PARAM],
        returns: 'ConnectTestResult',
      },
      async (c, deps) => ok(c, await portOf(deps).test(actorOf(c), param(c, 'id'))),
    ),
    route(
      {
        method: 'delete',
        path: '/v1/connections/:id',
        operationId: 'removeConnection',
        summary: '断开连接（凭据随之从凭据库删除）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        params: [ID_PARAM],
        returns: '{ removed: true }',
      },
      async (c, deps) => {
        await portOf(deps).remove(actorOf(c), param(c, 'id'))
        return ok(c, { removed: true })
      },
    ),
  ]
}
