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
  ChannelInboundPipeline,
  type CredentialSource,
  createSqliteChannelStores,
  defaultRoute,
  EmailChannelAdapter,
  ImapMailSource,
  type Mailer,
  type MailSource,
  MemoryDedupeStore,
  MemoryQueueStore,
  MemoryRawStore,
  type RawStore,
  type RouteInput,
  type RouteResult,
  SmtpMailer,
  SqliteRawStore,
} from '@agentsws/channels'
import type {
  ApprovalItem,
  Clock,
  EventEnvelope,
  Halt,
  InboundEvent,
  Iso8601,
  Matter,
  MessagePart,
  ObjectRef,
  PersonId,
  RoleId,
  StartRun,
  WorkspaceId,
} from '@agentsws/contracts'
import type { RawCipher } from '@agentsws/core'
import type { BackendResult } from '@agentsws/txn'
import type { Work } from '@agentsws/work'
import type { MailAccount } from './connections.js'

/** 出站被急停挡下时回给执行器的那一条。 */
export const OUTBOUND_HALTED = '出站已急停（AGENTSWS_HALT=outbound 或对账未完成），这封信没有发出'

/** 一个装好的邮箱账号：适配器 + 它自己的那条入站管线。 */
interface MailChannel {
  account: MailAccount
  adapter: EmailChannelAdapter
  pipeline: ChannelInboundPipeline
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
  /** 测试注入：收信端。缺省真 IMAP（`imapflow`）。 */
  makeSource?(account: MailAccount, credentials: CredentialSource): MailSource
  /** 测试注入：发信端。缺省真 SMTP（`nodemailer`）。 */
  makeMailer?(account: MailAccount, credentials: CredentialSource): Mailer
  /** 每轮最多取多少封。 */
  batch?: number
}

export interface MailPollReport {
  accounts: number
  messages: number
  /** 重试队列这一轮推动了几条。 */
  retried: number
  /** 拉不动的那几个账号（一个坏了不该拖垮别的）。 */
  failed: string[]
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

export function createChannels(options: ChannelsOptions): ChannelsAssembly {
  const { clock, workspace_id, dbDir } = options

  // ── 三样共用的：受控原始材料区、队列、去重表 ─────────────────────────
  // 表不共享别人的（35 §2），但同一个进程里的几个邮箱账号共用这三样：
  // 同一封信从两个账号进来只该产生一条事件。
  const sqliteStores =
    dbDir === undefined
      ? undefined
      : createSqliteChannelStores({ dbPath: join(dbDir, 'channels.sqlite'), clock })
  const raw: RawStore =
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
  const queue = sqliteStores?.queue ?? new MemoryQueueStore()
  const dedupe = sqliteStores?.dedupe ?? new MemoryDedupeStore()

  let channels: MailChannel[] = []

  // ── 入站的最后一跳：落成岗位事项，起 Run ───────────────────────────
  const matterFor = (event: InboundEvent): Matter | undefined => {
    const work = options.work
    const thread = event.thread?.external_id
    if (work === undefined || thread === undefined) return undefined
    const ref = threadRef(thread)
    const existing = work
      .listMatters({ kind: 'conversation' })
      .find((m) => m.context.pinned.some((p) => p.type === ref.type && p.id === ref.id))
    if (existing !== undefined) return existing
    const position = options.position?.()
    const who = event.actor?.display ?? event.actor?.external_id ?? '客户'
    return work.createMatter({
      kind: 'conversation',
      title: `与 ${who} 的往来`,
      pinned: [ref],
      ...(position === undefined ? {} : { position_id: position.assignment_id }),
    })
  }

  const onEvent = async (event: InboundEvent): Promise<void> => {
    const work = options.work
    const matter = matterFor(event)
    if (work === undefined || matter === undefined) return
    // 进模型的正文仍然带围栏（管线已经围过了）；时间线上给人看的那一行去掉标记
    const body = textOf(event.parts)
    work.appendEvent(matter.id, {
      kind: 'human_message',
      text: forDisplay(body),
      actor: { kind: 'system', id: `channel:${event.channel}` },
      ...(event.actor?.resolved === undefined ? {} : { ref: event.actor.resolved }),
    })
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
      onEvent,
    })
    return { account, adapter, pipeline }
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
      try {
        // 正文的出站脱敏在适配器的 `send` 里（`redactOutbound('email_body', …)`）
        const sent = await channel.adapter.send({ external_id: thread }, [{ type: 'text', text }], {
          connect_token: '',
          idempotency_key: opts.idempotencyKey,
        })
        return { status: 'ok', execution_id: sent.external_id }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        const code = (e as { code?: string }).code
        // 收件人门禁拒发不是「网络抖了」，重试没有意义
        return {
          status: 'failed',
          error: { message, retryable: code !== 'authorization_check_failed' },
        }
      }
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
