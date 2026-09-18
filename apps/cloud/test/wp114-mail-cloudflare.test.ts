/**
 * WP114 ③：Cloudflare Email Sending 的发信实现。
 *
 * 四件事要钉住：
 * 1. **那道闸还在**——binding 没绑 / 发件地址没配就抛，不悄悄退化成"不发信也能起"；
 * 2. 发件地址两种写法都认（`名字 <a@b>` 与裸 `a@b`），与 SMTP 档共用同一个环境变量；
 * 3. 失败回**人话**，那句话对"这个地址存不存在"一个字都不说；
 * 4. 日志里**只有域名与错误码**，没有完整邮箱。
 */

import { describe, expect, it } from 'vitest'
import {
  CLOUDFLARE_MAIL_FROM_ENV,
  type CloudflareEmailBinding,
  cloudflareEmailSender,
  cloudflareMailReady,
  cloudflareMailSenderFromEnv,
  loginMail,
  MailDeliveryError,
  parseMailFrom,
} from '../src/index.js'

type Sent = Parameters<CloudflareEmailBinding['send']>[0]

/** 假 binding：记下发过什么，或者按吩咐抛一个带 `code` 的错。 */
function fakeBinding(fail?: { code: string }): CloudflareEmailBinding & { sent: Sent[] } {
  const sent: Sent[] = []
  return {
    sent,
    async send(message) {
      if (fail !== undefined) {
        const err = new Error('upstream said no') as Error & { code: string }
        err.code = fail.code
        throw err
      }
      sent.push(message)
      return { messageId: 'msg_fake' }
    },
  }
}

describe('WP114 parseMailFrom', () => {
  it('认 `名字 <a@b>`', () => {
    expect(parseMailFrom('agentsws <login@agentsws.com>')).toEqual({
      email: 'login@agentsws.com',
      name: 'agentsws',
    })
  })

  it('认裸邮箱（没有名字就不带 name 这个键）', () => {
    expect(parseMailFrom('login@agentsws.com')).toEqual({ email: 'login@agentsws.com' })
  })

  it('带引号的名字去掉引号', () => {
    expect(parseMailFrom('"Agents 工坊" <login@agentsws.com>')?.name).toBe('Agents 工坊')
  })

  it('解不出邮箱就是 undefined（不抛，由调用方决定怎么办）', () => {
    expect(parseMailFrom(undefined)).toBeUndefined()
    expect(parseMailFrom('   ')).toBeUndefined()
    expect(parseMailFrom('agentsws')).toBeUndefined()
    expect(parseMailFrom('a b <not-an-email>')).toBeUndefined()
  })
})

describe('WP114 那道闸（没配就拒绝启动）', () => {
  it('没绑 binding → 抛，而且那句话说得出该去哪儿配', () => {
    expect(() =>
      cloudflareMailSenderFromEnv({
        binding: undefined,
        env: { [CLOUDFLARE_MAIL_FROM_ENV]: 'agentsws <login@agentsws.com>' },
      }),
    ).toThrow(/send_email/)
  })

  it('绑了 binding 但没配发件地址 → 抛', () => {
    expect(() => cloudflareMailSenderFromEnv({ binding: fakeBinding(), env: {} })).toThrow(
      new RegExp(CLOUDFLARE_MAIL_FROM_ENV),
    )
  })

  it('两样齐了才拼得出来；health 那一格读的是同一个判据', () => {
    const binding = fakeBinding()
    const env = { [CLOUDFLARE_MAIL_FROM_ENV]: 'agentsws <login@agentsws.com>' }
    expect(cloudflareMailReady(binding, env)).toBe(true)
    expect(cloudflareMailReady(undefined, env)).toBe(false)
    expect(cloudflareMailReady(binding, {})).toBe(false)
    expect(typeof cloudflareMailSenderFromEnv({ binding, env })).toBe('function')
  })
})

describe('WP114 真发一封（假 binding）', () => {
  it('to / from / subject / text / html 原样进 binding，链接两边都有', async () => {
    const binding = fakeBinding()
    const send = cloudflareMailSenderFromEnv({
      binding,
      env: { [CLOUDFLARE_MAIL_FROM_ENV]: 'agentsws <login@agentsws.com>' },
    })
    const link = 'https://cloud.agentsws.com/login?token=cml_x'
    await send(loginMail('someone@example.com', link, 15))
    expect(binding.sent).toHaveLength(1)
    const one = binding.sent[0]
    expect(one?.to).toBe('someone@example.com')
    expect(one?.from).toEqual({ email: 'login@agentsws.com', name: 'agentsws' })
    expect(one?.subject).toContain('Agents 工坊')
    // 纯文本与 HTML 两边都要有那条链接——只放在 HTML 里的话有些客户端就登不进来
    expect(one?.text).toContain(link)
    expect(one?.html).toContain(link)
  })

  it('发件域没开通 → 人话 + 不提收件地址；日志里只有域名与错误码', async () => {
    const lines: string[] = []
    const send = cloudflareEmailSender({
      binding: fakeBinding({ code: 'E_SENDER_NOT_VERIFIED' }),
      from: { email: 'login@agentsws.com' },
      warn: (l) => lines.push(l),
    })
    await expect(send(loginMail('someone@example.com', 'https://x/login', 15))).rejects.toThrow(
      MailDeliveryError,
    )
    await send(loginMail('someone@example.com', 'https://x/login', 15)).catch((err: unknown) => {
      expect((err as Error).message).toContain('发信域名')
      // 对"这个地址存不存在"一个字不说
      expect((err as Error).message).not.toContain('someone@example.com')
    })
    expect(lines.join('')).toContain('to=example.com')
    expect(lines.join('')).toContain('code=E_SENDER_NOT_VERIFIED')
    expect(lines.join('')).not.toContain('someone@example.com')
  })

  it('限流与额度各有自己的一句话；认不出的错回通用那句', async () => {
    const say = async (code: string): Promise<string> => {
      const send = cloudflareEmailSender({
        binding: fakeBinding({ code }),
        from: { email: 'login@agentsws.com' },
        warn: () => undefined,
      })
      try {
        await send(loginMail('a@example.com', 'https://x', 15))
        return ''
      } catch (err) {
        return (err as Error).message
      }
    }
    expect(await say('E_RATE_LIMIT_EXCEEDED')).toContain('频繁')
    expect(await say('E_DAILY_LIMIT_EXCEEDED')).toContain('额度')
    expect(await say('E_DELIVERY_FAILED')).toContain('没发出去')
  })
})
