import { describe, expect, it } from 'vitest'
import { handoffOf, TRIAGE_ROUTES, triageCounts, triageThread } from '../src/index.js'

const t = (text: string, over: { is_dm?: boolean } = {}) => triageThread({ text, ...over })

describe('56 §3 分类六类与那条边界（WP72）', () => {
  it('客户问题 → 转客服，**社媒运营不答**（56 的边界行）', () => {
    const r = t('我的单什么时候到啊？下了五天了还没动静')
    expect(r.klass).toBe('customer_question')
    expect(r.route).toBe('support')
    const card = handoffOf(r, { channel: 'discord', author_handle: 'kai' })
    expect(card?.to_role).toBe('dtc.community-support')
    expect(card?.reason).toContain('客服')
  })

  it('英文的客户问题一样判得出来', () => {
    expect(t('when will it ship? ordered last week').klass).toBe('customer_question')
    expect(t('does it work with a usb-c hub?').klass).toBe('customer_question')
  })

  it('合作询问 → 提示转红人营销，但**不替它建合作**（建合作永远人审）', () => {
    const r = t('你好，我是做数码开箱的，想聊聊商务合作，可以寄样吗')
    expect(r.klass).toBe('partnership')
    expect(handoffOf(r, { channel: 'meta', author_handle: 'jonas' })?.to_role).toBe('kol.meta')
  })

  it('夸、投诉、垃圾都归社媒运营自己处理', () => {
    expect(t('这个充电器真香，推荐给我同事了').route).toBe('social')
    expect(t('太差了，再也不买了，客服也不理人').klass).toBe('complaint')
    expect(t('加微信免费领礼品，点击链接').klass).toBe('spam')
    for (const k of ['praise', 'complaint', 'spam', 'other'] as const)
      expect(TRIAGE_ROUTES[k]).toBe('social')
  })

  it('一条又抱怨又问订单的话，判成客户问题——客服接得住抱怨，社媒运营接不住订单', () => {
    const r = t('我的订单还没收到，太慢了，很失望')
    expect(r.klass).toBe('customer_question')
  })

  it('判不准就落 other，**不猜**（多一个"疑似"的桶会让两边都不接）', () => {
    const r = t('今天天气不错')
    expect(r.klass).toBe('other')
    expect(r.confidence).toBe(0)
    expect(handoffOf(r, { channel: 'reddit', author_handle: 'x' })).toBeUndefined()
  })

  it('私信里一句没命中任何词的开场白，倾向客户问题（多转一张卡比没人理便宜）', () => {
    const r = t('在吗', { is_dm: true })
    expect(r.klass).toBe('customer_question')
    expect(r.signals).toContain('customer_question:dm_opener')
    // 同一句话在群里不倾斜
    expect(t('在吗').klass).toBe('other')
  })

  it('结论里只有判据名，没有原句（评论正文是外部文本，会进事件日志）', () => {
    const r = t('我的订单号是 #1001，什么时候发货')
    expect(r.signals.join(' ')).not.toContain('#1001')
    for (const s of r.signals) expect(s).toMatch(/^[a-z_]+:/)
  })

  it('计数六格齐全，形状不随数据变（面板上那一格读它）', () => {
    const counts = triageCounts([
      { klass: 'customer_question' },
      { klass: 'customer_question' },
      { klass: 'spam' },
    ])
    expect(counts).toEqual({
      customer_question: 2,
      praise: 0,
      complaint: 0,
      spam: 1,
      partnership: 0,
      other: 0,
    })
  })
})
