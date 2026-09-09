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
  ProviderFieldSpec,
  ProviderView,
  RuntimeStatusView,
  SubmitConnectionInput,
} from '@agentsws/api'
import { ImapMailSource, SmtpMailer } from '@agentsws/channels'
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
import { CATALOG, type CatalogEntry, catalogEntry, serviceOfUpstream } from './catalog.js'
import {
  createSecretStore,
  SECRETS_KEY_ENV,
  type SecretStore,
  SecretStoreError,
} from './secret-store.js'
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
    password: string,
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
}

export interface ConnectionsAssembly {
  port: ConnectionsPort
  /** 当前真实连接（只有 service 与状态）——给 deck 算 `DataSourceStatus`。 */
  snapshot(): ConnectionLike[]
  /** 邮箱连接的参数（channels 装配 IMAP / SMTP 用）；口令仍要经 `credentialSource()` 取。 */
  mailAccounts(): MailAccount[]
  /** 交给 `@agentsws/channels` 的凭据来源：按连接 id 从加密库取口令。 */
  credentialSource(): { password(ref: { connection_id: string }): string }
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
  entry: CatalogEntry | undefined,
  runtime?: { name: string; secret: boolean }[],
): ProviderFieldSpec[] {
  if (entry !== undefined && entry.fields.length > 0) return entry.fields
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
  let state: StateFile = { version: 1, local: [], tests: {} }
  if (stateFile !== undefined) {
    try {
      const parsed = JSON.parse(readFileSync(stateFile, 'utf8')) as StateFile
      state = { version: 1, local: parsed.local ?? [], tests: parsed.tests ?? {} }
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
    let token: ConnectToken | undefined
    try {
      token = await connect.issueToken({
        assignment_id: SMOKE_ASSIGNMENT,
        kind: 'role-read',
        allowed_actions: [action.id],
        allowed_connections: [view.id],
        expires_in_seconds: SMOKE_TOKEN_TTL_SECONDS,
      })
      await connect.execute(action.id, {}, { token: token.token, connection: view.id })
      return { ok: true, reason: 'ok', detail: `试跑 ${action.id} 成功`, checked_at }
    } catch (e) {
      const code = errorCodeOf(e)
      return { ok: false, reason: code, detail: humanize(code, messageOf(e)), checked_at }
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
    try {
      const fields = secrets.get(id)
      if (fields === undefined) {
        return { ok: false, reason: 'not_found', detail: '这条连接的凭据不见了', checked_at }
      }
      account = accountOf(id)
      password = fields.password
    } catch (e) {
      const detail = e instanceof SecretStoreError ? e.message : messageOf(e)
      return { ok: false, reason: errorCodeOf(e), detail, checked_at }
    }
    if (account === undefined || password === undefined || password === '') {
      return { ok: false, reason: 'bad_credentials', detail: '这条连接没有存密码', checked_at }
    }
    try {
      // 口令只在这一句里出现；探针不许留存、不许回显
      const outcome = await probeImpl.check(account, password)
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
        }
      })
    },

    list: () => listAll(),

    async begin(_actor: ConnectionsActor, service, input): Promise<BeginConnectResult> {
      const entry = catalogEntry(service)
      if (entry === undefined) throw notFound(`没有这个服务：${service}`)
      if (entry.store === 'local_vault') {
        if (!secrets.available) {
          throw invalid(
            `这台机器没有秘密库密钥（环境变量 ${SECRETS_KEY_ENV}），暂时不能保存邮箱账号密码`,
          )
        }
        // 本机档不需要跟任何人打招呼：直接把表单描述给出去
        return { request_id: `creq_local_${nextLocalId()}`, secure_form: { fields: entry.fields } }
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
          : { secure_form: { fields: fieldSpecs(entry, started.secure_form.fields) } }),
      }
    },

    async pollRequest(_actor, request_id) {
      if (request_id.startsWith('creq_local_')) {
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
      const missing = entry.fields
        .filter((f) => f.required && (input.fields[f.name] ?? '').trim() === '')
        .map((f) => f.name)
      if (missing.length > 0) {
        throw invalid(`还有必填项没填：${missing.join('、')}`, { missing_fields: missing })
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
        return
      }
      await connect.removeConnection(id)
      delete state.tests[id]
      flush()
      await listAll()
    },

    test: (_actor, id) => testById(id),

    runtime: () => runtimeStatus(),
  }

  const credentialSource = {
    password(ref: { connection_id: string }): string {
      const fields = secrets.get(ref.connection_id)
      const password = fields?.password
      if (password === undefined || password === '') {
        throw new SecretStoreError('not_found', `秘密库里没有这条连接的口令：${ref.connection_id}`)
      }
      return password
    },
  }

  return {
    port,
    snapshot: () =>
      cached.map((c) => ({ service: c.service, status: c.status }) satisfies ConnectionLike),
    mailAccounts: () =>
      state.local.map((m) => accountOf(m.id)).filter((a): a is MailAccount => a !== undefined),
    credentialSource: () => credentialSource,
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
      secrets.close()
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

/** 把上游报的那一句话归成一个原因码，界面才好出人话。 */
export function classifyMailFailure(detail: string, side: 'imap' | 'smtp'): string {
  const text = detail.toLowerCase()
  if (/auth|credential|password|login|535|eauth|invalid user/.test(text)) return 'bad_credentials'
  if (/enotfound|getaddrinfo|eai_again|dns/.test(text)) return 'host_not_found'
  if (/econnrefused|ehostunreach|enetunreach/.test(text)) return 'unreachable'
  if (/timeout|etimedout/.test(text)) return 'timeout'
  if (/cert|tls|ssl|self.signed/.test(text)) return 'tls_failed'
  return `${side}_failed`
}

/**
 * 真的去连一次：IMAP 登录 + 打开收件箱，SMTP 建连 + 鉴权握手（nodemailer 的 `verify()`）。
 *
 * 口令由参数进来、只交给 channels 的 `CredentialSource`，两个客户端用完即关；
 * 这个函数不返回、不记录、不缓存口令。
 */
export function createMailProbe(): MailProbe {
  return {
    async check(account, password) {
      const credentials = { password: () => password }
      const source = new ImapMailSource({ config: { ...account.imap }, credentials })
      const imap = await source.health()
      if (!imap.ok) {
        const detail = imap.detail ?? 'IMAP 登录失败'
        return { ok: false, reason: classifyMailFailure(detail, 'imap'), detail }
      }
      const mailer = new SmtpMailer({ config: { ...account.smtp }, credentials })
      const smtp = await mailer.health()
      await mailer.close()
      if (!smtp.ok) {
        const detail = smtp.detail ?? 'SMTP 握手失败'
        return { ok: false, reason: classifyMailFailure(detail, 'smtp'), detail }
      }
      return { ok: true, reason: 'ok', detail: '收信登录与发信握手都通过' }
    },
  }
}
