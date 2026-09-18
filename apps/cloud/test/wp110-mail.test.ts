/**
 * WP110 ①：真的 MailSender（nodemailer 走 SMTP）。
 *
 * 三件事要钉住：
 * 1. **那道闸还在**——环境变量说"这是生产"而没配 SMTP 时拒绝启动，
 *    不悄悄退化成"把登录链接打进生产日志"；
 * 2. 投递失败回**人话**，而且那句话对"这个地址存不存在"一个字都不说；
 * 3. 信里那条链接**纯文本与 HTML 两边都有**——只放在 HTML 里的话，
 *    收不了 HTML 的客户端就登不进来了。
 */

import { describe, expect, it } from 'vitest'
import {
  type CloudMail,
  consoleMailSender,
  loginMail,
  MailDeliveryError,
  mailSenderFromEnv,
  NODE_ENV,
  SMTP_ENV,
  type SmtpTransport,
  smtpMailSender,
} from '../src/index.js'

const LINK = 'https://cloud.example.test/login?token=cml_abcdef123456&state=s1'

describe('WP110 mailSenderFromEnv 的那道闸', () => {
  it('什么都没配 = console 投递（开发档要看得见链接）', async () => {
    const lines: string[] = []
    const send = mailSenderFromEnv({}, (l) => lines.push(l))
    await send({ to: 'a@example.com', subject: 's', text: LINK })
    expect(lines.join('')).toContain(LINK)
  })

  it('配了 SMTP 却没配发件地址 → 拒绝启动', () => {
    expect(() => mailSenderFromEnv({ [SMTP_ENV.url]: 'smtps://u:p@smtp.example.test' })).toThrow(
      /AGENTSWS_CLOUD_MAIL_FROM/,
    )
  })

  it('生产档没配 SMTP → 拒绝启动（不把登录链接打进生产日志）', () => {
    expect(() => mailSenderFromEnv({ [NODE_ENV]: 'production' })).toThrow(/production/)
  })

  it('生产档想用 console 得显式认账', async () => {
    const lines: string[] = []
    const send = mailSenderFromEnv(
      { [NODE_ENV]: 'production', [SMTP_ENV.allowConsole]: '1' },
      (l) => lines.push(l),
    )
    await send({ to: 'a@example.com', subject: 's', text: 'x' })
    expect(lines).toHaveLength(1)
  })

  it('配齐了就是真投递（不是 console）', async () => {
    const lines: string[] = []
    const send = mailSenderFromEnv(
      {
        [SMTP_ENV.url]: 'smtp://127.0.0.1:1/',
        [SMTP_ENV.from]: 'agentsws <no-reply@example.test>',
      },
      (l) => lines.push(l),
    )
    // 真 transport 连不上 127.0.0.1:1 —— 失败恰好证明它没走 console 那条路
    await expect(send({ to: 'a@example.com', subject: 's', text: 'x' })).rejects.toBeInstanceOf(
      MailDeliveryError,
    )
    expect(lines).toHaveLength(0)
  })
})

describe('WP110 smtpMailSender', () => {
  const fakeTransport = (): { sent: unknown[]; transport: SmtpTransport } => {
    const sent: unknown[] = []
    return {
      sent,
      transport: {
        async sendMail(message) {
          sent.push(message)
          return { messageId: 'x' }
        },
      },
    }
  }

  it('from / to / subject / text / html 原样交给 transport', async () => {
    const fake = fakeTransport()
    const send = smtpMailSender({ from: 'agentsws <no-reply@example.test>', ...fake })
    await send(loginMail('luoye@example.com', LINK, 15))
    expect(fake.sent).toHaveLength(1)
    const message = fake.sent[0] as CloudMail & { from: string }
    expect(message.from).toBe('agentsws <no-reply@example.test>')
    expect(message.to).toBe('luoye@example.com')
    expect(message.text).toContain(LINK)
    // HTML 里 `&` 是转过义的，所以比的是转义之后那一条
    expect(message.html).toContain(LINK.replace('&', '&amp;'))
  })

  it('投递失败：回人话，且那句话与日志里都没有整个邮箱', async () => {
    const lines: string[] = []
    const send = smtpMailSender({
      from: 'no-reply@example.test',
      warn: (l) => lines.push(l),
      transport: {
        async sendMail() {
          // 真实退信里常常带着收件地址，这里照抄那个形状
          const err = new Error('550 5.1.1 <luoye@example.com> user unknown')
          ;(err as { responseCode?: number }).responseCode = 550
          throw err
        },
      },
    })
    let caught: unknown
    await send({ to: 'luoye@example.com', subject: 's', text: 'x' }).catch((e: unknown) => {
      caught = e
    })
    expect(caught).toBeInstanceOf(MailDeliveryError)
    const message = (caught as Error).message
    expect(message).toBe('登录信没发出去，等一分钟再试一次。')
    // "存不存在"一个字不说：既不提邮箱本地部分，也不提上游那句 user unknown
    expect(message).not.toContain('luoye')
    expect(message).not.toContain('unknown')
    const log = lines.join('')
    expect(log).toContain('example.com')
    expect(log).not.toContain('luoye@example.com')
    expect(log).not.toContain('user unknown')
  })

  it('没有 transport 也没有 url = 一句人话，不是 TypeError', async () => {
    const send = smtpMailSender({ from: 'no-reply@example.test' })
    await expect(send({ to: 'a@example.com', subject: 's', text: 'x' })).rejects.toBeInstanceOf(
      MailDeliveryError,
    )
  })
})

describe('WP110 登录信的正文', () => {
  it('链接在纯文本与 HTML 两边都有；HTML 里内联的是六块标记，不是外链图片', () => {
    const mail = loginMail('luoye@example.com', LINK, 15)
    expect(mail.text).toContain(LINK)
    expect(mail.html).toBeDefined()
    const html = mail.html ?? ''
    expect(html).toContain('<svg')
    // 六块 = 六个 rect；一块都不能少、也不该多
    expect(html.match(/<rect /g) ?? []).toHaveLength(6)
    /*
     * 不拉任何外部资源：邮件客户端会拦，而且一张外链图片就是一个追踪像素。
     * （`xmlns="http://www.w3.org/2000/svg"` 是命名空间不是请求，不算。）
     */
    expect(html).not.toMatch(/<img/i)
    expect(html).not.toMatch(/\bsrc=/i)
    // 唯一的外链是那条登录链接本身
    const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1])
    expect(hrefs.length).toBeGreaterThan(0)
    for (const href of hrefs) expect(href).toContain('cloud.example.test/login')
  })

  it('HTML 里的链接转过义（& 不会把 state 吃掉）', () => {
    const mail = loginMail('a@example.com', 'https://c.test/login?token=t&state=s', 15)
    expect(mail.html).toContain('token=t&amp;state=s')
  })

  it('consoleMailSender 还是老样子（开发档要肉眼看得见链接）', async () => {
    const lines: string[] = []
    await consoleMailSender((l) => lines.push(l))(loginMail('a@example.com', LINK, 15))
    expect(lines.join('')).toContain(LINK)
  })
})
