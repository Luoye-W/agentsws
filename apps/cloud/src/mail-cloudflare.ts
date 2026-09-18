/**
 * Cloudflare Email Sending 投递（**Workers 形态用这一份**，WP114）。
 *
 * 为什么不是 SMTP、也不是某家发信 API：Workers 里没有 `node:net`，nodemailer
 * 用不了；而 Cloudflare 自己的 Email Service 在 Worker 里是一个 **binding**
 * （`wrangler.toml` 的 `[[send_email]]`），`env.EMAIL.send(...)` 就发出去了——
 * **一把密钥都不用**。没有密钥就没有"密钥放哪儿、谁能看见、多久轮换"这三个问题。
 *
 * 照 2026-09 的官方文档（`developers.cloudflare.com/email-service/`）：
 *
 * | | |
 * |---|---|
 * | 配置 | `[[send_email]] name = "EMAIL"` |
 * | 调用 | `env.EMAIL.send({ to, from: { email, name }, subject, html, text })` |
 * | 回值 | `{ messageId }` |
 * | 发给任意收件人 | **要 Workers Paid 档**；发给本账号里已验证的目的地址是免费的 |
 * | 发件域 | 必须先在 Email Sending 里开通（SPF / DKIM 两条 DNS） |
 * | 收件人上限 | to + cc + bcc 合计 50；整封信 5 MiB |
 * | 出错 | 抛一个带 `code`（`E_…`）与 `message` 的错 |
 *
 * 三条纪律与 SMTP 那一份一字不差：
 *
 * 1. **没配就拒绝启动**（binding 没绑、或者没给发件地址），不悄悄退化成
 *    "把登录链接打进日志"——与 WP58 那道闸同一条；
 * 2. 失败回人话，且**对"这个地址存不存在"一个字都不说**；
 * 3. 日志里只有域名与错误码，**没有完整邮箱**（21 §1）。
 */

import { emailDomain } from '@agentsws/contracts'
import { type CloudMail, MailDeliveryError, type MailSender } from './mail.js'

/**
 * `env.EMAIL` 那一点点面。
 *
 * 写成自己的结构类型而不是 import `@cloudflare/workers-types`：这个文件在 Node
 * 那一侧也要编得过（测试注入一个假 binding），而 workers 的全局类型会把
 * `apps/cloud` 整包的 lib 配置搅乱。
 */
export interface CloudflareEmailBinding {
  send(message: {
    to: string | string[]
    from: { email: string; name?: string }
    subject: string
    text?: string
    html?: string
    replyTo?: string
  }): Promise<{ messageId?: string } | undefined>
}

/** 发件地址那个环境变量名（与 SMTP 档共用同一个，值形如 `agentsws <login@agentsws.com>`）。 */
export const CLOUDFLARE_MAIL_FROM_ENV = 'AGENTSWS_CLOUD_MAIL_FROM'

/** 一个发件地址：`名字 <a@b>` 或者裸 `a@b`。 */
export interface MailFrom {
  email: string
  name?: string
}

/**
 * 把 `AGENTSWS_CLOUD_MAIL_FROM` 解成 binding 要的那个对象。
 *
 * 认两种写法（SMTP 那边一直是第一种，所以两个形态可以共用同一个值）：
 * `agentsws <login@agentsws.com>` 与 `login@agentsws.com`。
 * 解不出邮箱就回 `undefined`——由调用方决定是拒绝启动还是标红，这个函数不抛。
 */
export function parseMailFrom(raw: string | undefined): MailFrom | undefined {
  const value = (raw ?? '').trim()
  if (value === '') return undefined
  const angled = /^(.*)<\s*([^<>\s]+@[^<>\s]+)\s*>$/.exec(value)
  if (angled !== null) {
    const email = (angled[2] ?? '').trim()
    const name = (angled[1] ?? '').trim().replace(/^"|"$/g, '')
    if (email === '' || !email.includes('@')) return undefined
    return name === '' ? { email } : { email, name }
  }
  if (!value.includes('@') || /\s/.test(value)) return undefined
  return { email: value }
}

/** binding 抛出来的错里只取"是什么错"，不取它可能夹带的地址。 */
function errorCodeOf(err: unknown): string {
  if (err === null || typeof err !== 'object') return 'unknown'
  const code = (err as { code?: unknown }).code
  return typeof code === 'string' && code !== '' ? code : 'unknown'
}

/**
 * 错误码 → 给用户的那句话。
 *
 * 只分两类：**我们这边没配好**（发件域没开通、超额）与**这一次没发出去**
 * （限流、投递失败）。两类都不提收件地址。
 */
function humanMessage(code: string): string {
  switch (code) {
    case 'E_SENDER_NOT_VERIFIED':
    case 'E_SENDER_DOMAIN_NOT_AVAILABLE':
      return '云侧的发信域名还没开通，登录信发不出去。'
    case 'E_DAILY_LIMIT_EXCEEDED':
      return '云侧今天的发信额度用完了，明天再试，或者联系我们。'
    case 'E_RATE_LIMIT_EXCEEDED':
      return '发得太频繁了，过一分钟再试一次。'
    default:
      return '登录信没发出去，等一分钟再试一次。'
  }
}

export interface CloudflareEmailSenderOptions {
  /** `env.EMAIL`（`wrangler.toml` 里 `[[send_email]] name = "EMAIL"`）。 */
  binding: CloudflareEmailBinding
  /** 发件地址。 */
  from: MailFrom
  /** 投递失败时把那一行写到哪儿；默认 `console.warn`（Workers 上没有 stderr）。 */
  warn?: (line: string) => void
}

/** 真投递：Cloudflare Email Sending 的 binding。 */
export function cloudflareEmailSender(options: CloudflareEmailSenderOptions): MailSender {
  const warn =
    options.warn ??
    ((line: string) => {
      console.warn(line)
    })
  return async (mail: CloudMail): Promise<void> => {
    try {
      await options.binding.send({
        to: mail.to,
        from: options.from,
        subject: mail.subject,
        text: mail.text,
        // 收不了 HTML 的客户端退回 text——所以链接两边都有（`loginMail` 保证）
        ...(mail.html === undefined ? {} : { html: mail.html }),
      })
    } catch (err) {
      const code = errorCodeOf(err)
      // 只有域名与错误码；完整邮箱一个字不进日志
      warn(`[cloud-mail] 投递失败 to=${emailDomain(mail.to)} code=${code}\n`)
      throw new MailDeliveryError(humanMessage(code), err)
    }
  }
}

export interface CloudflareMailFromEnvOptions {
  /** `env.EMAIL`；**没绑就拒绝启动**（不是标红了还照跑）。 */
  binding: CloudflareEmailBinding | undefined
  env: Record<string, string | undefined>
  warn?: (line: string) => void
}

/**
 * 按 binding 与环境变量拼一个发信口——**缺一样就抛**。
 *
 * 与 `mailSenderFromEnv`（SMTP 档）那道闸同一条纪律：登录信是云侧**唯一**的
 * 进门方式，发不出去的节点不该起得来假装自己好着。Workers 那边这个错会在
 * 第一次请求时抛，`/v1/cloud/health` 里 `mail` 那一格是 false。
 */
export function cloudflareMailSenderFromEnv(options: CloudflareMailFromEnvOptions): MailSender {
  if (options.binding === undefined)
    throw new Error(
      'Workers 形态没有绑 Email Sending（wrangler.toml 里的 [[send_email]] name = "EMAIL"）：登录信发不出去，等于没人登得进来。',
    )
  const from = parseMailFrom(options.env[CLOUDFLARE_MAIL_FROM_ENV])
  if (from === undefined)
    throw new Error(
      `${CLOUDFLARE_MAIL_FROM_ENV} 没配或者不是一个邮箱（形如 "agentsws <login@agentsws.com>"）：没有发件人的信会被退回或当垃圾。`,
    )
  return cloudflareEmailSender({
    binding: options.binding,
    from,
    ...(options.warn === undefined ? {} : { warn: options.warn }),
  })
}

/** 这个节点发得了信没有（`/v1/cloud/health` 的 `mail` 那一格读它）。 */
export function cloudflareMailReady(
  binding: CloudflareEmailBinding | undefined,
  env: Record<string, string | undefined>,
): boolean {
  return binding !== undefined && parseMailFrom(env[CLOUDFLARE_MAIL_FROM_ENV]) !== undefined
}
