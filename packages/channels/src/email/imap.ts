import type { Iso8601 } from '@agentsws/contracts'
import { ImapFlow } from 'imapflow'
import { ChannelError } from '../errors.js'

/** 一封从邮箱取回来的原始邮件（未解析）。 */
export interface RawEmailMessage {
  uid: number
  mailbox: string
  /** 原始 MIME 源；只进受控原始材料区 */
  source: string
  internal_date?: Iso8601
  /**
   * WP113（63 §7）：服务器上的 flags（`\Seen` / `\Flagged` / `\Answered` / `\Draft`）。
   *
   * 消息库要它才说得出"这封读过没有"。老调用方（入站管线）不看这一格，
   * 不实现的替身也照常工作——那时消息库里一律按"未读、没星标"算。
   */
  flags?: readonly string[]
}

/** 收信端口：适配器只依赖它，imapflow 是其默认实现，测试可注入内存实现。 */
export interface MailSource {
  /** 按 UID 增量拉取（只返回 uid > since_uid 的，升序）。 */
  fetchSince(since_uid: number, limit?: number): Promise<RawEmailMessage[]>
  health(): Promise<{ ok: boolean; detail?: string }>
  close?(): Promise<void>
  /**
   * WP55 / 48 §4 L3 #5：这个文件夹当前的 `UIDVALIDITY`。
   *
   * 它一变，游标水位立刻作废（服务器重建过邮箱）。不实现 = 永远回同一个值，
   * 游标照常工作，只是失去了"服务器重建过"这一层保护。
   */
  uidValidity?(): Promise<number>
  /**
   * WP55 / 48 §4 L3 #5：把处理过的信搬进归档文件夹并标已读。
   *
   * 建不了 / 服务器拒绝 MOVE **只 log**——归档是锦上添花，不该拖垮收信。
   * 回 `false` = 没搬动（调用方据此只记一条日志，不重试、不报错）。
   */
  archive?(uid: number, folder: string, mark_read: boolean): Promise<boolean>
  /**
   * WP55 / 48 §4 L3 #4：去已发 / 归档文件夹里搜一个 Message-ID。
   *
   * 出站对账的全部内容就是这一句话：一封 `sent_unknown` 的信到底发出去没有，
   * 唯一能问的人是邮箱服务器自己——「已发送」里有没有它。
   *
   * 可选：不实现 = 这只邮箱的对账永远找不到证据，于是走到退避耗尽出人工卡。
   * 那是**正确**的降级（人去看一眼），不是静默重发。
   */
  findMessageId?(message_id: string, folders?: readonly string[]): Promise<string | undefined>
}

/** imapflow 里我们真正用到的那几个方法（便于替身与最小 IMAP 桩）。 */
export interface ImapClientLike {
  connect(): Promise<void>
  logout(): Promise<void>
  close(): void
  getMailboxLock(path: string): Promise<{ release: () => void }>
  /**
   * WP55：打开一个文件夹并拿到它的 `UIDVALIDITY`。
   *
   * WP113 多读一格 `permanentFlags`：含 `\*` 的服务器允许自定义 keyword，
   * 标签才同步得过去（63 §5）；不含就只在本地打标签，**不为了标签去挪信**。
   */
  mailboxOpen?(path: string): Promise<{
    uidValidity?: number | bigint | undefined
    permanentFlags?: readonly string[] | Set<string> | undefined
  }>
  /** WP55：新建文件夹（归档文件夹第一次用时）。 */
  mailboxCreate?(path: string): Promise<unknown>
  /** WP55：把一封信搬到另一个文件夹。 */
  messageMove?(range: string, destination: string, options: { uid: true }): Promise<unknown>
  /** WP55：加 flag（归档时顺手标已读）。 */
  messageFlagsAdd?(range: string, flags: string[], options: { uid: true }): Promise<unknown>
  /**
   * WP113（63 §7）：**去** flag。
   *
   * 回写要的是双向：人在工作台里把一封信标回未读，用户的邮箱软件里也该是未读。
   * 只加不减的回写会让"已读"变成一条单行道。
   */
  messageFlagsRemove?(range: string, flags: string[], options: { uid: true }): Promise<unknown>
  /** WP113：这台服务器上有哪些文件夹（全量同步要按真名逐个扫）。 */
  list?(): Promise<readonly { path: string }[]>
  /** WP55：按头搜（对账用）。imapflow 有，最小桩可以不实现。 */
  search?(
    query: { header: Record<string, string> },
    options: { uid: true },
  ): Promise<number[] | false | undefined>
  fetch(
    range: string,
    /** WP113：多取一格 `flags`——消息库要它才说得出"这封读过没有"。 */
    query: { uid: true; source: true; internalDate: true; flags?: true },
    options: { uid: true },
  ): AsyncIterable<{
    uid: number
    source?: Uint8Array | undefined
    internalDate?: Date | string | undefined
    flags?: Set<string> | readonly string[] | undefined
  }>
}

export interface ImapConfig {
  host: string
  port: number
  /** 993 用 TLS；测试里的内存桩用 false */
  secure: boolean
  user: string
  /**
   * 应用专用密码的**环境变量名**（13 §4.3：秘密只从环境变量读，绝不写进配置对象、
   * 不进事件、不进模型）。与 `connection_id` 二选一。
   */
  password_env?: string
  /**
   * WP20：这条邮箱连接的 id。给了就改从本机加密秘密库按 id 取口令
   * （用户在工作台的原生表单里填的那一份），`password_env` 就不用了。
   */
  connection_id?: string
  mailbox?: string
  /** 每轮最多取多少封，默认 50 */
  batch?: number
  /**
   * WP55 / 48 §4 L3 #5：处理过的信搬进哪个文件夹（缺省 `agentsws`）。
   * 建不了 / 服务器拒绝 MOVE 就只记一条日志——归档是锦上添花，不该拖垮收信。
   */
  archive_folder?: string
  /** WP55：对账去哪几个文件夹找证据；不给用 {@link DEFAULT_SENT_FOLDERS}。 */
  sent_folders?: readonly string[]
}

export function readSecretFromEnv(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const value = env[name]
  if (value === undefined || value.length === 0) {
    throw new ChannelError('unauthenticated', `环境变量未设置：${name}`, { env_var: name })
  }
  return value
}

/**
 * 凭据来源（WP20）。
 *
 * 邮箱口令原来只能来自环境变量；现在还可以来自本机的 AES-256-GCM 秘密库
 * （`apps/server/src/secret-store.ts`，用户在工作台原生表单里填的那一份）。
 * channels 只认这个最小端口，不认识 SQLite、不认识加密——凭据怎么存是装配方的事。
 */
export interface CredentialSource {
  /**
   * 取一条连接的口令；取不到就抛，别返回空串。
   *
   * `purpose` 区分收信与发信：多数邮箱两边同一个授权码（装配方对 `smtp` 回退到
   * 收信那一份），少数（用户自己填了发信专用密码）两边不同。缺省按 `imap`。
   */
  password(ref: { connection_id: string; purpose?: 'imap' | 'smtp' }): string
}

/**
 * 口令读取的**唯一入口**（IMAP 与 SMTP 共用）。
 *
 * 优先级：`connection_id`（秘密库）→ `password_env`（环境变量）→ 都没有则由调用方决定
 * 是不是允许无鉴权（本地 SMTP 桩）。任何一条路上都不把口令写进配置对象或日志。
 */
export function readPassword(
  config: { password_env?: string | undefined; connection_id?: string | undefined },
  env: NodeJS.ProcessEnv,
  credentials?: CredentialSource | undefined,
  purpose: 'imap' | 'smtp' = 'imap',
): string | undefined {
  if (config.connection_id !== undefined) {
    if (credentials === undefined) {
      throw new ChannelError(
        'unauthenticated',
        '这条邮箱连接的凭据在本机秘密库里，但适配器没装配 CredentialSource',
        { connection_id: config.connection_id },
      )
    }
    return credentials.password({ connection_id: config.connection_id, purpose })
  }
  if (config.password_env !== undefined) return readSecretFromEnv(config.password_env, env)
  return undefined
}

/** 把 imapflow 实例收窄成 `ImapClientLike`。 */
export function fromImapFlow(client: ImapFlow): ImapClientLike {
  return {
    connect: () => client.connect(),
    logout: () => client.logout(),
    close: () => {
      client.close()
    },
    getMailboxLock: async (path) => {
      const lock = await client.getMailboxLock(path)
      return { release: () => lock.release() }
    },
    mailboxOpen: (path) => client.mailboxOpen(path),
    mailboxCreate: (path) => client.mailboxCreate(path),
    messageMove: (range, destination, options) => client.messageMove(range, destination, options),
    messageFlagsAdd: (range, flags, options) => client.messageFlagsAdd(range, flags, options),
    // WP113：回写要双向（标回未读 / 去星标），所以 remove 也接出来
    messageFlagsRemove: (range, flags, options) => client.messageFlagsRemove(range, flags, options),
    list: async () => (await client.list()).map((b) => ({ path: b.path })),
    search: (query, options) => client.search(query, options),
    fetch: (range, query, options) => client.fetch(range, query, options),
  }
}

/**
 * WP55：出站对账要看的文件夹（按顺序找，命中即停）。
 *
 * 名字各家不一样（Gmail 是 `[Gmail]/Sent Mail`，Outlook 是 `Sent Items`）——
 * 全试一遍，打不开的跳过。多试几个文件夹的代价是几次 IMAP 往返，找不到证据的
 * 代价是一张本来不必出的人工卡。
 */
export const DEFAULT_SENT_FOLDERS: readonly string[] = [
  'Sent',
  'Sent Items',
  'Sent Messages',
  '[Gmail]/Sent Mail',
  '已发送',
  'agentsws',
]

export interface ImapMailSourceOptions {
  config: ImapConfig
  /** 默认用 imapflow；测试注入最小 IMAP 桩或内存实现 */
  createClient?: (config: ImapConfig, password: string) => ImapClientLike
  env?: NodeJS.ProcessEnv
  /** WP20：`config.connection_id` 存在时，口令从这里按连接 id 取。 */
  credentials?: CredentialSource
}

/**
 * IMAP 收信（18 §2.2 的「接收」一跳）。每轮 poll 开一条连接、按 UID 增量取、取完登出——
 * 常驻长连接留给后续 IDLE 支持，轮询档不值得为它承担重连状态机。
 */
export class ImapMailSource implements MailSource {
  private readonly config: ImapConfig
  private readonly env: NodeJS.ProcessEnv
  private readonly createClient: (config: ImapConfig, password: string) => ImapClientLike
  private readonly credentials: CredentialSource | undefined

  constructor(opts: ImapMailSourceOptions) {
    this.config = opts.config
    this.env = opts.env ?? process.env
    this.createClient = opts.createClient ?? defaultImapClient
    this.credentials = opts.credentials
  }

  get mailbox(): string {
    return this.config.mailbox ?? 'INBOX'
  }

  async fetchSince(since_uid: number, limit?: number): Promise<RawEmailMessage[]> {
    const batch = limit ?? this.config.batch ?? 50
    const client = this.connectedClient()
    const out: RawEmailMessage[] = []
    try {
      await client.connect()
      const lock = await client.getMailboxLock(this.mailbox)
      try {
        // UID `n:*` 至少回一条（即使其 uid < n），所以这里还要自己过一遍。
        const range = `${Math.max(1, since_uid + 1)}:*`
        for await (const msg of client.fetch(
          range,
          { uid: true, source: true, internalDate: true, flags: true },
          { uid: true },
        )) {
          if (msg.uid <= since_uid) continue
          if (msg.source === undefined) continue
          const flags = flagsOf(msg.flags)
          out.push({
            uid: msg.uid,
            mailbox: this.mailbox,
            source: Buffer.from(msg.source).toString('utf8'),
            ...(internalDateOf(msg.internalDate) === undefined
              ? {}
              : { internal_date: internalDateOf(msg.internalDate) as Iso8601 }),
            ...(flags === undefined ? {} : { flags }),
          })
          if (out.length >= batch) break
        }
      } finally {
        lock.release()
      }
      await client.logout()
    } catch (e) {
      client.close()
      throw asChannelError(e, 'IMAP 拉取失败')
    }
    return out.sort((a, b) => a.uid - b.uid)
  }

  /**
   * WP55 / 48 §4 L3 #5：这个文件夹当前的 `UIDVALIDITY`。
   *
   * 取不到就回 0：游标照常工作，只是失去了"服务器重建过邮箱"这一层保护——
   * 比整轮拉取失败强。
   */
  async uidValidity(): Promise<number> {
    const client = this.connectedClient()
    if (client.mailboxOpen === undefined) return 0
    try {
      await client.connect()
      const box = await client.mailboxOpen(this.mailbox)
      await client.logout()
      return Number(box.uidValidity ?? 0)
    } catch {
      client.close()
      return 0
    }
  }

  /**
   * WP55 / 48 §4 L3 #5：把处理过的信搬进归档文件夹并标已读。
   *
   * 文件夹不存在就先建一个；建不了 / 服务器拒绝 MOVE 一律回 `false`（调用方只
   * 记一条日志）。**绝不抛**——归档是锦上添花，不该拖垮这一轮收信。
   */
  async archive(uid: number, folder: string, mark_read: boolean): Promise<boolean> {
    const client = this.connectedClient()
    if (client.messageMove === undefined) return false
    try {
      await client.connect()
      try {
        const lock = await client.getMailboxLock(this.mailbox)
        try {
          if (mark_read) {
            await client.messageFlagsAdd?.(String(uid), ['\\Seen'], { uid: true })
          }
          try {
            await client.messageMove(String(uid), folder, { uid: true })
          } catch {
            // 文件夹可能还不存在：建一个再搬一次，还不行就认输
            await client.mailboxCreate?.(folder)
            await client.messageMove(String(uid), folder, { uid: true })
          }
        } finally {
          lock.release()
        }
      } finally {
        await client.logout()
      }
      return true
    } catch {
      client.close()
      return false
    }
  }

  /**
   * WP55 / 48 §4 L3 #4：去已发 / 归档文件夹里搜这个 Message-ID。
   *
   * 找到 = 这封信确实发出去了（`confirmed`）；找不到 **不等于**没发出去，只等于
   * 「这一轮没拿到证据」——所以返回 `undefined` 的那条路上一个字都不会重发。
   */
  async findMessageId(
    message_id: string,
    folders: readonly string[] = this.config.sent_folders ?? DEFAULT_SENT_FOLDERS,
  ): Promise<string | undefined> {
    const normalized = message_id.startsWith('<') ? message_id : `<${message_id}>`
    const client = this.connectedClient()
    if (client.search === undefined) return undefined
    try {
      await client.connect()
      try {
        for (const folder of folders) {
          let lock: { release: () => void } | undefined
          try {
            lock = await client.getMailboxLock(folder)
            const hits = await client.search?.(
              { header: { 'message-id': normalized } },
              { uid: true },
            )
            if (Array.isArray(hits) && hits.length > 0) return folder
          } catch {
            // 这个文件夹不存在 / 打不开：换下一个，别让一个名字拖垮整轮对账
          } finally {
            lock?.release()
          }
        }
      } finally {
        await client.logout()
      }
    } catch (e) {
      client.close()
      throw asChannelError(e, 'IMAP 对账搜索失败')
    }
    return undefined
  }

  /**
   * 健康检查**永不抛**：口令取不到（秘密库里没有、环境变量没设）也是一种"不健康"，
   * 调用方（连接向导的试连、渠道的巡检）要的是一个 ok 与一句话，不是一个异常。
   */
  async health(): Promise<{ ok: boolean; detail?: string }> {
    let client: ImapClientLike | undefined
    try {
      client = this.connectedClient()
      await client.connect()
      const lock = await client.getMailboxLock(this.mailbox)
      lock.release()
      await client.logout()
      return { ok: true }
    } catch (e) {
      client?.close()
      return { ok: false, detail: `imap: ${errorText(e)}` }
    }
  }

  private connectedClient(): ImapClientLike {
    const password = readPassword(this.config, this.env, this.credentials)
    if (password === undefined) {
      throw new ChannelError(
        'unauthenticated',
        'IMAP 收信要口令：既没有 password_env 也没有 connection_id',
        { user: this.config.user },
      )
    }
    return this.createClient(this.config, password)
  }
}

/**
 * 缺省的 imapflow 客户端工厂。
 *
 * 导出它是为了让**同一个包之外**的装配（`apps/server` 的消息面回写端）不必自己
 * `import { ImapFlow }`——那会把 imapflow 变成 `apps/server` 的直接依赖，
 * 而"哪个包认识 imapflow"这件事应该只有一个答案。
 */
export function defaultImapClient(config: ImapConfig, password: string): ImapClientLike {
  return fromImapFlow(
    new ImapFlow({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: { user: config.user, pass: password },
      logger: false,
      emitLogs: false,
    }),
  )
}

/** imapflow 的 flags 是 Set；替身可能给数组，也可能一个都不给。 */
export function flagsOf(value: Set<string> | readonly string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined
  const list = Array.isArray(value) ? value : [...(value as Set<string>)]
  return list.length === 0 ? [] : list
}

/** imapflow 的 internalDate 可能是 Date 也可能是字符串。 */
export function internalDateOf(value: Date | string | undefined): Iso8601 | undefined {
  if (value === undefined) return undefined
  const d = value instanceof Date ? value : new Date(value)
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString()
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export function asChannelError(e: unknown, prefix: string): ChannelError {
  if (e instanceof ChannelError) return e
  // 认证失败与"上游不可用"是两码事：前者要人去重新授权，后者退避重试就行
  if (isAuthFailure(e)) return new ChannelError('unauthenticated', `${prefix}：${errorText(e)}`)
  return new ChannelError('provider_unavailable', `${prefix}：${errorText(e)}`)
}

function isAuthFailure(e: unknown): boolean {
  if (e === null || typeof e !== 'object') return false
  const o = e as { authenticationFailed?: unknown; responseCode?: unknown; code?: unknown }
  if (o.authenticationFailed === true) return true
  return o.code === 'EAUTH' || o.responseCode === 535
}
