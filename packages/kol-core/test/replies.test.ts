import { describe, expect, it } from 'vitest'
import { classifyReply, NEXT_STEP_ZH } from '../src/index.js'

const known = (text: string) => classifyReply({ text, known_contact: true })
const stranger = (text: string) => classifyReply({ text, known_contact: false })

describe('回复分类（封闭六类，48 §5.2）', () => {
  it('六类各认得出来', () => {
    expect(known('这个方向我有兴趣，可以聊').klass).toBe('interested')
    expect(known('先报个价吧，你们预算是多少').klass).toBe('wants_quote')
    expect(known('这次不合适，最近没档期').klass).toBe('declined')
    expect(known('我已经和你们合作过了，是跟你同事谈的').klass).toBe('already_working')
    expect(stranger('你好，我是做桌面好物的，想找合作').klass).toBe('cold_inbound')
    expect(known('专业代运营涨粉，加微信了解').klass).toBe('spam')
  })

  it('英文同样认得出来', () => {
    expect(known('Interested — tell me more').klass).toBe('interested')
    expect(known('What is your budget? Here is my rate card.').klass).toBe('wants_quote')
    expect(known('Not interested, no thanks.').klass).toBe('declined')
  })

  it('分不出来就是 unknown，不硬塞进某一类', () => {
    const r = known('收到')
    expect(r.klass).toBe('unknown')
    expect(NEXT_STEP_ZH[r.klass]).toContain('人读一遍')
  })

  it('"这次不做"与"以后都别找我"分得开——只有后者进抑制名单', () => {
    const once = known('这次不合适')
    expect(once.klass).toBe('declined')
    expect(once.opt_out).toBe(false)

    const forever = known('请勿再联系我，别再发了')
    expect(forever.klass).toBe('declined')
    expect(forever.opt_out).toBe(true)
    expect(forever.confidence).toBeGreaterThanOrEqual(0.9)
  })

  it('陌生来信里直接开价的照报价判（陌生来信里也有直接开价的）', () => {
    expect(stranger('你好，我的报价是一条视频 500 刀').klass).toBe('wants_quote')
  })

  it('垃圾邮件哪怕来自我们发过信的地址也是垃圾（对方邮箱被拿去群发了）', () => {
    expect(known('SEO services and link building, increase your traffic').klass).toBe('spam')
  })

  it('每一类都说得出接下来干什么，而且只是建议', () => {
    for (const k of Object.keys(NEXT_STEP_ZH) as (keyof typeof NEXT_STEP_ZH)[])
      expect(NEXT_STEP_ZH[k].length, k).toBeGreaterThan(0)
    expect(NEXT_STEP_ZH.wants_quote).toContain('要人点头')
  })

  it('判据进 signals，卡面上答得出"为什么这么判"', () => {
    const r = known('先报个价')
    expect(r.signals.some((s) => s.startsWith('wants_quote:'))).toBe(true)
  })
})
