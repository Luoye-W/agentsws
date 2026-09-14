/**
 * 在线聊天渠道适配器（`ChannelAdapter`，name='chat'；WP57）。
 *
 * 形状照邮件适配器写，所以入站走的是**同一条** `ChannelInboundPipeline`：
 * 去重 → 围栏 + 秘密脱敏 → 解析 → 路由 → 排队 → 触发，一跳都不重写。
 *
 * 三处与邮件不同，每一处都有理由：
 *
 * 1. **没有 `start` 轮询循环**。邮件要去 IMAP 把信拉回来；聊天是推过来的
 *    （沙盒页 / 托管档的公网端点调 `ingest`），所以 `start` 只记下 handler，
 *    真正的入口是 `receive()`。
 * 2. **`send` 不发信，是往会话里推**。收件人门禁的形态也随之变了：邮件是
 *    "收件人只从线程台账取"，聊天是"只往**已经存在的会话**里推"——
 *    `thread.external_id` 认不出来就拒，模型给不了一个新的会话 id。
 * 3. **限流在适配器里**。邮件的速率由 IMAP 那头决定，聊天由访客决定，
 *    所以第一道门要在最外层（见 `rate-limit.ts` 里为什么）。
 *
 * 与邮件一致的地方：原文落受控原始材料区（`subject_ref` = 访客 id，按它加密、
 * 按它随主体删除），事件里只留 `raw_ref`；`parts.text` 在这里仍是**未围栏未脱敏**
 * 的解析结果——围栏与秘密检测是管线的一跳，适配器只负责"取到正确的文本"。
 */
import type {
  ChannelAdapter,
  ChannelName,
  Clock,
  InboundEvent,
  MessagePart,
  WorkspaceId,
} from '@agentsws/contracts'
import { redactOutboundText } from '@agentsws/core'
import { ChannelError } from '../errors.js'
import type { RawStore } from '../raw-store.js'
import { scrubSecrets } from '../secrets.js'
import { ChatRateLimiter, type ChatRateLimitPolicy, type ChatRateVerdict } from './rate-limit.js'
import { ChatSessionStream } from './stream.js'
import {
  type ChatMessage,
  type ChatSession,
  type ChatSource,
  type ChatStore,
  chatDedupeKey,
  type RawChatMessage,
} from './types.js'

export interface ChatAdapterOptions {
  clock: Clock
  /** 会话与消息的落库口。 */
  store: ChatStore
  /** 受控原始材料区：访客原文落这里，事件里只留 ref。 */
  rawStore: RawStore
  /** 出站推送；不给就自己起一条（沙盒与真访客共用同一条时由宿主传进来）。 */
  stream?: ChatSessionStream
  /** 每访客限流；不给用默认（20/min、200/h）。 */
  rate_limit?: Partial<ChatRateLimitPolicy>
  /** 原始材料区里的秘密处理：默认 redact（31 §4）。 */
  raw_secret_policy?: 'redact' | 'keep'
}

/** `receive` 的结果：被限流挡下时不入库、不进管线。 */
export interface ChatReceiveResult {
  accepted: boolean
  rate: ChatRateVerdict
  message?: ChatMessage
}

export class ChatChannelAdapter implements ChannelAdapter {
  readonly name: ChannelName = 'chat'
  readonly store: ChatStore
  readonly stream: ChatSessionStream

  private readonly clock: Clock
  private readonly rawStore: RawStore
  private readonly limiter: ChatRateLimiter
  private readonly rawSecretPolicy: 'redact' | 'keep'
  private handler: ((raw: unknown) => Promise<void>) | undefined
  private readonly sentByKey = new Map<string, string>()
  private running = false

  constructor(opts: ChatAdapterOptions) {
    this.clock = opts.clock
    this.store = opts.store
    this.rawStore = opts.rawStore
    this.stream = opts.stream ?? new ChatSessionStream()
    this.limiter = new ChatRateLimiter(opts.rate_limit ?? {})
    this.rawSecretPolicy = opts.raw_secret_policy ?? 'redact'
  }

  capabilities(): {
    text: boolean
    image: boolean
    file: boolean
    card: boolean
    thread: boolean
    streaming: boolean
  } {
    // v1 只收发纯文本。`streaming: true` 说的是出站会话内推送（SSE），
    // 不是"模型逐字吐"——那是运行时那一层的事。
    return { text: true, image: false, file: false, card: false, thread: true, streaming: true }
  }

  async start(handler: (raw: unknown) => Promise<void>): Promise<void> {
    this.handler = handler
    this.running = true
  }

  async stop(): Promise<void> {
    this.running = false
    this.handler = undefined
  }

  get started(): boolean {
    return this.running
  }

  /** 取或建一条会话（唯一键 `(workspace, source, external_session_id)`）。 */
  async openSession(input: {
    workspace_id: WorkspaceId
    source: ChatSource
    external_session_id: string
    visitor_id: string
    visitor_display?: string
  }): Promise<ChatSession> {
    return this.store.ensureSession({ ...input, at: this.clock.now() })
  }

  /**
   * 收一条访客消息：限流 → 落库 → 交给管线。
   *
   * **顺序是有讲究的**：限流在落库之前。被挡下的消息不该在库里留下任何痕迹，
   * 否则"挡住了"就只是"没起运行"，库还是在被一条一条地写。
   */
  async receive(input: {
    workspace_id: WorkspaceId
    session_id: string
    external_id: string
    text: string
  }): Promise<ChatReceiveResult> {
    const session = await this.store.getSession(input.session_id)
    if (session === undefined) {
      throw new ChannelError('not_found', `没有这条会话：${input.session_id}`, {
        session_id: input.session_id,
      })
    }
    const now = this.clock.now()
    const rate = this.limiter.take(input.workspace_id, session.visitor_id, Date.parse(now))
    if (!rate.allowed) return { accepted: false, rate }

    const message = await this.store.appendMessage({
      session_id: session.id,
      workspace_id: input.workspace_id,
      role: 'visitor',
      text: input.text,
      at: now,
      external_id: input.external_id,
    })
    await this.store.patchSession(session.id, { last_seen_at: now, at: now })
    this.stream.publish(session.id, { type: 'message', message })

    const raw: RawChatMessage = {
      session_id: session.id,
      external_id: input.external_id,
      visitor_id: session.visitor_id,
      text: input.text,
      at: now,
      ...(session.visitor_display === undefined
        ? {}
        : { visitor_display: session.visitor_display }),
    }
    await this.handler?.(raw)
    return { accepted: true, rate, message }
  }

  /**
   * 原始载荷 → `InboundEvent` 的前半段（管线补 id / 路由 / 脱敏标记）。
   *
   * 去重键 = **会话 + 消息 id**（18 §2.2）。没有 Message-ID 那种全局唯一物，
   * 会话 id 就是那个作用域——同一条消息重投只产出一条事件。
   */
  async toInbound(
    raw: unknown,
    workspace_id: WorkspaceId,
  ): Promise<Omit<InboundEvent, 'id' | 'routing' | 'secrets_scrubbed'>> {
    const msg = asRawChat(raw)
    const session = await this.store.getSession(msg.session_id)
    if (session === undefined) {
      throw new ChannelError('not_found', `没有这条会话：${msg.session_id}`, {
        session_id: msg.session_id,
      })
    }
    const received_at = this.clock.now()

    // 原文进受控原始材料区（不进模型）。`subject_ref` = 访客 id：
    // 受控区按它加密、按它随主体删除（21 §4 / 18 §2.1）。没有它就是明文落盘。
    const body =
      this.rawSecretPolicy === 'redact' ? scrubSecrets(msg.text) : { text: msg.text, rules: [] }
    const raw_ref = await this.rawStore.put({
      channel: 'chat',
      kind: 'message',
      stored_at: received_at,
      payload: body.text,
      mime: 'text/plain',
      subject_ref: session.visitor_id,
      name: `${session.id}/${msg.external_id}`,
      ...(body.rules.length > 0 ? { secrets_scrubbed: true } : {}),
    })

    const parts: MessagePart[] = [{ type: 'text', text: msg.text }]
    return {
      schema_version: 1,
      workspace_id,
      channel: 'chat',
      kind: 'message',
      received_at,
      occurred_at: msg.at,
      dedupe_key: chatDedupeKey(session.id, msg.external_id),
      actor: {
        external_id: session.visitor_id,
        display: session.visitor_display ?? msg.visitor_display ?? session.visitor_id,
      },
      thread: { external_id: session.thread_external_id },
      parts,
      raw_ref,
    }
  }

  /**
   * 出站：往这条会话里推一条 AI 消息。
   *
   * 会话门禁（邮件那边是收件人门禁，31 §3.3 的同一条纪律）：
   * `thread.external_id` 必须对应一条**已经存在的**会话——模型给不出一个新的
   * 会话 id，也就推不到别人的聊天窗里去。
   */
  async send(
    thread: { external_id: string },
    parts: MessagePart[],
    opts: { connect_token: string; connection?: string; idempotency_key: string },
  ): Promise<{ external_id: string; template_used?: boolean }> {
    if (opts.idempotency_key.length === 0) {
      throw new ChannelError('invalid_input', 'send 缺 idempotency_key')
    }
    const already = this.sentByKey.get(opts.idempotency_key)
    if (already !== undefined) return { external_id: already }

    const session = await this.store.findByThread(thread.external_id)
    if (session === undefined) {
      throw new ChannelError(
        'authorization_check_failed',
        `未知会话，会话门禁拒绝推送：${thread.external_id}`,
        { thread: thread.external_id },
      )
    }
    /*
     * 31 §3.3 出站脱敏：模型写的正文里可能夹着它从入站材料里抄来的凭据形态串。
     *
     * 通道用 `answer` 而不是新加一个 `chat_message`：`answer` 的口径就是
     * "对人说的一段话"，与聊天消息逐字相同（只过秘密表，不抹 URL token——
     * 那是 `tool_result` 那一档的事）。核心包的 `OutboundChannel` 是别的 WP
     * 也在动的公共面，为一条语义相同的通道去加值只会制造冲突。
     */
    const text = redactOutboundText('answer', textOf(parts))
    if (text.length === 0) throw new ChannelError('invalid_input', 'send 的 parts 里没有文本')

    const now = this.clock.now()
    const message = await this.store.appendMessage({
      session_id: session.id,
      workspace_id: session.workspace_id,
      role: 'agent',
      text,
      at: now,
      external_id: opts.idempotency_key,
    })
    await this.store.patchSession(session.id, { at: now })
    this.stream.publish(session.id, { type: 'message', message })
    this.sentByKey.set(opts.idempotency_key, message.id)
    return { external_id: message.id }
  }

  /** 系统消息（求助提醒、转邮件通知）。不经模型，所以不走 `send` 的脱敏。 */
  async say(
    session_id: string,
    role: 'agent' | 'operator' | 'system',
    text: string,
    extra: { external_id?: string; run_id?: string; plan_action?: string } = {},
  ): Promise<ChatMessage> {
    const session = await this.store.getSession(session_id)
    if (session === undefined) {
      throw new ChannelError('not_found', `没有这条会话：${session_id}`, { session_id })
    }
    const now = this.clock.now()
    const message = await this.store.appendMessage({
      session_id,
      workspace_id: session.workspace_id,
      role,
      text,
      at: now,
      external_id: extra.external_id ?? `sys_${role}_${now}`,
      ...(extra.run_id === undefined ? {} : { run_id: extra.run_id }),
      ...(extra.plan_action === undefined ? {} : { plan_action: extra.plan_action }),
    })
    await this.store.patchSession(session_id, { at: now })
    this.stream.publish(session_id, { type: 'message', message })
    return message
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    return this.running
      ? { ok: true }
      : { ok: true, detail: 'chat: 已装配，未接入站 handler（只发不收）' }
  }
}

function textOf(parts: readonly MessagePart[]): string {
  return parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
    .trim()
}

function asRawChat(raw: unknown): RawChatMessage {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ChannelError('invalid_input', '入站原始载荷必须是对象')
  }
  const o = raw as Record<string, unknown>
  const required = ['session_id', 'external_id', 'visitor_id', 'text', 'at'] as const
  for (const key of required) {
    if (typeof o[key] !== 'string' || (o[key] as string).length === 0) {
      throw new ChannelError('invalid_input', `入站聊天消息缺 ${key}`)
    }
  }
  return {
    session_id: o.session_id as string,
    external_id: o.external_id as string,
    visitor_id: o.visitor_id as string,
    text: o.text as string,
    at: o.at as string,
    ...(typeof o.visitor_display === 'string' ? { visitor_display: o.visitor_display } : {}),
  }
}
