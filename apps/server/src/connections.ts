/**
 * 连接面的装配（WP20 连接向导）。
 *
 * 一句话职责：把「目录（`catalog.ts`）+ OpenConnector（真适配器或替身）+ 本机加密秘密库
 * （`secret-store.ts`）」拼成网关要的 `ConnectionsPort`，并把连接状态回灌给工作台的数据源。
 *
 * **凭据在这里只经过一次，不停留**（13 §4.3）：
 * - `submit()` 拿到字段值 → 立刻转给 OpenConnector 的凭据库（`PUT /api/connections/:service`）
 *   或本机 AES-256-GCM 秘密库 → 局部变量出作用域即结束。
 * - 事件日志里只有 `service` / `alias` / **字段名**；`GET /v1/connections` 里连字段名都没有。
 * - 试连要读回口令时（IMAP / SMTP），值只在 `mailProbe` 的调用栈里活一次，不进返回值。
 *
 * 两档装配（35 §5「替身 → 真实现」）：
 * - `AGENTSWS_CONNECT_URL` 存在 → 真 `connect-adapter`（admin token 从环境变量名读），
 *   且**先过 08 §5 的加固检查**：没开鉴权 / 没开静态加密的 runtime 一律不给用。
 * - 不存在 → stand-ins 的 `MockOpenConnector`（开发与 demo），状态条上明说是替身。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type {
  BeginConnectResult,
  ConnectionsActor,
  ConnectionsPort,
  ConnectionView,
  ConnectRequestStatus,
  ConnectTestResult,
  MailboxDetectResult,
  MailboxPresetView,
  ProviderFieldSpec,
  ProviderView,
  RuntimeStatusView,
  SubmitConnectionInput,
} from '@agentsws/api'
import {
  classifyMailFailure,
  detectMailbox,
  ImapMailSource,
  type MailboxPreset,
  type ResolveMx,
  SmtpMailer,
} from '@agentsws/channels'
import { assertRuntimeHardened, createConnectAdapter } from '@agentsws/connect-adapter'
import type {
  ActionMeta,
  Clock,
  Connection,
  ConnectToken,
  EventEnvelope,
  ExecuteResult,
  Iso8601,
  ProviderMeta,
  WorkspaceId,
} from '@agentsws/contracts'
import type { ConnectionLike, DataSourceStatus } from '@agentsws/deck'
import { mergeDataSources } from '@agentsws/deck'
import { seededRandom } from '@agentsws/kernel'
import { MockOpenConnector } from '@agentsws/stand-ins'
import {
  authOptionOf,
  CATALOG,
  type CatalogAuthOption,
  type CatalogEntry,
  catalogEntry,
  serviceOfUpstream,
} from './catalog.js'
import {
  createSecretStore,
  SECRETS_KEY_ENV,
  type SecretStore,
  SecretStoreError,
} from './secret-store.js'
import {
  type BrokerFetch,
  createShopifyBroker,
  type ShopifyBroker,
  ShopifyBrokerError,
  type ShopifyBrokerRecord,
} from './shopify-broker.js'
import type { WorkstationDataSource } from './workstation.js'

/** 试连时临时签发的 role-read token 挂在这个 assignment 下；用完立刻吊销。 */
const SMOKE_ASSIGNMENT = 'asg_connection_smoke'
const SMOKE_TOKEN_TTL_SECONDS = 120
/** 加固检查的缓存时长——每敲一次界面就去探一次 runtime 没必要。 */
const HARDENING_TTL_MS = 30_000
const LOCAL_SERVICE = 'imap_smtp'

/** OpenConnector 的最小面（真适配器与替身都满足这个形状）。 */
export interface ConnectLike {
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
  pollConnect(request_id: string): Promise<ConnectRequestStatus>
  submitForm(
    service: string,
    input: {
      workspace_id: WorkspaceId
      ownership: Connection['ownership']
      alias: string
      auth_type?: string
      fields: Readonly<Record<string, string>>
      request_id?: string
    },
  ): Promise<Connection>
  removeConnection(id: string): Promise<void>
  issueToken(input: {
    assignment_id: string
    kind: ConnectToken['kind']
    allowed_actions: string[]
    allowed_connections: string[]
    expires_in_seconds?: number
  }): Promise<ConnectToken>
  revokeTokens(assignment_id: string): Promise<void>
  execute<T = unknown>(
    action_id: string,
    input: unknown,
    opts: { token: string; connection?: string; idempotencyKey?: string },
  ): Promise<ExecuteResult<T>>
}

/** 一个邮箱账号的连接参数（**不含口令**——口令只在秘密库里）。 */
export interface MailAccount {
  connection_id: string
  address: string
  imap: { host: string; port: number; secure: boolean; user: string; connection_id: string }
  smtp: { host: string; port: number; secure: boolean; user: string; connection_id: string }
}

/**
 * 邮箱试连（IMAP 登录 + SMTP 握手）。
 *
 * 抽成端口有两个理由：一是测试里不能真去连外网；二是**口令只在这个调用里出现一次**，
 * 探针不许把它存起来、也不许回显。
 */
export interface MailProbe {
  check(
    account: MailAccount,
    /** 收信口令。 */
    password: string,
    /** 发信口令；用户没单独填就等于收信那一份。 */
    smtpPassword: string,
  ): Promise<{ ok: boolean; reason?: string; detail?: string }>
}

interface LocalConnectionMeta {
  id: string
  alias: string
  ownership: 'workspace' | 'person'
  /** 展示名 = 邮箱地址（身份，不是凭据）。 */
  display_name: string
  created_at: Iso8601
}

interface StateFile {
  version: 1
  local: LocalConnectionMeta[]
  /** connection_id → 上次试连结果（只有 ok / 原因，没有任何凭据线索）。 */
  tests: Record<string, ConnectTestResult>
  /** WP25：客户端凭据接管的 Shopify 店（只有域名 / 连接 id / 到期时间）。 */
  shopify?: ShopifyBrokerRecord[]
}

export interface ConnectionsOptions {
  clock: Clock
  workspace_id: WorkspaceId
  env?: NodeJS.ProcessEnv
  /** SQLite / 状态文件目录；不给则全内存（测试与一次性任务）。 */
  dbDir?: string
  random?: () => number
  /** 事件汇（21 §1）；payload 里永远没有凭据。 */
  appendEvent?: (e: Omit<EventEnvelope, 'id' | 'at'> & { at?: string }) => void
  /** 测试注入点：替代按环境变量选出来的那一个。 */
  connect?: ConnectLike
  secrets?: SecretStore
  mailProbe?: MailProbe
  /** 加固探针（默认 `assertRuntimeHardened`）。 */
  probe?: (baseUrl: string) => Promise<{
    ok: boolean
    reasons: readonly string[]
    checks: readonly { name: string; ok: boolean; detail: string }[]
  }>
  /** WP25：Shopify 换令牌用的 fetch（测试注入 fixture 回放，不联网）。 */
  shopifyFetch?: BrokerFetch
  /** WP25：邮箱识别用的 MX 查询（测试注入；缺省用 `node:dns/promises`）。 */
  resolveMx?: ResolveMx
  /**
   * WP25：Shopify 令牌刷新的巡检间隔（毫秒）。给 0 / 不给就不起定时器——
   * 测试与一次性任务不该有后台计时器；服务进程装配时传 15 分钟。
   */
  refreshIntervalMs?: number
}

export interface ConnectionsAssembly {
  port: ConnectionsPort
  /** WP25：Shopify 客户端凭据经纪人（换令牌 / 刷新 / 忘记）。 */
  shopify: ShopifyBroker
  /** 立刻跑一轮"快到期的都换一张"（服务进程的定时器与测试都调它）。 */
  refreshTokens(): Promise<void>
  /** 当前真实连接（只有 service 与状态）——给 deck 算 `DataSourceStatus`。 */
  snapshot(): ConnectionLike[]
  /** 邮箱连接的参数（channels 装配 IMAP / SMTP 用）；口令仍要经 `credentialSource()` 取。 */
  mailAccounts(): MailAccount[]
  /** 交给 `@agentsws/channels` 的凭据来源：按连接 id 从加密库取口令。 */
  credentialSource(): { password(ref: { connection_id: string }): string }
  /**
   * WP34：邮箱连接**变了**（新增 / 改口令 / 断开）时叫一声。
   *
   * 渠道装配（`./channels.ts`）拿它做热更新——用户在连接页加一个邮箱，
   * 下一轮轮询就该开始收信，而不是等重启。返回取消订阅的函数。
   *
   * 回调里**不带任何凭据**，连 id 都只是「有变动」的信号：订阅者自己再去
   * `mailAccounts()` 取一份新的。
   */
  onMailChange(listener: () => void): () => void
  /** 把工作台数据源包一层：连接状态从真实连接算（36 §3）。 */
  wrapDataSource(base: WorkstationDataSource): WorkstationDataSource
  close(): void
}

// ── 小工具 ─────────────────────────────────────────────────────────────

function errorCodeOf(e: unknown): string {
  if (typeof e === 'object' && e !== null && 'code' in e) {
    const code = (e as { code: unknown }).code
    if (typeof code === 'string') return code
  }
  return 'internal'
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** 上游错误 → 人话。界面还会按 `reason` 出自己的文案，这里是兜底。 */
function humanize(code: string, fallback: string): string {
  switch (code) {
    case 'unauthenticated':
    case 'bad_credentials':
      return '账号或密码不对，请核对后重新填一次'
    case 'provider_error':
      return '对方服务拒绝了这次连接：多半是令牌过期或权限不够'
    case 'not_found':
    case 'host_not_found':
      return '找不到这个地址：域名或服务器地址可能写错了'
    case 'provider_unavailable':
      return '连不上对方服务，检查一下网络'
    case 'timeout':
      return '等太久没有回应，稍后再试一次'
    case 'forbidden':
      return '这个账号没有我们需要的权限'
    default:
      return fallback
  }
}

/** 上游说"你没权限"的那几个码。Shopify 的 24 小时令牌过期就长这样。 */
function isUnauthorized(code: string): boolean {
  return (
    code === 'unauthenticated' ||
    code === 'authorization_failed' ||
    code === 'forbidden' ||
    code === 'bad_credentials'
  )
}

/**
 * 试连成功之后给用户看的那一句。
 *
 * Shopify 的 `get_shop` 回的是店铺信息——**回店铺名，不回令牌**，这样用户一眼能确认
 * "接的是我那家店"。别的动作只说跑通了。
 */
export function smokeDetail(action_id: string, result: unknown): string {
  const name = shopNameOf(result)
  if (action_id.endsWith('get_shop') && name !== undefined) return `连上了：${name}`
  return `试跑 ${action_id} 成功`
}

/** 从 `get_shop` 的返回里挖出店铺名。挖不到就 undefined（绝不编一个）。 */
function shopNameOf(result: unknown): string | undefined {
  const seen = new Set<unknown>()
  const walk = (node: unknown, depth: number): string | undefined => {
    if (depth > 4 || typeof node !== 'object' || node === null || seen.has(node)) return undefined
    seen.add(node)
    const record = node as Record<string, unknown>
    for (const key of ['name', 'shopName', 'myshopifyDomain', 'displayName']) {
      const value = record[key]
      if (typeof value === 'string' && value.trim() !== '') return value
    }
    for (const value of Object.values(record)) {
      const hit = walk(value, depth + 1)
      if (hit !== undefined) return hit
    }
    return undefined
  }
  return walk(result, 0)
}

/** 预设 → 对外的那一份（前端只认这个形状）。 */
function presetView(preset: MailboxPreset): MailboxPresetView {
  return {
    id: preset.id,
    label: preset.label,
    imap_host: preset.imap_host,
    imap_port: preset.imap_port,
    smtp_host: preset.smtp_host,
    smtp_port: preset.smtp_port,
    auth: preset.auth,
    note: preset.note,
    ...(preset.help_url === undefined ? {} : { help_url: preset.help_url }),
  }
}

/** 只挑"不填任何参数就能跑"的只读 Action 当试连动作。 */
function noRequiredInput(schema: unknown): boolean {
  if (typeof schema !== 'object' || schema === null) return true
  const required = (schema as { required?: unknown }).required
  if (required === undefined) return true
  return Array.isArray(required) && required.length === 0
}

function pickSmokeAction(actions: ActionMeta[], hints: readonly string[]): ActionMeta | undefined {
  const usable = actions.filter(
    (a) =>
      a.side_effect === 'read' &&
      noRequiredInput(a.input_schema) &&
      (a.execution === undefined || (a.execution.locally_executable && !a.execution.catalog_only)),
  )
  for (const hint of hints) {
    const hit = usable.find((a) => a.id.toLowerCase().includes(hint))
    if (hit !== undefined) return hit
  }
  return usable[0]
}

/** 上次试连结果 → 两个可选字段（exactOptionalPropertyTypes：没有就整个键都别出现）。 */
function testFields(
  test: ConnectTestResult | undefined,
): { last_tested_at: string; last_test: ConnectTestResult } | Record<string, never> {
  return test === undefined ? {} : { last_tested_at: test.checked_at, last_test: test }
}

function toNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : fallback
}

/**
 * 表单要画哪几个字段。
 *
 * **目录优先**：v1 这六个 provider 的字段是我们逐个核对过的，带人话标签、占位符与提示
 * （"令牌只显示一次"这种话 runtime 不会说）。runtime 的原始字段清单只在目录没写时兜底——
 * 真出现字段对不上（上游改了形状），提交会被上游拒，错误原样回到界面上，
 * 比我们拿一堆 `apiKey` / `baseUrl` 的裸字段名糊弄用户强。
 */
function fieldSpecs(
  catalogFields: readonly ProviderFieldSpec[] | undefined,
  runtime?: { name: string; secret: boolean }[],
): ProviderFieldSpec[] {
  if (catalogFields !== undefined && catalogFields.length > 0) return [...catalogFields]
  return (runtime ?? []).map((f) => ({
    name: f.name,
    label: f.name,
    secret: f.secret,
    required: true,
    kind: f.secret ? ('password' as const) : ('text' as const),
  }))
}

// ── 装配 ───────────────────────────────────────────────────────────────

export async function createConnections(options: ConnectionsOptions): Promise<ConnectionsAssembly> {
  const env = options.env ?? process.env
  const clock = options.clock
  const random = options.random ?? seededRandom(Date.parse(clock.now()) % 2147483647)
  const workspace_id = options.workspace_id
  const baseUrl = env.AGENTSWS_CONNECT_URL?.trim()
  const stateFile =
    options.dbDir === undefined ? undefined : join(options.dbDir, 'connections.json')

  // 秘密库可以由服务进程建好传进来（模型 key 与邮箱口令同一个库、不同 key 前缀）；
  // 谁建的谁负责关，不然 `close()` 会把别人还在用的库关掉。
  const ownsSecrets = options.secrets === undefined
  const secrets =
    options.secrets ??
    createSecretStore({
      dbPath: options.dbDir === undefined ? ':memory:' : join(options.dbDir, 'secrets.sqlite'),
      clock,
      env,
    })

  const connect: ConnectLike =
    options.connect ??
    (baseUrl !== undefined && baseUrl !== ''
      ? (createConnectAdapter({
          baseUrl,
          adminTokenEnv: 'OOMOL_CONNECT_ADMIN_TOKEN',
          clock,
          env,
          workspaceId: workspace_id,
          services: CATALOG.filter((c) => c.upstream !== 'local').map((c) => c.upstream),
          ...(options.dbDir === undefined
            ? {}
            : { stateFile: join(options.dbDir, 'connect-adapter.json') }),
          eventSink: {
            emit: (e) => {
              options.appendEvent?.({
                schema_version: 1,
                workspace_id,
                type: e.type,
                actor: { kind: 'system', id: 'connections' },
                correlation: { trace_id: '' },
                payload: e.payload,
                ...(e.at === undefined ? {} : { at: e.at }),
              })
            },
          },
        }) as unknown as ConnectLike)
      : (new MockOpenConnector({
          clock,
          random,
          // 替身自带的示例连接归到一个别的工作区：本工作区一开始就是"什么都没连"，
          // 用户在向导里连出来的那几条才属于自己。否则界面会凭空显示"已连接"。
          workspace_id: 'ws_stand_in',
        }) as unknown as ConnectLike))

  const usingStandIn = options.connect === undefined && (baseUrl === undefined || baseUrl === '')
  const probe = options.probe ?? ((url: string) => assertRuntimeHardened(url, { env }))

  // ── 本地状态（只有非凭据元数据）
  let state: StateFile = { version: 1, local: [], tests: {}, shopify: [] }
  if (stateFile !== undefined) {
    try {
      const parsed = JSON.parse(readFileSync(stateFile, 'utf8')) as StateFile
      state = {
        version: 1,
        local: parsed.local ?? [],
        tests: parsed.tests ?? {},
        shopify: parsed.shopify ?? [],
      }
    } catch {
      // 第一次跑，或者文件坏了：从空开始，加密库里的凭据不受影响
    }
  }
  const flush = (): void => {
    if (stateFile === undefined) return
    mkdirSync(dirname(stateFile), { recursive: true })
    writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  }

  let seq = 0
  const nextLocalId = (): string => {
    seq += 1
    return `conn_mail_${Date.parse(clock.now()).toString(36)}_${seq}`
  }

  /** 后台作业自己的 trace 根（没有请求可挂靠时用它）。 */
  let traceSeq = 0
  const nextTraceId = (kind: string): string => {
    traceSeq += 1
    return `trc_${kind}_${Date.parse(clock.now()).toString(36)}_${traceSeq}`
  }

  // ── WP25：Shopify 客户端凭据经纪人
  //
  // 换令牌那一跳在 `shopify-broker.ts`；这里只提供它需要的三个口子：
  // 秘密库（存客户端 ID / 密钥）、记录存储（存到期时间，跟连接元数据同一个文件）、
  // 以及"把令牌推进 OpenConnector"的那一次转发。
  const shopify = createShopifyBroker({
    clock,
    vault: secrets,
    records: {
      list: () => state.shopify ?? [],
      put(record) {
        const rows = state.shopify ?? []
        const at = rows.findIndex((r) => r.shop === record.shop)
        if (at >= 0) rows[at] = record
        else rows.push(record)
        state.shopify = rows
        flush()
      },
      remove(shop) {
        state.shopify = (state.shopify ?? []).filter((r) => r.shop !== shop)
        flush()
      },
    },
    async pushToken({ shop, alias, accessToken }) {
      // 令牌在这一句里第一次也是最后一次被本进程持有：上游认的字段名是
      // `apiKey` / `shopDomain`（09-09 在真 runtime 上实测，写别的名字会 400）
      const conn = await connect.submitForm('shopify_admin', {
        workspace_id,
        ownership: 'workspace',
        alias,
        auth_type: 'api_key',
        fields: { apiKey: accessToken, shopDomain: shop },
      })
      return {
        connection_id: conn.id,
        ...(conn.identity?.display_name === undefined
          ? {}
          : { display_name: conn.identity.display_name }),
      }
    },
    ...(options.shopifyFetch === undefined ? {} : { fetch: options.shopifyFetch }),
    appendEvent: (type, payload) => {
      options.appendEvent?.({
        schema_version: 1,
        workspace_id,
        type,
        actor: { kind: 'system', id: 'connections' },
        // 别的地方写 `trace_id: ''` 是因为它们都在请求里，服务进程会拿当前那条 trace 覆盖掉。
        // **换令牌不一样**：到期刷新是后台定时器跑的，压根没有请求，空串会被内核顶回来
        // （事件要求非空 trace_id），于是每次自动换令牌都抛。后台作业自成一条 trace 的根。
        correlation: { trace_id: nextTraceId('shopify') },
        payload,
      })
    },
  })

  // ── runtime 加固检查（带缓存）
  let hardening: { at: number; report: Awaited<ReturnType<typeof probe>> } | undefined
  const hardeningReport = async (): Promise<Awaited<ReturnType<typeof probe>> | undefined> => {
    if (baseUrl === undefined || baseUrl === '') return undefined
    const now = Date.parse(clock.now())
    if (hardening !== undefined && now - hardening.at < HARDENING_TTL_MS) return hardening.report
    // 实测：全新 runtime 里一个 token 都没有时，匿名 /v1/health 是 200；适配器按需自签的
    // 目录 token 一存在，/v1 就强制鉴权。所以先让适配器把目录 token 签出来，再探。
    try {
      await connect.providers()
    } catch {
      // 签不出来（runtime 不通 / admin token 错）会在探测里以自己的理由体现
    }
    const report = await probe(baseUrl)
    hardening = { at: now, report }
    return report
  }

  const runtimeStatus = async (): Promise<RuntimeStatusView> => {
    const checked_at = clock.now()
    const vault = secrets.available
      ? { available: true }
      : {
          available: false,
          reason: `环境变量 ${SECRETS_KEY_ENV} 未设置：这台机器还不能保存邮箱账号密码`,
        }
    if (usingStandIn) {
      return {
        state: 'stand_in',
        reasons: ['AGENTSWS_CONNECT_URL 未设置，正在用开发替身；连出来的都是假连接'],
        checks: [],
        checked_at,
        secrets_vault: vault,
      }
    }
    const report = await hardeningReport()
    if (report === undefined) {
      return {
        state: 'absent',
        reasons: ['AGENTSWS_CONNECT_URL 未设置'],
        checks: [],
        checked_at,
        secrets_vault: vault,
      }
    }
    const absent = report.reasons.includes('runtime_unreachable')
    return {
      state: report.ok ? 'ready' : absent ? 'absent' : 'unhardened',
      ...(baseUrl === undefined ? {} : { base_url: baseUrl }),
      reasons: [...report.reasons],
      checks: report.checks.map((c) => ({ ...c })),
      checked_at,
      secrets_vault: vault,
    }
  }

  /** OpenConnector 那条路现在能不能用（替身档永远能用）。 */
  const connectUsable = async (): Promise<{ ok: boolean; reason?: string }> => {
    if (usingStandIn || options.connect !== undefined) return { ok: true }
    const status = await runtimeStatus()
    if (status.state === 'ready') return { ok: true }
    return {
      ok: false,
      reason:
        status.state === 'absent'
          ? '本机还没有装 OpenConnector runtime（或者它没起来）'
          : `OpenConnector runtime 没加固好，不能用：${status.reasons.join('、')}`,
    }
  }

  // ── 连接清单
  const localView = (meta: LocalConnectionMeta): ConnectionView => ({
    id: meta.id,
    service: LOCAL_SERVICE,
    service_label: catalogEntry(LOCAL_SERVICE)?.label ?? LOCAL_SERVICE,
    alias: meta.alias,
    ownership: meta.ownership,
    status: 'active',
    identity: { display_name: meta.display_name },
    credential_store: 'local_vault',
    data_sources: [],
    ...testFields(state.tests[meta.id]),
  })

  const remoteView = (conn: Connection): ConnectionView => {
    const service = serviceOfUpstream(conn.service)
    const entry = catalogEntry(service)
    const test = state.tests[conn.id]
    return {
      id: conn.id,
      service,
      service_label: entry?.label ?? service,
      alias: conn.alias,
      ownership: conn.ownership,
      status: conn.status,
      ...(conn.identity === undefined ? {} : { identity: { ...conn.identity } }),
      credential_store: 'openconnector',
      data_sources: entry?.data_sources ?? [],
      ...testFields(test),
    }
  }

  let cached: ConnectionView[] = state.local.map(localView)

  const listAll = async (): Promise<ConnectionView[]> => {
    const rows: ConnectionView[] = state.local.map(localView)
    try {
      for (const c of await connect.connections(workspace_id)) {
        // 上游的 no_auth 虚拟连接（`service:default`，公共只读 API）不是用户连的，不进"已连接"
        if (c.id.endsWith(':default') && catalogEntry(c.service) === undefined) continue
        rows.push(remoteView(c))
      }
    } catch {
      // runtime 挂了不该让整页白屏：本地那几条照常列，状态条上会红着说明原因
    }
    cached = rows
    return rows
  }

  await listAll()

  // ── 试连
  /** 跑一次只读 Action。分出来是为了「上游 401 → 换张令牌 → 再跑一次」能复用。 */
  const runSmokeAction = async (
    action: ActionMeta,
    connection_id: string,
  ): Promise<{ result: unknown }> => {
    let token: ConnectToken | undefined
    try {
      token = await connect.issueToken({
        assignment_id: SMOKE_ASSIGNMENT,
        kind: 'role-read',
        allowed_actions: [action.id],
        allowed_connections: [connection_id],
        expires_in_seconds: SMOKE_TOKEN_TTL_SECONDS,
      })
      const outcome = await connect.execute(
        action.id,
        {},
        {
          token: token.token,
          connection: connection_id,
        },
      )
      return { result: (outcome as { result?: unknown }).result ?? outcome }
    } finally {
      // 试连用的 token 一定要吊销：它的存在时间就该只有这一次调用
      if (token !== undefined) {
        try {
          await connect.revokeTokens(SMOKE_ASSIGNMENT)
        } catch {
          // 吊销失败也不该把试连结果变成失败；token 120 秒后本地记账也会过期
        }
      }
    }
  }

  const smokeRemote = async (view: ConnectionView): Promise<ConnectTestResult> => {
    const checked_at = clock.now()
    const entry = catalogEntry(view.service)
    const upstream = entry?.upstream ?? view.service
    let actions: ActionMeta[]
    try {
      actions = await connect.actions(upstream)
    } catch (e) {
      const code = errorCodeOf(e)
      return { ok: false, reason: code, detail: humanize(code, messageOf(e)), checked_at }
    }
    const action = pickSmokeAction(actions, entry?.smoke_hints ?? [])
    if (action === undefined) {
      return {
        ok: false,
        reason: 'test_unavailable',
        detail: '这个服务的目录里没有"不填参数就能跑"的只读动作，暂时没法自检；连接本身可能是好的',
        checked_at,
      }
    }
    try {
      const { result } = await runSmokeAction(action, view.id)
      return { ok: true, reason: 'ok', detail: smokeDetail(action.id, result), checked_at }
    } catch (e) {
      const code = errorCodeOf(e)
      // 上游说"没权限"时，如果这条连接是客户端凭据接管的，多半只是那张 24 小时的
      // 令牌过期了：换一张再跑一次。换不到才是真的连不上。
      if (isUnauthorized(code) && shopify.recordOf(view.id) !== undefined) {
        try {
          await shopify.refresh(view.id)
          const { result } = await runSmokeAction(action, view.id)
          return {
            ok: true,
            reason: 'ok',
            detail: `${smokeDetail(action.id, result)}（令牌过期了，已经自动换了一张新的）`,
            checked_at,
          }
        } catch (again) {
          if (again instanceof ShopifyBrokerError) {
            return { ok: false, reason: again.code, detail: again.message, checked_at }
          }
          const retryCode = errorCodeOf(again)
          return {
            ok: false,
            reason: retryCode,
            detail: humanize(retryCode, messageOf(again)),
            checked_at,
          }
        }
      }
      return { ok: false, reason: code, detail: humanize(code, messageOf(e)), checked_at }
    }
  }

  const accountOf = (connection_id: string): MailAccount | undefined => {
    const fields = secrets.get(connection_id)
    if (fields === undefined) return undefined
    const address = fields.email ?? ''
    const user = fields.username === undefined || fields.username === '' ? address : fields.username
    const imap_port = toNumber(fields.imap_port, 993)
    const smtp_port = toNumber(fields.smtp_port, 465)
    return {
      connection_id,
      address,
      imap: {
        host: fields.imap_host ?? '',
        port: imap_port,
        secure: imap_port !== 143,
        user,
        connection_id,
      },
      smtp: {
        host: fields.smtp_host ?? '',
        port: smtp_port,
        secure: smtp_port === 465,
        user,
        connection_id,
      },
    }
  }

  const smokeLocal = async (id: string): Promise<ConnectTestResult> => {
    const checked_at = clock.now()
    const probeImpl = options.mailProbe
    if (probeImpl === undefined) {
      return {
        ok: false,
        reason: 'test_unavailable',
        detail: '这个服务进程没有装配邮箱试连探针',
        checked_at,
      }
    }
    let account: MailAccount | undefined
    let password: string | undefined
    let smtpPassword: string | undefined
    try {
      const fields = secrets.get(id)
      if (fields === undefined) {
        return { ok: false, reason: 'not_found', detail: '这条连接的凭据不见了', checked_at }
      }
      account = accountOf(id)
      password = fields.password
      // 发信密码留空 = 复用收信那一份（多数邮箱本来就是同一个授权码）
      smtpPassword = fields.smtp_password === '' ? undefined : fields.smtp_password
    } catch (e) {
      const detail = e instanceof SecretStoreError ? e.message : messageOf(e)
      return { ok: false, reason: errorCodeOf(e), detail, checked_at }
    }
    if (account === undefined || password === undefined || password === '') {
      return { ok: false, reason: 'bad_credentials', detail: '这条连接没有存密码', checked_at }
    }
    try {
      // 口令只在这一句里出现；探针不许留存、不许回显
      const outcome = await probeImpl.check(account, password, smtpPassword ?? password)
      return {
        ok: outcome.ok,
        ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
        detail:
          outcome.detail ??
          (outcome.ok ? '收信登录与发信握手都通过' : humanize(outcome.reason ?? '', '连不上')),
        checked_at,
      }
    } catch (e) {
      const code = errorCodeOf(e)
      return { ok: false, reason: code, detail: humanize(code, messageOf(e)), checked_at }
    }
  }

  const rememberTest = (id: string, result: ConnectTestResult): ConnectTestResult => {
    state.tests[id] = result
    flush()
    const view = cached.find((c) => c.id === id)
    if (view !== undefined) {
      view.last_test = result
      view.last_tested_at = result.checked_at
    }
    options.appendEvent?.({
      schema_version: 1,
      workspace_id,
      type: 'connect.connection_tested',
      actor: { kind: 'system', id: 'connections' },
      correlation: { trace_id: '' },
      // 只有 ok 与原因码——没有任何凭据线索
      payload: { connection_id: id, ok: result.ok, reason: result.reason ?? null },
    })
    return result
  }

  const testById = async (id: string): Promise<ConnectTestResult> => {
    if (state.local.some((m) => m.id === id)) return rememberTest(id, await smokeLocal(id))
    const view = (await listAll()).find((c) => c.id === id)
    if (view === undefined) {
      return {
        ok: false,
        reason: 'not_found',
        detail: '找不到这条连接',
        checked_at: clock.now(),
      }
    }
    return rememberTest(id, await smokeRemote(view))
  }

  /**
   * WP25 交付 A：客户端凭据 → 令牌 → OpenConnector。
   *
   * 凭据在这个函数里只经过一次：`input.fields` 交给经纪人，经纪人换到令牌立刻
   * PUT 给 OpenConnector，然后把 ID / 密钥写进本机加密库。返回值里只有连接视图与
   * 试连结果——没有 ID、没有密钥、没有令牌。
   */
  const submitShopifyApp = async (
    entry: CatalogEntry,
    option: CatalogAuthOption,
    input: SubmitConnectionInput,
  ): Promise<{ connection: ConnectionView; test: ConnectTestResult }> => {
    const usable = await connectUsable()
    if (!usable.ok) throw unavailable(usable.reason ?? 'OpenConnector 不可用')
    let record: ShopifyBrokerRecord
    try {
      record = await shopify.connect({
        shop: input.fields.shop_domain ?? '',
        alias: input.alias,
        client_id: input.fields.client_id ?? '',
        client_secret: input.fields.client_secret ?? '',
      })
    } catch (e) {
      if (e instanceof ShopifyBrokerError) {
        // 中文人话进 message；上游原文（已经过 scrub）只进 details.detail
        throw new ConnectionsError('invalid_input', e.message, {
          reason: e.code,
          ...(e.detail === undefined ? {} : { detail: e.detail }),
        })
      }
      throw e
    }
    options.appendEvent?.({
      schema_version: 1,
      workspace_id,
      type: 'connect.form_submitted',
      actor: { kind: 'system', id: 'connections' },
      correlation: { trace_id: '' },
      // 只有字段名与接法，没有字段值
      payload: {
        service: entry.service,
        alias: input.alias,
        connection_id: record.connection_id,
        field_names: Object.keys(input.fields),
        auth_option: option.id,
        store: 'local_vault+openconnector',
      },
    })
    const rows = await listAll()
    const view = rows.find((r) => r.id === record.connection_id)
    if (view === undefined) {
      throw new ConnectionsError(
        'provider_error',
        '令牌换到了，但连接器里没出现这条连接；再点一次试试',
      )
    }
    const test = rememberTest(view.id, await smokeRemote(view))
    return { connection: { ...view, last_test: test, last_tested_at: test.checked_at }, test }
  }

  // ── 端口
  const port: ConnectionsPort = {
    async providers(): Promise<ProviderView[]> {
      const usable = await connectUsable()
      return CATALOG.map((entry) => {
        const local = entry.store === 'local_vault'
        const available = local ? secrets.available : usable.ok
        const unavailable_reason = available
          ? undefined
          : local
            ? `这台机器没有秘密库密钥（${SECRETS_KEY_ENV}），邮箱账号密码无处安全存放`
            : usable.reason
        return {
          service: entry.service,
          label: entry.label,
          auth: entry.auth,
          // 目录这层只讲「要准备什么」；真 runtime 上的字段清单在 begin() 里以它为准
          fields: entry.auth === 'oauth2' ? [] : entry.fields,
          available,
          ...(unavailable_reason === undefined ? {} : { unavailable_reason }),
          data_sources: [...entry.data_sources],
          setup_guide: entry.setup_guide,
          ...(entry.data_note === undefined ? {} : { data_note: entry.data_note }),
          // WP25：Shopify 有两种接法，让用户先选一次（`flow` 是装配细节，不出网关）
          ...(entry.auth_options === undefined
            ? {}
            : {
                auth_options: entry.auth_options.map(({ flow: _flow, ...option }) => ({
                  ...option,
                  fields: option.fields.map((f) => ({ ...f })),
                  setup_guide: {
                    ...option.setup_guide,
                    steps: [...option.setup_guide.steps],
                    links: option.setup_guide.links.map((l) => ({ ...l })),
                  },
                })),
              }),
        }
      })
    },

    list: () => listAll(),

    async begin(_actor: ConnectionsActor, service, input): Promise<BeginConnectResult> {
      const entry = catalogEntry(service)
      if (entry === undefined) throw notFound(`没有这个服务：${service}`)
      const option = authOptionOf(entry, input.auth_option)
      if (entry.store === 'local_vault') {
        if (!secrets.available) {
          throw invalid(
            `这台机器没有秘密库密钥（环境变量 ${SECRETS_KEY_ENV}），暂时不能保存邮箱账号密码`,
          )
        }
        // 本机档不需要跟任何人打招呼：直接把表单描述给出去
        return { request_id: `creq_local_${nextLocalId()}`, secure_form: { fields: entry.fields } }
      }
      // 客户端凭据那条路根本不去问上游要表单：字段是我们自己的（ID / 密钥 / 域名），
      // 换到令牌之后才有 OpenConnector 的事。
      if (option !== undefined && option.flow === 'shopify_client_credentials') {
        if (!secrets.available) {
          throw invalid(
            `这台机器没有秘密库密钥（环境变量 ${SECRETS_KEY_ENV}），客户端密钥无处安全存放。` +
              '可以先用"自定义应用访问令牌"那一种接法。',
          )
        }
        const usableNow = await connectUsable()
        if (!usableNow.ok) throw unavailable(usableNow.reason ?? 'OpenConnector 不可用')
        return {
          request_id: `creq_shopify_${nextLocalId()}`,
          secure_form: { fields: option.fields, auth_option: option.id },
        }
      }
      const usable = await connectUsable()
      if (!usable.ok) throw unavailable(usable.reason ?? 'OpenConnector 不可用')
      const started = await connect.beginConnect(entry.upstream, {
        workspace_id,
        ownership: input.ownership,
        alias: input.alias,
        mode: input.mode,
      })
      return {
        request_id: started.request_id,
        ...(started.authorization_url === undefined
          ? {}
          : { authorization_url: started.authorization_url }),
        ...(started.secure_form === undefined
          ? {}
          : {
              secure_form: {
                fields: fieldSpecs(option?.fields ?? entry.fields, started.secure_form.fields),
                ...(option === undefined ? {} : { auth_option: option.id }),
              },
            }),
      }
    },

    async pollRequest(_actor, request_id) {
      if (request_id.startsWith('creq_local_') || request_id.startsWith('creq_shopify_')) {
        return { status: 'initiated' as const }
      }
      const status = await connect.pollConnect(request_id)
      if (status !== 'connected') return { status }
      const rows = await listAll()
      // 刚连上的那条：OpenConnector 侧最新出现的一条（listAll 已经刷新过）
      const hit = rows.filter((r) => r.credential_store === 'openconnector').at(-1)
      return { status, ...(hit === undefined ? {} : { connection: hit }) }
    },

    /**
     * **唯一接触凭据原文的方法。**
     *
     * `input.fields` 进来之后只做两件事之一：转给 OpenConnector 的凭据库，
     * 或者写进本机 AES-256-GCM 秘密库。两条路都不把值抄进日志、事件、缓存或返回值；
     * 出错时 `details` 里也只有字段名。
     */
    async submit(_actor, service, input: SubmitConnectionInput) {
      const entry = catalogEntry(service)
      if (entry === undefined) throw notFound(`没有这个服务：${service}`)
      if (entry.auth === 'oauth2') throw invalid(`${entry.label} 走授权页，不接受表单直填`)
      const option = authOptionOf(entry, input.auth_option)
      const required = option?.fields ?? entry.fields
      const missing = required
        .filter((f) => f.required && (input.fields[f.name] ?? '').trim() === '')
        .map((f) => f.name)
      if (missing.length > 0) {
        throw invalid(`还有必填项没填：${missing.join('、')}`, { missing_fields: missing })
      }

      if (option !== undefined && option.flow === 'shopify_client_credentials') {
        return submitShopifyApp(entry, option, input)
      }

      if (entry.store === 'local_vault') {
        if (!secrets.available) {
          throw invalid(
            `这台机器没有秘密库密钥（环境变量 ${SECRETS_KEY_ENV}），暂时不能保存邮箱账号密码。` +
              '桌面壳会在首次启动时生成它；直接跑服务进程时请自己生成一把 32 字节密钥再启动。',
          )
        }
        const address = (input.fields.email ?? '').trim()
        const existing = state.local.find((m) => m.display_name === address)
        const id = existing?.id ?? nextLocalId()
        // 值在这里第一次也是最后一次被读；写进去之后本模块不再持有
        secrets.put(id, { ...input.fields })
        const meta: LocalConnectionMeta = existing ?? {
          id,
          alias: input.alias,
          ownership: input.ownership,
          display_name: address,
          created_at: clock.now(),
        }
        meta.alias = input.alias
        meta.ownership = input.ownership
        meta.display_name = address
        if (existing === undefined) state.local.push(meta)
        flush()
        options.appendEvent?.({
          schema_version: 1,
          workspace_id,
          type: 'connect.form_submitted',
          actor: { kind: 'system', id: 'connections' },
          correlation: { trace_id: '' },
          // 只有字段名，没有字段值
          payload: {
            service,
            alias: input.alias,
            connection_id: id,
            field_names: Object.keys(input.fields),
            store: 'local_vault',
          },
        })
        await listAll()
        // 热更新：下一轮轮询就该开始收这个邮箱，不必等重启
        notifyMailChange()
        // 存完立刻试一次连：用户点一次按钮就该知道成没成
        const test = rememberTest(id, await smokeLocal(id))
        const view = localView(meta)
        return { connection: { ...view, last_test: test, last_tested_at: test.checked_at }, test }
      }

      const usable = await connectUsable()
      if (!usable.ok) throw unavailable(usable.reason ?? 'OpenConnector 不可用')
      const conn = await connect.submitForm(entry.upstream, {
        workspace_id,
        ownership: input.ownership,
        alias: input.alias,
        auth_type: entry.auth,
        fields: input.fields,
        ...(input.request_id === undefined ? {} : { request_id: input.request_id }),
      })
      await listAll()
      const view = remoteView(conn)
      const test = rememberTest(view.id, await smokeRemote(view))
      return { connection: { ...view, last_test: test, last_tested_at: test.checked_at }, test }
    },

    async remove(_actor, id) {
      const localIndex = state.local.findIndex((m) => m.id === id)
      if (localIndex >= 0) {
        state.local.splice(localIndex, 1)
        delete state.tests[id]
        secrets.remove(id)
        flush()
        options.appendEvent?.({
          schema_version: 1,
          workspace_id,
          type: 'connect.connection_removed',
          actor: { kind: 'system', id: 'connections' },
          correlation: { trace_id: '' },
          payload: { connection_id: id, store: 'local_vault' },
        })
        await listAll()
        // 热更新：断开的邮箱要立刻停掉轮询，别再拿一份已经删掉的口令去登录
        notifyMailChange()
        return
      }
      await connect.removeConnection(id)
      // 客户端凭据接管的店：应用 ID / 密钥也一起从本机秘密库删掉，不留残渣
      shopify.forget(id)
      delete state.tests[id]
      flush()
      await listAll()
    },

    test: (_actor, id) => testById(id),

    runtime: () => runtimeStatus(),

    /**
     * WP25 交付 B：按域名的 MX 记录认出是哪家邮箱。
     *
     * **永不抛**（`detectMailbox` 自己吞掉 DNS 的所有异常），认不出就 `preset: null`。
     * 这条路什么都不落盘、不进事件——只是一次 DNS 查询。
     */
    async detectMailbox(_actor, email): Promise<MailboxDetectResult> {
      const found = await detectMailbox(
        email,
        ...(options.resolveMx === undefined ? [] : [options.resolveMx]),
      )
      return {
        domain: found.domain,
        mx_hosts: [...found.mx_hosts],
        preset: found.preset === undefined ? null : presetView(found.preset),
      }
    },
  }

  const credentialSource = {
    /**
     * 按连接 id 取口令。`purpose: 'smtp'` 且用户填过发信专用密码就用那一份，
     * 否则回退到收信那一份——「发信密码留空 = 复用」这条规则落在这里，
     * channels 那边不需要知道。
     */
    password(ref: { connection_id: string; purpose?: 'imap' | 'smtp' }): string {
      const fields = secrets.get(ref.connection_id)
      const smtp = fields?.smtp_password
      if (ref.purpose === 'smtp' && smtp !== undefined && smtp !== '') return smtp
      const password = fields?.password
      if (password === undefined || password === '') {
        throw new SecretStoreError('not_found', `秘密库里没有这条连接的口令：${ref.connection_id}`)
      }
      return password
    },
  }

  // WP34 热更新：邮箱连接有变动就叫一声（不带凭据，只是「有变动」这个信号）
  const mailListeners = new Set<() => void>()
  const notifyMailChange = (): void => {
    for (const fn of [...mailListeners]) {
      try {
        fn()
      } catch {
        // 一个订阅者炸了不该拖垮连接面：连接已经存好了，热更新失败下一轮轮询会自愈
      }
    }
  }

  // 到期前 1 小时换新令牌。定时器只在服务进程装配时起（`refreshIntervalMs`），
  // 而且 `unref()`——它不该拦着进程退出。
  const refreshTokens = async (): Promise<void> => {
    await shopify.refreshDue()
  }
  let timer: ReturnType<typeof setInterval> | undefined
  const interval = options.refreshIntervalMs ?? 0
  if (interval > 0) {
    timer = setInterval(() => {
      void refreshTokens()
    }, interval)
    timer.unref?.()
  }

  return {
    port,
    shopify,
    refreshTokens,
    snapshot: () =>
      cached.map((c) => ({ service: c.service, status: c.status }) satisfies ConnectionLike),
    mailAccounts: () =>
      state.local.map((m) => accountOf(m.id)).filter((a): a is MailAccount => a !== undefined),
    credentialSource: () => credentialSource,
    onMailChange(listener) {
      mailListeners.add(listener)
      return () => mailListeners.delete(listener)
    },
    wrapDataSource(base) {
      return {
        ...base,
        sources: (): DataSourceStatus[] =>
          mergeDataSources(
            base.sources(),
            cached.map((c) => ({ service: c.service, status: c.status })),
          ),
      }
    },
    close: () => {
      if (timer !== undefined) clearInterval(timer)
      // 秘密库是别人传进来的就别关：服务进程还要拿它读模型 key
      if (ownsSecrets) secrets.close()
    },
  }
}

// ── 错误（网关会把 code 翻成 HTTP 状态）────────────────────────────────

class ConnectionsError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'ConnectionsError'
  }
}

const notFound = (m: string): ConnectionsError => new ConnectionsError('not_found', m)
const invalid = (m: string, d?: unknown): ConnectionsError =>
  new ConnectionsError('invalid_input', m, d)
const unavailable = (m: string): ConnectionsError => new ConnectionsError('provider_unavailable', m)

// ── 邮箱试连的默认实现 ─────────────────────────────────────────────────

/**
 * 真的去连一次：IMAP 登录 + 打开收件箱，SMTP 建连 + 鉴权握手（nodemailer 的 `verify()`）。
 *
 * 口令由参数进来、只交给 channels 的 `CredentialSource`，两个客户端用完即关；
 * 这个函数不返回、不记录、不缓存口令。
 *
 * WP25：失败原文交给 `@agentsws/channels` 的 {@link classifyMailFailure} 翻成中文——
 * 主文案是人话（"要用授权码，不是登录密码"），上游原文只进 `detail`。
 */
export function createMailProbe(): MailProbe {
  return {
    async check(account, password, smtpPassword) {
      const source = new ImapMailSource({
        config: { ...account.imap },
        credentials: { password: () => password },
      })
      const imap = await source.health()
      if (!imap.ok) {
        const failure = classifyMailFailure(
          imap.detail ?? 'IMAP 登录失败',
          'imap',
          account.imap.host,
        )
        return {
          ok: false,
          reason: failure.reason,
          detail: `${failure.message}（${failure.detail}）`,
        }
      }
      const mailer = new SmtpMailer({
        config: { ...account.smtp },
        credentials: { password: () => smtpPassword },
      })
      const smtp = await mailer.health()
      await mailer.close()
      if (!smtp.ok) {
        const failure = classifyMailFailure(
          smtp.detail ?? 'SMTP 握手失败',
          'smtp',
          account.smtp.host,
        )
        return {
          ok: false,
          reason: failure.reason,
          detail: `${failure.message}（${failure.detail}）`,
        }
      }
      return { ok: true, reason: 'ok', detail: '收信登录与发信握手都通过' }
    },
  }
}
