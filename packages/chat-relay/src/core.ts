/**
 * 转发器核心（运行时无关）：官方托管 / 自建 Docker / 自建 Worker 三种部署
 * 跑的是同一份逻辑，差别只在两个薄适配给的端口实现（连接怎么收发、
 * 计数与留言箱落在哪）。
 *
 * **职责只有转发**（修订第 2 条）：不存对话正文、不跑 AI、不做客服判断。
 * 替商家存的东西只有三样：挂件外观（让挂件画得出来）、对话计数、留言密文。
 * 一条「转发路径上没有写存储的调用」的守卫测试钉住这句话（见 test/privacy.test.ts）。
 *
 * 对端选择（修订第 2 条）：订阅客服增值服务后，对端从「商家本机」换成
 * 「托管实例」。转发器不查订阅——**谁连上来谁说话**：托管实例只在订阅生效时
 * 连进来；两头都在时托管实例赢（它连着就说明订阅在效，且它 7×24 在线）。
 */
import type { Iso8601 } from '@agentsws/contracts'
import { MemoryOfflineBox, type OfflineBox } from './offline-box.js'
import {
  type ClientFrame,
  negotiateVersion,
  RELAY_HEARTBEAT_MS,
  RELAY_PROTOCOL_VERSION,
  type RelayFrame,
  type RelayPeerKind,
  type RelayWidgetConfig,
} from './protocol.js'
import { type CounterStore, crossedWarnThreshold, judgeQuota, MemoryCounterStore } from './quota.js'

/** 转发器眼里的一条对端连接（宿主适配给实现：WS / DO WebSocket）。 */
export interface ClientHandle {
  readonly peer: RelayPeerKind
  send(frame: RelayFrame): void
  close(): void
}

/** 转发器眼里的一条访客流（SSE 或 WS 的写入端）。 */
export interface VisitorSink {
  send(
    frame:
      | { type: 'message'; message: { role: 'agent'; text: string } }
      | { type: 'typing'; active: boolean }
      | { type: 'offline' },
  ): void
  close(): void
}

/** 转发器往外报的事（宿主层接通知 / 日志；转发器自己不打日志）。 */
export type RelayEvent =
  | { type: 'peer_connected'; workspace: string; peer: RelayPeerKind; at: Iso8601 }
  | { type: 'peer_disconnected'; workspace: string; peer: RelayPeerKind; at: Iso8601 }
  | { type: 'conversation_counted'; workspace: string; count: number; at: Iso8601 }
  | { type: 'quota_warn_80'; workspace: string; count: number; limit: number; at: Iso8601 }
  | { type: 'quota_full'; workspace: string; limit: number; at: Iso8601 }
  | { type: 'offline_message_left'; workspace: string; at: Iso8601 }

export interface RelayCoreOptions {
  clock(): Iso8601
  /** 配对校验：实现里做哈希比对（明文只进这一个函数一次）。 */
  verifyPairing(workspace: string, pairing: string): boolean
  /** 免费档每月对话上限；`undefined` = 无上限。官方托管从 limits.json 读。 */
  conversationLimit?: number
  /** 订阅状态（官方托管查得着；自建没有这层，恒无上限）。 */
  isSubscribed?(workspace: string): boolean
  counters?: CounterStore
  offline?: OfflineBox
  onEvent?(event: RelayEvent): void
  /** 留言封箱（宿主用配对密钥加密；不给就原样存——测试用）。 */
  seal?(workspace: string, plaintext: string): string
  newId(): string
}

/** 一条在途访客会话：只有编号与流，没有正文。 */
interface VisitorSession {
  workspace: string
  visitor: string
  sink: VisitorSink
  /** 等回复的那一轮；第二条同轮回复会被拒。 */
  pendingTurn?: string
}

export interface VisitorMessageInput {
  workspace: string
  session: string
  visitor: string
  display?: string
  text: string
  page?: { host: string; path: string; product?: string }
  /** 商家设置页试聊：不计对话数（AI 费用照算）。 */
  trial?: boolean
}

export type VisitorMessageResult =
  | { status: 'forwarded' }
  | { status: 'queued_typing' }
  | { status: 'offline'; reason: 'peer_offline' | 'quota_exhausted' }

export class RelayCore {
  private readonly clients = new Map<string, ClientHandle>()
  private readonly visitors = new Map<string, VisitorSession>()
  private readonly configs = new Map<string, RelayWidgetConfig>()
  private readonly counters: CounterStore
  private readonly offline: OfflineBox

  constructor(private readonly options: RelayCoreOptions) {
    this.counters = options.counters ?? new MemoryCounterStore()
    this.offline = options.offline ?? new MemoryOfflineBox()
  }

  /* ── 对面（本机 / 托管实例）那一侧 ─────────────────────────────── */

  /** 握手。返回 hello_ok 时连接已挂上；hello_err 时应断开。 */
  handshake(
    socket: { send(frame: RelayFrame): void; close?(): void },
    frame: Extract<ClientFrame, { type: 'hello' }>,
  ): { ok: boolean } {
    const offered = negotiateVersion([RELAY_PROTOCOL_VERSION], frame.protocol_version)
    if (offered === undefined) {
      socket.send({
        type: 'hello_err',
        reason: 'version_mismatch',
        supported_versions: [RELAY_PROTOCOL_VERSION],
      })
      return { ok: false }
    }
    if (!this.options.verifyPairing(frame.workspace, frame.pairing)) {
      // 密钥错与工作区不存在是同一句话（不给探测的人任何多余信息）
      socket.send({
        type: 'hello_err',
        reason: 'bad_pairing',
        supported_versions: [RELAY_PROTOCOL_VERSION],
      })
      return { ok: false }
    }
    // 同一工作区同一类对端只留一条：重连的先踢旧的（幂等，不靠对面守规矩）
    const prior = this.clients.get(frame.workspace)
    if (prior !== undefined && prior.peer === frame.peer) prior.close()
    const handle: ClientHandle = {
      peer: frame.peer,
      send: (f) => socket.send(f),
      close: () =>
        socket.send({ type: 'error', code: 'closed', message: 'replaced by a new connection' }),
    }
    this.clients.set(frame.workspace, handle)
    if (frame.config !== undefined) this.configs.set(frame.workspace, frame.config)
    this.options.onEvent?.({
      type: 'peer_connected',
      workspace: frame.workspace,
      peer: frame.peer,
      at: this.options.clock(),
    })
    socket.send({
      type: 'hello_ok',
      protocol_version: RELAY_PROTOCOL_VERSION,
      heartbeat_ms: RELAY_HEARTBEAT_MS,
      peer: frame.peer,
    })
    return { ok: true }
  }

  /** 挂件外观更新（本机改了设置推过来；不是对话正文）。 */
  updateConfig(workspace: string, config: RelayWidgetConfig): void {
    this.configs.set(workspace, config)
  }

  /** 对端断开。 */
  dropClient(workspace: string): void {
    const handle = this.clients.get(workspace)
    if (handle === undefined) return
    this.clients.delete(workspace)
    this.options.onEvent?.({
      type: 'peer_disconnected',
      workspace,
      peer: handle.peer,
      at: this.options.clock(),
    })
  }

  /** 对面上来的一帧（握手之后）。 */
  onClientFrame(workspace: string, frame: ClientFrame): void {
    switch (frame.type) {
      case 'config':
        this.updateConfig(workspace, frame.config)
        return
      case 'reply':
        this.deliverReply(workspace, frame.session, frame.turn, frame.message_id, frame.text)
        return
      case 'typing': {
        const visitor = this.visitors.get(frame.session)
        if (visitor !== undefined && visitor.workspace === workspace)
          visitor.sink.send({ type: 'typing', active: frame.active })
        return
      }
      case 'pull_offline': {
        const items = this.offline.take(workspace)
        const handle = this.clients.get(workspace)
        handle?.send({ type: 'offline_batch', items })
        return
      }
      case 'ping': {
        this.clients.get(workspace)?.send({ type: 'pong' })
        return
      }
      case 'hello':
        // 握手只走 handshake()；走到这里说明对面在旧连接上又握了一次手，忽略
        return
    }
  }

  /* ── 访客那一侧 ────────────────────────────────────────────────── */

  /** 挂件拉外观（不知道配置就给一个「未开」的默认——转发器不猜）。 */
  publicConfig(workspace: string): RelayWidgetConfig {
    return this.configs.get(workspace) ?? { enabled: false, accent: '#2563eb', greeting: '' }
  }

  attachVisitor(workspace: string, session: string, visitor: string, sink: VisitorSink): void {
    this.visitors.set(session, { workspace, visitor, sink })
  }

  detachVisitor(session: string): void {
    this.visitors.delete(session)
  }

  /**
   * 访客说了一句。**接收与投递解耦**：返回值只是「收到并怎么处理了」，
   * 回复从访客流异步回来。
   */
  visitorMessage(input: VisitorMessageInput): VisitorMessageResult {
    const now = this.options.clock()
    const subscribed = this.options.isSubscribed?.(input.workspace) ?? false
    const limit = this.options.conversationLimit
    const before = this.counters.count(input.workspace, now.slice(0, 7))
    const verdict = judgeQuota(this.counters, {
      workspace: input.workspace,
      visitor: input.visitor,
      now,
      ...(limit === undefined ? {} : { limit }),
      subscribed,
      ...(input.trial === true ? { trial: true } : {}),
    })
    if (!verdict.admit) {
      this.options.onEvent?.({
        type: 'quota_full',
        workspace: input.workspace,
        limit: limit ?? 0,
        at: now,
      })
      return { status: 'offline', reason: 'quota_exhausted' }
    }
    const after = this.counters.count(input.workspace, now.slice(0, 7))
    if (verdict.counted) {
      this.options.onEvent?.({
        type: 'conversation_counted',
        workspace: input.workspace,
        count: after,
        at: now,
      })
      if (limit !== undefined && !subscribed && crossedWarnThreshold(before, after, limit)) {
        this.options.onEvent?.({
          type: 'quota_warn_80',
          workspace: input.workspace,
          count: after,
          limit,
          at: now,
        })
      }
    }
    const handle = this.clients.get(input.workspace)
    if (handle === undefined) return { status: 'offline', reason: 'peer_offline' }
    const turn = `t_${this.options.newId()}`
    const visitor = this.visitors.get(input.session)
    if (visitor !== undefined) visitor.pendingTurn = turn
    handle.send({
      type: 'visit',
      session: input.session,
      turn,
      visitor_id: input.visitor,
      ...(input.display === undefined ? {} : { display: input.display }),
      text: input.text,
      ...(input.page === undefined ? {} : { page: input.page }),
    })
    return { status: 'forwarded' }
  }

  /** 访客的打字信号转给对面（只布尔；解析层已经把带文本的拒了）。 */
  visitorTyping(session: string, active: boolean): void {
    const visitor = this.visitors.get(session)
    if (visitor === undefined) return
    this.clients.get(visitor.workspace)?.send({
      type: 'visitor_typing',
      session,
      active,
    })
  }

  /** 访客留言（密文入箱）。返回条数上限是否已被顶掉（界面照常收，不拒绝）。 */
  leaveOfflineMessage(workspace: string, plaintext: string): void {
    const sealed = this.options.seal?.(workspace, plaintext) ?? plaintext
    this.offline.put(workspace, {
      id: `om_${this.options.newId()}`,
      sealed,
      created_at: this.options.clock(),
    })
    this.options.onEvent?.({ type: 'offline_message_left', workspace, at: this.options.clock() })
  }

  /* ── 内部 ──────────────────────────────────────────────────────── */

  private deliverReply(
    workspace: string,
    session: string,
    turn: string,
    message_id: string,
    text: string,
  ): void {
    const visitor = this.visitors.get(session)
    if (visitor === undefined || visitor.workspace !== workspace) {
      this.clients.get(workspace)?.send({
        type: 'error',
        code: 'unknown_session',
        message: '这条会话不在这台转发器上（访客已离开或换了节点）',
      })
      return
    }
    // 一次话轮恰好一条回复：第二条同轮回复丢弃（docs/72 §6.3 #3）
    if (visitor.pendingTurn !== turn) {
      this.clients.get(workspace)?.send({
        type: 'error',
        code: 'turn_already_answered',
        message: '这一轮已经回过了',
      })
      return
    }
    delete visitor.pendingTurn
    visitor.sink.send({ type: 'message', message: { role: 'agent', text } })
    void message_id
  }

  /** 测试与宿主自检用：不暴露正文，只有形状。 */
  stats(): { clients: number; visitors: number } {
    return { clients: this.clients.size, visitors: this.visitors.size }
  }
}
