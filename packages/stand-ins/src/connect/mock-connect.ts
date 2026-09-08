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
import type { Random } from '@agentsws/kernel'
import { StandInError } from '../errors.js'
import type { OutboundObservation } from '../observations.js'
import { ObservationLog, summarizeInput } from '../observations.js'
import type { ActionDef } from './actions.js'
import { actionCatalog, asInputObject, PROVIDERS } from './actions.js'
import type { MockState } from './state.js'
import { defaultState } from './state.js'

/** 26 §3 故障注入：对某个 Action 连续失败 `times` 次。 */
export interface FaultInjection {
  action: string
  code: 429 | 500 | 'timeout'
  times: number
}

interface TokenRecord {
  token: string
  kind: ConnectToken['kind']
  assignment_id: AssignmentId
  allowed_actions: string[]
  allowed_connections: string[]
  /** 18 §1：role-read 恒为空——禁 proxy。 */
  allowed_proxies: string[]
  issued_at: Iso8601
  expires_at: Iso8601
  revoked: boolean
}

interface IdempotencyRecord {
  key: string
  action_id: string
  at: Iso8601
  state: 'in_progress' | 'done'
  result?: ExecuteResult
}

interface ConnectRequest {
  request_id: string
  service: string
  workspace_id: WorkspaceId
  ownership: Connection['ownership']
  alias: string
  polls: number
}

export interface MockConnectOptions {
  clock: Clock
  random: Random
  workspace_id?: WorkspaceId
  /** 内存状态；不给则按 `clock.now()` 生成默认数据集。 */
  state?: MockState
  observations?: ObservationLog
  /** 18 §1 幂等窗口，默认 24h。 */
  idempotencyWindowMs?: number
  /** token 默认有效期，默认 1h。 */
  tokenTtlSeconds?: number
}

const DEFAULT_IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * 26 §3 合成 provider：Shopify / Gmail / Meta / Klaviyo / WhatsApp 的假 executor。
 * 与真实 connect-adapter 遵守同一份 18 §1 `Connect` 契约：
 * 写 Action 真的改内存状态、token 按 allowed_actions / allowed_connections 校验、
 * `role-read` 不得调 write Action 也不得 proxy、幂等键 24h 重放、可注入故障、每次调用都被观察。
 */
export class MockOpenConnector implements Connect {
  readonly observations: ObservationLog
  readonly state: MockState
  private readonly clock: Clock
  private readonly random: Random
  private readonly defs: ActionDef[]
  private readonly conns = new Map<string, Connection>()
  private readonly tokens = new Map<string, TokenRecord>()
  private readonly idem = new Map<string, IdempotencyRecord>()
  private readonly requests = new Map<string, ConnectRequest>()
  private readonly faults: FaultInjection[] = []
  private readonly idempotencyWindowMs: number
  private readonly tokenTtlSeconds: number
  private seq = 0

  constructor(opts: MockConnectOptions) {
    this.clock = opts.clock
    this.random = opts.random
    this.observations = opts.observations ?? new ObservationLog()
    this.state = opts.state ?? defaultState(opts.clock.now())
    this.defs = actionCatalog()
    this.idempotencyWindowMs = opts.idempotencyWindowMs ?? DEFAULT_IDEMPOTENCY_WINDOW_MS
    this.tokenTtlSeconds = opts.tokenTtlSeconds ?? 3600
    const workspace = opts.workspace_id ?? 'ws_stand_in'
    for (const p of PROVIDERS) {
      const id = `conn_${p.service}`
      this.conns.set(id, {
        id,
        service: p.service,
        alias: `${p.service} (stand-in)`,
        ownership: 'workspace',
        workspace_id: workspace,
        identity: { account_id: `acct_${p.service}`, display_name: `${p.service} sandbox` },
        status: 'active',
      })
    }
  }

  // ---------- 发现 ----------

  async providers(): Promise<ProviderMeta[]> {
    return PROVIDERS.map((p) => ({ ...p }))
  }

  async actions(service: string): Promise<ActionMeta[]> {
    return this.defs
      .filter((d) => d.service === service)
      .map((d) => ({
        id: d.id,
        service: d.service,
        input_schema: d.input_schema,
        side_effect: d.side_effect,
        ...(d.required_scopes === undefined ? {} : { required_scopes: [...d.required_scopes] }),
      }))
  }

  /** 全部 Action 的元数据（16 §3 副作用表的来源）。 */
  allActions(): ActionMeta[] {
    return this.defs.map((d) => ({
      id: d.id,
      service: d.service,
      input_schema: d.input_schema,
      side_effect: d.side_effect,
      ...(d.required_scopes === undefined ? {} : { required_scopes: [...d.required_scopes] }),
    }))
  }

  /** 裸名（`get_order`）与全名（`shopify_admin.get_order`）都能解析；重名报冲突。 */
  resolveActionId(name: string): string {
    const exact = this.defs.find((d) => d.id === name)
    if (exact) return exact.id
    const bare = this.defs.filter((d) => d.id.endsWith(`.${name}`))
    if (bare.length === 1 && bare[0]) return bare[0].id
    if (bare.length > 1) {
      throw new StandInError('conflict', `Action 名歧义：${name}`, {
        candidates: bare.map((d) => d.id),
      })
    }
    throw new StandInError('not_found', `未知 Action：${name}`, { action: name })
  }

  // ---------- 连接 ----------

  async connections(workspace_id: WorkspaceId): Promise<Connection[]> {
    return [...this.conns.values()]
      .filter((c) => c.workspace_id === workspace_id)
      .map((c) => ({ ...c }))
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
    const provider = PROVIDERS.find((p) => p.service === service)
    if (!provider) throw new StandInError('not_found', `未知 provider：${service}`, { service })
    const request_id = this.nextId('creq')
    this.requests.set(request_id, {
      request_id,
      service,
      workspace_id: opts.workspace_id,
      ownership: opts.ownership,
      alias: opts.alias,
      polls: 0,
    })
    if (provider.auth === 'api_key' || provider.auth === 'custom_credential') {
      return {
        request_id,
        secure_form: {
          fields: [
            { name: 'api_key', secret: true },
            { name: 'account', secret: false },
          ],
        },
      }
    }
    return {
      request_id,
      authorization_url: `https://stand-in.local/oauth/${service}?request_id=${request_id}&mode=${opts.mode}`,
    }
  }

  /** 第一次 poll 是 `initiated`，第二次起 `connected` 并建连接；未知 request 视为 `expired`。 */
  async pollConnect(request_id: string): Promise<'initiated' | 'connected' | 'failed' | 'expired'> {
    const req = this.requests.get(request_id)
    if (!req) return 'expired'
    req.polls += 1
    if (req.polls === 1) return 'initiated'
    const id = `conn_${req.service}_${req.request_id}`
    if (!this.conns.has(id)) {
      this.conns.set(id, {
        id,
        service: req.service,
        alias: req.alias,
        ownership: req.ownership,
        workspace_id: req.workspace_id,
        identity: { account_id: `acct_${req.service}`, display_name: req.alias },
        status: 'active',
      })
    }
    return 'connected'
  }

  async transferConnection(id: string, to_workspace: WorkspaceId): Promise<Connection> {
    const conn = this.conns.get(id)
    if (!conn) throw new StandInError('not_found', `连接不存在：${id}`, { connection: id })
    if (conn.ownership !== 'workspace') {
      throw new StandInError('forbidden', '只有 ownership=workspace 的连接可转移', {
        connection: id,
      })
    }
    conn.workspace_id = to_workspace
    return { ...conn }
  }

  /** 直接放一个连接进来（场景装配用）。 */
  putConnection(conn: Connection): void {
    this.conns.set(conn.id, { ...conn })
  }

  // ---------- token ----------

  /**
   * 18 §1（09-08 改）：`allowed_connections` 为空即拒签——上游把空列表当"不限制"。
   * `allowed_actions` 同理。`role-read` 的 `allowed_proxies` 恒为空（禁 proxy）。
   */
  async issueToken(input: {
    assignment_id: AssignmentId
    kind: ConnectToken['kind']
    allowed_actions: string[]
    allowed_connections: string[]
    expires_in_seconds?: number
  }): Promise<ConnectToken> {
    if (input.allowed_connections.length === 0) {
      throw new StandInError('invalid_input', '空 allowed_connections 拒签（空列表 = 不限制）', {
        assignment_id: input.assignment_id,
      })
    }
    if (input.allowed_actions.length === 0) {
      throw new StandInError('invalid_input', '空 allowed_actions 拒签（空列表 = 不限制）', {
        assignment_id: input.assignment_id,
      })
    }
    for (const c of input.allowed_connections) {
      if (!this.conns.has(c)) {
        throw new StandInError('invalid_input', `allowed_connections 含未知连接：${c}`, {
          connection: c,
        })
      }
    }
    const ttl = input.expires_in_seconds ?? this.tokenTtlSeconds
    const issued_at = this.clock.now()
    const expires_at = new Date(Date.parse(issued_at) + ttl * 1000).toISOString()
    const token = this.nextId('tok')
    this.tokens.set(token, {
      token,
      kind: input.kind,
      assignment_id: input.assignment_id,
      allowed_actions: [...input.allowed_actions],
      allowed_connections: [...input.allowed_connections],
      allowed_proxies: [],
      issued_at,
      expires_at,
      revoked: false,
    })
    return {
      token,
      kind: input.kind,
      assignment_id: input.assignment_id,
      expires_at,
      allowed_actions: [...input.allowed_actions],
      allowed_connections: [...input.allowed_connections],
      allowed_proxies: [],
    }
  }

  async revokeTokens(assignment_id: AssignmentId): Promise<void> {
    for (const t of this.tokens.values()) {
      if (t.assignment_id === assignment_id) t.revoked = true
    }
  }

  /**
   * 18 §1「role-read 的 allowedProxies 为空、禁 proxy」。契约 `Connect` 没有 proxy 方法；
   * 替身保留它只为把这条规则钉住：任何 token 走原始代理一律拒。
   */
  async proxy(service: string, _req: unknown, opts: { token: string }): Promise<never> {
    const t = this.tokens.get(opts.token)
    throw new StandInError(
      'forbidden',
      t?.kind === 'role-read'
        ? 'role-read token 禁 proxy（allowed_proxies 为空）'
        : '合成 provider 不提供原始代理，只允许目录内 Action',
      { service },
    )
  }

  // ---------- 故障注入 ----------

  inject(spec: FaultInjection): void {
    if (spec.times <= 0) throw new StandInError('invalid_input', 'times 必须为正')
    this.faults.push({ ...spec, action: this.resolveActionId(spec.action) })
  }

  /**
   * 15 §5.8 对账：把一把停在"进行中"（超时后结果未知）的幂等键释放掉。
   * 返回是否真的有这么一条。
   */
  settleIdempotency(key: string): boolean {
    return this.idem.delete(key)
  }

  pendingFaults(): FaultInjection[] {
    return this.faults.filter((f) => f.times > 0).map((f) => ({ ...f }))
  }

  clearFaults(): void {
    this.faults.length = 0
  }

  private takeFault(action_id: string): FaultInjection | undefined {
    const f = this.faults.find((x) => x.action === action_id && x.times > 0)
    if (!f) return undefined
    f.times -= 1
    return { ...f, times: f.times }
  }

  // ---------- 执行 ----------

  async execute<T = unknown>(
    action_id: string,
    input: unknown,
    opts: ExecuteOptions,
  ): Promise<ExecuteResult<T>> {
    const at = this.clock.now()
    const def = this.lookup(action_id)
    const base = {
      at,
      service: def?.service ?? 'unknown',
      action_id: def?.id ?? action_id,
      side_effect: def?.side_effect ?? ('write' as const),
      category: (def?.side_effect === 'read' ? 'read_external' : 'write_external') as
        | 'read_external'
        | 'write_external',
      input_summary: summarizeInput(input),
      ...(opts.idempotencyKey === undefined ? {} : { idempotency_key: opts.idempotencyKey }),
    }

    const token = this.tokens.get(opts.token)
    if (!token || token.revoked) {
      throw this.blocked(base, new StandInError('forbidden', 'connect token 无效或已吊销'))
    }
    if (Date.parse(at) >= Date.parse(token.expires_at)) {
      throw this.blocked(
        { ...base, token_kind: token.kind, assignment_id: token.assignment_id },
        new StandInError('forbidden', 'connect token 已过期'),
      )
    }
    const withToken = { ...base, token_kind: token.kind, assignment_id: token.assignment_id }

    if (!def) {
      throw this.blocked(withToken, new StandInError('not_found', `未知 Action：${action_id}`))
    }
    if (!token.allowed_actions.includes(def.id) && !token.allowed_actions.includes(bare(def.id))) {
      throw this.blocked(
        withToken,
        new StandInError('forbidden', `token 不允许该 Action：${def.id}`, {
          allowed_actions: token.allowed_actions,
        }),
      )
    }
    if (token.kind === 'role-read' && def.side_effect === 'write') {
      throw this.blocked(
        withToken,
        new StandInError('forbidden', `role-read token 不能调用写 Action：${def.id}`),
      )
    }

    const connId = opts.connection ?? `conn_${def.service}`
    const conn = this.conns.get(connId)
    if (!conn) {
      throw this.blocked(withToken, new StandInError('not_found', `连接不存在：${connId}`))
    }
    if (conn.service !== def.service) {
      throw this.blocked(
        { ...withToken, connection_id: connId },
        new StandInError('connection_not_allowed', `连接 ${connId} 不属于 ${def.service}`),
      )
    }
    if (!token.allowed_connections.includes(connId)) {
      throw this.blocked(
        { ...withToken, connection_id: connId },
        new StandInError('connection_not_allowed', `token 不允许该连接：${connId}`, {
          allowed_connections: token.allowed_connections,
        }),
      )
    }
    if (conn.status !== 'active') {
      throw this.blocked(
        { ...withToken, connection_id: connId },
        new StandInError('forbidden', `连接不可用：${connId}（${conn.status}）`),
      )
    }
    const ctx = { ...withToken, connection_id: connId }

    // 幂等：同键 24h 内重放原结果；进行中 = 409
    const key = opts.idempotencyKey
    if (key !== undefined) {
      const prior = this.idem.get(key)
      if (prior && Date.parse(at) - Date.parse(prior.at) >= this.idempotencyWindowMs) {
        this.idem.delete(key)
      } else if (prior) {
        if (prior.action_id !== def.id) {
          throw this.blocked(
            ctx,
            new StandInError('idempotency_conflict', `幂等键 ${key} 已用于 ${prior.action_id}`),
          )
        }
        if (prior.state === 'in_progress') {
          throw this.blocked(
            ctx,
            new StandInError('idempotency_conflict', `幂等键 ${key} 正在执行中`),
          )
        }
        const replay = prior.result as ExecuteResult<T>
        this.observations.record({
          ...ctx,
          status: 'ok',
          execution_id: replay.execution_id,
          replayed: true,
        })
        return { ...replay, meta: { ...(replay.meta ?? {}), idempotent_replay: true } }
      }
      this.idem.set(key, { key, action_id: def.id, at, state: 'in_progress' })
    }

    const fail = (err: StandInError, injected?: string): StandInError => {
      // 15 §5.8：超时 = 结果未知，那条键留在"进行中"，重试拿 409，直到对账（`settleIdempotency`）。
      // 其余失败没有副作用，键立即释放，重试可用同一把。
      if (key !== undefined && err.code !== 'timeout') this.idem.delete(key)
      this.observations.record({
        ...ctx,
        status: 'error',
        error_code: err.code,
        ...(injected === undefined ? {} : { injected }),
      })
      return err
    }

    const fault = this.takeFault(def.id)
    if (fault) {
      const err =
        fault.code === 429
          ? new StandInError('rate_limited', `注入限流：${def.id}`, { retry_after_ms: 1000 })
          : fault.code === 500
            ? new StandInError('provider_error', `注入上游错误：${def.id}`)
            : new StandInError('timeout', `注入超时：${def.id}`)
      throw fail(err, String(fault.code))
    }

    let data: unknown
    try {
      data = def.handler(asInputObject(input), {
        state: this.state,
        now: at,
        nextId: (prefix) => this.nextId(prefix),
      })
    } catch (e) {
      throw fail(e instanceof StandInError ? e : new StandInError('provider_error', String(e)))
    }

    const result: ExecuteResult<T> = {
      data: data as T,
      execution_id: this.nextId('exec'),
      meta: { action_id: def.id, connection_id: connId, at, side_effect: def.side_effect },
    }
    if (key !== undefined) {
      this.idem.set(key, { key, action_id: def.id, at, state: 'done', result })
    }
    this.observations.record({ ...ctx, status: 'ok', execution_id: result.execution_id })
    return result
  }

  // ---------- 内部 ----------

  private lookup(name: string): ActionDef | undefined {
    const exact = this.defs.find((d) => d.id === name)
    if (exact) return exact
    const bareMatches = this.defs.filter((d) => d.id.endsWith(`.${name}`))
    return bareMatches.length === 1 ? bareMatches[0] : undefined
  }

  private blocked(
    ctx: Omit<OutboundObservation, 'seq' | 'status'>,
    err: StandInError,
  ): StandInError {
    this.observations.record({ ...ctx, status: 'blocked', error_code: err.code })
    return err
  }

  /** 确定性 id：序号 + seed 决定的十六进制后缀。 */
  private nextId(prefix: string): string {
    this.seq += 1
    const r = Math.floor(this.random() * 0xffffff)
      .toString(16)
      .padStart(6, '0')
    return `${prefix}_${this.seq}_${r}`
  }
}

function bare(id: string): string {
  const i = id.indexOf('.')
  return i < 0 ? id : id.slice(i + 1)
}
