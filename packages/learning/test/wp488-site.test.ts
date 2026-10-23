/**
 * WP488（决策 1681）：从官网 / 售后网站学一遍（编排）。读页与模型都用替身；页面是现编的假站点。
 */
import { describe, expect, it } from 'vitest'
import { learnFromSite, type SiteReader } from '../src/index.js'

const AT = '2026-10-23T09:00:00.000Z'
const LONG = ' Our team answers within one business day.'.repeat(4)

const site: Record<string, { html: string; text: string }> = {
  'https://shop.example/': {
    html: '<a href="/pages/faq">FAQ</a><a href="/policies/shipping-policy">Shipping</a><a href="/about-us">x</a>',
    text: `Welcome to the shop.${LONG}`,
  },
  'https://shop.example/pages/faq': { html: '', text: `Q: Do you ship to Canada? A: Yes.${LONG}` },
  'https://shop.example/policies/shipping-policy': {
    html: '',
    text: `Orders ship within 2 business days.${LONG}`,
  },
  'https://shop.example/about-us': { html: '', text: 'short' },
  'https://help.shop.example/': {
    html: '<a href="/hc/articles/1">Returns</a>',
    text: `Help center home.${LONG}`,
  },
  'https://help.shop.example/hc/articles/1': {
    html: '',
    text: `Returns are accepted within 30 days of delivery.${LONG}`,
  },
}

const reader: SiteReader = {
  page: async (url) => {
    const p = site[url]
    return p === undefined ? undefined : { url, html: p.html, text: p.text }
  },
  sitemap: async () => undefined,
}

/** 假模型：按页面给一两条（只看页面网址）。 */
const extract = async (_prompt: string, url: string): Promise<string> => {
  if (url.endsWith('/pages/faq'))
    return JSON.stringify({
      items: [
        {
          question: 'Do you ship to Canada?',
          answer: 'Yes, we ship to Canada.',
          stage: 'presales',
        },
      ],
    })
  if (url.includes('shipping-policy'))
    return JSON.stringify({
      items: [
        { question: 'How fast do orders ship?', answer: 'Orders ship within 2 business days.' },
      ],
    })
  if (url.includes('/hc/articles/1'))
    return JSON.stringify({
      items: [
        {
          question: 'Can I return my order?',
          answer: 'Returns are accepted within 30 days of delivery.',
          stage: 'postsales',
        },
      ],
    })
  return JSON.stringify({ items: [] })
}

describe('从网站学一遍', () => {
  it('官网 + 售后站一起读：政策 / FAQ 先读，太薄的页跳过，每条记来源页与范围', async () => {
    const progress: number[] = []
    const out = await learnFromSite({
      urls: ['shop.example', 'https://help.shop.example/'],
      read: reader,
      extract,
      at: AT,
      maxPages: 10,
      onProgress: (done) => progress.push(done),
    })
    expect(out.planned[0]).toBe('https://shop.example/')
    expect(out.planned.indexOf('https://shop.example/policies/shipping-policy')).toBeLessThan(
      out.planned.indexOf('https://shop.example/pages/faq'),
    )
    expect(out.skipped).toContainEqual({ url: 'https://shop.example/about-us', reason: 'thin' })
    const all = out.pages.flatMap((p) => p.candidates.map((c) => ({ url: p.url, c })))
    expect(all.map((x) => x.c.question).sort()).toEqual([
      'Can I return my order?',
      'Do you ship to Canada?',
      'How fast do orders ship?',
    ])
    const canada = all.find((x) => x.c.question.startsWith('Do you ship'))
    expect(canada?.c.stage).toBe('presales')
    expect(canada?.c.provenance.ref).toBe('https://shop.example/pages/faq')
    expect(all.find((x) => x.c.question.startsWith('Can I return'))?.c.stage).toBe('postsales')
    // 没判范围、问法也判不出 → 公共
    expect(all.find((x) => x.c.question.startsWith('How fast'))?.c.stage).toBe('both')
    expect(progress.at(-1)).toBe(out.planned.length)
  })

  it('停下来（网关冻结）就不再问模型', async () => {
    let calls = 0
    const out = await learnFromSite({
      urls: ['https://shop.example/'],
      read: reader,
      extract: async (p, u) => {
        calls += 1
        return extract(p, u)
      },
      at: AT,
      maxPages: 10,
      shouldContinue: () => calls < 1,
    })
    expect(calls).toBe(1)
    expect(out.skipped.filter((s) => s.reason === 'stopped').length).toBeGreaterThan(0)
  })
})
