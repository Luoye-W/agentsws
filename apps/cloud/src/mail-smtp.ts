/**
 * SMTP 投递（nodemailer）。**Compose / 自建形态用这一份**。
 *
 * 单独一个文件是有意的（WP114）：nodemailer 要 `node:net` / `node:tls` / `node:dns`，
 * 这几样在 Cloudflare Workers 上根本没有。云的 Workers 形态用
 * `mail-cloudflare.ts`（Email Sending 的 binding），而它绝不能因为 import 了
 * `mail.ts` 就把整棵 nodemailer 依赖树拖进打包产物。
 *
 * 口子一个没变：这里出来的还是 `mail.ts` 的 {@link MailSender}。
 */

import { emailDomain } from '@agentsws/contracts'
import {
  type CloudMail,
  consoleMailSender,
  MailDeliveryError,
  type MailSender,
  NODE_ENV,
  SMTP_ENV,
} from './mail.js'

/**
 * nodemailer 的 transport 里我们真正用到的那一小块。
 *
 * 写成自己的接口而不是 import nodemailer 的类型：测试要注入一个假的，
 * 而假的不该被迫实现 `Transporter` 上那几十个我们一个都不碰的成员。
 */
export interface SmtpTransport {
  sendMail(message: {
    from: string
    to: string
    subject: string
    text: string
    html?: string
  }): Promise<unknown>
}

export interface SmtpMailSenderOptions {
  /** 发件地址（`AGENTSWS_CLOUD_MAIL_FROM`），例如 `agentsws <no-reply@…>`。 */
  from: string
  /** 已经建好的 transport（测试注入假的）。不给就按 `url` 现建一个。 */
  transport?: SmtpTransport
  /** SMTP 连接串（`AGENTSWS_CLOUD_SMTP_URL`）。只在 `transport` 没给时用。 */
  url?: string
  /** 投递失败时把上游那串写到哪儿。默认 stderr。 */
  warn?: (line: string) => void
}

/**
 * 真投递：nodemailer 走 SMTP。
 *
 * transport **懒建**：没配 SMTP 的部署（开发、测试、只跑账号层的节点）不该在启动
 * 路径上把 nodemailer 整棵依赖树拉进内存。建一次就存着——每封信新建一条连接
 * 会被大多数 SMTP 服务商当成攻击。
 */
export function smtpMailSender(options: SmtpMailSenderOptions): MailSender {
  const warn = options.warn ?? ((l: string) => process.stderr.write(l))
  let transport = options.transport
  const ensure = async (): Promise<SmtpTransport> => {
    if (transport !== undefined) return transport
    const url = options.url
    if (url === undefined || url.trim() === '')
      throw new MailDeliveryError('云侧没有配 SMTP，登录信发不出去。')
    const nodemailer = await import('nodemailer')
    // 连接串里有口令：它只从这里进 nodemailer，不进日志、不进错误信封
    transport = nodemailer.createTransport(url) as unknown as SmtpTransport
    return transport
  }
  return async (mail: CloudMail): Promise<void> => {
    let sender: SmtpTransport
    try {
      sender = await ensure()
    } catch (err) {
      if (err instanceof MailDeliveryError) throw err
      warn(`[cloud-mail] transport 建不起来：${String(err)}\n`)
      throw new MailDeliveryError('云侧的邮件通道没配好，登录信发不出去。', err)
    }
    try {
      await sender.sendMail({
        from: options.from,
        to: mail.to,
        subject: mail.subject,
        text: mail.text,
        ...(mail.html === undefined ? {} : { html: mail.html }),
      })
    } catch (err) {
      /*
       * 上游那串里常常带着收件地址（`550 5.1.1 <someone@…> unknown`）——
       * 它连 stderr 都不进（只打域名），更不进响应。给用户看的那句话对
       * "这个地址存不存在"一个字都不说。
       */
      warn(`[cloud-mail] 投递失败 to=${emailDomain(mail.to)}：${errorSummary(err)}\n`)
      throw new MailDeliveryError('登录信没发出去，等一分钟再试一次。', err)
    }
  }
}

/** 上游错误里只取"是什么错"，不取它可能夹带的地址与正文。 */
function errorSummary(err: unknown): string {
  if (err === null || typeof err !== 'object') return 'unknown'
  const e = err as { code?: unknown; responseCode?: unknown; name?: unknown }
  const parts = [
    typeof e.name === 'string' ? e.name : undefined,
    typeof e.code === 'string' ? e.code : undefined,
    typeof e.responseCode === 'number' ? String(e.responseCode) : undefined,
  ].filter((p): p is string => p !== undefined)
  return parts.length === 0 ? 'unknown' : parts.join(' ')
}

/**
 * 按环境变量挑一个投递实现。
 *
 * - 配了 `AGENTSWS_CLOUD_SMTP_URL` → 真发信。这时 `AGENTSWS_CLOUD_MAIL_FROM`
 *   **必填**：没有发件地址的信要么被退回要么进垃圾箱，两种都比起不来难查。
 * - 没配，而且 `NODE_ENV=production` → **拒绝启动**。把真账号的登录链接打进
 *   生产日志，比起不了服务糟得多。明知故犯要显式写
 *   `AGENTSWS_CLOUD_ALLOW_CONSOLE_MAIL=1`。
 * - 其余（开发 / 测试）→ console 投递。
 */
export function mailSenderFromEnv(
  env: Record<string, string | undefined>,
  write?: (line: string) => void,
): MailSender {
  const url = env[SMTP_ENV.url]?.trim()
  if (url !== undefined && url !== '') {
    const from = env[SMTP_ENV.from]?.trim()
    if (from === undefined || from === '')
      throw new Error(
        `配了 ${SMTP_ENV.url} 就必须配 ${SMTP_ENV.from}（发件地址）：没有发件人的信会被退回或当垃圾。`,
      )
    return smtpMailSender({ from, url })
  }
  const production = env[NODE_ENV] === 'production'
  const allowConsole = (env[SMTP_ENV.allowConsole] ?? '').trim() !== ''
  if (production && !allowConsole)
    throw new Error(
      `这是生产档（${NODE_ENV}=production）但没配 ${SMTP_ENV.url}：登录链接会被打进日志。` +
        `配上 SMTP，或者显式写 ${SMTP_ENV.allowConsole}=1 认这件事。`,
    )
  return consoleMailSender(write)
}
