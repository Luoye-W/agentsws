/**
 * 钉钉机器人渠道适配器（WP211；Stream 模式，与 `wecom-bot/adapter.ts` 同一个形状）。
 *
 * 一次 HTTP 换 ticket → 一条 WebSocket → 收 `CALLBACK /v1.0/im/bot/messages/get`
 * → **马上回执**（60 秒内不回执钉钉会重推）→ 交给 18 §2 的入站管线 → 代理答完之后
 * 经那条消息自带的 `sessionWebhook` 回一句。
 *
 * 纪律：
 * 1. **Client Secret 不落在这个类里**：每次（含重连）换 ticket 都经 `credentials()` 现取。
 * 2. **凭据错了不空转**：换 ticket 回 4xx 就停，给一句人话，等人去重填（官方 Node SDK
 *    在这里是每秒重试、吞掉错误——这是我们不直接用它的主要原因，见 protocol.ts 文件头）。
 * 3. **断线重连**：退避梯子 1s → 60s；重连前先关旧连接；服务端发 `disconnect` 就主动换一条。
 * 4. **只往钉钉自己的域名回**：`sessionWebhook` 不是 `https://*.dingtalk.com` 就不发。
 *
 * WebSocket 与 HTTP 都是**注入的**：`@agentsws/channels` 不依赖 `ws`，测试全在内存里。
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
  ackFrame,
  DINGTALK_BACKOFF_MS,
  DINGTALK_BOT_CHANNEL,
  DINGTALK_GATEWAY_URL,
  type DingtalkDownStream,
  type DingtalkErrorCode,
  type DingtalkRobotMessage,
  dingtalkDedupeKey,
  dingtalkErrorToHuman,
  dingtalkSenderId,
  isAddressedToDingtalkBot,
  isDingtalkWebhook,
  isGroupConversation,
  openConnectionBody,
  pongFrame,
  sessionReplyBody,
  TOPIC_ROBOT,
  textOfDingtalk,
} from './protocol.js'

/** 一条长连接的最小形状（`ws` 的 `WebSocket` 结构上满足它；与企业微信那条同形）。 */
export interface DingtalkSocket {
  send(data: string): void
  close(): void
  on(event: 'open', cb: () => void): void
  on(event: 'message', cb: (data: unknown) => void): void
  on(event: 'close', cb: () => void): void
  on(event: 'error', cb: (err: unknown) => void): void
}

export type DingtalkSocketFactory = (url: string) => DingtalkSocket

/** 最小的 HTTP 口（`globalThis.fetch` 结构上满足它）。 */
export type DingtalkHttp = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string },
) => Promise<{ status: number; json(): Promise<unknown> }>

export type DingtalkConnState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'failed'

export interface DingtalkCredentials {
  client_id: string
  client_secret: string
}

export interface DingtalkPendingReply {
  webhook: string
  /** 毫秒时间戳；过了就不能再经这个地址回。 */
  expires_at_ms: number
  conversation_id: string
  group: boolean
  sender_staff_id: string
}

export interface DingtalkInboundHead {
  schema_version: 1
  workspace_id: WorkspaceId
  channel: typeof DINGTALK_BOT_CHANNEL
  kind: 'message'
  received_at: Iso8601
  occurred_at: Iso8601
  dedupe_key: string
  actor: { external_id: string; display?: string }
  thread: { external_id: string }
  parts: MessagePart[]
  raw_ref: string
  secrets_scrubbed?: boolean
  sub_channel: 'dingtalk_bot'
  channel_meta: Record<string, unknown>
}

export interface DingtalkBotAdapterOptions {
  clock: Clock
  rawStore: RawStore
  workspace_id: WorkspaceId
  credentials(): MaybePromise<DingtalkCredentials | undefined>
  socket?: DingtalkSocketFactory
  /** 缺省用 `globalThis.fetch`。 */
  http?: DingtalkHttp
  gateway_url?: string
  backoff_ms?: readonly number[]
  raw_secret_policy?: 'redact' | 'keep'
  on_error?(e: unknown): void
}

type OnMessage = (m: DingtalkRobotMessage, pending: DingtalkPendingReply) => Promise<void>

export class DingtalkBotAdapter {
  readonly name = DINGTALK_BOT_CHANNEL

  readonly #options: DingtalkBotAdapterOptions
  readonly #pending = new Map<string, DingtalkPendingReply>()
  #socket: DingtalkSocket | undefined
  #timer: ReturnType<typeof setTimeout> | undefined
  #state: DingtalkConnState = 'idle'
  #error: { code: DingtalkErrorCode; message: string } | undefined
  #running = false
  #attempt = 0
  #received = 0
  #reconnects = 0

  constructor(options: DingtalkBotAdapterOptions) {
    this.#options = options
  }

  capabilities(): { text: boolean; image: boolean; file: boolean; card: boolean } {
    // card=false：群里所有人都看得见，按钮谁都能按（见 im-cards.ts）
    return { text: true, image: false, file: false, card: false }
  }

  get state(): DingtalkConnState {
    return this.#state
  }

  get connected(): boolean {
    return this.#state === 'connected'
  }

  get lastError(): { code: DingtalkErrorCode; message: string } | undefined {
    return this.#error
  }

  get received(): number {
    return this.#received
  }

  get reconnects(): number {
    return this.#reconnects
  }

  get pending(): number {
    return this.#pending.size
  }

  health(): { ok: boolean; detail?: string } {
    if (this.#state === 'connected') return { ok: true }
    if (this.#error !== undefined) return { ok: false, detail: this.#error.message }
    return { ok: false, detail: this.#running ? '长连接还没连上（在重连）' : '没有在连' }
  }

  /** 起连接。没配凭据就不连（等人去消息渠道页填了再 start 一次）。 */
  async start(onMessage: OnMessage): Promise<void> {
    if (this.#running) return
    if (this.#options.socket === undefined)
      throw new ChannelError('not_implemented', '没有给钉钉长连接的建连方式')
    this.#running = true
    this.#error = undefined
    this.#attempt = 0
    this.#state = 'connecting'
    await this.#connect(onMessage)
  }

  async stop(): Promise<void> {
    this.#running = false
    this.#state = 'idle'
    if (this.#timer !== undefined) clearTimeout(this.#timer)
    this.#timer = undefined
    const s = this.#socket
    this.#socket = undefined
    s?.close()
  }

  /** 一条线上的消息 → 入站事件的前半段。正文在这里就脱敏，原文落受控区。 */
  async toInbound(
    m: DingtalkRobotMessage,
    workspace_id: WorkspaceId,
  ): Promise<DingtalkInboundHead> {
    const now = this.#options.clock.now()
    const from = dingtalkSenderId(m)
    const text = textOfDingtalk(m)
    const scrubbed = scrubSecrets(text)
    const raw_ref = await this.#options.rawStore.put({
      channel: DINGTALK_BOT_CHANNEL,
      kind: 'message',
      payload: this.#options.raw_secret_policy === 'keep' ? text : scrubbed.text,
      subject_ref: `dingtalk:${from}`,
      stored_at: now,
      secrets_scrubbed: scrubbed.rules.length > 0,
    })
    return {
      schema_version: 1,
      workspace_id,
      channel: DINGTALK_BOT_CHANNEL,
      kind: 'message',
      received_at: now,
      occurred_at: now,
      dedupe_key: dingtalkDedupeKey(m),
      actor: {
        external_id: from,
        ...(typeof m.senderNick === 'string' ? { display: m.senderNick } : {}),
      },
      thread: { external_id: `dingtalk:${m.conversationId ?? ''}` },
      parts: scrubbed.text === '' ? [] : [{ type: 'text', text: scrubbed.text }],
      raw_ref,
      secrets_scrubbed: scrubbed.rules.length > 0,
      sub_channel: 'dingtalk_bot',
      channel_meta: {
        chat_type: isGroupConversation(m) ? 'group' : 'single',
        ...(m.msgtype === undefined ? {} : { msgtype: m.msgtype }),
      },
    }
  }

  /** 经那条消息自带的 `sessionWebhook` 回一句。不发的理由都说得清，不排队、不补发。 */
  async reply(dedupe_key: string, text: string): Promise<{ sent: boolean; reason?: string }> {
    const pending = this.#pending.get(dedupe_key)
    if (pending === undefined) return { sent: false, reason: 'unknown_message' }
    const now_ms = Date.parse(this.#options.clock.now())
    if (now_ms >= pending.expires_at_ms) {
      this.#pending.delete(dedupe_key)
      return { sent: false, reason: 'reply_window_closed' }
    }
    if (!isDingtalkWebhook(pending.webhook)) {
      this.#pending.delete(dedupe_key)
      return { sent: false, reason: 'bad_webhook' }
    }
    const body = sessionReplyBody(text, pending.group ? pending.sender_staff_id : undefined)
    try {
      const res = await this.#http()(pending.webhook, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const out = (await res.json().catch(() => ({}))) as { errcode?: number }
      if (res.status < 200 || res.status >= 300 || (out.errcode ?? 0) !== 0)
        return { sent: false, reason: 'send_failed' }
    } catch (e) {
      this.#options.on_error?.(e)
      return { sent: false, reason: 'send_failed' }
    }
    this.#pending.delete(dedupe_key)
    return { sent: true }
  }

  /** 丢掉过了窗口的待回复条目（宿主定时调）。 */
  prune(now_ms: number): number {
    let dropped = 0
    for (const [id, p] of [...this.#pending])
      if (now_ms >= p.expires_at_ms) {
        this.#pending.delete(id)
        dropped += 1
      }
    return dropped
  }

  /* ── 内部 ────────────────────────────────────────────────────────── */

  #http(): DingtalkHttp {
    return this.#options.http ?? (globalThis.fetch as unknown as DingtalkHttp)
  }

  async #connect(onMessage: OnMessage): Promise<void> {
    const creds = await this.#options.credentials()
    if (creds === undefined) {
      this.#running = false
      this.#state = 'idle'
      return
    }
    let status: number | undefined
    let ticket: { endpoint?: string; ticket?: string } = {}
    try {
      const res = await this.#http()(this.#options.gateway_url ?? DINGTALK_GATEWAY_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(
          openConnectionBody({ client_id: creds.client_id, client_secret: creds.client_secret }),
        ),
      })
      status = res.status
      if (status >= 200 && status < 300)
        ticket = ((await res.json().catch(() => ({}))) ?? {}) as typeof ticket
    } catch (e) {
      this.#options.on_error?.(e)
    }
    if (!this.#running) return
    if (ticket.endpoint === undefined || ticket.ticket === undefined) {
      this.#error = dingtalkErrorToHuman(status)
      if (this.#error.code === 'bad_credentials') {
        // 凭据错了重试多少次都一样：停下，等人去重填（原始响应不进这里）
        this.#running = false
        this.#state = 'failed'
        this.#options.on_error?.(
          new ChannelError('unauthenticated', `钉钉换 ticket 被拒：HTTP ${status}`),
        )
        return
      }
      this.#schedule(onMessage)
      return
    }
    // 重连前先关旧的：同一个应用多开连接只会互相踢
    this.#socket?.close()
    const url = `${ticket.endpoint}?ticket=${encodeURIComponent(ticket.ticket)}`
    const socket = (this.#options.socket as DingtalkSocketFactory)(url)
    this.#socket = socket
    socket.on('open', () => {
      if (this.#socket !== socket) return
      this.#state = 'connected'
      this.#error = undefined
      this.#attempt = 0
    })
    socket.on('message', (data) => {
      this.#onFrame(socket, data, onMessage)
    })
    socket.on('error', (err) => {
      this.#options.on_error?.(err)
    })
    socket.on('close', () => {
      // 旧连接的 close（我们自己换连接时关的）不触发重连
      if (this.#socket !== socket) return
      this.#socket = undefined
      if (!this.#running) return
      this.#reconnects += 1
      this.#schedule(onMessage)
    })
  }

  #schedule(onMessage: OnMessage): void {
    this.#state = 'reconnecting'
    const ladder = this.#options.backoff_ms ?? DINGTALK_BACKOFF_MS
    const delay = ladder[Math.min(this.#attempt, ladder.length - 1)] ?? 60_000
    this.#attempt += 1
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      if (!this.#running) return
      void this.#connect(onMessage).catch((e: unknown) => {
        this.#options.on_error?.(e)
      })
    }, delay)
    this.#timer.unref?.()
  }

  #onFrame(socket: DingtalkSocket, data: unknown, onMessage: OnMessage): void {
    let down: DingtalkDownStream
    try {
      down = JSON.parse(typeof data === 'string' ? data : String(data)) as DingtalkDownStream
    } catch (e) {
      this.#options.on_error?.(e)
      return
    }
    const topic = down.headers?.topic
    if (down.type === 'SYSTEM') {
      if (topic === 'ping') socket.send(pongFrame(down))
      // 服务端要我们换一条连接（发布 / 迁移）：关掉，close 里按退避重连
      if (topic === 'disconnect') socket.close()
      return
    }
    if (down.type !== 'CALLBACK') return
    const messageId = down.headers?.messageId
    // 先回执：处理（问代理）可能要十几秒，超过 60 秒钉钉就会重推
    if (typeof messageId === 'string' && messageId !== '') socket.send(ackFrame(messageId))
    if (topic !== TOPIC_ROBOT) return
    let m: DingtalkRobotMessage
    try {
      m = JSON.parse(down.data ?? '{}') as DingtalkRobotMessage
    } catch (e) {
      this.#options.on_error?.(e)
      return
    }
    void this.#onRobotMessage(m, onMessage)
  }

  async #onRobotMessage(m: DingtalkRobotMessage, onMessage: OnMessage): Promise<void> {
    if (!isAddressedToDingtalkBot(m)) return
    const webhook = typeof m.sessionWebhook === 'string' ? m.sessionWebhook : ''
    if (webhook === '') return
    const pending: DingtalkPendingReply = {
      webhook,
      expires_at_ms:
        typeof m.sessionWebhookExpiredTime === 'number'
          ? m.sessionWebhookExpiredTime
          : Date.parse(this.#options.clock.now()) + 60 * 60 * 1000,
      conversation_id: m.conversationId ?? '',
      group: isGroupConversation(m),
      sender_staff_id: typeof m.senderStaffId === 'string' ? m.senderStaffId : '',
    }
    this.#pending.set(dingtalkDedupeKey(m), pending)
    this.#received += 1
    try {
      await onMessage(m, pending)
    } catch (e) {
      this.#options.on_error?.(e)
    }
  }
}

/** 把它接到 18 §2 的入站管线上（管线只会调 `toInbound`）。 */
export function dingtalkPipelineAdapter(adapter: DingtalkBotAdapter): ChannelAdapter {
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
      adapter.toInbound(raw as DingtalkRobotMessage, workspace_id),
    async send(): Promise<never> {
      throw new ChannelError(
        'not_implemented',
        '钉钉这条通道只在 sessionWebhook 有效期内回提问（用 adapter.reply），不做任意外发',
      )
    },
    health: async () => adapter.health(),
  }
}
