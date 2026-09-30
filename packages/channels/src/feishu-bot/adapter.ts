/**
 * 飞书机器人渠道适配器（WP211；与 `wecom-bot/adapter.ts` 同一套纪律）。
 *
 * 长连接交给官方 SDK（`@larksuiteoapi/node-sdk` 的 `WSClient`），但 SDK 是**注入的**
 * （`FeishuTransport`）：`@agentsws/channels` 不依赖它，测试用内存替身，CI 一行网都不出。
 * 真实现在 `apps/server/src/im-sdk.ts`，选了飞书才 `import()`。
 *
 * 四条纪律：
 * 1. **App Secret 不落在这个类里**：每次起连接都经注入的 `credentials()` 现取现用（13 §4.3）。
 * 2. **只理冲着它来的**：私聊都算，群里要 @ 机器人（`isAddressedToFeishuBot`）；
 *    机器人 / 应用自己发的一律不理（免得两个机器人对聊）。
 * 3. **事件回调立刻返回**：飞书 3 秒内收不到回执会重推（**已核实**），真正的处理
 *    （问代理可能要十几秒）放到后面去，重推靠去重键挡掉。
 * 4. **凭据错了不空转**：SDK 报鉴权失败（514）就停，给一句人话，等人去重填。
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
  FEISHU_BOT_CHANNEL,
  type FeishuDomain,
  type FeishuErrorCode,
  type FeishuMessageEvent,
  feishuDedupeKey,
  feishuErrorToHuman,
  feishuSenderId,
  isAddressedToFeishuBot,
  isFeishuAppId,
  isFromApp,
  isGroupChat,
  textOfFeishu,
} from './protocol.js'

export type FeishuConnState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'failed'

/** 官方 SDK 的最小包装。真实现见 `apps/server/src/im-sdk.ts`。 */
export interface FeishuTransport {
  start(input: {
    app_id: string
    app_secret: string
    domain: FeishuDomain
    onEvent(e: FeishuMessageEvent): void
    onState(state: FeishuConnState, detail?: string): void
  }): Promise<void>
  stop(): Promise<void>
  /** 回复一条消息（`im.v1.message.reply`；群里会挂在原消息下面）。 */
  reply(input: { message_id: string; text: string }): Promise<void>
  /** 机器人自己的 open_id（群里判 @ 用）；拿不到回 `undefined`。 */
  botOpenId(): Promise<string | undefined>
}

export type FeishuTransportFactory = () => FeishuTransport

export interface FeishuCredentials {
  app_id: string
  app_secret: string
  domain?: FeishuDomain
}

export interface FeishuPendingReply {
  message_id: string
  chat_id: string
  chat_type: 'p2p' | 'group'
  from_open_id: string
  received_at_ms: number
}

export interface FeishuInboundHead {
  schema_version: 1
  workspace_id: WorkspaceId
  channel: typeof FEISHU_BOT_CHANNEL
  kind: 'message'
  received_at: Iso8601
  occurred_at: Iso8601
  dedupe_key: string
  actor: { external_id: string }
  thread: { external_id: string }
  parts: MessagePart[]
  raw_ref: string
  secrets_scrubbed?: boolean
  sub_channel: 'feishu_bot'
  channel_meta: Record<string, unknown>
}

export interface FeishuBotAdapterOptions {
  clock: Clock
  rawStore: RawStore
  workspace_id: WorkspaceId
  /** 每次起连接现取；适配器不持有 Secret。 */
  credentials(): MaybePromise<FeishuCredentials | undefined>
  transport?: FeishuTransportFactory
  /** 待回复的条目留多久（默认 24h；飞书的回复接口本身没有窗口，这里只是别让内存无限长）。 */
  pending_ttl_ms?: number
  raw_secret_policy?: 'redact' | 'keep'
  on_error?(e: unknown): void
}

const DAY_MS = 24 * 60 * 60 * 1000

export class FeishuBotAdapter {
  readonly name = FEISHU_BOT_CHANNEL

  readonly #options: FeishuBotAdapterOptions
  readonly #pending = new Map<string, FeishuPendingReply>()
  #transport: FeishuTransport | undefined
  #state: FeishuConnState = 'idle'
  #error: { code: FeishuErrorCode; message: string } | undefined
  #botOpenId: string | undefined
  #received = 0
  #reconnects = 0
  #running = false

  constructor(options: FeishuBotAdapterOptions) {
    this.#options = options
  }

  capabilities(): { text: boolean; image: boolean; file: boolean; card: boolean } {
    // card=false：群里所有人都看得见，按钮谁都能按（见 im-cards.ts）
    return { text: true, image: false, file: false, card: false }
  }

  get state(): FeishuConnState {
    return this.#state
  }

  get connected(): boolean {
    return this.#state === 'connected'
  }

  /** 最近一次连接失败的人话（连上之后清掉）。 */
  get lastError(): { code: FeishuErrorCode; message: string } | undefined {
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
  /**
   * 起连接。`onMessage` 收到一条冲着机器人来的消息；抛异常只记不断线。
   * 没配凭据就不连（等人去消息渠道页填了再 start 一次）。
   */
  async start(
    onMessage: (e: FeishuMessageEvent, pending: FeishuPendingReply) => Promise<void>,
  ): Promise<void> {
    if (this.#running) return
    const make = this.#options.transport
    if (make === undefined) throw new ChannelError('not_implemented', '没有给飞书长连接的建连方式')
    const creds = await this.#options.credentials()
    if (creds === undefined) return
    if (!isFeishuAppId(creds.app_id)) {
      // SDK 对不合形状的 App ID 是悄悄不连；这里先拦下来给一句人话
      this.#state = 'failed'
      this.#error = feishuErrorToHuman('code=514 invalid app_id')
      return
    }
    this.#running = true
    this.#error = undefined
    this.#state = 'connecting'
    const transport = make()
    this.#transport = transport
    try {
      await transport.start({
        app_id: creds.app_id,
        app_secret: creds.app_secret,
        domain: creds.domain ?? 'feishu',
        onEvent: (e) => {
          // 立刻返回：飞书 3 秒内要回执，问代理的那一段放到后面
          void this.#onEvent(e, onMessage)
        },
        onState: (state, detail) => {
          this.#onState(state, detail)
        },
      })
    } catch (e) {
      this.#onState('failed', e instanceof Error ? e.message : String(e))
      return
    }
    try {
      this.#botOpenId = await transport.botOpenId()
    } catch (e) {
      // 拿不到机器人自己的 open_id 不致命：群里退回「有 @ 就算」（见 protocol.ts）
      this.#options.on_error?.(e)
    }
  }

  async stop(): Promise<void> {
    this.#running = false
    this.#state = 'idle'
    const t = this.#transport
    this.#transport = undefined
    await t?.stop()
  }

  /** 一条线上的消息 → 入站事件的前半段。正文在这里就脱敏，原文落受控区。 */
  async toInbound(e: FeishuMessageEvent, workspace_id: WorkspaceId): Promise<FeishuInboundHead> {
    const now = this.#options.clock.now()
    const from = feishuSenderId(e)
    const chat = e.message?.chat_id ?? ''
    const text = textOfFeishu(e)
    const scrubbed = scrubSecrets(text)
    const raw_ref = await this.#options.rawStore.put({
      channel: FEISHU_BOT_CHANNEL,
      kind: 'message',
      payload: this.#options.raw_secret_policy === 'keep' ? text : scrubbed.text,
      subject_ref: `feishu:${from}`,
      stored_at: now,
      secrets_scrubbed: scrubbed.rules.length > 0,
    })
    return {
      schema_version: 1,
      workspace_id,
      channel: FEISHU_BOT_CHANNEL,
      kind: 'message',
      received_at: now,
      occurred_at: now,
      dedupe_key: feishuDedupeKey(e),
      actor: { external_id: from },
      thread: { external_id: `feishu:${chat}` },
      parts: scrubbed.text === '' ? [] : [{ type: 'text', text: scrubbed.text }],
      raw_ref,
      secrets_scrubbed: scrubbed.rules.length > 0,
      sub_channel: 'feishu_bot',
      channel_meta: {
        chat_type: isGroupChat(e) ? 'group' : 'p2p',
        ...(e.message?.message_type === undefined ? {} : { msgtype: e.message.message_type }),
      },
    }
  }

  /** 回一条文本（按入站的去重键找回原消息）。不发也不排队的理由都说得清。 */
  async reply(dedupe_key: string, text: string): Promise<{ sent: boolean; reason?: string }> {
    const pending = this.#pending.get(dedupe_key)
    if (pending === undefined) return { sent: false, reason: 'unknown_message' }
    const t = this.#transport
    if (t === undefined) return { sent: false, reason: 'not_connected' }
    try {
      await t.reply({ message_id: pending.message_id, text })
    } catch (e) {
      this.#options.on_error?.(e)
      return { sent: false, reason: 'send_failed' }
    }
    this.#pending.delete(dedupe_key)
    return { sent: true }
  }

  /** 丢掉放太久的待回复条目（宿主定时调；不调也只是多占点内存）。 */
  prune(now_ms: number): number {
    const ttl = this.#options.pending_ttl_ms ?? DAY_MS
    let dropped = 0
    for (const [id, p] of [...this.#pending])
      if (now_ms - p.received_at_ms >= ttl) {
        this.#pending.delete(id)
        dropped += 1
      }
    return dropped
  }

  /* ── 内部 ────────────────────────────────────────────────────────── */

  #onState(state: FeishuConnState, detail?: string): void {
    const was = this.#state
    this.#state = state
    if (state === 'reconnecting' && was === 'connected') this.#reconnects += 1
    if (state === 'connected') this.#error = undefined
    if (state === 'failed') {
      this.#error = feishuErrorToHuman(detail ?? '')
      // 原始错误只进诊断出口（宿主那边只记原因，不记凭据）
      this.#options.on_error?.(
        new ChannelError(
          this.#error.code === 'bad_credentials' ? 'unauthenticated' : 'provider_unavailable',
          `飞书长连接失败：${this.#error.code}`,
        ),
      )
      if (this.#error.code === 'bad_credentials') {
        // 凭据错了重试多少次都一样：停下（状态留在 failed），等人去重填
        this.#running = false
        const t = this.#transport
        this.#transport = undefined
        void t?.stop().catch((err: unknown) => {
          this.#options.on_error?.(err)
        })
      }
    }
  }

  async #onEvent(
    e: FeishuMessageEvent,
    onMessage: (e: FeishuMessageEvent, pending: FeishuPendingReply) => Promise<void>,
  ): Promise<void> {
    if (isFromApp(e)) return
    if (!isAddressedToFeishuBot(e, this.#botOpenId)) return
    const message_id = e.message?.message_id ?? ''
    if (message_id === '') return
    const pending: FeishuPendingReply = {
      message_id,
      chat_id: e.message?.chat_id ?? '',
      chat_type: isGroupChat(e) ? 'group' : 'p2p',
      from_open_id: feishuSenderId(e),
      received_at_ms: Date.parse(this.#options.clock.now()),
    }
    this.#pending.set(feishuDedupeKey(e), pending)
    this.#received += 1
    try {
      await onMessage(e, pending)
    } catch (err) {
      this.#options.on_error?.(err)
    }
  }
}

/** 把它接到 18 §2 的入站管线上（管线只会调 `toInbound`）。 */
export function feishuPipelineAdapter(adapter: FeishuBotAdapter): ChannelAdapter {
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
      adapter.toInbound(raw as FeishuMessageEvent, workspace_id),
    async send(): Promise<never> {
      throw new ChannelError(
        'not_implemented',
        '飞书这条通道只回提问（用 adapter.reply），不做任意外发',
      )
    },
    health: async () => adapter.health(),
  }
}
