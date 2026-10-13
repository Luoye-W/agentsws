/**
 * 企业微信智能机器人渠道适配器（WP85；54 §5）。
 *
 * 一条 WebSocket 长连接：订阅 → 收 `aibot_msg_callback` → 交给 18 §2 的入站管线
 * → 代理答完之后用**入站那条的 `req_id`** 回一帧 `aibot_respond_msg`。
 *
 * 四条纪律：
 * 1. **`secret` 不落在这个类里**：每次要握手都经注入的 `credentials()` 现取现用
 *    （13 §4.3）。重连也是重新取一次，不在内存里留着。
 * 2. **回复窗口**：文档写的是「收到后 24h 内可回」。过了窗口就不回——
 *    一条迟到一天的回复在群里只会让人莫名其妙，而且照样算进限额。
 * 3. **限额**：单会话 30 条/分钟、1000 条/小时（文档）。挡下来的不排队、不补发，
 *    只记一笔——IM 里补发的旧消息比不发更糟。
 * 4. **断线重连**：退避梯子封顶 30s；同一个机器人同时只有一条连接（文档），
 *    所以重连前一定先把旧的关掉。
 * 5. **判死**（WP308，决策 451）：心跳发出去、到下一次心跳之前一帧都没收到 → 当它断了，
 *    掐掉重连（走代理时上游断了、本地这头不 close 的「假活」，与飞书 WP306 那个洞同一类）；
 *    握手（连上 → 订阅成功）15 秒没完成也掐掉重连。状态变化经 `on_state` 报给宿主。
 *
 * WebSocket 本身是**注入的**（`WecomSocketFactory`）：`@agentsws/channels` 不依赖
 * `ws`，测试用内存替身或本机 `127.0.0.1` 上的假服务器，CI 一行网都不出。
 */

import type {
  ChannelAdapter,
  Clock,
  Iso8601,
  MaybePromise,
  MessagePart,
  WorkspaceId,
} from '@agentsws/contracts'
import { ChannelError } from '../errors.js'
import type { RawStore } from '../raw-store.js'
import { scrubSecrets } from '../secrets.js'
import {
  CMD_PONG,
  HANDSHAKE_TIMEOUT_MS,
  HEARTBEAT_MS,
  isAddressedToBot,
  isDisconnectedEvent,
  isInboundEvent,
  isInboundMessage,
  pingFrame,
  RATE_PER_HOUR,
  RATE_PER_MINUTE,
  RECONNECT_BACKOFF_MS,
  REPLY_WINDOW_MS,
  respondTextFrame,
  STREAM_MAX_MS,
  streamTextFrame,
  subscribeFrame,
  subscribeOk,
  textOfInbound,
  WECOM_BOT_CHANNEL,
  WECOM_WS_URL,
  type WecomFrame,
  type WecomInboundBody,
  wecomDedupeKey,
} from './protocol.js'

/** 一条长连接的最小形状（`ws` 的 `WebSocket` 结构上满足它）。 */
export interface WecomSocket {
  send(data: string): void
  close(): void
  /** WP308：判死时立刻掐断（`ws` 有；没有就退回 `close`）。 */
  terminate?(): void
  on(event: 'open', cb: () => void): void
  on(event: 'message', cb: (data: unknown) => void): void
  on(event: 'close', cb: () => void): void
  on(event: 'error', cb: (err: unknown) => void): void
}

export type WecomSocketFactory = (url: string) => WecomSocket

/** WP308：长连接状态（与飞书 / 钉钉同一组名字，卡片按它显示）。 */
export type WecomConnState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'failed'

/** 入站事件的前半段（与微信那条同形状）。 */
export interface WecomInboundHead {
  schema_version: 1
  workspace_id: WorkspaceId
  channel: typeof WECOM_BOT_CHANNEL
  kind: 'message'
  received_at: Iso8601
  occurred_at: Iso8601
  dedupe_key: string
  actor: { external_id: string; display?: string }
  thread: { external_id: string }
  parts: MessagePart[]
  raw_ref: string
  secrets_scrubbed?: boolean
  sub_channel: 'wecom_bot'
  channel_meta: Record<string, unknown>
}

/** 一条待回复的入站（回复窗口与 `req_id` 都记在这里）。 */
export interface WecomPendingReply {
  req_id: string
  chat_id: string
  chat_type: 'single' | 'group'
  from_user_id: string
  received_at_ms: number
  /** WP308：已经开了的那条流式回复（先回过「收到」）；之后的回复都刷这一条。 */
  stream?: { id: string; started_at_ms: number }
}

export interface WecomBotAdapterOptions {
  clock: Clock
  rawStore: RawStore
  workspace_id: WorkspaceId
  /** 握手用的凭据；**每次重连现取**，适配器不持有。 */
  credentials(): MaybePromise<{ bot_id: string; secret: string } | undefined>
  /** 建连；不给就不连（测试里只跑纯函数那几条）。 */
  socket?: WecomSocketFactory
  url?: string
  newId(): string
  heartbeat_ms?: number
  /** WP308：握手（连上 → 订阅成功）最多等多久，缺省 15 秒。 */
  handshake_timeout_ms?: number
  /** WP308：重连退避（测试调快），缺省 `RECONNECT_BACKOFF_MS`。 */
  backoff_ms?: readonly number[]
  /** WP308：连接状态真的变了（`prev` → `state`）。人点断开（`stop`）不报。 */
  on_state?(state: WecomConnState, prev: WecomConnState): void
  reply_window_ms?: number
  rate?: { per_minute?: number; per_hour?: number }
  raw_secret_policy?: 'redact' | 'keep'
  on_error?(e: unknown): void
}

interface Bucket {
  minute: number[]
  hour: number[]
}

/** 企业微信智能机器人适配器。归属 **workspace**（公司资产，20）。 */
export class WecomBotAdapter {
  readonly name = WECOM_BOT_CHANNEL

  readonly #options: WecomBotAdapterOptions
  readonly #pending = new Map<string, WecomPendingReply>()
  readonly #buckets = new Map<string, Bucket>()
  #socket: WecomSocket | undefined
  #running = false
  #subscribed = false
  #attempt = 0
  #heartbeat: ReturnType<typeof setInterval> | undefined
  #handshake: ReturnType<typeof setTimeout> | undefined
  /** 心跳发出去之后还没收到任何一帧（下一次心跳时还是 true = 判死）。 */
  #awaiting = false
  #state: WecomConnState = 'idle'
  #error: string | undefined
  #received = 0
  #reconnects = 0

  constructor(options: WecomBotAdapterOptions) {
    this.#options = options
  }

  capabilities(): { text: boolean; image: boolean; file: boolean; card: boolean } {
    // card=false 与微信那条同一个理由：群里所有人都看得见，按钮谁都能按（见 im-cards.ts）
    return { text: true, image: false, file: false, card: false }
  }

  get connected(): boolean {
    return this.#subscribed
  }

  /** WP308：连不上时给人看的一句话（订阅被拒 / 被别处顶掉）。 */
  get lastError(): string | undefined {
    return this.#error
  }

  /** WP308：连接状态（卡片上「连接中 / 已连接 / 断了，在重连 / 连不上」）。 */
  get state(): WecomConnState {
    return this.#state
  }

  get received(): number {
    return this.#received
  }

  get reconnects(): number {
    return this.#reconnects
  }

  health(): { ok: boolean; detail?: string } {
    if (!this.#running) return { ok: false, detail: '没有在连' }
    return this.#subscribed ? { ok: true } : { ok: false, detail: '长连接还没订阅成功（在重连）' }
  }

  /** 起连接。`onMessage` 收到一条入站；抛异常只记不断线。 */
  async start(
    onMessage: (body: WecomInboundBody, pending: WecomPendingReply) => Promise<void>,
  ): Promise<void> {
    if (this.#running) return
    this.#running = true
    this.#setState('connecting')
    await this.#connect(onMessage)
  }

  async stop(): Promise<void> {
    this.#running = false
    this.#subscribed = false
    // 人点断开 / 进程在关：不报状态变化（那不是「断了」）
    this.#state = 'idle'
    this.#clearTimers()
    const s = this.#socket
    this.#socket = undefined
    s?.close()
  }

  /**
   * 一条线上的消息 → 入站事件的前半段。正文在这里就脱敏，原文落受控区。
   */
  async toInbound(body: WecomInboundBody, workspace_id: WorkspaceId): Promise<WecomInboundHead> {
    const now = this.#options.clock.now()
    const from = body.from?.userid ?? ''
    const chat = typeof body.chatid === 'string' ? body.chatid : ''
    const text = textOfInbound(body)
    const scrubbed = scrubSecrets(text)
    const raw_ref = await this.#options.rawStore.put({
      channel: WECOM_BOT_CHANNEL,
      kind: 'message',
      payload: this.#options.raw_secret_policy === 'keep' ? text : scrubbed.text,
      subject_ref: `wecom:${from}`,
      stored_at: now,
      secrets_scrubbed: scrubbed.rules.length > 0,
    })
    const parts: MessagePart[] = scrubbed.text === '' ? [] : [{ type: 'text', text: scrubbed.text }]
    return {
      schema_version: 1,
      workspace_id,
      channel: WECOM_BOT_CHANNEL,
      kind: 'message',
      received_at: now,
      occurred_at: now,
      dedupe_key: wecomDedupeKey(body),
      actor: {
        external_id: from,
        ...(body.from?.name === undefined ? {} : { display: body.from.name }),
      },
      thread: { external_id: `wecom:${chat}` },
      parts,
      raw_ref,
      secrets_scrubbed: scrubbed.rules.length > 0,
      sub_channel: 'wecom_bot',
      channel_meta: {
        chat_type: body.chattype ?? 'single',
        ...(body.msgtype === undefined ? {} : { msgtype: body.msgtype }),
        ...(body.aibotid === undefined ? {} : { aibotid: body.aibotid }),
      },
    }
  }

  /**
   * 回一条文本。
   *
   * 三道门，按顺序：连上了没 → 还在 24h 窗口里没 → 限额还有没有。
   * 任何一道没过都**不发也不排队**，返回一个说得清的理由。
   */
  async reply(
    msgid: string,
    text: string,
    opts: { keep?: boolean } = {},
  ): Promise<{ sent: boolean; reason?: string }> {
    const pending = this.#pending.get(msgid)
    if (pending === undefined) return { sent: false, reason: 'unknown_message' }
    const now_ms = Date.parse(this.#options.clock.now())
    const window = this.#options.reply_window_ms ?? REPLY_WINDOW_MS
    if (now_ms - pending.received_at_ms >= window) {
      this.#pending.delete(msgid)
      return { sent: false, reason: 'reply_window_closed' }
    }
    if (this.#socket === undefined || !this.#subscribed)
      return { sent: false, reason: 'not_connected' }
    /*
     * WP308（决策 451）：`keep` = 这一句不是最后一句（先回「收到，我查一下」）。普通回复一条消息只能回一次，
     * 所以用**流式回复**：先开一条流（`finish=false`）放「收到」，之后的回复都刷这一条，最后一句 `finish=true`。
     * 流过了 10 分钟（文档时限）就退回普通文本回复。
     */
    const stream =
      pending.stream !== undefined && now_ms - pending.stream.started_at_ms < STREAM_MAX_MS
        ? pending.stream
        : undefined
    // 刷同一条流不算一条新消息；新开的（流或普通回复）才占限额
    if (stream === undefined && !this.#take(pending.chat_id, now_ms))
      return { sent: false, reason: 'rate_limited' }
    if (stream !== undefined || opts.keep === true) {
      const id = stream?.id ?? this.#options.newId()
      if (stream === undefined) pending.stream = { id, started_at_ms: now_ms }
      this.#socket.send(
        JSON.stringify(
          streamTextFrame({
            req_id: pending.req_id,
            stream_id: id,
            text,
            finish: opts.keep !== true,
          }),
        ),
      )
    } else {
      delete pending.stream
      this.#socket.send(JSON.stringify(respondTextFrame({ req_id: pending.req_id, text })))
    }
    if (opts.keep !== true) this.#pending.delete(msgid)
    return { sent: true }
  }

  /** 观察面：还有几条在等回复。 */
  get pending(): number {
    return this.#pending.size
  }

  /** 丢掉过了窗口的那些（宿主定时调；不调也只是多占点内存）。 */
  prune(now_ms: number): number {
    const window = this.#options.reply_window_ms ?? REPLY_WINDOW_MS
    let dropped = 0
    for (const [id, p] of [...this.#pending])
      if (now_ms - p.received_at_ms >= window) {
        this.#pending.delete(id)
        dropped += 1
      }
    return dropped
  }

  /* ── 内部 ────────────────────────────────────────────────────────── */

  async #connect(
    onMessage: (body: WecomInboundBody, pending: WecomPendingReply) => Promise<void>,
  ): Promise<void> {
    const make = this.#options.socket
    if (make === undefined)
      throw new ChannelError('not_implemented', '没有给企业微信长连接的建连方式')
    const creds = await this.#options.credentials()
    if (creds === undefined) {
      // 没配 BotID / Secret：不空转，等有人去设置页填了再 start 一次
      this.#running = false
      this.#state = 'idle'
      return
    }
    if (!this.#running) return
    // 文档：同一个机器人同时只保持一条有效长连接 → 连之前先把旧的关掉
    const old = this.#socket
    this.#socket = undefined
    old?.close()
    const socket = make(this.#options.url ?? WECOM_WS_URL)
    this.#socket = socket
    this.#awaiting = false
    // WP308：握手（连上 → 订阅成功）卡住就掐掉重连
    if (this.#handshake !== undefined) clearTimeout(this.#handshake)
    this.#handshake = setTimeout(() => {
      this.#handshake = undefined
      if (this.#socket === socket && !this.#subscribed) this.#kill(socket, onMessage)
    }, this.#options.handshake_timeout_ms ?? HANDSHAKE_TIMEOUT_MS)
    this.#handshake.unref?.()

    socket.on('open', () => {
      if (this.#socket !== socket) return
      socket.send(
        JSON.stringify(
          subscribeFrame({
            bot_id: creds.bot_id,
            secret: creds.secret,
            req_id: this.#options.newId(),
          }),
        ),
      )
    })

    socket.on('message', (data) => {
      // 已经换下来 / 判死掐掉的旧连接上的帧不算
      if (this.#socket !== socket) return
      // 收到任何一帧（含心跳回包）都说明它还活着
      this.#awaiting = false
      void this.#onFrame(data, onMessage)
    })

    socket.on('error', (err) => {
      this.#options.on_error?.(err)
    })

    socket.on('close', () => {
      // 旧连接的 close（换连接 / 判死时我们自己关的）不再触发一次重连
      if (this.#socket !== socket) return
      this.#socket = undefined
      this.#lost(onMessage)
    })
  }

  /** 这条连接没了（对端关了 / 判死）：清定时器、报「在重连」、按退避再连。 */
  #lost(onMessage: (body: WecomInboundBody, pending: WecomPendingReply) => Promise<void>): void {
    this.#subscribed = false
    this.#clearTimers()
    if (!this.#running) return
    this.#reconnects += 1
    this.#setState('reconnecting')
    const ladder = this.#options.backoff_ms ?? RECONNECT_BACKOFF_MS
    const delay = ladder[Math.min(this.#attempt, ladder.length - 1)] ?? 30_000
    this.#attempt += 1
    const timer = setTimeout(() => {
      if (!this.#running) return
      void this.#connect(onMessage).catch((e: unknown) => {
        this.#options.on_error?.(e)
      })
    }, delay)
    timer.unref?.()
  }

  /** WP308：判死——掐掉这条（不等它慢慢 close），当场按断线处理。 */
  #kill(
    socket: WecomSocket,
    onMessage: (body: WecomInboundBody, pending: WecomPendingReply) => Promise<void>,
  ): void {
    if (this.#socket !== socket) return
    this.#socket = undefined
    try {
      if (socket.terminate !== undefined) socket.terminate()
      else socket.close()
    } catch (e) {
      this.#options.on_error?.(e)
    }
    this.#lost(onMessage)
  }

  #clearTimers(): void {
    if (this.#heartbeat !== undefined) clearInterval(this.#heartbeat)
    this.#heartbeat = undefined
    if (this.#handshake !== undefined) clearTimeout(this.#handshake)
    this.#handshake = undefined
    this.#awaiting = false
  }

  #setState(state: WecomConnState): void {
    const prev = this.#state
    this.#state = state
    if (prev !== state) this.#options.on_state?.(state, prev)
  }

  async #onFrame(
    data: unknown,
    onMessage: (body: WecomInboundBody, pending: WecomPendingReply) => Promise<void>,
  ): Promise<void> {
    let frame: WecomFrame
    try {
      frame = JSON.parse(typeof data === 'string' ? data : String(data)) as WecomFrame
    } catch (e) {
      this.#options.on_error?.(e)
      return
    }
    if (frame.cmd === CMD_PONG) return
    if (subscribeOk(frame)) {
      this.#subscribed = true
      this.#error = undefined
      this.#attempt = 0
      if (this.#handshake !== undefined) clearTimeout(this.#handshake)
      this.#handshake = undefined
      this.#startHeartbeat(onMessage)
      this.#setState('connected')
      return
    }
    if (frame.cmd === 'aibot_subscribe') {
      // 订阅被拒（BotID / Secret 不对）：不重试到天荒地老，交给上层去提示重填
      this.#subscribed = false
      if (this.#handshake !== undefined) clearTimeout(this.#handshake)
      this.#handshake = undefined
      this.#error = '企业微信不认这组 BotID / Secret。去企业微信后台核一下再填。'
      this.#setState('failed')
      this.#options.on_error?.(
        new ChannelError(
          'unauthenticated',
          `企业微信订阅被拒：${frame.errmsg ?? `errcode=${frame.errcode ?? 'none'}`}`,
        ),
      )
      return
    }
    if (isDisconnectedEvent(frame)) {
      /*
       * WP308：被别处的新连接顶掉了（同一个机器人只能有一条连接）。不再自动重连——
       * 两边都自动重连就会互相踢个没完。卡片上说一句，等人决定留哪一边（重填一次凭据就会再连）。
       */
      this.#running = false
      this.#subscribed = false
      this.#clearTimers()
      this.#error = '这个企业微信机器人在别的地方连上了，这边让出来了。要用这边，重新保存一次凭据。'
      this.#setState('failed')
      this.#options.on_error?.(new ChannelError('conflict', '企业微信长连接被别处的连接顶掉'))
      return
    }
    if (isInboundEvent(frame)) return
    if (!isInboundMessage(frame)) return
    const body = frame.body
    if (body === undefined) return
    if (!isAddressedToBot(body)) return
    const req_id = frame.headers?.req_id
    if (req_id === undefined || req_id === '') return
    const msgid = wecomDedupeKey(body)
    const pending: WecomPendingReply = {
      req_id,
      chat_id: typeof body.chatid === 'string' ? body.chatid : '',
      chat_type: body.chattype === 'group' ? 'group' : 'single',
      from_user_id: body.from?.userid ?? '',
      received_at_ms: Date.parse(this.#options.clock.now()),
    }
    this.#pending.set(msgid, pending)
    this.#received += 1
    try {
      await onMessage(body, pending)
    } catch (e) {
      this.#options.on_error?.(e)
    }
  }

  #startHeartbeat(
    onMessage: (body: WecomInboundBody, pending: WecomPendingReply) => Promise<void>,
  ): void {
    if (this.#heartbeat !== undefined) clearInterval(this.#heartbeat)
    this.#awaiting = false
    this.#heartbeat = setInterval(() => {
      const socket = this.#socket
      if (socket === undefined) return
      // WP308：上一次心跳到现在一帧都没回 → 判死（最坏约两个心跳间隔发现，默认 60 秒）
      if (this.#awaiting) {
        this.#kill(socket, onMessage)
        return
      }
      try {
        socket.send(JSON.stringify(pingFrame(this.#options.newId())))
        this.#awaiting = true
      } catch (e) {
        this.#options.on_error?.(e)
      }
    }, this.#options.heartbeat_ms ?? HEARTBEAT_MS)
    // 心跳不该拖住进程退出
    this.#heartbeat.unref?.()
  }

  /** 单会话限额（文档：30 条/分钟、1000 条/小时）。 */
  #take(chat_id: string, now_ms: number): boolean {
    const perMinute = this.#options.rate?.per_minute ?? RATE_PER_MINUTE
    const perHour = this.#options.rate?.per_hour ?? RATE_PER_HOUR
    const bucket = this.#buckets.get(chat_id) ?? { minute: [], hour: [] }
    bucket.minute = bucket.minute.filter((t) => now_ms - t < 60_000)
    bucket.hour = bucket.hour.filter((t) => now_ms - t < 60 * 60_000)
    this.#buckets.set(chat_id, bucket)
    if (bucket.minute.length >= perMinute || bucket.hour.length >= perHour) return false
    bucket.minute.push(now_ms)
    bucket.hour.push(now_ms)
    return true
  }
}

/** 把它接到 18 §2 的入站管线上（管线只会调 `toInbound`）。 */
export function wecomPipelineAdapter(adapter: WecomBotAdapter): ChannelAdapter {
  return {
    name: adapter.name,
    capabilities: () => ({ ...adapter.capabilities(), thread: true, streaming: false }),
    async start() {
      /* 连接由适配器自己起；管线不驱动它 */
    },
    async stop() {
      await adapter.stop()
    },
    toInbound: async (raw, workspace_id) =>
      adapter.toInbound(raw as WecomInboundBody, workspace_id),
    async send(): Promise<never> {
      throw new ChannelError(
        'not_implemented',
        '企业微信这条通道只在 24h 回复窗口里回（用 adapter.reply），不做任意外发',
      )
    },
    health: async () => adapter.health(),
  }
}
