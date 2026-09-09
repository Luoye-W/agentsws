import type {
  ChannelAdapter,
  ChannelName,
  Clock,
  Connect,
  InboundEvent,
  Iso8601,
  MessagePart,
  WorkspaceId,
} from '@agentsws/contracts'
import { canonicalJson, redactOutboundText, sha256 } from '@agentsws/core'
import { type AddressObject, type ParsedMail, simpleParser } from 'mailparser'
import { ChannelError } from '../errors.js'
import type { RawStore } from '../raw-store.js'
import { scrubSecrets } from '../secrets.js'
import type { MailSource, RawEmailMessage } from './imap.js'
import {
  buildReplyHeaders,
  htmlToText,
  normalizeAddress,
  normalizeMessageId,
  normalizeText,
  parseReferences,
  stripQuotedTail,
  threadExternalId,
} from './mime.js'
import { domainOf, type Mailer, messageIdFor } from './smtp.js'
import { MemoryThreadStore, mergeThread, type ThreadStore } from './threads.js'

/** 出站走哪条路（health / 观察面用）。 */
export type SendRoute = 'connect' | 'smtp'

export interface EmailAdapterOptions {
  clock: Clock
  /** 受控原始材料区：原始 MIME 与附件字节落这里，事件里只留 ref */
  rawStore: RawStore
  /** 我们自己的收件地址（From，也是收件人门禁里要排除的那个） */
  address: string
  display_name?: string
  /** 收信（IMAP）；不给则本适配器只发不收 */
  source?: MailSource
  /** 发信（SMTP）；Connect 不可用时的兜底 */
  mailer?: Mailer
  /** 有 gmail provider 且可执行时优先走它（凭据留在 OpenConnector，09 §7.2） */
  connect?: Connect
  gmail_action?: string
  gmail_service?: string
  /** 轮询周期，默认 60s；时间一律经 Clock */
  interval_ms?: number
  threads?: ThreadStore
  /** 原始材料区里的秘密处理：默认 redact（31 §4「秘密脱敏后才落 raw」） */
  raw_secret_policy?: 'redact' | 'keep'
  /** 可选 HTML 正文渲染（不给则只发纯文本） */
  render_html?: (text: string) => string
  /** 轮询循环里的异常出口（不抛出中断循环） */
  on_error?: (e: unknown) => void
}

const DEFAULT_INTERVAL_MS = 60_000

/**
 * 邮件渠道适配器（`ChannelAdapter`，name='email'）。
 *
 * 收：IMAP 轮询 → 原始 MIME → `toInbound` 映射成 `InboundEvent` 的前半段（管线补 id / 路由 / 脱敏标记）。
 * 发：`send` 组装回复头（In-Reply-To / References / Re:），
 *     **有 gmail provider 就走 Connect.execute**（凭据不落我们这），否则走自带 SMTP。
 */
export class EmailChannelAdapter implements ChannelAdapter {
  readonly name: ChannelName = 'email'
  readonly address: string
  readonly threads: ThreadStore

  private readonly clock: Clock
  private readonly rawStore: RawStore
  private readonly source: MailSource | undefined
  private readonly mailer: Mailer | undefined
  private readonly connect: Connect | undefined
  private readonly gmailAction: string
  private readonly gmailService: string
  private readonly intervalMs: number
  private readonly rawSecretPolicy: 'redact' | 'keep'
  private readonly renderHtml: ((text: string) => string) | undefined
  private readonly onError: ((e: unknown) => void) | undefined
  private readonly displayName: string | undefined

  private running = false
  private loop: Promise<void> | undefined
  private waking: (() => void) | undefined
  private lastUid = 0
  private gmailReady: boolean | undefined
  private readonly sentByKey = new Map<string, { external_id: string; route: SendRoute }>()

  constructor(opts: EmailAdapterOptions) {
    this.clock = opts.clock
    this.rawStore = opts.rawStore
    this.address = normalizeAddress(opts.address)
    this.displayName = opts.display_name
    this.source = opts.source
    this.mailer = opts.mailer
    this.connect = opts.connect
    this.gmailAction = opts.gmail_action ?? 'gmail.send_message'
    this.gmailService = opts.gmail_service ?? 'gmail'
    this.intervalMs = opts.interval_ms ?? DEFAULT_INTERVAL_MS
    this.threads = opts.threads ?? new MemoryThreadStore()
    this.rawSecretPolicy = opts.raw_secret_policy ?? 'redact'
    this.renderHtml = opts.render_html
    this.onError = opts.on_error
  }

  capabilities(): {
    text: boolean
    image: boolean
    file: boolean
    card: boolean
    thread: boolean
    streaming: boolean
  } {
    // 能力协商说的是 `send` 能发什么：v1 只发纯文本（可选 HTML 正文）。
    // 入站附件仍会被登记成 file / image part，但出站附件、卡片、流式都不支持。
    return { text: true, image: false, file: false, card: false, thread: true, streaming: false }
  }

  // ---------- 收 ----------

  /** 起轮询循环；每封原始邮件交给 handler（由入站管线接住）。 */
  async start(handler: (raw: unknown) => Promise<void>): Promise<void> {
    if (this.source === undefined) {
      throw new ChannelError('invalid_input', '未注入 MailSource，邮件适配器无法收信')
    }
    if (this.running) return
    this.running = true
    this.loop = this.runLoop(handler)
  }

  async stop(): Promise<void> {
    this.running = false
    this.wake()
    const loop = this.loop
    this.loop = undefined
    if (loop !== undefined) await loop
    await this.source?.close?.()
    await this.mailer?.close?.()
  }

  get started(): boolean {
    return this.running
  }

  /** 拉一轮（测试与"立刻收一次"用）；返回本轮新邮件数。 */
  async poll(handler: (raw: unknown) => Promise<void>): Promise<number> {
    if (this.source === undefined) {
      throw new ChannelError('invalid_input', '未注入 MailSource，邮件适配器无法收信')
    }
    const batch = await this.source.fetchSince(this.lastUid)
    for (const msg of batch) {
      this.lastUid = Math.max(this.lastUid, msg.uid)
      await handler(msg)
    }
    return batch.length
  }

  private async runLoop(handler: (raw: unknown) => Promise<void>): Promise<void> {
    while (this.running) {
      try {
        await this.poll(handler)
      } catch (e) {
        this.onError?.(e)
      }
      if (!this.running) break
      await this.sleep(this.intervalMs)
    }
  }

  /** 可被 `stop()` 打断的等待：周期由 Clock 决定，停机不必等满一个周期。 */
  private async sleep(ms: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    await new Promise<void>((resolve) => {
      this.waking = resolve
      const clockSleep = this.clock.sleep
      if (clockSleep !== undefined) {
        void Promise.resolve(clockSleep.call(this.clock, ms)).then(() => this.wake())
      } else {
        timer = setTimeout(() => this.wake(), ms)
        timer.unref?.()
      }
    })
    if (timer !== undefined) clearTimeout(timer)
  }

  private wake(): void {
    const resolve = this.waking
    this.waking = undefined
    resolve?.()
  }

  /**
   * 原始邮件 → `InboundEvent` 的前半段。
   * `parts.text` 在这里还是**未围栏未脱敏**的解析结果——围栏与秘密检测是管线的一跳（18 §2.2），
   * 适配器只负责"取到正确的文本"：纯文本优先，只有 HTML 时转文本，去掉引用尾巴，附件不进 text。
   */
  async toInbound(
    raw: unknown,
    workspace_id: WorkspaceId,
  ): Promise<Omit<InboundEvent, 'id' | 'routing' | 'secrets_scrubbed'>> {
    const msg = asRawEmail(raw)
    const parsed = await simpleParser(msg.source)
    const received_at = this.clock.now()

    const from = firstAddress(parsed.from)
    if (from === undefined) {
      throw new ChannelError('invalid_input', '入站邮件缺 From', { uid: msg.uid })
    }
    const message_id = normalizeMessageId(parsed.messageId)
    const references = parseReferences(parsed.references)
    const in_reply_to = normalizeMessageId(parsed.inReplyTo)
    const thread_external =
      threadExternalId({
        ...(message_id === undefined ? {} : { message_id }),
        ...(in_reply_to === undefined ? {} : { in_reply_to }),
        references,
      }) ?? `email-thread:${sha256(from + (parsed.subject ?? '')).slice(0, 16)}`

    // ① 原始 MIME 进受控原始材料区（不进模型）；秘密按策略在落库前就抹掉
    //    `subject_ref` = 发件人地址：受控区按它加密、按它随主体删除（21 §4 / 18 §2.1）。
    //    没有它，材料就是明文落盘——所以每条都要带。
    const sourceForRaw =
      this.rawSecretPolicy === 'redact' ? scrubSecrets(msg.source) : { text: msg.source, rules: [] }
    const raw_ref = await this.rawStore.put({
      channel: 'email',
      kind: 'message',
      stored_at: received_at,
      payload: sourceForRaw.text,
      mime: 'message/rfc822',
      subject_ref: from,
      ...(sourceForRaw.rules.length > 0 ? { secrets_scrubbed: true } : {}),
      ...(msg.mailbox.length > 0 ? { name: `${msg.mailbox}/${msg.uid}` } : {}),
    })

    // ② 正文：纯文本优先；只有 HTML 时转文本；两者都去引用尾巴
    const bodyText = pickBodyText(parsed)
    const parts: MessagePart[] = [{ type: 'text', text: bodyText }]

    // ③ 附件只登记成 file / image part，内容进 raw 区，绝不并进 text
    for (const att of parsed.attachments ?? []) {
      const ref = await this.rawStore.put({
        channel: 'email',
        kind: 'attachment',
        stored_at: received_at,
        payload: new Uint8Array(att.content),
        subject_ref: from,
        ...(att.contentType === undefined ? {} : { mime: att.contentType }),
        ...(att.filename === undefined ? {} : { name: att.filename }),
      })
      const isImage = (att.contentType ?? '').startsWith('image/')
      parts.push({
        type: isImage ? 'image' : 'file',
        ref,
        ...(att.contentType === undefined ? {} : { mime: att.contentType }),
        ...(att.filename === undefined ? {} : { name: att.filename }),
      })
    }

    // ④ 线程台账（收件人门禁的依据）
    const participants = [
      from,
      ...addressesOf(parsed.to),
      ...addressesOf(parsed.cc),
      ...addressesOf(parsed.replyTo),
    ].filter((a) => a !== this.address)
    await this.threads.upsert(
      mergeThread(await this.threads.get(thread_external), {
        external_id: thread_external,
        participants,
        references,
        at: received_at,
        ...(parsed.subject === undefined ? {} : { subject: parsed.subject }),
        ...(message_id === undefined ? {} : { message_id }),
      }),
    )

    const display = displayNameOf(parsed.from) ?? from
    const occurred_at: Iso8601 =
      parsed.date instanceof Date && !Number.isNaN(parsed.date.getTime())
        ? parsed.date.toISOString()
        : (msg.internal_date ?? received_at)

    return {
      schema_version: 1,
      workspace_id,
      channel: 'email',
      kind: 'message',
      received_at,
      occurred_at,
      dedupe_key: emailDedupeKey(message_id, {
        from,
        body: bodyText,
        ...(parsed.subject === undefined ? {} : { subject: parsed.subject }),
      }),
      actor: { external_id: from, display },
      thread: { external_id: thread_external },
      parts,
      raw_ref,
    }
  }

  // ---------- 发 ----------

  /**
   * 在这段对话里回复（09 §7.1）。收件人**只从线程台账取**（31 §3.3 收件人门禁），
   * 入参里没有、也不接受来自模型的收件人。
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
    if (already !== undefined) return { external_id: already.external_id }

    const record = await this.threads.get(thread.external_id)
    if (record === undefined) {
      throw new ChannelError(
        'authorization_check_failed',
        `未知线程，收件人门禁拒绝发送：${thread.external_id}`,
        { thread: thread.external_id },
      )
    }
    const to = record.participants.filter((p) => p !== this.address)
    if (to.length === 0) {
      throw new ChannelError(
        'authorization_check_failed',
        `线程没有可回复的原有参与者：${thread.external_id}`,
        { thread: thread.external_id },
      )
    }

    // 31 §3.3 出站脱敏：回信正文这一路的收口。模型写的正文里可能夹着它从
    // 入站材料里抄来的凭据形态串——发出去就收不回来了。
    const text = redactOutboundText('email_body', textOf(parts))
    if (text.length === 0) {
      throw new ChannelError('invalid_input', 'send 的 parts 里没有文本')
    }

    const headers = buildReplyHeaders({
      ...(record.subject === undefined ? {} : { subject: record.subject }),
      ...(record.last_message_id === undefined
        ? {}
        : { reply_to_message_id: record.last_message_id }),
      references: record.references,
    })
    const message_id = messageIdFor(opts.idempotency_key, domainOf(this.address))
    const html = this.renderHtml?.(text)

    const route: SendRoute = (await this.gmailAvailable(opts.connect_token)) ? 'connect' : 'smtp'
    const external_id =
      route === 'connect'
        ? await this.sendViaConnect({ to, text, html, headers, message_id, opts })
        : await this.sendViaSmtp({ to, text, html, headers, message_id })

    await this.threads.upsert(
      mergeThread(record, {
        external_id: record.external_id,
        participants: record.participants,
        references: record.references,
        at: this.clock.now(),
        message_id,
        ...(record.subject === undefined ? {} : { subject: record.subject }),
      }),
    )
    this.sentByKey.set(opts.idempotency_key, { external_id, route })
    return { external_id }
  }

  /** 观察面：某个幂等键实际走了哪条路（测试与健康看板用）。 */
  routeOf(idempotency_key: string): SendRoute | undefined {
    return this.sentByKey.get(idempotency_key)?.route
  }

  private async sendViaConnect(input: {
    to: string[]
    text: string
    html: string | undefined
    headers: { subject: string; in_reply_to?: string; references?: string }
    message_id: string
    opts: { connect_token: string; connection?: string; idempotency_key: string }
  }): Promise<string> {
    const connect = this.connect
    if (connect === undefined) throw new ChannelError('provider_unavailable', 'Connect 不可用')
    const result = await connect.execute<{ id?: string; message_id?: string }>(
      this.gmailAction,
      {
        from: this.fromHeader(),
        to: input.to,
        subject: input.headers.subject,
        text: input.text,
        message_id: input.message_id,
        ...(input.html === undefined ? {} : { html: input.html }),
        ...(input.headers.in_reply_to === undefined
          ? {}
          : { in_reply_to: input.headers.in_reply_to }),
        ...(input.headers.references === undefined ? {} : { references: input.headers.references }),
      },
      {
        token: input.opts.connect_token,
        idempotencyKey: input.opts.idempotency_key,
        ...(input.opts.connection === undefined ? {} : { connection: input.opts.connection }),
      },
    )
    return result.data?.id ?? result.data?.message_id ?? input.message_id
  }

  private async sendViaSmtp(input: {
    to: string[]
    text: string
    html: string | undefined
    headers: { subject: string; in_reply_to?: string; references?: string }
    message_id: string
  }): Promise<string> {
    if (this.mailer === undefined) {
      throw new ChannelError('provider_unavailable', '既没有可用的 gmail provider，也没有注入 SMTP')
    }
    const sent = await this.mailer.send({
      from: this.fromHeader(),
      to: input.to,
      subject: input.headers.subject,
      text: input.text,
      message_id: input.message_id,
      ...(input.html === undefined ? {} : { html: input.html }),
      ...(input.headers.in_reply_to === undefined
        ? {}
        : { in_reply_to: input.headers.in_reply_to }),
      ...(input.headers.references === undefined ? {} : { references: input.headers.references }),
    })
    return sent.message_id.length > 0 ? sent.message_id : input.message_id
  }

  private fromHeader(): string {
    return this.displayName === undefined ? this.address : `${this.displayName} <${this.address}>`
  }

  private async gmailAvailable(token: string): Promise<boolean> {
    if (this.connect === undefined || token.length === 0) return false
    if (this.gmailReady !== undefined) return this.gmailReady
    try {
      const providers = await this.connect.providers()
      this.gmailReady = providers.some((p) => p.service === this.gmailService && p.executable)
    } catch {
      this.gmailReady = false
    }
    return this.gmailReady
  }

  // ---------- 健康 ----------

  async health(): Promise<{ ok: boolean; detail?: string }> {
    const details: string[] = []
    let ok = true
    if (this.source === undefined) details.push('imap: 未配置')
    else {
      const h = await this.source.health()
      if (!h.ok) {
        ok = false
        details.push(h.detail ?? 'imap: 不可用')
      }
    }
    if (this.mailer === undefined) {
      if (this.connect === undefined) {
        ok = false
        details.push('smtp: 未配置且无 Connect')
      } else details.push('smtp: 未配置（走 Connect）')
    } else {
      const h = await this.mailer.health()
      if (!h.ok) {
        ok = false
        details.push(h.detail ?? 'smtp: 不可用')
      }
    }
    return details.length === 0 ? { ok } : { ok, detail: details.join('; ') }
  }
}

/** 18 §2.2 去重键：`email:<Message-ID>`；没有 Message-ID 才退化成内容哈希。 */
export function emailDedupeKey(
  message_id: string | undefined,
  fallback: { from: string; subject?: string; body: string },
): string {
  if (message_id !== undefined) return `email:${message_id}`
  return `email:${sha256(canonicalJson(fallback)).slice(0, 32)}`
}

function pickBodyText(parsed: ParsedMail): string {
  const plain = typeof parsed.text === 'string' ? parsed.text : ''
  if (plain.trim().length > 0) return stripQuotedTail(plain)
  const html = typeof parsed.html === 'string' ? parsed.html : ''
  if (html.length > 0) return stripQuotedTail(htmlToText(html))
  return normalizeText(plain)
}

function firstAddress(a: AddressObject | AddressObject[] | undefined): string | undefined {
  const list = addressesOf(a)
  return list[0]
}

function addressesOf(a: AddressObject | AddressObject[] | undefined): string[] {
  if (a === undefined) return []
  const objs = Array.isArray(a) ? a : [a]
  const out: string[] = []
  for (const obj of objs)
    for (const v of obj.value ?? [])
      if (typeof v.address === 'string' && v.address.length > 0)
        out.push(normalizeAddress(v.address))
  return out
}

function displayNameOf(a: AddressObject | AddressObject[] | undefined): string | undefined {
  const objs = a === undefined ? [] : Array.isArray(a) ? a : [a]
  for (const obj of objs)
    for (const v of obj.value ?? [])
      if (typeof v.name === 'string' && v.name.trim().length > 0) return v.name.trim()
  return undefined
}

function textOf(parts: readonly MessagePart[]): string {
  return parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
    .trim()
}

function asRawEmail(raw: unknown): RawEmailMessage {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ChannelError('invalid_input', '入站原始载荷必须是对象')
  }
  const o = raw as Record<string, unknown>
  const source = o.source
  if (typeof source !== 'string' || source.length === 0) {
    throw new ChannelError('invalid_input', '入站邮件缺原始 MIME（source）')
  }
  const uid = typeof o.uid === 'number' && Number.isFinite(o.uid) ? o.uid : 0
  const mailbox = typeof o.mailbox === 'string' ? o.mailbox : 'INBOX'
  return {
    uid,
    mailbox,
    source,
    ...(typeof o.internal_date === 'string' ? { internal_date: o.internal_date } : {}),
  }
}
