/**
 * 云侧的邮件投递口子。
 *
 * 四条纪律：
 *
 * 1. **一个接口，三种实现**：开发环境把链接打到 stdout（`consoleMailSender`），
 *    测试注入自己的假 transport，生产走 SMTP（`smtpMailSender`）。
 * 2. **SMTP 配置只从环境变量读，永远不硬编码**。这个文件里没有任何主机名、
 *    端口、用户名、口令，也不该有——真账号的那几行属于部署，不属于仓库。
 * 3. 一次性登录链接**只进邮件正文**：不进响应体、不进事件、不进任何持久化的日志。
 *    开发档打到 stdout 是有意的（本机开发要点得进去），所以在环境变量说"这是生产"
 *    时 {@link mailSenderFromEnv} 会拒绝退化成 console 投递，而不是把链接打进生产日志。
 * 4. **失败回人话，且不透露这个地址存不存在**：投递失败只说"信没发出去"
 *    （{@link MailDeliveryError}），上游那串错误进 stderr 不进响应；而且连
 *    stderr 里也只有域名——`to=example.com`，不是整个邮箱（21 §1）。
 *
 * WP110 之前这个文件里没有真实现（WP58 明确不带 SMTP 客户端）：那时候配了
 * `AGENTSWS_CLOUD_SMTP_URL` 就直接抛，逼宿主自己注入。现在真实现接上来了，
 * 那道闸还在，只是判据从"有没有实现"换成了"这一档该不该用 console"。
 */

import { emailDomain } from '@agentsws/contracts'
import { BRAND_GREEN, brandDisc } from './brand.js'

export interface CloudMail {
  to: string
  subject: string
  /** 纯文本正文；一次性登录链接就在里面。 */
  text: string
  /**
   * HTML 正文（可选）。收不了 HTML 的客户端退回 `text`——所以链接**两边都有**，
   * 不能只放在 HTML 里。
   */
  html?: string
}

export type MailSender = (mail: CloudMail) => Promise<void>

/** SMTP 只认这几个环境变量名；值一个都不在仓库里。 */
export const SMTP_ENV = {
  url: 'AGENTSWS_CLOUD_SMTP_URL',
  from: 'AGENTSWS_CLOUD_MAIL_FROM',
  /** 明确认账的逃生口：生产档也用 console 投递（只在还没配 SMTP 的调试期用）。 */
  allowConsole: 'AGENTSWS_CLOUD_ALLOW_CONSOLE_MAIL',
} as const

/** 判"这是不是生产档"看的环境变量。 */
export const NODE_ENV = 'NODE_ENV'

/**
 * 投递失败。
 *
 * 只带一句人话；上游那串（`535 auth failed` / `EAI_AGAIN` …）在 `cause` 里，
 * 由调用方决定要不要打进 stderr——**不进 HTTP 响应**。
 */
export class MailDeliveryError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'MailDeliveryError'
  }
}

/** 开发档：把信打到 stdout（或注入的 sink），链接肉眼可见。 */
export function consoleMailSender(write: (line: string) => void = (l) => process.stdout.write(l)) {
  return async (mail: CloudMail): Promise<void> => {
    write(`\n[cloud-mail] to=${mail.to} subject=${mail.subject}\n${mail.text}\n`)
  }
}

const escapeHtml = (raw: string): string =>
  raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** 登录信的正文。只有一句话与一条链接——没有品牌废话，也没有任何别的信息。 */
export function loginMail(to: string, link: string, minutes: number): CloudMail {
  const text = [
    '点下面这条链接登录 agentsws 云账号：',
    '',
    link,
    '',
    `链接 ${String(minutes)} 分钟内有效，只能用一次。`,
    '不是你本人操作的话，忽略这封信就行——没有点，什么都不会发生。',
  ].join('\n')
  const safeLink = escapeHtml(link)
  const html = [
    '<div style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif;font-size:15px;line-height:1.7;color:#1B1D22;">',
    `<div style="margin-bottom:20px;">${brandDisc({ size: 52, id: 'awmail' })}</div>`,
    '<p style="margin:0 0 16px;">点下面这颗按钮登录 agentsws 云账号：</p>',
    `<p style="margin:0 0 20px;"><a href="${safeLink}" style="display:inline-block;padding:11px 20px;border-radius:10px;background:${BRAND_GREEN};color:#ffffff;text-decoration:none;font-weight:600;">登录 agentsws</a></p>`,
    // 按钮点不动的客户端（纯文本视图、部分企业邮箱）也要能把链接抄出来
    `<p style="margin:0 0 16px;font-size:13px;color:#5B6169;word-break:break-all;">按钮点不动就复制这条：<br><a href="${safeLink}" style="color:${BRAND_GREEN};">${safeLink}</a></p>`,
    `<p style="margin:0 0 6px;font-size:13px;color:#5B6169;">链接 ${String(minutes)} 分钟内有效，只能用一次。</p>`,
    '<p style="margin:0;font-size:13px;color:#5B6169;">不是你本人操作的话，忽略这封信就行——没有点，什么都不会发生。</p>',
    '</div>',
  ].join('')
  return { to, subject: '登录 agentsws 云账号', text, html }
}
