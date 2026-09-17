/**
 * WP78（60 §2 / 分界行）：提及归一、去重、情绪三档、归谁。
 *
 * 最要紧的一条：**客户问题转客服，公关不答**——与 56 的那条边界同一条纪律。
 */
import { describe, expect, it } from 'vitest'
import {
  dedupeMentions,
  handoffOfMention,
  mentionCounts,
  mentionKey,
  normalizeUrl,
  scoreSentiment,
  triageMention,
} from '../src/index.js'

describe('去重', () => {
  it('追踪参数与末尾斜杠不影响归一', () => {
    expect(normalizeUrl('https://Example.com/a/?utm_source=x&id=3#top')).toBe(
      'https://example.com/a?id=3',
    )
  })

  it('同一个地址 = 同一条', () => {
    const a = mentionKey({ source: 'news', url: 'https://x.com/a?utm_medium=rss' })
    const b = mentionKey({ source: 'news', url: 'https://x.com/a/' })
    expect(a).toBe(b)
  })

  it('没有地址就按「来源 + 标题」，**不跨来源合并**', () => {
    const news = mentionKey({ source: 'news', title: 'Nordvolt 发布新品！' })
    const reddit = mentionKey({ source: 'reddit', title: 'Nordvolt 发布新品' })
    expect(news).not.toBe(reddit)
    expect(news).toBe(mentionKey({ source: 'news', title: 'Nordvolt, 发布  新品' }))
  })

  it('去重留最早的那条，并数出被转了几次', () => {
    const rows = [
      { dedupe_key: 'k', published_at: '2026-09-17T10:00:00Z', id: 'b' },
      { dedupe_key: 'k', published_at: '2026-09-17T08:00:00Z', id: 'a' },
      { dedupe_key: 'j', published_at: '2026-09-17T09:00:00Z', id: 'c' },
    ]
    const out = dedupeMentions(rows)
    expect(out).toHaveLength(2)
    expect(out[0]?.mention.id).toBe('a')
    expect(out[0]?.seen_count).toBe(2)
  })
})

describe('情绪三档', () => {
  it('负面词命中 → negative', () => {
    expect(scoreSentiment({ text: '用了两周就漏电，避雷' }).sentiment).toBe('negative')
  })

  it('正面词命中 → positive', () => {
    expect(scoreSentiment({ text: 'holds up after a year, highly recommend' }).sentiment).toBe(
      'positive',
    )
  })

  it('两边都命中 → **负面赢**', () => {
    expect(scoreSentiment({ text: '做工扎实，但用了两周就漏电' }).sentiment).toBe('negative')
  })

  it('一条都没命中 → neutral，把握是 0（不猜）', () => {
    const r = scoreSentiment({ text: '有人用过这个牌子吗' })
    expect(r.sentiment).toBe('neutral')
    expect(r.confidence).toBe(0)
  })

  it('结论里只有判据名，没有原句（外部文本不进日志）', () => {
    const r = scoreSentiment({ text: '这玩意儿就是智商税，我的身份证号是 x' })
    expect(r.signals).toContain('negative:智商税')
    expect(r.signals.join(' ')).not.toContain('身份证')
  })
})

describe('归谁（60 分界行）', () => {
  it('客户问题 → 转客服，公关不答', () => {
    const r = triageMention({
      source: 'reddit',
      text: '我上周下的单到现在还没发货，单号 #10231，什么时候能寄出？',
    })
    expect(r.triage).toBe('customer_issue')
    expect(r.route).toBe('support')
    const card = handoffOfMention(r, { origin: 'r/gadgets', author: 'linaw' })
    expect(card.kind).toBe('support_handoff')
    expect(card.to_role).toBe('dtc.support')
  })

  it('记者来问 → 回应草稿卡，哪怕同时命中负面词', () => {
    const r = triageMention({
      source: 'news',
      text: '我在写一篇关于召回的报道，能否请贵司给一句回应？press inquiry',
    })
    expect(r.triage).toBe('media_inquiry')
    expect(handoffOfMention(r, { origin: 'techpress.example' }).kind).toBe('response_draft')
  })

  it('负面舆情 → 负面预警卡', () => {
    const r = triageMention({ source: 'forum', text: '这家虚假宣传，大家避雷' })
    expect(r.triage).toBe('reputation')
    expect(r.sentiment).toBe('negative')
    expect(handoffOfMention(r, { origin: 'quora.com' }).kind).toBe('negative_alert')
  })

  it('好话 → 存证，不出卡', () => {
    const r = triageMention({ source: 'review', text: '用了一年，真香，推荐' })
    expect(r.triage).toBe('praise')
    expect(handoffOfMention(r, { origin: 'x' }).kind).toBe('archive')
  })

  it('判不准 → noise，不猜', () => {
    const r = triageMention({ source: 'other', text: '有人用过这个牌子吗' })
    expect(r.triage).toBe('noise')
    expect(r.route).toBe('pr')
  })
})

describe('计数', () => {
  it('三档情绪与五类各出一个数（没有的那一档也是 0）', () => {
    const c = mentionCounts([
      { sentiment: 'negative', triage: 'reputation' },
      { sentiment: 'positive', triage: 'praise' },
      { sentiment: 'negative', triage: 'customer_issue' },
    ])
    expect(c.sentiment).toEqual({ negative: 2, neutral: 0, positive: 1 })
    expect(c.triage.reputation).toBe(1)
    expect(c.triage.media_inquiry).toBe(0)
  })
})
