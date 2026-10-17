/**
 * WP381 ③：AI 来源流量——用录好的 Shopify 订单进店来源样本（首次 / 最后一次进店）与店铺报表会话样本算，不联网。
 */
import { describe, expect, it } from 'vitest'
import {
  aiPlatformOf,
  aiTrafficBrief,
  DEFAULT_AI_REFERRERS,
  effectiveReferrers,
  summarizeAiTraffic,
  type TrafficOrder,
} from '../src/index.js'

const ORDERS: TrafficOrder[] = [
  // 最后一次从 ChatGPT 点进来（带 utm_source=chatgpt.com）
  {
    total: 49.99,
    currency: 'USD',
    created_at: '2026-10-12T10:00:00Z',
    last: {
      landing_page: '/products/power-bank-20000?utm_source=chatgpt.com',
      source: 'chatgpt.com',
    },
  },
  // 首次从 Perplexity 来、最后一次直接进来
  {
    total: 89.5,
    currency: 'USD',
    created_at: '2026-10-13T10:00:00Z',
    first: { referrer_url: 'https://www.perplexity.ai/search?q=best+power+bank' },
    last: { source: 'direct' },
  },
  // 首次从 Google、最后一次从 Claude 来：记 Claude（最后一次优先）
  {
    total: 30,
    currency: 'USD',
    created_at: '2026-10-14T10:00:00Z',
    first: { referrer_url: 'https://www.google.com/' },
    last: { referrer_url: 'https://claude.ai/chat/abc' },
  },
  // 不是 AI
  {
    total: 20,
    currency: 'USD',
    created_at: '2026-10-15T10:00:00Z',
    first: { referrer_url: 'https://www.google.com/' },
  },
  // 窗口外
  {
    total: 99,
    currency: 'USD',
    created_at: '2026-09-01T10:00:00Z',
    last: { referrer_url: 'https://chatgpt.com/' },
  },
]

describe('WP381 ③ AI 来源流量（实测）', () => {
  it('认来源：网址主机、子域名、落地页 utm、Shopify 归的来源名', () => {
    expect(aiPlatformOf({ referrer_url: 'https://chatgpt.com/c/123' })).toBe('ChatGPT')
    expect(aiPlatformOf({ referrer_url: 'https://www.perplexity.ai/' })).toBe('Perplexity')
    expect(aiPlatformOf({ referrer_url: 'android-app://com.google.android.gm' })).toBeUndefined()
    expect(aiPlatformOf({ landing_page: '/?utm_source=copilot' })).toBe('Copilot')
    expect(aiPlatformOf({ source: 'gemini.google.com' })).toBe('Gemini')
    expect(aiPlatformOf({ source: 'Google' })).toBeUndefined()
  })

  it('一单只算一次、最后一次进店优先；窗口外不算；会话按来源域名并进来', () => {
    const s = summarizeAiTraffic({
      orders: ORDERS,
      sessions: [
        { referrer_domain: 'chatgpt.com', sessions: 120 },
        { referrer_domain: 'www.perplexity.ai', sessions: 30 },
        { referrer_domain: 'google.com', sessions: 900 },
      ],
      visits_state: 'ok',
      since: '2026-10-11T00:00:00Z',
      until: '2026-10-17T23:59:59Z',
      currency: 'USD',
      now: '2026-10-17T12:00:00Z',
    })
    expect(s.measured).toBe(true)
    expect(s.total_orders).toBe(4)
    expect(s.ai_orders).toBe(3)
    expect(s.ai_revenue).toBe(169.49)
    expect(s.rows).toEqual([
      { platform: 'ChatGPT', orders: 1, revenue: 49.99, visits: 120 },
      { platform: 'Perplexity', orders: 1, revenue: 89.5, visits: 30 },
      { platform: 'Claude', orders: 1, revenue: 30 },
    ])
    expect(aiTrafficBrief(s)).toBe('AI 带来 3 单 / USD 169.49（实测） · 访问 150 · ChatGPT 1 单')
    expect(s.daily).toEqual([0, 1, 1, 1, 0, 0, 0])
  })

  it('没授权店铺报表：访问不出、成交照算；清单可加减', () => {
    const s = summarizeAiTraffic({
      orders: ORDERS,
      visits_state: 'no_scope',
      since: '2026-10-11T00:00:00Z',
      until: '2026-10-17T23:59:59Z',
      currency: 'USD',
      now: '2026-10-17T12:00:00Z',
      list: effectiveReferrers({
        referrers_remove: ['claude'],
        referrers_add: [{ platform: 'NewAI', hosts: ['newai.example'] }],
      }),
    })
    expect(s.visits).toBe('no_scope')
    // 前一段窗口：9 月那一单是 ChatGPT 来的
    const withPrev = summarizeAiTraffic({
      orders: ORDERS,
      visits_state: 'no_scope',
      since: '2026-10-11T00:00:00Z',
      until: '2026-10-17T23:59:59Z',
      currency: 'USD',
      now: '2026-10-17T12:00:00Z',
      previous: { since: '2026-08-30T00:00:00Z', until: '2026-10-11T00:00:00Z' },
    })
    expect(withPrev.previous).toEqual({ ai_orders: 1, ai_revenue: 99 })
    expect(s.rows.every((r) => r.visits === undefined)).toBe(true)
    expect(s.ai_orders).toBe(2)
    expect(aiTrafficBrief(s)).toBe('AI 带来 2 单 / USD 139.49（实测） · ChatGPT 1 单')
    const names = DEFAULT_AI_REFERRERS.map((r) => r.platform)
    for (const p of ['ChatGPT', 'Perplexity', 'Gemini', 'Copilot', 'Claude'])
      expect(names).toContain(p)
  })
})
