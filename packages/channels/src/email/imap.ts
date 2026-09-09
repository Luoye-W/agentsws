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
}

/** 收信端口：适配器只依赖它，imapflow 是其默认实现，测试可注入内存实现。 */
export interface MailSource {
  /** 按 UID 增量拉取（只返回 uid > since_uid 的，升序）。 */
  fetchSince(since_uid: number, limit?: number): Promise<RawEmailMessage[]>
  health(): Promise<{ ok: boolean; detail?: string }>
  close?(): Promise<void>
}

/** imapflow 里我们真正用到的那几个方法（便于替身与最小 IMAP 桩）。 */
export interface ImapClientLike {
  connect(): Promise<void>
  logout(): Promise<void>
  close(): void
  getMailboxLock(path: string): Promise<{ release: () => void }>
  fetch(
    range: string,
    query: { uid: true; source: true; internalDate: true },
    options: { uid: true },
  ): AsyncIterable<{
    uid: number
    source?: Uint8Array | undefined
    internalDate?: Date | string | undefined
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
  /** 取一条连接的口令；取不到就抛，别返回空串。 */
  password(ref: { connection_id: string }): string
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
): string | undefined {
  if (config.connection_id !== undefined) {
    if (credentials === undefined) {
      throw new ChannelError(
        'unauthenticated',
        '这条邮箱连接的凭据在本机秘密库里，但适配器没装配 CredentialSource',
        { connection_id: config.connection_id },
      )
    }
    return credentials.password({ connection_id: config.connection_id })
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
    fetch: (range, query, options) => client.fetch(range, query, options),
  }
}

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
          { uid: true, source: true, internalDate: true },
          { uid: true },
        )) {
          if (msg.uid <= since_uid) continue
          if (msg.source === undefined) continue
          out.push({
            uid: msg.uid,
            mailbox: this.mailbox,
            source: Buffer.from(msg.source).toString('utf8'),
            ...(internalDateOf(msg.internalDate) === undefined
              ? {}
              : { internal_date: internalDateOf(msg.internalDate) as Iso8601 }),
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

function defaultImapClient(config: ImapConfig, password: string): ImapClientLike {
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
