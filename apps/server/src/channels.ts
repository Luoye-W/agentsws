/**
 * 渠道在服务进程里的真装配（18 §2 入站管线 + §3 投递；39 待办 C）。
 *
 * WP20 把邮箱连接做完了（用户能在连接页填 IMAP / SMTP 并试连成功），但**收信与
 * 发信从来没有在服务进程里接上**——邮件适配器、入站管线、受控原始材料区
 * 只在包自己的测试与模拟回路里跑过。于是真机器上：
 *
 * - 连上的邮箱不会被拉，客户来信永远进不来；
 * - 批准了的回信也发不出去（执行器的 `deliverOutbound` 打在内存桩上）；
 * - 而且**一旦接上，如果忘了把 `data.keyring` 传给原始材料区，邮件原文就是明文落盘**
 *   （31 §4 / 18 §2.1 的第一条纪律）。channels 包里那条反向哨兵测试
 *   「不接密钥环就是明文落盘」，钉的就是这一步。
 *
 * 这一层的规矩：
 * - 一个邮箱账号一条管线（`ChannelInboundPipeline` 按 `channel` 名分派适配器，
 *   两个 email 适配器会互相覆盖），但**共用**受控原始材料区、队列与去重表
 *   ——同一封信从两个账号进来只该产生一条事件。
 * - 收信的每一跳都在管线里（去重 → 围栏 + 秘密脱敏 → 解析 → 路由 → 排队 → 触发），
 *   本文件只负责把口子接上，不重写任何一跳。
 * - 出站要过急停的 `outbound` 档。这是 15 §5.8「对账没完不放出站」真正生效的地方。
 * - 凭据从不经过本文件：`CredentialSource` 由连接面提供，口令只在 IMAP / SMTP
 *   客户端建连那一瞬间出现。
 */

import { join } from 'node:path'
import {
  BlobBackedRawStore,
  ChannelInboundPipeline,
  type CredentialSource,
  classifySendFailure,
  createSqliteChannelStores,
  defaultRoute,
  domainOf,
  EmailChannelAdapter,
  ImapMailSource,
  type Mailer,
  type MailSource,
  MemoryDedupeStore,
  MemoryOutboxStore,
  MemoryQueueStore,
  MemoryRawStore,
  mergeThread,
  messageIdFor,
  Outbox,
  type OutboxTransitionEvent,
  outboxPayloadHash,
  type RawStore,
  type RouteInput,
  type RouteResult,
  SmtpMailer,
  SqliteRawStore,
  type SubChannelHints,
  type SubChannelVerdict,
} from '@agentsws/channels'
import type {
  ApprovalItem,
  Clock,
  EventEnvelope,
  Halt,
  InboundEvent,
  Iso8601,
  Matter,
  MaybePromise,
  MessagePart,
  ObjectRef,
  PersonId,
  RoleId,
  StartRun,
  WorkspaceId,
} from '@agentsws/contracts'
import type { RawBlobPort, RawCipher } from '@agentsws/core'
import {
  AMAZON_MESSAGE_ACTIONS,
  type AmazonSlaThreadState,
  amazonSlaCardTitle,
  buildAmazonChannelMeta,
  buildAmazonRewriteInstruction,
  describeAmazonDetection,
  detectAmazonChannel,
  evaluateAmazonOutbound,
  evaluateAmazonSlaCycle,
  isMarketplaceRelayAddress,
  summarizeAmazonViolations,
} from '@agentsws/support-core'
import type { BackendResult } from '@agentsws/txn'
import type { Work } from '@agentsws/work'
import type { MailAccount } from './connections.js'

/** 出站被急停挡下时回给执行器的那一条。 */
export const OUTBOUND_HALTED = '出站已急停（AGENTSWS_HALT=outbound 或对账未完成），这封信没有发出'

/**
 * WP55 / 48 §4 L3 #2：Amazon 出站硬闸挡下时回给执行器的那一条。
 *
 * **不可重试**：同一份正文重发多少次都会被同一条规则拦下。要的是**打回重写**
 * ——原因原样回给上游，由起草那一跳重写正文，而不是在这里静默删改后照发。
 */
export const AMAZON_OUTBOUND_BLOCKED = 'Amazon 站内信出站守卫拦下了这封回复'

/** 同一幂等键换了正文：调用方的 bug，不该被当成"重试"悄悄发出另一封信。 */
export const OUTBOX_PAYLOAD_DRIFT =
  '同一个幂等键上换了正文（outbox payload_drift）：这不是重试，拒绝发送'

/** WP55 / 48 §4 L3 #5：处理过的信搬进哪个文件夹。 */
export const ARCHIVE_FOLDER = 'agentsws'

/** 单轮对账的扫描上限；落后的下一分钟补上。 */
const RECONCILE_BATCH = 20

/**
 * WP55：Amazon 渠道细分判定（`classify_sub_channel` 的真实现）。
 *
 * 判定规则全在 `@agentsws/support-core/amazon`（纯函数、常量表逐字节抄
 * KefuAgent）。这里只做两件事：把适配器给的头喂进去，把结论翻译成线程补丁。
 */
export function createAmazonSubChannelClassifier(
  clock: Clock,
): (hints: SubChannelHints) => SubChannelVerdict | undefined {
  return (hints) => classifyAmazonSubChannel(hints, clock.now())
}

export function classifyAmazonSubChannel(
  hints: SubChannelHints,
  at: Iso8601,
): SubChannelVerdict | undefined {
  const detection = detectAmazonChannel({
    from_email: hints.from_email,
    from_name: hints.from_name ?? null,
    reply_to_email: hints.reply_to_email ?? null,
    subject: hints.subject ?? '',
    body_text: hints.body_text,
    body_html: hints.body_html ?? null,
    authentication_results: hints.authentication_results ?? null,
    in_reply_to_message_id: hints.in_reply_to_message_id ?? null,
  })
  if (detection === undefined) return undefined
  const action = AMAZON_MESSAGE_ACTIONS[detection.message_type]
  return {
    channel: 'amazon',
    meta: {
      // 时钟锚只由买家消息族写（`buildAmazonChannelMeta` 自己管这条纪律）
      ...buildAmazonChannelMeta(detection, at),
      summary: describeAmazonDetection(detection),
      // 这两条跟着 meta 走，因为线程与入站事件都要读：钓鱼件绝不起草。
      needs_human_review: action.needs_human_review,
      generates_draft: action.generates_draft,
    },
    ...(action.needs_human_review ? { needs_human_review: true } : {}),
  }
}

/** 一个装好的邮箱账号：适配器 + 它自己的那条入站管线。 */
interface MailChannel {
  account: MailAccount
  adapter: EmailChannelAdapter
  pipeline: ChannelInboundPipeline
  /** WP55：对账要直接问这只邮箱「已发送里有没有这封」。 */
  source: MailSource
}

export interface ChannelsOptions {
  clock: Clock
  workspace_id: WorkspaceId
  /** 给了就落盘（受控原始材料区 / 队列 / 去重表）；不给全内存（测试）。 */
  dbDir?: string
  appendEvent(e: Omit<EventEnvelope, 'id' | 'at'> & { at?: string }): void
  /** 急停面：出站要过 `outbound` 档。 */
  halt: Halt
  /**
   * 18 §2.1 第一条纪律：受控原始材料区的加密。传 `data.keyring`。
   * **不传就是明文落盘**——只有内存档（`dbDir` 为空）才该这样。
   */
  cipher?: RawCipher
  /**
   * WP40：附件字节落**对象存储**（本地目录 / S3 兼容），受控区里只留一句 `blob://…`
   * （18 §2.1「原始材料区只留文本与引用」）。不传就照旧落库。
   * 邮件原文是文本，无论如何都留在库里——它要检索、要脱敏。
   */
  blobs?: RawBlobPort
  /** 现在连着哪几个邮箱（`connections.mailAccounts()`）。 */
  accounts(): MailAccount[]
  /** 口令来源（`connections.credentialSource()`）；本文件不碰值。 */
  credentials: CredentialSource
  /** 37 工作模型：入站落成岗位事项。不给就只落事件，不开事项。 */
  work?: Work
  /** 17 §1 起 Run；不给就只开事项不跑运行时。 */
  startRun?: StartRun
  /** 入站事项挂谁名下（本人的那条岗位）。 */
  position?(): { person_id: PersonId; assignment_id: string; role_id: RoleId } | undefined
  /** 06 §2.4 路由器；缺省按渠道映射（邮件 → `dtc.aftersales`）。 */
  route?(input: RouteInput): RouteResult | undefined
  /**
   * WP53：发件人 → 线程台账里的那条联系人（31 §3.3）。真环境接的是
   * `records.ts` 的 `contactOf`，所以入站解析出来的 ref 与运行时里工具带回来的
   * 是**同一条**记录。不给就是老行为：`event.actor.resolved` 永远为空，
   * 事项上没有联系人可钉，那次运行也就建不出回信草稿卡。
   */
  resolveActor?(external_id: string): ObjectRef | undefined
  /** 测试注入：收信端。缺省真 IMAP（`imapflow`）。 */
  makeSource?(account: MailAccount, credentials: CredentialSource): MailSource
  /** 测试注入：发信端。缺省真 SMTP（`nodemailer`）。 */
  makeMailer?(account: MailAccount, credentials: CredentialSource): Mailer
  /** 每轮最多取多少封。 */
  batch?: number
  /**
   * WP55 / 48 §4 L3 #4：对账退避耗尽时出一张人工卡。
   *
   * 不装 = 只落事件不出卡（测试与最小装配）。真服务进程里它接到审批总线上。
   */
  escalateUnresolvedDelivery?(input: UnresolvedDelivery): MaybePromise<void>
}

export interface MailPollReport {
  accounts: number
  messages: number
  /** 重试队列这一轮推动了几条。 */
  retried: number
  /** 拉不动的那几个账号（一个坏了不该拖垮别的）。 */
  failed: string[]
}

/** WP55：一轮 Amazon 24h SLA sweep 的结果（三档各出了几张、闭了几笔账）。 */
export interface AmazonSlaReport {
  /** 本轮真正评估过的线程数（没有时钟锚的不计入）。 */
  scanned: number
  reminders: number
  criticals: number
  accounted: number
}

/** WP55：一轮出站对账的结果。 */
export interface ReconcileReport {
  scanned: number
  /** 在已发 / 归档文件夹里找到证据了。 */
  confirmed: number
  /** 这一轮没拿到证据，排下一次（**不重发**）。 */
  still_unknown: number
  /** 退避次数耗尽 → 出了人工卡。 */
  escalated: number
}

/** WP55：对账耗尽时要人看一眼的那一条。 */
export interface UnresolvedDelivery {
  outbox_id: string
  thread_ref: string
  attempts: number
  approval_item_id?: string
  last_error?: string
}

export interface ChannelsAssembly {
  /** 受控原始材料区（保留期与随主体删除都从这里进）。 */
  raw: RawStore
  /** 现在装着哪几个邮箱地址。 */
  addresses(): string[]
  /** 调度器消费者：拉一轮所有邮箱 + 推一轮重试队列。 */
  poll(): Promise<MailPollReport>
  /** 连接页新增 / 断开邮箱之后热更新（幂等，可反复调）。 */
  refresh(): void
  /** WP55 / 48 §4 L3 #2：Amazon 24h SLA 三档 sweep（调度器每 5 分钟调一次）。 */
  amazonSlaSweep(): Promise<AmazonSlaReport>
  /** WP55 / 48 §4 L3 #4：出站对账（调度器每分钟调一次）。绝不自动重发。 */
  reconcileDeliveries(): Promise<ReconcileReport>
  /** WP55：出站 outbox（工作台与人工卡要能翻这张表）。 */
  outbox: Outbox
  /**
   * 出站：审批通过的对外草稿真发出去。
   * 回 `undefined` = 这条不归渠道管（不是邮件 / 没有线程 / 没装邮箱），调用方回落到别处。
   */
  deliver(item: ApprovalItem, opts: { idempotencyKey: string }): Promise<BackendResult | undefined>
  /** 21 §4 随主体删除（`./erase.ts` 的编排调它）。 */
  eraseSubject(subject: string): Promise<{ shredded_at?: string; rows: number }>
  /** 18 §2.1 保留期。 */
  prune(retentionMs: number, now: Iso8601): Promise<number>
  close(): Promise<void>
}

const textOf = (parts: readonly MessagePart[]): string =>
  parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
    .trim()

/** 时间线上给人看的一行：去掉围栏标记（进模型的那一份仍然带围栏）。 */
export function forDisplay(text: string, max = 200): string {
  const stripped = text
    .replace(/<\/?external_data>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return stripped.length > max ? `${stripped.slice(0, max - 1)}…` : stripped
}

/** 收件人 / 线程 → 事项的钉子：事项的 `pinned` 里放一条 thread ref，重启后还认得出。 */
const threadRef = (external_id: string): ObjectRef => ({ type: 'thread', id: external_id })

/** `channel_meta` 里的一个 ISO 串 → SLA 状态的一个字段（不是串就当没有）。 */
function pickIso<K extends string>(
  meta: Record<string, unknown>,
  from: string,
  to: K,
): Partial<Record<K, Iso8601>> {
  const value = meta[from]
  return typeof value === 'string' && value.length > 0
    ? ({ [to]: value as Iso8601 } as Partial<Record<K, Iso8601>>)
    : {}
}

export function createChannels(options: ChannelsOptions): ChannelsAssembly {
  const { clock, workspace_id, dbDir } = options

  // ── 三样共用的：受控原始材料区、队列、去重表 ─────────────────────────
  // 表不共享别人的（35 §2），但同一个进程里的几个邮箱账号共用这三样：
  // 同一封信从两个账号进来只该产生一条事件。
  const sqliteStores =
    dbDir === undefined
      ? undefined
      : createSqliteChannelStores({ dbPath: join(dbDir, 'channels.sqlite'), clock })
  const innerRaw =
    dbDir === undefined
      ? new MemoryRawStore({
          clock,
          ...(options.cipher === undefined ? {} : { cipher: options.cipher }),
        })
      : new SqliteRawStore({
          dbPath: join(dbDir, 'channels-raw.sqlite'),
          clock,
          // 18 §2.1 第一条纪律。漏了这一行邮件原文就是明文落盘。
          ...(options.cipher === undefined ? {} : { cipher: options.cipher }),
        })
  // WP40：装了对象存储就套一层——附件走 blob，邮件原文照旧留库
  const raw: RawStore =
    options.blobs === undefined
      ? innerRaw
      : new BlobBackedRawStore({ inner: innerRaw, blobs: options.blobs })
  const queue = sqliteStores?.queue ?? new MemoryQueueStore()
  const dedupe = sqliteStores?.dedupe ?? new MemoryDedupeStore()
  /**
   * WP55 / 48 §4 L3 #4：出站 outbox。与队列、去重表同一张库（同一个进程里的几个
   * 邮箱账号共用），因为幂等是按**审批项**算的，不是按邮箱算的。
   */
  const outbox = new Outbox({
    store: sqliteStores?.outbox ?? new MemoryOutboxStore(),
    workspace_id,
    onTransition: (e: OutboxTransitionEvent) => {
      options.appendEvent({
        schema_version: 1,
        workspace_id,
        type: 'outbound.state_changed',
        actor: { kind: 'system', id: 'channel:outbox' },
        subject: { type: 'outbox', id: e.record.id },
        correlation: { trace_id: `tr_obx_${e.record.id}` },
        // 只记状态与分类标记：收件人与正文永远不进日志
        payload: {
          from: e.from,
          to: e.to,
          attempts: e.record.attempts,
          ...(e.reason === undefined ? {} : { reason: e.reason }),
        },
      })
    },
  })

  let channels: MailChannel[] = []

  // ── 入站的最后一跳：落成岗位事项，起 Run ───────────────────────────
  const matterFor = (event: InboundEvent): Matter | undefined => {
    const work = options.work
    const thread = event.thread?.external_id
    if (work === undefined || thread === undefined) return undefined
    const ref = threadRef(thread)
    /**
     * WP53：来信人也钉在事项上。
     *
     * 收件人门禁（31 §3.3）要的是"这次运行读过这个联系人"——运行时只认注入进
     * ContextItem 的那几条 pinned。09-14 真店验收里草稿卡建不出来，就差这一条：
     * 线程钉上了，写信的人没钉上。
     */
    const actor = event.actor?.resolved
    const existing = work
      .listMatters({ kind: 'conversation' })
      .find((m) => m.context.pinned.some((p) => p.type === ref.type && p.id === ref.id))
    if (existing !== undefined) {
      if (
        actor !== undefined &&
        !existing.context.pinned.some((p) => p.type === actor.type && p.id === actor.id)
      ) {
        // 老事项是 WP53 之前开的（只钉了线程）：补钉一次，下一次运行就认得出收件人
        return work.pin(existing.id, actor)
      }
      return existing
    }
    const position = options.position?.()
    const who = event.actor?.display ?? event.actor?.external_id ?? '客户'
    return work.createMatter({
      kind: 'conversation',
      title: `与 ${who} 的往来`,
      pinned: actor === undefined ? [ref] : [ref, actor],
      ...(position === undefined ? {} : { position_id: position.assignment_id }),
    })
  }

  /**
   * 同一封信在队列里重试时（起 Run 抛了异常 → 退避 → 再来），时间线上不能每次都多一行来信。
   * 09-12 真账号验收：一封客户来信重试五次，事项里出现五条一模一样的 human_message。
   * 按 (事项, 去重键) 记一下——只在本进程内，跨重启的重复由去重表（24h 窗口）兜住。
   */
  const appendedInbound = new Set<string>()

  /**
   * WP55：SLA 的三档（提醒 / 升级 / 闭账）落在**事项时间线**上——那是人真正会看的
   * 地方。找不到事项就只留事件（线程还没落成事项时不该凭空开一个）。
   */
  const noteOnThread = (thread_external: string, text: string): void => {
    const work = options.work
    if (work === undefined) return
    const ref = threadRef(thread_external)
    const matter = work
      .listMatters({ kind: 'conversation' })
      .find((m) => m.context.pinned.some((p) => p.type === ref.type && p.id === ref.id))
    if (matter === undefined) return
    work.appendEvent(matter.id, {
      kind: 'note',
      text,
      actor: { kind: 'system', id: 'channel:amazon' },
    })
  }

  const onEvent = async (event: InboundEvent): Promise<void> => {
    const work = options.work
    const matter = matterFor(event)
    if (work === undefined || matter === undefined) return
    // 进模型的正文仍然带围栏（管线已经围过了）；时间线上给人看的那一行去掉标记
    const body = textOf(event.parts)
    const inboundKey = `${matter.id}|${event.dedupe_key}`
    if (!appendedInbound.has(inboundKey)) {
      appendedInbound.add(inboundKey)
      work.appendEvent(matter.id, {
        kind: 'human_message',
        text: forDisplay(body),
        actor: { kind: 'system', id: `channel:${event.channel}` },
        ...(event.actor?.resolved === undefined ? {} : { ref: event.actor.resolved }),
      })
    }
    // WP55：钓鱼 / 退信 / A-to-z 这几类**落库但绝不生成草稿**——它们要人看一眼。
    // 「不静默丢」与「不自动回」是同一条纪律的两面：信留在事项里，Run 不起。
    const meta = event.channel_meta
    if (meta?.needs_human_review === true || meta?.generates_draft === false) {
      const summary = typeof meta.summary === 'string' ? meta.summary : '渠道判定要求人工处理'
      work.appendEvent(matter.id, {
        kind: 'note',
        text: `${summary}——按渠道规则不生成回复草稿，请人看一眼。`,
        actor: { kind: 'system', id: `channel:${event.channel}` },
      })
      return
    }
    const position = options.position?.()
    const startRun = options.startRun
    if (startRun === undefined || position === undefined) return
    const { run_id } = await startRun({
      matter,
      brief: body,
      actor: { person_id: position.person_id, assignment_id: position.assignment_id },
    })
    work.appendEvent(matter.id, {
      kind: 'run',
      text: '收到来信，开始处理',
      actor: { kind: 'agent', id: position.role_id },
      run_id,
    })
  }

  // ── 一个账号的装配 ─────────────────────────────────────────────────
  const build = (account: MailAccount): MailChannel => {
    const source =
      options.makeSource?.(account, options.credentials) ??
      new ImapMailSource({
        config: {
          host: account.imap.host,
          port: account.imap.port,
          secure: account.imap.secure,
          user: account.imap.user,
          connection_id: account.connection_id,
          ...(options.batch === undefined ? {} : { batch: options.batch }),
        },
        credentials: options.credentials,
      })
    const mailer =
      options.makeMailer?.(account, options.credentials) ??
      new SmtpMailer({
        config: {
          host: account.smtp.host,
          port: account.smtp.port,
          secure: account.smtp.secure,
          user: account.smtp.user,
          connection_id: account.connection_id,
        },
        credentials: options.credentials,
      })
    const adapter = new EmailChannelAdapter({
      clock,
      rawStore: raw,
      address: account.address,
      source,
      mailer,
      // WP55 / 48 §4 L3 #2：Amazon 买家消息寄生在这只客服邮箱上。判定在 AI 分类
      // 之前，不花积分；判成 amazon 的线程从此走 Amazon 那一套（硬闸 + 24h SLA）。
      classify_sub_channel: createAmazonSubChannelClassifier(clock),
      on_error: (e) => {
        options.appendEvent({
          schema_version: 1,
          workspace_id,
          type: 'inbound.dead_letter',
          actor: { kind: 'system', id: 'channel:email' },
          correlation: { trace_id: `tr_mail_${clock.now()}` },
          // 只有原因，没有凭据：失败原文里可能带服务器回的登录提示
          payload: { reason: 'imap_poll_failed', account: account.address, detail: String(e) },
        })
      },
    })
    const pipeline = new ChannelInboundPipeline({
      clock,
      adapters: [adapter],
      workspace_id,
      events: { append: (e) => options.appendEvent(e as Omit<EventEnvelope, 'id' | 'at'>) },
      rawStore: raw,
      queue,
      dedupe,
      route: (input) => options.route?.(input) ?? defaultRoute(input),
      // WP53：发件人解析进管线；解析结果就是事项上要钉的那条联系人
      ...(options.resolveActor === undefined
        ? {}
        : { resolveActor: options.resolveActor.bind(options) }),
      onEvent,
    })
    return { account, adapter, pipeline, source }
  }

  const refresh = (): void => {
    const wanted = options.accounts()
    const byId = new Map(channels.map((c) => [c.account.connection_id, c]))
    const next: MailChannel[] = []
    for (const account of wanted) {
      const existing = byId.get(account.connection_id)
      // 同一条连接、同一个地址 = 同一个适配器（保住它的 lastUid 与线程台账）
      if (existing !== undefined && existing.account.address === account.address) {
        next.push(existing)
        byId.delete(account.connection_id)
        continue
      }
      next.push(build(account))
    }
    // 断开的那几个：停掉轮询循环，别再拿一份已经删掉的口令去登录
    for (const gone of byId.values()) void gone.adapter.stop()
    channels = next
  }

  refresh()
  options.accounts().length // 触发一次求值，装配时就知道有没有邮箱

  return {
    raw,
    addresses: () => channels.map((c) => c.account.address),
    refresh,

    async poll(): Promise<MailPollReport> {
      refresh()
      let messages = 0
      let retried = 0
      const failed: string[] = []
      for (const channel of channels) {
        try {
          // **要 await**：管线的每一跳（去重 / 脱敏 / 路由 / 起 Run）都在这一条里，
          // 放开手不管的话「拉完一轮」就只是「网络收完了」，不是「处理完了」。
          messages += await channel.adapter.poll(async (rawMail) => {
            try {
              await channel.pipeline.ingest('email', rawMail, workspace_id)
            } catch (e) {
              // 一封信解析不了不该让这一轮剩下的信都拉不进来
              failed.push(
                `${channel.account.address}: ${e instanceof Error ? e.message : String(e)}`,
              )
            }
          })
        } catch (e) {
          // 一个邮箱连不上不该拖垮别的邮箱；下一轮再试
          failed.push(`${channel.account.address}: ${e instanceof Error ? e.message : String(e)}`)
        }
        // 上一轮触发失败的那几条按退避重排（18 §2.2 重试 ≤ 5 次，之后死信）
        retried += await channel.pipeline.pump()
      }
      return { accounts: channels.length, messages, retried, failed }
    },

    async deliver(item, opts): Promise<BackendResult | undefined> {
      const payload = item.payload as { channel?: string; thread_ref?: string; body?: unknown }
      if (payload.channel !== 'email') return undefined
      const thread = payload.thread_ref
      if (typeof thread !== 'string' || thread.length === 0) return undefined
      // 收件人只从线程台账取（31 §3.3），所以要找到**认识这个线程**的那个账号
      const channel = await pick(channels, thread)
      if (channel === undefined) return undefined

      // 15 §5.8 / 28 §1：出站急停。对账没完、或人按了托盘的「暂停」，这里一律不发。
      if (options.halt.isHalted('outbound')) {
        return { status: 'failed', error: { message: OUTBOUND_HALTED, retryable: true } }
      }

      const body = payload.body as { text?: string; subject?: string } | undefined
      const text = typeof body?.text === 'string' ? body.text : ''

      // WP55 / 48 §4 L3 #2：**Amazon 出站硬闸**。
      //
      // 触发条件是收件人域，与任何开关无关：急停关了也照样跑（急停该让判定回到
      // 现状，不该让一封已经存在的 Amazon 线程绕过 Amazon 的社区规范）。拦下 =
      // **打回重写**，原因原样回给调用方喂进重写循环——绝不静默删改后照发，
      // 那会让运营永远不知道模型在写违规内容。
      const record = await channel.adapter.threads.get(thread)
      const amazonTo = (record?.participants ?? []).find((p) => isMarketplaceRelayAddress(p))
      if (record?.channel === 'amazon' || amazonTo !== undefined) {
        const verdict = evaluateAmazonOutbound('amazon', {
          to_address: amazonTo ?? record?.participants[0] ?? '',
          subject:
            typeof body?.subject === 'string' ? body.subject : `Re: ${record?.subject ?? ''}`,
          original_subject: record?.subject ?? null,
          body_text: text,
          is_reply_to_buyer_thread: (record?.references.length ?? 0) > 0,
          recipient_opted_out: record?.channel_meta?.message_type === 'buyer_opt_out',
        })
        if (!verdict.ok) {
          options.appendEvent({
            schema_version: 1,
            workspace_id,
            type: 'delivery.failed',
            actor: { kind: 'system', id: 'channel:amazon' },
            subject: { type: 'approval_item', id: item.id },
            correlation: { trace_id: `tr_amz_guard_${item.id}` },
            // 只记违规码与中文原因，不记正文
            payload: {
              reason: 'amazon_outbound_guard',
              thread_ref: thread,
              codes: verdict.violations.map((v) => v.code),
            },
          })
          return {
            status: 'failed',
            error: {
              // 同一份正文重发多少次都会被同一条规则拦下：不可重试，只能重写
              message: `${AMAZON_OUTBOUND_BLOCKED}\n${summarizeAmazonViolations(verdict.violations)}\n\n${buildAmazonRewriteInstruction(verdict.violations)}`,
              retryable: false,
            },
          }
        }
      }

      // WP55 / 48 §4 L3 #4：**出站 outbox**。
      //
      // SMTP 抛异常不等于这封信没发出去，所以发送前先在这张表上落一行：同一审批项
      // 只发一次（重试、人手再按一遍通过、进程重启后的补偿，都只认这一行）。
      const to = (record?.participants ?? []).filter((p) => p !== channel.account.address)
      const prepared = await outbox.prepare({
        idempotency_key: opts.idempotencyKey,
        thread_ref: thread,
        message_id: messageIdFor(opts.idempotencyKey, domainOf(channel.account.address)),
        // 只哈希**草稿内容**（收件人 + 主题 + 正文）。线程头不进哈希：它是投递管线
        // 按线程台账现算的，第一封发出去之后 `last_message_id` 就变了——把它算进去
        // 的话，同一张卡重投一次会被自己误判成 payload_drift。
        payload_hash: outboxPayloadHash({
          to,
          text,
          ...(typeof body?.subject === 'string' ? { subject: body.subject } : {}),
        }),
        approval_item_id: item.id,
        now: clock.now(),
      })
      if (prepared.kind === 'payload_drift') {
        // 同一幂等键换了正文：这是调用方的 bug，不该被当成"重试"悄悄发出另一封信
        return {
          status: 'failed',
          error: { message: OUTBOX_PAYLOAD_DRIFT, retryable: false },
        }
      }
      if (prepared.kind === 'already') {
        // 已经发过（或可能已经发出去了）：**不要再发**。回 ok 让调用方别重试——
        // `sent_unknown` 那一份由对账去找证据，不由这里去赌。
        return { status: 'ok', execution_id: prepared.record.external_id ?? prepared.record.id }
      }

      let row = await outbox.beginSend(prepared.record, clock.now())
      try {
        // 正文的出站脱敏在适配器的 `send` 里（`redactOutbound('email_body', …)`）
        const sent = await channel.adapter.send({ external_id: thread }, [{ type: 'text', text }], {
          connect_token: '',
          idempotency_key: opts.idempotencyKey,
        })
        row = await outbox.markAccepted(row, clock.now(), sent.external_id)
        return { status: 'ok', execution_id: sent.external_id }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        const code = (e as { code?: string }).code
        // 三态分类：只有能证明"在被接受之前就失败了"的错误才可重试，其余一律歧义
        const failure = classifySendFailure(
          Object.assign(
            e instanceof Error ? e : new Error(message),
            code === undefined ? {} : { code },
          ),
        )
        row = await outbox.recordFailure(row, failure, clock.now())
        return {
          status: 'failed',
          error: {
            message: `${message}（outbox：${row.status}）`,
            // `sent_unknown` **绝不自动重试**：重发一封可能已经发出去的信，
            // 代价是客户收到两封，而两封信是收不回来的。
            retryable: row.status === 'failed_retryable',
          },
        }
      }
    },

    outbox,

    /**
     * WP55 / 48 §4 L3 #4：出站对账。
     *
     * 对一轮 `sent_unknown` 与迟迟没确认的已受理项，去已发 / 归档文件夹里搜
     * Message-ID 找证据。找到 → `confirmed`；找不到 → 排下一次；退避次数耗尽 →
     * 出人工卡。**任何一条路上都不重发。**
     */
    async reconcileDeliveries(): Promise<ReconcileReport> {
      const now = clock.now()
      const report: ReconcileReport = {
        scanned: 0,
        confirmed: 0,
        still_unknown: 0,
        escalated: 0,
      }
      const due = await outbox.dueForReconcile(now, RECONCILE_BATCH)
      for (const record of due) {
        report.scanned += 1
        const channel = await pick(channels, record.thread_ref)
        let found: { source: 'sent_folder' | 'archive_folder' } | undefined
        try {
          const folder = await channel?.source.findMessageId?.(record.message_id)
          if (folder !== undefined) {
            found = {
              source: folder === ARCHIVE_FOLDER ? 'archive_folder' : 'sent_folder',
            }
          }
        } catch {
          // 搜不动（邮箱连不上 / 服务器不支持 SEARCH）：这一轮当"没找到证据"，
          // 下一轮再试。**不**当成"没发出去"。
        }
        const { record: next, outcome } = await outbox.recordReconcile(record, found, now)
        if (outcome === 'confirmed') report.confirmed += 1
        else if (outcome === 'exhausted') report.escalated += 1
        else report.still_unknown += 1

        options.appendEvent({
          schema_version: 1,
          workspace_id,
          type: 'outbound.reconciled',
          actor: { kind: 'system', id: 'channel:outbox' },
          subject: { type: 'outbox', id: next.id },
          correlation: { trace_id: `tr_obx_${next.id}` },
          // 只记结论与计数：收件人、正文、Message-ID 都不进日志
          payload: {
            outcome,
            status: next.status,
            reconcile_attempts: next.reconcile_attempts,
            ...(next.confirmation_source === undefined
              ? {}
              : { confirmation_source: next.confirmation_source }),
          },
        })

        if (outcome === 'exhausted') {
          await options.escalateUnresolvedDelivery?.({
            outbox_id: next.id,
            thread_ref: next.thread_ref,
            attempts: next.reconcile_attempts,
            ...(next.approval_item_id === undefined
              ? {}
              : { approval_item_id: next.approval_item_id }),
            ...(next.last_error === undefined ? {} : { last_error: next.last_error }),
          })
        }
      }
      return report
    },

    /**
     * WP55 / 48 §4 L3 #2：Amazon 24h SLA 三档 sweep。
     *
     * 幂等靠线程 `channel_meta` 里的三个字段（`sla_reminder_fired_at` /
     * `sla_escalation_fired_at` / `sla_cycle_accounted_at`），语义都是「为空**或
     * 早于锚** = 本轮还没做」。新一轮买家来信把锚往前推，三个字段自动全部过期
     * = 重新武装，不需要任何清理任务。
     *
     * 认领（写三个字段）与出卡在同一跳里做完：出卡失败就不写字段，下一轮补上
     * ——反过来（先写后出）会让一次网络抖动把这一轮的卡永远吞掉。
     */
    async amazonSlaSweep(): Promise<AmazonSlaReport> {
      const now = clock.now()
      const report: AmazonSlaReport = { scanned: 0, reminders: 0, criticals: 0, accounted: 0 }
      for (const channel of channels) {
        const threads = (await channel.adapter.threads.list?.()) ?? []
        for (const record of threads) {
          if (record.channel !== 'amazon') continue
          const meta = record.channel_meta ?? {}
          const state: AmazonSlaThreadState = {
            thread_id: record.external_id,
            ...pickIso(meta, 'last_buyer_message_at', 'last_buyer_message_at'),
            ...pickIso(meta, 'last_outbound_at', 'last_outbound_at'),
            ...pickIso(meta, 'sla_reminder_fired_at', 'reminder_fired_at'),
            ...pickIso(meta, 'sla_escalation_fired_at', 'escalation_fired_at'),
            ...pickIso(meta, 'sla_cycle_accounted_at', 'cycle_accounted_at'),
          }
          if (state.last_buyer_message_at === undefined) continue
          report.scanned += 1
          const action = evaluateAmazonSlaCycle(state, now)
          if (action.kind === 'none') continue

          const patch: Record<string, unknown> = {}
          let text: string
          if (action.kind === 'reminder') {
            patch.sla_reminder_fired_at = now
            report.reminders += 1
            text = `${amazonSlaCardTitle('reminder', record.external_id, action.cycle_stamp)}：还有 ${action.remaining_minutes} 分钟到 24 小时响应线。`
          } else if (action.kind === 'critical') {
            patch.sla_escalation_fired_at = now
            // 12h 档已被 4h 档吸收：第一次看见就已经 ≤4h 的线程不该先补一张提醒卡
            if (action.absorbs_reminder) patch.sla_reminder_fired_at = now
            report.criticals += 1
            text = `${amazonSlaCardTitle('critical', record.external_id, action.cycle_stamp)}：只剩 ${action.remaining_minutes} 分钟（负数 = 已超时），再不回就要扣响应率。`
          } else {
            patch.sla_cycle_accounted_at = now
            if (action.responded) {
              patch.sla_reminder_fired_at = now
              patch.sla_escalation_fired_at = now
            }
            report.accounted += 1
            text =
              action.outcome === 'within'
                ? `Amazon 24 小时响应闭账：这封买家来信已在窗口内回复（截止 ${action.deadline}）。`
                : `Amazon 24 小时响应闭账：**超时未回**（截止 ${action.deadline}），这一笔计入 miss。`
          }

          options.appendEvent({
            schema_version: 1,
            workspace_id,
            type: 'support.amazon_sla',
            actor: { kind: 'system', id: 'channel:amazon' },
            subject: { type: 'thread', id: record.external_id },
            correlation: { trace_id: `tr_amz_sla_${record.external_id}` },
            // 只记档位与时刻，不记正文、不记 relay 地址
            payload: {
              tier: action.kind,
              deadline: action.deadline,
              cycle_stamp: action.kind === 'account' ? action.cycle_stamp : action.cycle_stamp,
              ...(action.kind === 'account' ? { outcome: action.outcome } : {}),
            },
          })
          noteOnThread(record.external_id, text)
          await channel.adapter.threads.upsert(
            mergeThread(record, {
              external_id: record.external_id,
              participants: record.participants,
              references: record.references,
              at: now,
              channel_meta: patch,
              ...(record.subject === undefined ? {} : { subject: record.subject }),
            }),
          )
        }
      }
      return report
    },

    eraseSubject: async (subject) => raw.eraseSubject(subject),
    prune: async (retentionMs) => raw.prune(retentionMs, clock),

    async close(): Promise<void> {
      for (const channel of channels) await channel.adapter.stop()
      channels = []
      sqliteStores?.close()
      ;(raw as Partial<SqliteRawStore>).close?.()
    },
  }
}

/** 哪个账号认识这条线程（收件人门禁的依据在各自的线程台账里）。 */
async function pick(
  channels: readonly MailChannel[],
  thread: string,
): Promise<MailChannel | undefined> {
  for (const channel of channels) {
    if ((await channel.adapter.threads.get(thread)) !== undefined) return channel
  }
  // 一个账号都没认出来：只有一个账号时交给它（由它的门禁去拒），否则交不出去
  return channels.length === 1 ? channels[0] : undefined
}
