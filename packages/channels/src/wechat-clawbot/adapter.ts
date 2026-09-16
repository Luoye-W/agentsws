/**
 * 微信 ClawBot 渠道适配器（WP85；54 §5，Luoye 拍板 Q5b）。
 *
 * **它只做一件事**：本人在微信里跟**自己的代理**说话，以及代理把本人的卡片摘要
 * 推回微信。不做客服、不做团队、不主动对外发消息——ClawBot 使用条款 6.1 / 6.4
 * 里违规会牵连**主微信账号**（那是用户本人的账号）。这条定位不是产品取舍，
 * 是风险边界，所以它落在代码里：
 *
 * - `allow_from`：只处理**绑定的那个人**发来的消息，别人发的一律丢掉（不回、不入管线）；
 * - `send()` 只在「有一条最近的入站」这个前提下成立（`context_token`），
 *   没有上下文就不发——**没有主动外呼这条路**。
 *
 * 收：`getupdates` 35s 长轮询 → `get_updates_buf` 游标落盘 → `toInbound` 映射成
 * `InboundEvent` 的前半段，交给 18 §2 的入站管线（去重键 = 消息 id）。
 * 发：`sendmessage` 带上那条会话的 `context_token`；`-2` 丢缓存、`-14` 停一小时并要求重扫。
 *
 * 归属（20）：**person 的，留本机**。token 在秘密库里按 person 键存，
 * 这个类自己不持有 token 字符串——每次要用都经注入的 `token()` 现取现用。
 */

import type { ChannelAdapter, Clock, Iso8601, MessagePart, WorkspaceId } from '@agentsws/contracts'
import { sha256 } from '@agentsws/core'
import { ChannelError } from '../errors.js'
import type { RawStore } from '../raw-store.js'
import { scrubSecrets } from '../secrets.js'
import {
  BACKOFF_DELAY_MS,
  buildImageMessage,
  buildTextMessage,
  CONTEXT_TOKEN_TTL_MS,
  clawBotDedupeKey,
  DEFAULT_LONG_POLL_TIMEOUT_MS,
  isApiError,
  isStaleToken,
  MAX_CONSECUTIVE_FAILURES,
  MSG_TYPE_BOT,
  mediaKindsOf,
  RET_PREPARE_FAILED,
  RETRY_DELAY_MS,
  STALE_TOKEN_PAUSE_MS,
  textOfMessage,
  WECHAT_CLAWBOT_CHANNEL,
  type WireImageItem,
  type WireMessage,
} from './protocol.js'
import { type ClawBotStateStore, MemoryClawBotStateStore } from './state.js'
import type { ClawBotTransport } from './transport.js'

/** `toInbound` 的产出：`InboundEvent` 里由适配器负责的那一半。 */
export interface ClawBotInboundHead {
  schema_version: 1
  workspace_id: WorkspaceId
  channel: typeof WECHAT_CLAWBOT_CHANNEL
  kind: 'message'
  received_at: Iso8601
  occurred_at: Iso8601
  dedupe_key: string
  actor: { external_id: string; display?: string }
  thread: { external_id: string }
  parts: MessagePart[]
  raw_ref: string
  secrets_scrubbed?: boolean
  sub_channel: 'wechat_clawbot'
  channel_meta: Record<string, unknown>
}

export interface ClawBotAdapterOptions {
  clock: Clock
  /** 受控原始材料区：原文落这里，事件里只留 ref（18 §2.1）。 */
  rawStore: RawStore
  transport: ClawBotTransport
  /** 这条绑定的账号 id（`ilink_bot_id`）：游标与上下文缓存都按它分。 */
  account_id: string
  /** Bot API 打哪个域名（扫码确认时服务端给的 `baseurl`）。 */
  base_url: string
  /**
   * **现取现用**的 token：适配器不持有它。返回 `undefined` = 这条绑定没凭据了
   * （解绑过、或秘密库没密钥），循环自己停下来。
   */
  token(): Promise<string | undefined> | string | undefined
  /**
   * 只认这些 `from_user_id`（扫码那个人）。**空数组 = 谁都不认**——
   * 宁可一条都不处理，也不要在「本人 ↔ 代理」这条通道上代答陌生人。
   */
  allow_from: readonly string[]
  /** 游标与 `context_token` 的落点；不给就只在内存里（测试）。 */
  state?: ClawBotStateStore
  /** `context_token` 的有效期（协议文档未提供，缺省 15h，见 protocol.ts）。 */
  context_token_ttl_ms?: number
  /** 长轮询超时；服务端会用 `longpolling_timeout_ms` 改写它。 */
  long_poll_timeout_ms?: number
  /** 连续失败没到阈值时隔多久再试（缺省 2s，官方 `RETRY_DELAY_MS`）。 */
  retry_delay_ms?: number
  /** 连续失败到阈值之后退避多久（缺省 30s，官方 `BACKOFF_DELAY_MS`）。 */
  backoff_delay_ms?: number
  /** 两轮长轮询之间让出多久（缺省 0：真机上服务端自己会挂 35s）。 */
  idle_delay_ms?: number
  raw_secret_policy?: 'redact' | 'keep'
  /**
   * token 失效（`-14`）：停一小时，并且**要人去重扫**。
   * 装配方接到这个回调就该把绑定标成「要重连」，让工作台上显示出来。
   */
  onTokenStale?(input: { account_id: string; paused_until: Iso8601 }): void
  /** 循环里的异常出口（不抛出中断循环）。 */
  on_error?(e: unknown): void
}

/** 网络节奏用的真定时器（业务时间一律经 Clock，见 `#backoff` 的注释）。 */
function sleepMs(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

/** 出站结果。`skipped` = 没有可用的会话上下文，这一条**故意没发**。 */
export interface ClawBotSendResult {
  external_id?: string
  skipped?: 'no_context' | 'context_expired' | 'no_token' | 'paused'
}

/**
 * 微信 ClawBot 适配器。
 *
 * 不实现 `@agentsws/contracts` 的 `ChannelAdapter`：那个接口的 `send()` 只收
 * `connect_token`，而 ClawBot 的凭据既不在 OpenConnector 里也不是一条 workspace
 * 连接——它是**某个人本机上的**一枚 token。契约要加的那两处列在报告里，
 * 本 WP 内用这个本地形状。入站那一头照旧喂给 `ChannelInboundPipeline`
 * （见 `toInbound` 与 `clawBotPipelineAdapter`）。
 */
export class WeChatClawBotAdapter {
  readonly name = WECHAT_CLAWBOT_CHANNEL
  readonly account_id: string

  readonly #options: ClawBotAdapterOptions
  readonly #state: ClawBotStateStore
  readonly #ttlMs: number
  #running = false
  #abort: AbortController | undefined
  #loop: Promise<void> | undefined
  #pausedUntilMs = 0
  #lastPollAt: Iso8601 | undefined
  #received = 0

  constructor(options: ClawBotAdapterOptions) {
    this.#options = options
    this.account_id = options.account_id
    this.#state = options.state ?? new MemoryClawBotStateStore()
    this.#ttlMs = options.context_token_ttl_ms ?? CONTEXT_TOKEN_TTL_MS
  }

  capabilities(): { text: boolean; image: boolean; file: boolean; card: boolean } {
    // card=false 是个**结论**不是缺口：审批动作不在 IM 里做（见 `renderCardForIm`）。
    return { text: true, image: true, file: false, card: false }
  }

  /** 这个人的消息我们认不认。 */
  allows(from_user_id: string): boolean {
    return this.#options.allow_from.includes(from_user_id)
  }

  /** 正在停机（`-14` 之后的一小时）到什么时候；没停返回 `undefined`。 */
  pausedUntil(): Iso8601 | undefined {
    return this.#pausedUntilMs === 0 ? undefined : new Date(this.#pausedUntilMs).toISOString()
  }

  health(): { ok: boolean; detail?: string } {
    const paused = this.pausedUntil()
    if (paused !== undefined)
      return { ok: false, detail: `微信登录失效，${paused} 之后才会再试；请重新扫码` }
    return this.#running
      ? { ok: true, ...(this.#lastPollAt === undefined ? {} : { detail: this.#lastPollAt }) }
      : { ok: false, detail: '没有在收信' }
  }

  /** 观察面：这条绑定收到过几条。 */
  get received(): number {
    return this.#received
  }

  /**
   * 一条线上的消息 → 入站事件的前半段。
   *
   * 正文在这里就**脱敏**（31 §4：秘密脱敏之后才落 raw），原文落受控区，
   * 事件里只留 `raw_ref`。围栏由管线统一加（它对所有渠道一视同仁）。
   */
  async toInbound(msg: WireMessage, workspace_id: WorkspaceId): Promise<ClawBotInboundHead> {
    const now = this.#options.clock.now()
    const from = msg.from_user_id ?? ''
    const text = textOfMessage(msg)
    const scrubbed = scrubSecrets(text)
    const raw_ref = await this.#options.rawStore.put({
      channel: WECHAT_CLAWBOT_CHANNEL,
      kind: 'message',
      // 31 §4：受控区留的是**去秘密之后**的原文
      payload: this.#options.raw_secret_policy === 'keep' ? text : scrubbed.text,
      subject_ref: `wechat:${from}`,
      stored_at: now,
      secrets_scrubbed: scrubbed.rules.length > 0,
    })
    const media = mediaKindsOf(msg)
    const parts: MessagePart[] = []
    if (scrubbed.text !== '') parts.push({ type: 'text', text: scrubbed.text })
    for (const kind of media)
      if (kind === 'image')
        // 图片字节留在微信 CDN（AES-128-ECB 加密）；事件里只放一条引用，
        // 真要取的时候才按 `aeskey` 解——那把 key 是秘密，永不进事件。
        parts.push({ type: 'image', ref: `${raw_ref}#image`, name: '微信图片' })
    const occurred =
      msg.create_time_ms === undefined ? now : new Date(msg.create_time_ms).toISOString()
    return {
      schema_version: 1,
      workspace_id,
      channel: WECHAT_CLAWBOT_CHANNEL,
      kind: 'message',
      received_at: now,
      occurred_at: occurred,
      dedupe_key: clawBotDedupeKey(msg),
      actor: { external_id: from },
      // 一个人一条线程：ClawBot 里本来就只有「本人 ↔ 代理」这一条对话
      thread: { external_id: `wechat:${this.account_id}:${from}` },
      parts,
      raw_ref,
      secrets_scrubbed: scrubbed.rules.length > 0,
      sub_channel: 'wechat_clawbot',
      channel_meta: {
        account_id: this.account_id,
        ...(media.length === 0 ? {} : { media }),
        ...(msg.session_id === undefined ? {} : { session_id: msg.session_id }),
      },
    }
  }

  /**
   * 开始收信。调用方给一个 `onMessage`：一条线上的消息交给它，
   * 它负责喂管线。抛异常只记不停——一条消息炸了不该让整条通道停掉。
   */
  start(onMessage: (msg: WireMessage) => Promise<void>): void {
    if (this.#running) return
    this.#running = true
    this.#abort = new AbortController()
    this.#loop = this.#pump(onMessage)
  }

  async stop(): Promise<void> {
    this.#running = false
    this.#abort?.abort()
    const loop = this.#loop
    this.#loop = undefined
    if (loop !== undefined) await loop
  }

  /**
   * 回一条文本。
   *
   * **没有可用的 `context_token` 就不发**（返回 `skipped`）。这不是降级，
   * 是定位：ClawBot 不做主动外呼，只在本人刚说过话的那条会话里回。
   */
  async sendText(to_user_id: string, text: string): Promise<ClawBotSendResult> {
    return this.#send(to_user_id, (context_token, client_id) =>
      buildTextMessage({
        to_user_id,
        text,
        client_id,
        ...(context_token === undefined ? {} : { context_token }),
      }),
    )
  }

  /** 回一张图（图片已经在 CDN 上，这里只带引用）。 */
  async sendImage(to_user_id: string, image: WireImageItem): Promise<ClawBotSendResult> {
    return this.#send(to_user_id, (context_token, client_id) =>
      buildImageMessage({
        to_user_id,
        image,
        client_id,
        ...(context_token === undefined ? {} : { context_token }),
      }),
    )
  }

  /** 解绑：游标与上下文缓存一起清掉（token 由秘密库那边销毁）。 */
  async forget(): Promise<void> {
    await this.stop()
    await this.#state.clear(this.account_id)
  }

  /* ── 内部 ────────────────────────────────────────────────────────── */

  async #send(
    to_user_id: string,
    build: (
      context_token: string | undefined,
      client_id: string,
    ) => ReturnType<typeof buildTextMessage>,
  ): Promise<ClawBotSendResult> {
    const now_ms = Date.parse(this.#options.clock.now())
    if (this.#pausedUntilMs > now_ms) return { skipped: 'paused' }
    const token = await this.#options.token()
    if (token === undefined || token === '') return { skipped: 'no_token' }
    const context_token = await this.#state.contextToken(this.account_id, to_user_id, now_ms)
    if (context_token === undefined) return { skipped: 'no_context' }
    const client_id = `agentsws_${sha256(`${this.account_id}|${to_user_id}|${now_ms}`).slice(0, 16)}`
    const resp = await this.#options.transport.sendMessage({
      base_url: this.#options.base_url,
      token,
      body: build(context_token, client_id),
    })
    if (isStaleToken(resp)) {
      this.#pause(now_ms)
      return { skipped: 'paused' }
    }
    if (resp.ret === RET_PREPARE_FAILED) {
      // 这条会话上下文不能用了：丢掉缓存，等本人下一条消息带来新的
      await this.#state.clearContextToken(this.account_id, to_user_id)
      return { skipped: 'context_expired' }
    }
    if (isApiError(resp))
      throw new ChannelError('provider_error', `微信 sendmessage 失败：ret=${resp.ret ?? 'none'}`, {
        ret: resp.ret,
      })
    return { ...(resp.message_id === undefined ? {} : { external_id: resp.message_id }) }
  }

  async #pump(onMessage: (msg: WireMessage) => Promise<void>): Promise<void> {
    let timeout = this.#options.long_poll_timeout_ms ?? DEFAULT_LONG_POLL_TIMEOUT_MS
    let failures = 0
    let buf = (await this.#state.cursor(this.account_id)) ?? ''
    while (this.#running) {
      const now_ms = Date.parse(this.#options.clock.now())
      if (this.#pausedUntilMs > now_ms) {
        // `-14` 之后不在这里空等一小时：这条通道要**人去重扫**才活得过来
        // （`onTokenStale` 已经通知装配方了）。循环就此结束，省得一个死连接
        // 在后台每小时醒一次去撞同一堵墙。
        this.#running = false
        return
      }
      let token: string | undefined
      try {
        token = await this.#options.token()
      } catch (e) {
        this.#options.on_error?.(e)
      }
      if (token === undefined || token === '') {
        // 解绑了 / 秘密库没密钥：不再空转
        this.#running = false
        return
      }
      try {
        const signal = this.#abort?.signal
        const resp = await this.#options.transport.getUpdates({
          base_url: this.#options.base_url,
          token,
          get_updates_buf: buf,
          timeout_ms: timeout,
          ...(signal === undefined ? {} : { signal }),
        })
        if (resp.longpolling_timeout_ms !== undefined && resp.longpolling_timeout_ms > 0)
          timeout = resp.longpolling_timeout_ms
        if (isApiError(resp)) {
          if (isStaleToken(resp)) {
            this.#pause(Date.parse(this.#options.clock.now()))
            failures = 0
            continue
          }
          failures += 1
          await this.#backoff(failures)
          if (failures >= MAX_CONSECUTIVE_FAILURES) failures = 0
          continue
        }
        failures = 0
        this.#lastPollAt = this.#options.clock.now()
        // 游标**先落盘再处理**：处理中途崩了，重启时这一批会被去重表挡住，
        // 而不是永远卡在同一个 buf 上重放。
        if (resp.get_updates_buf !== undefined && resp.get_updates_buf !== '') {
          buf = resp.get_updates_buf
          await this.#state.setCursor(this.account_id, buf)
        }
        for (const msg of resp.msgs ?? []) {
          const from = msg.from_user_id ?? ''
          // bot 自己发的那几条会原样回来：不处理
          if (msg.message_type === MSG_TYPE_BOT) continue
          // allow-list：不是绑定的那个人，直接丢（不回、不入管线、不落事件）
          if (!this.allows(from)) continue
          const ctx = msg.context_token
          if (ctx !== undefined && ctx !== '') {
            await this.#state.setContextToken(this.account_id, from, {
              token: ctx,
              expires_at_ms: Date.parse(this.#options.clock.now()) + this.#ttlMs,
            })
          }
          this.#received += 1
          try {
            await onMessage(msg)
          } catch (e) {
            this.#options.on_error?.(e)
          }
        }
        // 真机上 `getupdates` 自己会挂 35s；假服务器是秒回的。这一跳让出宏任务，
        // 免得空转的循环把事件循环饿死（**不是**业务时间，所以不经 Clock）。
        await this.#idle()
      } catch (e) {
        if (!this.#running) return
        this.#options.on_error?.(e)
        failures += 1
        await this.#backoff(failures)
        if (failures >= MAX_CONSECUTIVE_FAILURES) failures = 0
      }
    }
  }

  /**
   * 退避。
   *
   * 用真定时器而不是注入的 Clock：这是「隔多久再打一次网络请求」，不是业务时间。
   * 业务时间（停机到点没到点、`context_token` 过没过期）全部经 Clock——
   * 那些才是测试要拨快的东西。两个数字都可注入，测试把它们调成 1ms。
   */
  async #backoff(failures: number): Promise<void> {
    await sleepMs(
      failures >= MAX_CONSECUTIVE_FAILURES
        ? (this.#options.backoff_delay_ms ?? BACKOFF_DELAY_MS)
        : (this.#options.retry_delay_ms ?? RETRY_DELAY_MS),
    )
  }

  async #idle(): Promise<void> {
    await sleepMs(this.#options.idle_delay_ms ?? 0)
  }

  #pause(now_ms: number): void {
    this.#pausedUntilMs = now_ms + STALE_TOKEN_PAUSE_MS
    this.#options.onTokenStale?.({
      account_id: this.account_id,
      paused_until: new Date(this.#pausedUntilMs).toISOString(),
    })
  }
}

/**
 * 把这个适配器接到 18 §2 的入站管线上。
 *
 * 管线按 `ChannelName` 分派，只会调 `toInbound`——收信循环由适配器自己跑
 * （长轮询不是「管线来拉」那种形状），出站也不经管线（`send` 在这里就该炸：
 * **ClawBot 没有主动外呼**，要发就走适配器的 `sendText`，它自己会检查会话上下文）。
 */
export function clawBotPipelineAdapter(adapter: WeChatClawBotAdapter): ChannelAdapter {
  return {
    name: adapter.name,
    capabilities: () => ({
      ...adapter.capabilities(),
      thread: true,
      streaming: false,
    }),
    async start() {
      /* 收信循环归适配器自己；管线不驱动它 */
    },
    async stop() {
      await adapter.stop()
    },
    toInbound: async (raw, workspace_id) => adapter.toInbound(raw as WireMessage, workspace_id),
    async send() {
      throw new ChannelError(
        'not_implemented',
        '微信这条通道不做主动外呼：只在本人刚说过话的那条会话里回（54 §5 / 条款 6.1）',
      )
    },
    health: async () => adapter.health(),
  }
}
