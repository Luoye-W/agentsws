import { describe, expect, it } from 'vitest'
import {
  type OutboundChannel,
  REDACTED_URL_PARAM,
  redactOutbound,
  redactOutboundText,
  redactUrl,
  redactUrlsIn,
} from '../src/redact-outbound.js'

/** 39 待办 D / E / F 点名的五个通道，一个都不能少。 */
const CHANNELS: readonly OutboundChannel[] = [
  'email_body',
  'card_payload',
  'answer',
  'tool_input',
  'tool_result',
]

/** 两种一眼是凭据的串：OpenAI 形态的 key，与用户会整段贴进来的邮箱授权码。 */
const API_KEY = 'sk-4f9ab2c7d1e08356zq'
const MAIL_PASSWORD = '授权码：abcdefghijklmnop'

describe('redactOutbound：五个出站通道的统一入口（31 §3.3 / 39 待办 D）', () => {
  for (const channel of CHANNELS) {
    it(`${channel} 通道：sk-… 与邮箱授权码形态的串都不出现在出站里`, () => {
      const text = `请用这把 key ${API_KEY} 登录，邮箱${MAIL_PASSWORD}`
      const out = redactOutboundText(channel, text)
      expect(out).not.toContain(API_KEY)
      expect(out).not.toContain('abcdefghijklmnop')
      expect(out).toContain('[redacted:api_key]')
      expect(out).toContain('[redacted:mail_app_password]')
    })

    it(`${channel} 通道：对象与数组深走一遍，嵌套里的秘密同样不见`, () => {
      const out = redactOutbound(channel, {
        note: `key=${API_KEY}`,
        items: [{ deep: MAIL_PASSWORD }],
        count: 3,
        ok: true,
        nothing: null,
      }) as Record<string, unknown>
      expect(JSON.stringify(out)).not.toContain(API_KEY)
      expect(JSON.stringify(out)).not.toContain('abcdefghijklmnop')
      // 非字符串标量原样：把它们变成字符串只会让下游解析炸掉
      expect(out.count).toBe(3)
      expect(out.ok).toBe(true)
      expect(out.nothing).toBeNull()
    })
  }

  it('键上挂着秘密也抹掉（对象的 key 一样过表）', () => {
    const out = redactOutbound('card_payload', { [API_KEY]: 1 }) as Record<string, unknown>
    expect(Object.keys(out)).toEqual(['[redacted:api_key]'])
  })
})

describe('工具返回的签名 URL（39 待办 F 的后半句）', () => {
  it('tool_result 通道抹掉 URL 里的签名参数，其余参数原样保留', () => {
    const url = 'https://cdn.example.com/invoice.pdf?X-Amz-Signature=deadbeefcafe&page=2'
    const out = redactOutboundText('tool_result', `下载：${url}`)
    expect(out).not.toContain('deadbeefcafe')
    expect(out).toContain(REDACTED_URL_PARAM)
    expect(out).toContain('page=2')
  })

  it('别的通道不动 URL：回信正文里的链接要保持可点', () => {
    const url = 'https://shop.example.com/orders/1042?sig=deadbeefcafe0123'
    expect(redactOutboundText('email_body', url)).toContain('deadbeefcafe0123')
    expect(redactOutboundText('tool_result', url)).not.toContain('deadbeefcafe0123')
  })

  it('不是合法 URL 的串原样返回（认不出来的交给秘密表，不硬猜）', () => {
    expect(redactUrl('not a url at all')).toBe('not a url at all')
  })

  it('没有凭据参数的 URL 一个字节都不改', () => {
    const url = 'https://shop.example.com/a/b?page=2&sort=desc'
    expect(redactUrl(url)).toBe(url)
  })

  it('一段文本里的每条 URL 都过一遍', () => {
    const out = redactUrlsIn(
      'a https://a.example/x?sig=aaaaaaaa b https://b.example/y?token=bbbb c',
    )
    expect(out).not.toContain('sig=aaaaaaaa')
    expect(out).not.toContain('token=bbbb')
    expect(out).toContain('c')
  })
})
