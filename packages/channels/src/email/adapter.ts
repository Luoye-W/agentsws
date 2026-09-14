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
import {
  advanceCursor,
  clearFault,
  DEFAULT_SCAN_LEASE_MS,
  type FolderSyncFault,
  isSkipped,
  type MailboxStateStore,
  recordFault,
  resumeFrom,
} from './cursors.js'
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
  /** WP55：游标按「账号 × 文件夹」记，所以适配器要知道自己在扫哪个文件夹（缺省 INBOX）。 */
  mailbox?: string
  threads?: ThreadStore
  /** 原始材料区里的秘密处理：默认 redact（31 §4「秘密脱敏后才落 raw」） */
  raw_secret_policy?: 'redact' | 'keep'
  /** 可选 HTML 正文渲染（不给则只发纯文本） */
  render_html?: (text: string) => string
  /** 轮询循环里的异常出口（不抛出中断循环） */
  on_error?: (e: unknown) => void
  /**
   * WP55 / 48 §4 L3 #2：**渠道细分判定**（Amazon 买家消息寄生在客服邮箱上）。
   *
   * 注入而不是内建：判定规则住在 `@agentsws/support-core`（纯函数、与 SaaS 共用
   * 同一份常量表），而 channels 是比它低一层的传输包——反过来依赖会把整条依赖链
   * 倒过来。不注入 = 老行为，一个字不用改。
   */
  classify_sub_channel?: (hints: SubChannelHints) => SubChannelVerdict | undefined
  /**
   * WP55 / 48 §4 L3 #5：邮箱状态（每文件夹 UID 游标 / 毒消息隔离 / 扫描租约）。
   *
   * 不给 = 老行为（游标只在内存里，重启从头拉，没有隔离也没有租约）。
   */
  mailbox_state?: MailboxStateStore
  /** 本进程的身份（租约持有者）。同一只邮箱同一时刻只有一个持有者。 */
  scan_owner?: string
  /** 租约时长；一轮拉取不该超过这么久。 */
  scan_lease_ms?: number
  /**
   * WP55：处理过的信搬进哪个文件夹并标已读。不给 = 不归档（这条可关）。
   * 建不了 / 服务器拒绝 MOVE 只 log，不影响收信。
   */
  archive_folder?: string
  /** 归档时是否顺手标已读（默认 true）。 */
  archive_mark_read?: boolean
  /** WP55：毒消息被永久越过时出一张卡（不给就只留在隔离表里）。 */
  on_folder_fault?: (fault: FolderSyncFault & { account: string; quarantined: boolean }) => void
}

/** 渠道细分判定要看的那几样（全是已解析的头与正文，判定方自己不碰 MIME）。 */
export interface SubChannelHints {
  from_email: string
  from_name?: string | undefined
  reply_to_email?: string | undefined
  subject?: string | undefined
  body_text: string
  body_html?: string | undefined
  /** 原始 `Authentication-Results` 头值；缺失 ≠ fail。 */
  authentication_results?: string | undefined
  in_reply_to_message_id?: string | undefined
}

/** 判定结论：写到线程与入站事件上的那两个字段，外加「这封信要不要人看一眼」。 */
export interface SubChannelVerdict {
  /** 渠道细分名（`amazon`）。 */
  channel: string
  /** 线程 `channel_meta` 的**增量补丁**（只写自己确实知道的键）。 */
  meta: Record<string, unknown>
  /** 路由要落到哪条职责（不给就走默认路由）。 */
  role_id?: string
  /** 钓鱼 / 退信 / 索赔这类：落库但绝不生成草稿，交人看。 */
  needs_human_review?: boolean
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
  private readonly classifySubChannel:
    | ((hints: SubChannelHints) => SubChannelVerdict | undefined)
    | undefined
  private readonly mailbox: string
  private readonly mailboxState: MailboxStateStore | undefined
  private readonly scanOwner: string
  private readonly scanLeaseMs: number
  private readonly archiveFolder: string | undefined
  private readonly archiveMarkRead: boolean
  private readonly onFolderFault:
    | ((fault: FolderSyncFault & { account: string; quarantined: boolean }) => void)
    | undefined

  private running = false
  private loop: Promise<void> | undefined
  private waking: (() => void) | undefined
  private lastUid = 0
  private leaseBusy = false
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
    this.classifySubChannel = opts.classify_sub_channel
    this.mailbox = opts.mailbox ?? 'INBOX'
    this.mailboxState = opts.mailbox_state
    this.scanOwner = opts.scan_owner ?? `pid_${process.pid}`
    this.scanLeaseMs = opts.scan_lease_ms ?? DEFAULT_SCAN_LEASE_MS
    this.archiveFolder = opts.archive_folder
    this.archiveMarkRead = opts.archive_mark_read ?? true
    this.onFolderFault = opts.on_folder_fault
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

  /**
   * 拉一轮（测试与"立刻收一次"用）；返回本轮**处理成功**的邮件数。
   *
   * WP55 / 48 §4 L3 #5 的三件事都在这一跳里：
   * ① 先领扫描租约（领不到 = 别人正在扫这只邮箱，本轮直接让开）；
   * ② 水位从持久游标读（`uid_validity` 变了就从 0 重来）；
   * ③ 一封信炸了就记一笔、跳过、继续——连续到阈值就永久越过并出卡。
   */
  async poll(handler: (raw: unknown) => Promise<void>): Promise<number> {
    const source = this.source
    if (source === undefined) {
      throw new ChannelError('invalid_input', '未注入 MailSource，邮件适配器无法收信')
    }
    const state = this.mailboxState
    const now = this.clock.now()
    // ① 同一只邮箱同一时刻只有一个进程在扫。两个进程各自推游标、各自归档，
    //    最后谁也说不清哪封处理过——所以领不到就让开，下一轮再来。
    if (state !== undefined) {
      const got = await state.claimScanLease(
        this.address,
        this.scanOwner,
        Date.parse(now),
        this.scanLeaseMs,
      )
      if (!got) {
        this.leaseBusy = true
        return 0
      }
      this.leaseBusy = false
    }
    try {
      return await this.pollUnderLease(source, handler, now)
    } finally {
      await state?.releaseScanLease(this.address, this.scanOwner)
    }
  }

  /** 观察面：上一轮是不是因为别人占着租约而让开了。 */
  get lastPollWasLeaseBusy(): boolean {
    return this.leaseBusy
  }

  private async pollUnderLease(
    source: MailSource,
    handler: (raw: unknown) => Promise<void>,
    now: Iso8601,
  ): Promise<number> {
    const state = this.mailboxState
    const folder = this.mailbox
    const uid_validity = (await source.uidValidity?.()) ?? 0
    const prior = await state?.cursor(this.address, folder)
    // `uid_validity` 变了 = 服务器重建过这个邮箱，旧水位全部作废，从 0 重来。
    // 宁可重拉一遍（去重表挡住重复产出），也不要静默漏信。
    const since = state === undefined ? this.lastUid : resumeFrom(prior, uid_validity)
    let cursor = prior
    let fault = await state?.fault(this.address, folder)

    const batch = await source.fetchSince(since)
    let handled = 0
    /**
     * 本轮第一封「炸了但还没到永久越过阈值」的 UID。
     *
     * 水位**不能推过它**：推过去就等于只失败一次就永久跳过，而那一次多半只是
     * 那一瞬间的抖动。它后面的信照常处理（不挡路），只是水位留在它前面，
     * 下一轮把它和它后面的一起重拉——重复的那几封由去重表（24h 窗口）挡住。
     */
    let blocked: number | undefined
    const advance = async (uid: number): Promise<void> => {
      if (blocked !== undefined) return
      cursor = advanceCursor(cursor, folder, uid_validity, uid)
      await state?.setCursor(this.address, cursor)
    }
    for (const msg of batch) {
      // 已经被永久越过的：连拉都不该再拉进来
      if (isSkipped(fault, msg.uid)) {
        await advance(msg.uid)
        continue
      }
      try {
        await handler(msg)
        handled += 1
        this.lastUid = Math.max(this.lastUid, msg.uid)
        // ③ 处理成功：水位推过它（前提是前面没有卡住的那一封）；
        //    它要是刚才那封卡住的，把计数清掉
        await advance(msg.uid)
        const cleared = clearFault(fault, folder, msg.uid)
        if (cleared !== fault && cleared !== undefined) {
          fault = cleared
          await state?.setFault(this.address, cleared)
        }
        await this.archiveOne(source, msg.uid)
      } catch (e) {
        // ② 毒消息隔离：记一笔、跳过、继续。一封畸形的信不该让它后面的每一封
        //    都永远进不来，但跳过必须是**有记录的跳过**。
        const detail = e instanceof Error ? e.message : String(e)
        this.onError?.(e)
        if (state === undefined) continue
        const next = recordFault(fault, { folder, uid: msg.uid, error: detail, at: now })
        fault = next.fault
        await state.setFault(this.address, next.fault)
        this.onFolderFault?.({
          ...next.fault,
          account: this.address,
          quarantined: next.quarantined,
        })
        if (next.quarantined) {
          // 连续失败到阈值：永久越过它，水位推过去
          await advance(msg.uid)
        } else if (blocked === undefined) {
          blocked = msg.uid
        }
      }
    }
    return handled
  }

  /** 处理过的信搬进归档文件夹并标已读。搬不动只 log——归档不该拖垮收信。 */
  private async archiveOne(source: MailSource, uid: number): Promise<void> {
    const folder = this.archiveFolder
    if (folder === undefined || source.archive === undefined) return
    try {
      const moved = await source.archive(uid, folder, this.archiveMarkRead)
      if (!moved) this.onError?.(new Error(`归档文件夹动不了：${folder}（uid ${uid}）`))
    } catch (e) {
      this.onError?.(e)
    }
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

    // ④ 渠道细分（WP55 / 48 §4 L3 #2）：Amazon 买家消息寄生在这只邮箱上。
    //    判定在 AI 分类之前，所以它不花任何积分，也不受模型可用性影响。
    const replyTo = firstAddress(parsed.replyTo)
    const bodyHtml = typeof parsed.html === 'string' ? parsed.html : undefined
    const sub = this.classifySubChannel?.({
      from_email: from,
      body_text: bodyText,
      ...(displayNameOf(parsed.from) === undefined
        ? {}
        : { from_name: displayNameOf(parsed.from) }),
      ...(replyTo === undefined ? {} : { reply_to_email: replyTo }),
      ...(parsed.subject === undefined ? {} : { subject: parsed.subject }),
      ...(bodyHtml === undefined ? {} : { body_html: bodyHtml }),
      ...(headerValue(parsed, 'authentication-results') === undefined
        ? {}
        : { authentication_results: headerValue(parsed, 'authentication-results') }),
      ...(in_reply_to === undefined ? {} : { in_reply_to_message_id: in_reply_to }),
    })

    // ⑤ 线程台账（收件人门禁的依据）
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
        ...(sub === undefined ? {} : { channel: sub.channel, channel_meta: sub.meta }),
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
      ...(sub === undefined ? {} : { sub_channel: sub.channel, channel_meta: sub.meta }),
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

    const sent_at = this.clock.now()
    await this.threads.upsert(
      mergeThread(record, {
        external_id: record.external_id,
        participants: record.participants,
        references: record.references,
        at: sent_at,
        message_id,
        ...(record.subject === undefined ? {} : { subject: record.subject }),
        // WP55：24h SLA 闭账要知道「这封信回了没有」，锚是买家来信、停表是这一刻
        ...(record.channel === undefined ? {} : { channel_meta: { last_outbound_at: sent_at } }),
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

/** 取一个原始头的字符串值（mailparser 的 headers 是 Map，值可能不是字符串）。 */
function headerValue(parsed: ParsedMail, name: string): string | undefined {
  const raw = parsed.headers?.get(name)
  if (typeof raw === 'string') return raw
  if (Array.isArray(raw)) {
    const first = raw.find((v) => typeof v === 'string')
    return typeof first === 'string' ? first : undefined
  }
  return undefined
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
