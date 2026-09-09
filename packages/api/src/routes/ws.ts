/**
 * 28 §2 的 WebSocket 事件流：`GET /v1/ws`。
 *
 * 三条纪律：
 * - **只推摘要**：`{ type, name, id, at, subject?, run_id? }`。正文一律不推——正文有敏感度分级，
 *   一条推送不该绕开 19 §3 的过滤下推；客户端拿到摘要后按本人身份去 `/v1` 取该取的东西。
 *   （工作台的用法就是「收到摘要 → 让对应的 TanStack Query 失效 → 重新取」。）
 * - **同一份可见性**：与 `GET /v1/events` 共用 `AssignmentVisibility`——WS 看得见的，
 *   长轮询也看得见，反之亦然。没有第二套权限规则。
 * - **急停 all 时只推 `halt.changed`**：这时整个系统在停机，唯一还该流动的信息是
 *   「停了 / 解停了」本身（28 §4 用例 3 的同一条精神）。
 *
 * 命名与结构对齐 AG-UI 类协议（29 §6）：每帧带一个 `type ∈ TEXT | TOOL_CALL | STATE | CUSTOM`
 * 的分类，外加一类 `CONTROL`（连接自身的握手 / 背压 / 错误，不是业务事件）。
 * 分类是**投影**不是替换：`name` 永远是事件日志里的原始类型名，第三方前端要更细的语义时按它分。
 *
 * ## 传输为什么不用 `hono/ws`
 *
 * `hono/ws` 的 `upgradeWebSocket` 要求把升级握手塞进 Hono 的中间件链里，而本网关的中间件链
 * （急停 → 鉴权限流 → 出站急停 → 绑 Assignment → 幂等）全部以 `Response` 为结果，
 * 拿不到底层 socket；而且 Node 档下它本来就是 `@hono/node-ws` → `ws` 的一层包装。
 * 所以：**协议逻辑放在本文件（与传输无关，可单测）**，真正的握手由 `apps/server` 在
 * `@hono/node-server` 返回的 `http.Server` 的 `upgrade` 事件上用 `ws` 完成（几行）。
 * 换一个宿主（Bun / Deno / Cloudflare）时只换那几行，本文件不动。
 *
 * ## 凭据为什么不进 URL
 *
 * 20 §3 / 21 §5：token 不进 URL（URL 会进浏览器历史、进反向代理日志、进 Referer）。
 * 浏览器同源连接靠 HttpOnly 会话 cookie，握手请求自带；SDK / CLI 用
 * `Sec-WebSocket-Protocol: agentsws.v1, agentsws.bearer.<token>` 带 bearer——
 * 子协议头是握手请求头的一部分，与 `Authorization` 同等待遇，且是浏览器 `WebSocket`
 * 构造函数唯一能自定义的那个头。`assignment` 不是凭据（只是个 id），走 `subscribe` 帧。
 */
import type { EventEnvelope } from '@agentsws/contracts'
import { ApiError } from '../errors.js'
import { ok } from '../helpers.js'
import { type Route, route } from '../route-spec.js'
import type { GatewayDeps, Principal } from '../types.js'
import { AssignmentVisibility, canReadAll } from './events.js'

/** 29 §6：AG-UI 类协议的四类 + 一类连接自身的控制帧。 */
export type WsFrameType = 'TEXT' | 'TOOL_CALL' | 'STATE' | 'CUSTOM' | 'CONTROL'

/** 一帧业务事件的**摘要**（不含正文）。 */
export interface WsEventFrame {
  type: Exclude<WsFrameType, 'CONTROL'>
  /** 事件日志里的 id（ulid）；断线重连拿最后一条当 `since`。 */
  id: string
  /** 事件日志里的原始类型名（17 §2 / 14 §10 / 15 §7 / 25 §5 …）。 */
  name: string
  at: string
  /** 这条事件是关于哪个对象的（只有 ref，没有正文）。 */
  subject?: { type: string; id: string }
  run_id?: string
  trace_id?: string
}

export interface WsControlFrame {
  type: 'CONTROL'
  name: 'ready' | 'error' | 'halted' | 'dropped' | 'pong' | 'closing'
  at: string
  /** 只放不敏感的元数据（订阅范围、丢了几条、错误码）。 */
  detail?: Record<string, unknown>
}

export type WsFrame = WsEventFrame | WsControlFrame

/** 客户端 → 服务端。只有两种。 */
export interface WsSubscribeMessage {
  op: 'subscribe'
  /** 31 §3.1 一次连接一个 Assignment（与 REST 的 `X-Assignment` 同义）。 */
  assignment_id: string
  /** 断线重连补拉：上次收到的最后一条事件 id。 */
  since?: string
  /** 只要这些类型（前缀匹配，如 `approval.`）；不给就是下面的默认集合。 */
  types?: string[]
}

export type WsClientMessage = WsSubscribeMessage | { op: 'ping' }

/** 默认推的类型前缀：17 §2 的运行事件 + 会改工作台上任何一格的那几类。 */
export const WS_DEFAULT_PREFIXES = [
  // 17 §2 运行协议
  'run.',
  'context.',
  'prompt.',
  'text.',
  'tool.',
  'proposal.',
  'ui',
  'progress',
  'budget.',
  // 14 / 15 审核机制
  'approval.',
  'change.',
  'guardrail.',
  // 37 工作模型（WP35 起 packages/work 真发这几条）
  'todo.',
  'matter.',
  // 25 定时与流程
  'schedule.',
  'workflow.',
  // 28 §1 急停
  'halt.',
] as const

/** 急停 `all` 时唯一还推的东西。 */
export const HALT_ONLY_EVENT = 'halt.changed'

/** 事件类型名 → 29 §6 的四类。 */
export function classify(name: string): Exclude<WsFrameType, 'CONTROL'> {
  if (name === 'text.delta') return 'TEXT'
  if (name.startsWith('tool.')) return 'TOOL_CALL'
  if (
    name.startsWith('run.') ||
    name.startsWith('approval.') ||
    name.startsWith('change.') ||
    name.startsWith('schedule.') ||
    name.startsWith('workflow.') ||
    name.startsWith('todo.') ||
    name.startsWith('matter.') ||
    name === 'halt.changed'
  )
    return 'STATE'
  return 'CUSTOM'
}

/** 一条事件 → 一帧摘要。**只取 ref 与元数据，payload 一个字节都不带。** */
export function summarize(e: EventEnvelope): WsEventFrame {
  const run_id = e.correlation.run_id ?? e.actor.run_id
  return {
    type: classify(e.type),
    id: e.id,
    name: e.type,
    at: e.at,
    ...(e.subject === undefined ? {} : { subject: { type: e.subject.type, id: e.subject.id } }),
    ...(run_id === undefined ? {} : { run_id }),
    ...(e.correlation.trace_id === '' ? {} : { trace_id: e.correlation.trace_id }),
  }
}

/** 一条连接能往里写的东西（`ws` 的 WebSocket、测试替身都满足）。 */
export interface WsSink {
  send(text: string): void
  close(code: number, reason: string): void
}

export interface WsOptions {
  /** 每次巡检最多读多少条（过滤前）。默认 200。 */
  batch?: number
  /** 每连接每秒最多推多少帧；超了就合并成一帧 `CONTROL/dropped`。默认 40。 */
  maxFramesPerSecond?: number
  /** 重连补拉最多回溯多少条。默认 500。 */
  backfill?: number
  /** 巡检间隔（宿主用它起定时器）。默认 1000ms。 */
  pollIntervalMs?: number
}

const DEFAULTS = {
  batch: 200,
  maxFramesPerSecond: 40,
  backfill: 500,
  pollIntervalMs: 1000,
} as const

export function wsOptions(deps: GatewayDeps): Required<WsOptions> {
  const o = deps.options?.ws ?? {}
  return {
    batch: o.batch ?? DEFAULTS.batch,
    maxFramesPerSecond: o.maxFramesPerSecond ?? DEFAULTS.maxFramesPerSecond,
    backfill: o.backfill ?? DEFAULTS.backfill,
    pollIntervalMs: o.pollIntervalMs ?? DEFAULTS.pollIntervalMs,
  }
}

/** 4000–4999 是应用自定义的关闭码（RFC 6455 §7.4.2）。 */
export const WS_CLOSE = {
  invalid_input: 4400,
  unauthenticated: 4401,
  forbidden: 4403,
  internal: 4500,
} as const

/**
 * 一条已鉴权的连接。
 *
 * 宿主负责：握手时鉴权（cookie / 子协议 bearer）→ `new WsSession(...)` → 把收到的文本交给
 * `handle()` → 起一个定时器周期性 `pump()` → 连接关掉时 `stop()`。
 * 本类不碰 socket、不认识 Node，也不自己起定时器（时间从注入的 Clock 来，25 §4）。
 */
export class WsSession {
  readonly #deps: GatewayDeps
  readonly #principal: Principal
  readonly #sink: WsSink
  readonly #opts: Required<WsOptions>
  #assignment_id: string | undefined
  #cursor: string | undefined
  #prefixes: readonly string[] = WS_DEFAULT_PREFIXES
  #stopped = false
  /** 限速窗口：窗口起点（ms）与本窗口已推帧数。 */
  #windowMs = -1
  #inWindow = 0
  #dropped = 0

  constructor(deps: GatewayDeps, principal: Principal, sink: WsSink) {
    this.#deps = deps
    this.#principal = principal
    this.#sink = sink
    this.#opts = wsOptions(deps)
  }

  get subscribed(): boolean {
    return this.#assignment_id !== undefined
  }

  get cursor(): string | undefined {
    return this.#cursor
  }

  get pollIntervalMs(): number {
    return this.#opts.pollIntervalMs
  }

  #now(): string {
    return this.#deps.clock.now()
  }

  #write(frame: WsFrame): void {
    if (this.#stopped) return
    this.#sink.send(JSON.stringify(frame))
  }

  #control(name: WsControlFrame['name'], detail?: Record<string, unknown>): void {
    this.#write({
      type: 'CONTROL',
      name,
      at: this.#now(),
      ...(detail === undefined ? {} : { detail }),
    })
  }

  #fail(code: keyof typeof WS_CLOSE, message: string): void {
    this.#control('error', { code, message })
    this.#stopped = true
    this.#sink.close(WS_CLOSE[code], code)
  }

  /**
   * 每连接限速（28 §2「限流与预算」的连接版）。
   *
   * 超限不是断线也不是丢帧不告诉你：本窗口剩下的都不推，窗口结束时补一帧
   * `CONTROL/dropped { count }`——客户端据此知道「我的视图可能不全，整体重取一次」。
   */
  #allow(): boolean {
    const nowMs = Date.parse(this.#now())
    if (this.#windowMs < 0 || nowMs - this.#windowMs >= 1000) {
      if (this.#dropped > 0) {
        const dropped = this.#dropped
        this.#dropped = 0
        this.#windowMs = nowMs
        this.#inWindow = 1
        this.#control('dropped', { count: dropped, hint: 'refetch' })
        return true
      }
      this.#windowMs = nowMs
      this.#inWindow = 0
    }
    if (this.#inWindow >= this.#opts.maxFramesPerSecond) {
      this.#dropped += 1
      return false
    }
    this.#inWindow += 1
    return true
  }

  /** 客户端来的一条文本消息。解析失败一律 4400——协议错就该早点断，不要半通不通地跑。 */
  async handle(text: string): Promise<void> {
    let msg: WsClientMessage
    try {
      msg = JSON.parse(text) as WsClientMessage
    } catch {
      this.#fail('invalid_input', '消息不是合法 JSON')
      return
    }
    if (msg === null || typeof msg !== 'object') {
      this.#fail('invalid_input', '消息必须是对象')
      return
    }
    if (msg.op === 'ping') {
      this.#control('pong')
      return
    }
    if (msg.op !== 'subscribe') {
      this.#fail('invalid_input', `不认识的 op：${String((msg as { op?: unknown }).op)}`)
      return
    }
    await this.#subscribe(msg)
  }

  async #subscribe(msg: WsSubscribeMessage): Promise<void> {
    const id = typeof msg.assignment_id === 'string' ? msg.assignment_id.trim() : ''
    if (id === '') {
      this.#fail('invalid_input', '缺少 assignment_id（31 §3.1 一次连接一个 Assignment）')
      return
    }
    const assignment = this.#deps.roles.getAssignment(id)
    if (
      !assignment ||
      assignment.revoked_at !== undefined ||
      assignment.person_id !== this.#principal.person_id ||
      assignment.workspace_id !== this.#principal.workspace_id
    ) {
      this.#fail('forbidden', 'assignment_id 不属于当前主体或已撤销')
      return
    }
    // 与 REST 同一条判定：连事件流也要有 event_log 的读权限（范围由 can 决定）
    if (
      !this.#deps.roles.can(assignment.id, 'event_log', 'read', {
        range: 'own',
        sensitivity: 'internal',
      })
    ) {
      this.#fail('forbidden', '这个岗位没有读事件日志的权限')
      return
    }
    this.#assignment_id = assignment.id
    if (Array.isArray(msg.types) && msg.types.length > 0)
      this.#prefixes = msg.types.filter((t) => typeof t === 'string' && t !== '')
    const since = typeof msg.since === 'string' && msg.since.trim() !== '' ? msg.since.trim() : ''
    this.#cursor = since === '' ? undefined : since
    this.#control('ready', {
      assignment_id: assignment.id,
      scope: canReadAll(this.#deps, assignment.id) ? 'workspace' : 'assignment',
      resumed: since !== '',
      poll_interval_ms: this.#opts.pollIntervalMs,
      halted: this.#deps.halt.isHalted('all'),
    })
    // 没带 since 的新连接不补历史：它接着「现在」看就够了，历史走 REST。
    if (since === '') {
      this.#cursor = await this.#tail()
      return
    }
    await this.pump({ limit: this.#opts.backfill })
  }

  /**
   * 当前日志末尾的 id（新连接的起点）。
   *
   * 一页一页往前翻到读不满为止：单发一个 `limit` 只会拿到**第一页**的最后一条，
   * 于是一条几千事件的日志上，新连接会把中间那几千条当成「新事件」全推一遍。
   * 每一页都只留一个 id，内存是常数。
   */
  async #tail(): Promise<string | undefined> {
    const limit = this.#opts.batch
    let cursor: string | undefined
    for (;;) {
      let count = 0
      let last: string | undefined
      for await (const e of this.#deps.eventLog.read({
        workspace_id: this.#principal.workspace_id,
        limit,
        ...(cursor === undefined ? {} : { since: cursor }),
      })) {
        count += 1
        last = e.id
      }
      if (last === undefined) return cursor
      cursor = last
      if (count < limit) return cursor
    }
  }

  #matches(name: string): boolean {
    return this.#prefixes.some((p) => name === p || name.startsWith(p))
  }

  /**
   * 巡检一次：读增量 → 按岗位过滤 → 摘要化 → 推。
   *
   * 急停 `all` 时只推 `halt.changed`，其余照样推进游标（解停之后不会突然涌回来一堆旧事件——
   * 停机期间发生的事本来就不该往外流，客户端解停后整体重取）。
   */
  async pump(options: { limit?: number } = {}): Promise<number> {
    if (this.#stopped) return 0
    const assignment_id = this.#assignment_id
    if (assignment_id === undefined) return 0
    const assignment = this.#deps.roles.getAssignment(assignment_id)
    if (!assignment || assignment.revoked_at !== undefined) {
      // 岗位被撤销了：连接立刻失效（05 §4「撤销后不可读」）
      this.#fail('forbidden', '岗位已撤销')
      return 0
    }
    const limit = options.limit ?? this.#opts.batch
    let scanned: EventEnvelope[] = []
    try {
      const out: EventEnvelope[] = []
      for await (const e of this.#deps.eventLog.read({
        workspace_id: this.#principal.workspace_id,
        limit,
        ...(this.#cursor === undefined ? {} : { since: this.#cursor }),
      }))
        out.push(e)
      scanned = out
    } catch {
      this.#control('error', { code: 'internal', message: '读事件日志失败' })
      return 0
    }
    if (scanned.length === 0) return 0
    const last = scanned[scanned.length - 1]
    if (last !== undefined) this.#cursor = last.id

    const halted = this.#deps.halt.isHalted('all')
    const wanted = scanned.filter((e) =>
      halted ? e.type === HALT_ONLY_EVENT : this.#matches(e.type),
    )
    if (wanted.length === 0) return 0
    const visible = canReadAll(this.#deps, assignment.id)
      ? wanted
      : await new AssignmentVisibility(this.#deps, this.#principal, assignment).filter(wanted)

    let sent = 0
    for (const e of visible) {
      // 急停期间的 halt.changed 不受限速影响：它是解停信号，丢了就没人知道能用了
      if (e.type !== HALT_ONLY_EVENT && !this.#allow()) continue
      this.#write(summarize(e))
      sent += 1
    }
    return sent
  }

  /** 宿主主动收尾（进程要关了 / 客户端断了）。 */
  stop(reason = 'closing'): void {
    if (this.#stopped) return
    this.#control('closing', { reason })
    this.#stopped = true
  }
}

/**
 * 子协议头里的 bearer：`Sec-WebSocket-Protocol: agentsws.v1, agentsws.bearer.<token>`。
 *
 * 返回值是 `{ token?, accept }`——`accept` 是握手要回的那个子协议名。浏览器要求
 * 服务端回一个**客户端提过的**子协议，否则连接直接失败；我们统一回 `agentsws.v1`。
 */
export const WS_SUBPROTOCOL = 'agentsws.v1'
export const WS_BEARER_PREFIX = 'agentsws.bearer.'

export function parseSubprotocols(header: string | undefined): {
  token?: string
  accept?: string
} {
  if (header === undefined || header.trim() === '') return {}
  const parts = header
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
  const bearer = parts.find((p) => p.startsWith(WS_BEARER_PREFIX))
  const token = bearer === undefined ? undefined : bearer.slice(WS_BEARER_PREFIX.length)
  const accept = parts.includes(WS_SUBPROTOCOL) ? WS_SUBPROTOCOL : undefined
  return {
    ...(token === undefined || token === '' ? {} : { token }),
    ...(accept === undefined ? {} : { accept }),
  }
}

/**
 * `GET /v1/ws` 的 HTTP 面。
 *
 * 真正的升级在宿主那一层（见文件头），所以走到这个处理器的一定是「用普通 HTTP 打了 WS 地址」
 * 的调用方——回 426 并把怎么连说清楚，比回 404 有用得多。装了 WS 的服务进程里，
 * 这条路由本身也是 OpenAPI 上那份 AsyncAPI 片段的挂点。
 */
export function wsRoutes(): Route[] {
  return [
    route(
      {
        method: 'get',
        path: '/v1/ws',
        operationId: 'openEventStream',
        summary: 'WebSocket 事件流（摘要推送；鉴权同 REST：会话 cookie 或子协议 bearer）',
        tag: 'event',
        auth: 'public',
        returns: '426 Upgrade Required（普通 HTTP 打过来时）；升级后是 WebSocket 帧流',
      },
      async (c, deps) => {
        const upgrade = c.req.header('Upgrade')?.toLowerCase()
        if (upgrade === 'websocket')
          // 走到这里说明宿主没装 WS 升级（比如只跑网关的测试或别的宿主）
          throw new ApiError('not_implemented', '这个服务进程没有装配 WebSocket 升级')
        c.header('Upgrade', 'websocket')
        c.header('Connection', 'Upgrade')
        return ok(
          c,
          {
            protocol: WS_SUBPROTOCOL,
            subscribe: {
              op: 'subscribe',
              assignment_id: '<assignment_id>',
              since: '<最后一条事件 id，选填>',
              types: [...WS_DEFAULT_PREFIXES],
            },
            auth: '同源浏览器用会话 cookie；其他调用方用 Sec-WebSocket-Protocol 带 bearer',
            frames: ['TEXT', 'TOOL_CALL', 'STATE', 'CUSTOM', 'CONTROL'],
            poll_interval_ms: wsOptions(deps).pollIntervalMs,
          },
          426,
        )
      },
    ),
  ]
}
