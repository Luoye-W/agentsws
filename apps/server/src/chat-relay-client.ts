/**
 * 本机侧的转发器客户端（WP124）：商家电脑主动外连转发器的那条长 WebSocket。
 *
 * 商家不开端口、不要公网 IP：这条连接是**本机拨出去**的。断线指数退避重连，
 * 心跳掉线即重连；连上后把转发器递来的访客消息喂给**现有的**
 * `ChatChannelAdapter`（判断、围栏、涉钱出卡一条不绕开），AI 的回复从
 * 会话流里接回来、原路送回转发器。
 *
 * 两类出站帧，边界刻意划开：
 * - `reply`：一次访客话轮的**那条**回复（转发器按话轮记账，一轮恰好一条）；
 * - `note`：话轮之外的插话（教 AI 的那句改写，话轮已经结过账）。
 *
 * 离线留言：连上后先拉一轮（转发器回离线时访客留的言，密文），开箱后交给
 * 宿主落进「消息」页（`MessageSource = 'chat'`，按邮箱续聊）。
 *
 * 运行环境说明：Node 22 自带 WebSocket 客户端；测试注入替身，不联网。
 */
import {
  openSealed,
  RELAY_HEARTBEAT_MS,
  RELAY_PROTOCOL_VERSION,
  sealedKeyOf,
} from '@agentsws/chat-relay'
import type { ChatWidgetConfig, Clock, WorkspaceId } from '@agentsws/contracts'
import type { ChatLane } from './chat.js'
import type { ChatWidgetAssembly } from './chat-widget.js'

/** 对外 WebSocket 客户端的最小面（undici 的 WebSocket 与测试替身都长这样）。 */
export interface RelayClientSocket {
  send(text: string): void
  close(): void
  addEventListener(type: 'open', handler: () => void): void
  addEventListener(type: 'message', handler: (event: { data: unknown }) => void): void
  addEventListener(type: 'close', handler: () => void): void
  addEventListener(type: 'error', handler: () => void): void
}

export type SocketFactory = (url: string) => RelayClientSocket

export type RelayClientState = 'stopped' | 'connecting' | 'online' | 'backoff'

/** 一条开过箱的离线留言（宿主落进消息库）。 */
export interface OfflineMessageContent {
  email: string
  text: string
  order_ref?: string
  page?: string
  left_at: string
}

export interface ChatRelayClientOptions {
  clock: Clock
  workspace_id: WorkspaceId
  lane: ChatLane
  widget: ChatWidgetAssembly
  /** 转发器地址（`https://host/relay/<ws>` 或本地 `/w/<ws>` 形态的绝对地址）。 */
  endpoint(): string | undefined
  /** 配对密钥（本机加密库里来的原生表单值；不给就连不上）。 */
  pairingToken(): string | undefined
  /** 留言密钥（与配对密钥同一刻签发的那个）。 */
  messageKey(): string | undefined
  socketFactory?: SocketFactory
  /** 开箱后的离线留言交给宿主（落「消息」页）。 */
  onOfflineMessage?(message: OfflineMessageContent): void | Promise<void>
  /** 事件（状态变化 / 泄漏级的错误；不打正文）。 */
  onEvent?(event: { type: string; detail?: string }): void
  /** 心跳间隔覆盖（测试）。 */
  heartbeatMs?: number
  /** 退避上限覆盖（测试）。 */
  maxBackoffMs?: number
}

const MAX_BACKOFF_MS = 60_000

/** `https://host/relay/ws_x` → `wss://host/relay/ws_x/connect`；不像地址就 `undefined`。 */
export function relayConnectUrl(endpoint: string): { url: string; workspace: string } | undefined {
  try {
    const url = new URL(endpoint)
    const match = /\/relay\/([^/]+)\/?$/.exec(url.pathname)
    if (match?.[1] === undefined) return undefined
    url.protocol =
      url.protocol === 'https:' ? 'wss:' : url.protocol === 'http:' ? 'ws:' : url.protocol
    url.pathname = `${url.pathname.replace(/\/$/, '')}/connect`
    return { url: url.toString(), workspace: match[1] }
  } catch {
    return undefined
  }
}

export class ChatRelayClient {
  readonly #options: ChatRelayClientOptions
  #socket: RelayClientSocket | undefined
  #state: RelayClientState = 'stopped'
  #attempts = 0
  #lastIncomingAt = 0
  #heartbeat: ReturnType<typeof setInterval> | undefined
  #reconnect: ReturnType<typeof setTimeout> | undefined
  #stopped = true
  /** 转发器会话 → 本机会话 id 与在途话轮（没有正文）。 */
  readonly #turns = new Map<string, string>()
  readonly #lanes = new Map<string, string>()
  readonly #unsubscribes = new Map<string, () => void>()

  constructor(options: ChatRelayClientOptions) {
    this.#options = options
  }

  state(): RelayClientState {
    return this.#state
  }

  start(): void {
    if (!this.#stopped) return
    this.#stopped = false
    this.#connect()
  }

  stop(): void {
    this.#stopped = true
    this.#teardown()
    this.#state = 'stopped'
    this.#options.onEvent?.({ type: 'stopped' })
  }

  /** 商家改了挂件设置：把新外观推给转发器（连着才推；没连着下次握手带）。 */
  syncConfig(): void {
    if (this.#state !== 'online' || this.#socket === undefined) return
    this.#socket.send(JSON.stringify({ type: 'config', config: this.#publicConfig() }))
  }

  /* ── 连接生命周期 ─────────────────────────────────────────────── */

  #publicConfig(): ChatWidgetConfig {
    return this.#options.widget.config()
  }

  #connect(): void {
    if (this.#stopped) return
    const endpoint = this.#options.endpoint()
    const pairing = this.#options.pairingToken()
    if (endpoint === undefined || pairing === undefined) {
      // 没配转发方式：安静地不做任何事（设置页会显示「未连接」）
      this.#state = 'stopped'
      return
    }
    const parsed = relayConnectUrl(endpoint)
    if (parsed === undefined) {
      this.#options.onEvent?.({ type: 'bad_endpoint' })
      this.#state = 'stopped'
      return
    }
    const factory: SocketFactory =
      this.#options.socketFactory ??
      ((url) =>
        new (globalThis as { WebSocket: new (url: string) => RelayClientSocket }).WebSocket(url))
    this.#state = 'connecting'
    const socket = factory(parsed.url)
    this.#socket = socket
    // close/error 只对"还是当前这条"的连接生效——teardown 主动关掉旧连接时
    // 也会触发 close，不能把它当成又一次断线（否则重连永不收敛）
    const isCurrent = (): boolean => this.#socket === socket
    socket.addEventListener('open', () => {
      socket.send(
        JSON.stringify({
          type: 'hello',
          protocol_version: RELAY_PROTOCOL_VERSION,
          workspace: parsed.workspace,
          pairing,
          peer: 'server',
          config: this.#publicConfig(),
        }),
      )
    })
    socket.addEventListener('message', (event) => {
      this.#lastIncomingAt = Date.parse(this.#options.clock.now())
      this.#onFrame(String(event.data), parsed.workspace)
    })
    socket.addEventListener('close', () => {
      if (isCurrent()) this.#scheduleReconnect()
    })
    socket.addEventListener('error', () => {
      // close 事件会跟着来；这里只记状态
    })
  }

  #teardown(): void {
    if (this.#heartbeat !== undefined) clearInterval(this.#heartbeat)
    this.#heartbeat = undefined
    if (this.#reconnect !== undefined) clearTimeout(this.#reconnect)
    this.#reconnect = undefined
    // 先摘下再关：close 事件里的 isCurrent 守卫靠这一行分清
    //「主动关」与「真断线」——主动关不该再触发一次重连排程
    const socket = this.#socket
    this.#socket = undefined
    try {
      socket?.close()
    } catch {
      // 已经断了
    }
    for (const unsub of this.#unsubscribes.values()) unsub()
    this.#unsubscribes.clear()
  }

  #scheduleReconnect(): void {
    this.#teardown()
    if (this.#stopped) return
    this.#attempts += 1
    this.#state = 'backoff'
    const max = this.#options.maxBackoffMs ?? MAX_BACKOFF_MS
    const base = Math.min(max, 1000 * 2 ** (this.#attempts - 1))
    // 抖动 ±20%：一群本机同时掉线不要同时挤回来
    const delay = Math.round(base * (0.8 + Math.random() * 0.4))
    this.#options.onEvent?.({ type: 'reconnect_scheduled', detail: `attempt ${this.#attempts}` })
    this.#reconnect = setTimeout(() => this.#connect(), delay)
  }

  #heartbeatLoop(): void {
    const interval = this.#options.heartbeatMs ?? RELAY_HEARTBEAT_MS
    if (this.#heartbeat !== undefined) clearInterval(this.#heartbeat)
    this.#heartbeat = setInterval(() => {
      if (this.#socket === undefined) return
      const last = this.#lastIncomingAt
      const now = Date.parse(this.#options.clock.now())
      // 两个心跳没收到任何帧：当掉线处理（close 会触发重连）
      if (last !== 0 && now - last > interval * 2) {
        this.#options.onEvent?.({ type: 'heartbeat_timeout' })
        this.#socket.close()
        return
      }
      try {
        this.#socket.send(JSON.stringify({ type: 'ping' }))
      } catch {
        this.#socket.close()
      }
    }, interval)
    this.#heartbeat.unref?.()
  }

  /* ── 转发器那一侧的帧 ─────────────────────────────────────────── */

  #onFrame(raw: string, workspace: string): void {
    let frame: Record<string, unknown>
    try {
      frame = JSON.parse(raw) as Record<string, unknown>
    } catch {
      return
    }
    switch (frame.type) {
      case 'hello_ok': {
        this.#state = 'online'
        this.#attempts = 0
        this.#lastIncomingAt = Date.parse(this.#options.clock.now())
        this.#heartbeatLoop()
        this.#options.onEvent?.({ type: 'online' })
        // 上线第一件事：把离线时访客留的言拉走（拉走即清除）
        const key = this.#options.messageKey()
        if (key !== undefined) this.#socket?.send(JSON.stringify({ type: 'pull_offline' }))
        void key
        return
      }
      case 'hello_err': {
        // 密钥错不重试：重试只会把对端刷屏。停下来等商家在设置页处理。
        this.#stopped = true
        this.#state = 'stopped'
        this.#options.onEvent?.({ type: `hello_err_${String(frame.reason)}` })
        return
      }
      case 'visit': {
        void this.#onVisit(frame, workspace)
        return
      }
      case 'offline_batch': {
        void this.#onOfflineBatch(frame)
        return
      }
      case 'pong':
      case 'error':
        // error 帧记一笔（不含正文）；pong 不用管
        if (frame.type === 'error')
          this.#options.onEvent?.({ type: 'relay_error', detail: String(frame.code) })
        return
      default:
        return
    }
  }

  async #onVisit(frame: Record<string, unknown>, _workspace: string): Promise<void> {
    const session = String(frame.session)
    const text = String(frame.text)
    const laneSession = await this.#laneSession(session, {
      visitorId: String(frame.visitor_id),
      ...(typeof frame.display === 'string' ? { display: frame.display } : {}),
    })
    this.#turns.set(session, String(frame.turn))
    // 喂给现有车道：判断 / 围栏 / 涉钱出卡全在 lane 那一侧，这里一字不重复
    await this.#options.lane.receive({ session_id: laneSession, text })
  }

  /** 转发器会话 → 本机车道会话（`external_session_id` 确定性映射，重启不丢）。 */
  async #laneSession(
    relaySession: string,
    visitor: { visitorId: string; display?: string },
  ): Promise<string> {
    const known = this.#lanes.get(relaySession)
    if (known !== undefined) {
      await this.#options.lane.touch(known)
      return known
    }
    const session = await this.#options.lane.openSession({
      source: 'widget',
      external_session_id: `relay:${relaySession}`,
      visitor_id: visitor.visitorId,
      ...(visitor.display === undefined ? {} : { visitor_display: visitor.display }),
    })
    this.#lanes.set(relaySession, session.id)
    // 回复原路回去：从会话流里接 AI 说的话
    const subscription = this.#options.lane.stream.subscribe(session.id, (frame) => {
      this.#onLaneMessage(relaySession, frame)
    })
    this.#unsubscribes.set(session.id, () => subscription.stop())
    return session.id
  }

  #onLaneMessage(relaySession: string, frame: unknown): void {
    const message = (frame as { type?: string; message?: { role?: string; text?: string } }).message
    if (message === undefined || message.role === 'visitor' || message.role === 'operator') return
    // 商家教 AI 的中文原话是 operator 帧，**永不**出站（72 红线）
    const text = message.text ?? ''
    if (text === '') return
    const socket = this.#socket
    if (socket === undefined || this.#state !== 'online') return
    const pendingTurn = this.#turns.get(relaySession)
    if (pendingTurn !== undefined) {
      // 这一轮的回复：只有一条，发完即销账
      this.#turns.delete(relaySession)
      socket.send(
        JSON.stringify({
          type: 'reply',
          session: relaySession,
          turn: pendingTurn,
          message_id: `r_${Date.parse(this.#options.clock.now())}`,
          text,
        }),
      )
      return
    }
    // 话轮之外的插话（教 AI 的改写）
    socket.send(
      JSON.stringify({
        type: 'note',
        session: relaySession,
        message_id: `n_${Date.parse(this.#options.clock.now())}`,
        text,
      }),
    )
  }

  async #onOfflineBatch(frame: Record<string, unknown>): Promise<void> {
    const key = this.#options.messageKey()
    if (key === undefined) return
    const items = (frame.items as { id: string; sealed: string; created_at: string }[]) ?? []
    for (const item of items) {
      const plaintext = openSealed(sealedKeyOf(key), item.sealed)
      if (plaintext === undefined) {
        // 钥匙不对：这条不是这把钥匙封的，留在日志里一句人话，不留原文
        this.#options.onEvent?.({ type: 'offline_message_undecryptable' })
        continue
      }
      try {
        const parsed = JSON.parse(plaintext) as Omit<OfflineMessageContent, 'left_at'>
        await this.#options.onOfflineMessage?.({ ...parsed, left_at: item.created_at })
      } catch {
        this.#options.onEvent?.({ type: 'offline_message_malformed' })
      }
    }
  }
}

/** 便捷判定：配置全齐才启动客户端。 */
export function relayClientConfigured(options: {
  endpoint(): string | undefined
  pairingToken(): string | undefined
}): boolean {
  return options.endpoint() !== undefined && options.pairingToken() !== undefined
}
