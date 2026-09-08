import { sha256 } from '@agentsws/core'
import nodemailer from 'nodemailer'
import { ChannelError } from '../errors.js'
import { asChannelError, errorText, readSecretFromEnv } from './imap.js'

export interface OutboundMail {
  from: string
  to: string[]
  subject: string
  text: string
  html?: string
  in_reply_to?: string
  references?: string
  /** 由调用方决定的 Message-ID（幂等键派生，不用随机） */
  message_id?: string
  headers?: Readonly<Record<string, string>>
}

/** 发信端口：适配器与投递都用它，nodemailer/SMTP 是默认实现。 */
export interface Mailer {
  send(mail: OutboundMail): Promise<{ message_id: string }>
  health(): Promise<{ ok: boolean; detail?: string }>
  close?(): Promise<void>
}

export interface SmtpConfig {
  host: string
  port: number
  secure: boolean
  user?: string
  /** 应用专用密码的**环境变量名**（13 §4.3）；不给则按无鉴权 SMTP（本地/测试） */
  password_env?: string
  /** 本机标识；也用于兜底生成 Message-ID 的域 */
  name?: string
  /** 测试用本地 SMTP 桩没有证书，允许显式关掉校验 */
  reject_unauthorized?: boolean
}

/** nodemailer transporter 里我们用到的部分。 */
export interface TransportLike {
  sendMail(mail: {
    from: string
    to: string[]
    subject: string
    text: string
    html?: string
    inReplyTo?: string
    references?: string
    messageId?: string
    headers?: Record<string, string>
  }): Promise<{ messageId?: string }>
  verify(): Promise<boolean>
  close?(): void
}

export interface SmtpMailerOptions {
  config: SmtpConfig
  createTransport?: (config: SmtpConfig, password: string | undefined) => TransportLike
  env?: NodeJS.ProcessEnv
}

/** SMTP 发信（自带账号：应用专用密码，31 F5 里"不需要平台审核的路径"）。 */
export class SmtpMailer implements Mailer {
  private readonly config: SmtpConfig
  private readonly env: NodeJS.ProcessEnv
  private readonly factory: (config: SmtpConfig, password: string | undefined) => TransportLike
  private transport: TransportLike | undefined

  constructor(opts: SmtpMailerOptions) {
    this.config = opts.config
    this.env = opts.env ?? process.env
    this.factory = opts.createTransport ?? defaultTransport
  }

  private get client(): TransportLike {
    if (this.transport === undefined) {
      const password =
        this.config.password_env === undefined
          ? undefined
          : readSecretFromEnv(this.config.password_env, this.env)
      this.transport = this.factory(this.config, password)
    }
    return this.transport
  }

  async send(mail: OutboundMail): Promise<{ message_id: string }> {
    if (mail.to.length === 0) {
      throw new ChannelError('invalid_input', 'SMTP 发信缺收件人')
    }
    try {
      const info = await this.client.sendMail({
        from: mail.from,
        to: [...mail.to],
        subject: mail.subject,
        text: mail.text,
        ...(mail.html === undefined ? {} : { html: mail.html }),
        ...(mail.in_reply_to === undefined ? {} : { inReplyTo: mail.in_reply_to }),
        ...(mail.references === undefined ? {} : { references: mail.references }),
        ...(mail.message_id === undefined ? {} : { messageId: mail.message_id }),
        ...(mail.headers === undefined ? {} : { headers: { ...mail.headers } }),
      })
      return { message_id: info.messageId ?? mail.message_id ?? '' }
    } catch (e) {
      throw asChannelError(e, 'SMTP 发信失败')
    }
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    try {
      await this.client.verify()
      return { ok: true }
    } catch (e) {
      return { ok: false, detail: `smtp: ${errorText(e)}` }
    }
  }

  async close(): Promise<void> {
    this.transport?.close?.()
    this.transport = undefined
  }
}

function defaultTransport(config: SmtpConfig, password: string | undefined): TransportLike {
  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    ...(config.name === undefined ? {} : { name: config.name }),
    ...(config.user === undefined || password === undefined
      ? {}
      : { auth: { user: config.user, pass: password } }),
    ...(config.reject_unauthorized === undefined
      ? {}
      : { tls: { rejectUnauthorized: config.reject_unauthorized } }),
  })
  return transporter as unknown as TransportLike
}

/**
 * 从幂等键派生 Message-ID：同一 `idempotency_key` 永远同一个 id，
 * 既让 SMTP 侧可去重，也避免在这里摸随机数（35 §2：随机经注入的 seed）。
 */
export function messageIdFor(idempotency_key: string, domain: string): string {
  return `<${sha256(idempotency_key).slice(0, 32)}@${domain}>`
}

export function domainOf(address: string): string {
  const at = address.lastIndexOf('@')
  return at === -1
    ? 'localhost'
    : address
        .slice(at + 1)
        .replace(/>$/, '')
        .trim()
        .toLowerCase()
}
