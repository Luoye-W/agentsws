/**
 * WP488（决策 1680 / 1681 / 1682）：从过往邮件拼问答对、从网站学的纯函数、售前 / 售后判定。
 * 全是现编的假往来与假页面，不放任何真实客户数据。
 */
import { resolveStage, stageOfText } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  clusterHistory,
  type HistoryMail,
  historyCategory,
  isBulkMail,
  isPolicyUrl,
  parseHistorySummary,
  parseSiteItems,
  planSitePages,
  qaPairsFromMail,
  sameSiteLinks,
  siteCandidate,
  sitemapLocs,
  stripQuoted,
} from '../src/index.js'

const OURS = new Set(['support@shop.example'])
const at = (d: number) => new Date(Date.UTC(2026, 5, d, 9)).toISOString()
const mail = (
  p: Partial<HistoryMail> & { id: string; thread_id: string; from: string; date: string },
): HistoryMail => ({
  subject: 'Hello',
  text: 'Hi there, a question about my order please.',
  ...p,
  from: { email: p.from },
})

describe('售前 / 售后判定（规则，不问模型）', () => {
  it('订单号 / 已购 / 物流售后词 → 售后', () => {
    expect(stageOfText('Where is my order #10234? It has not arrived yet')).toBe('postsales')
    expect(stageOfText('我的订单还没收到，物流到哪了')).toBe('postsales')
    expect(stageOfText('The lamp arrived damaged')).toBe('postsales')
  })
  it('询价 / 选型 / 有没有货 → 售前', () => {
    expect(stageOfText('How much is the 2-pack and is it in stock?')).toBe('presales')
    expect(stageOfText('这两款有什么区别，哪款适合露营')).toBe('presales')
  })
  it('两边都像 / 都不像 → 判不出（两边都取）；学的时候给公共', () => {
    expect(stageOfText('What is your return policy?')).toBeUndefined()
    expect(resolveStage(undefined, 'What is your return policy?')).toBe('both')
    expect(resolveStage('presales', 'Where is my order #10234?')).toBe('presales')
  })
})

describe('从过往邮件拼「客户问 → 我们人工回」', () => {
  it('跳过 AI 发的、群发 / 通知、没人回的、我们先发的', () => {
    const mails: HistoryMail[] = [
      // 1. 正常：客户问 → 我们人工回
      mail({
        id: 'a1',
        thread_id: 't1',
        from: 'amy@cust.example',
        date: at(1),
        message_id: '<a1@x>',
      }),
      mail({
        id: 'a2',
        thread_id: 't1',
        from: 'support@shop.example',
        date: at(2),
        message_id: '<a2@x>',
        text: 'We ship within 2 business days.\n\nOn Mon, Amy wrote:\n> where is it',
      }),
      // 2. 回的那封是工坊 AI 发的（出站台账里有）
      mail({ id: 'b1', thread_id: 't2', from: 'bob@cust.example', date: at(3) }),
      mail({
        id: 'b2',
        thread_id: 't2',
        from: 'support@shop.example',
        date: at(4),
        message_id: '<ai@x>',
      }),
      // 3. 群发
      mail({
        id: 'c1',
        thread_id: 't3',
        from: 'news@brand.example',
        date: at(5),
        headers: { 'list-unsubscribe': '<mailto:x>' },
      }),
      mail({ id: 'c2', thread_id: 't3', from: 'support@shop.example', date: at(6) }),
      // 4. 没人回
      mail({ id: 'd1', thread_id: 't4', from: 'dan@cust.example', date: at(7) }),
      // 5. 我们先发的（开发信）
      mail({ id: 'e1', thread_id: 't5', from: 'support@shop.example', date: at(8) }),
      mail({ id: 'e2', thread_id: 't5', from: 'eve@cust.example', date: at(9) }),
    ]
    const out = qaPairsFromMail(mails, { ours: OURS, machineSent: new Set(['<ai@x>']) })
    expect(out.pairs).toHaveLength(1)
    expect(out.pairs[0]?.human_answer).toBe('We ship within 2 business days.')
    expect(out.skipped).toEqual({ machine_sent: 1, bulk: 1, no_reply: 1, ours_first: 1 })
  })

  it('认得出群发与系统通知', () => {
    expect(isBulkMail({ from: { email: 'noreply@pay.example' } })).toBe(true)
    expect(isBulkMail({ from: { email: 'a@b.example' }, headers: { precedence: 'bulk' } })).toBe(
      true,
    )
    expect(isBulkMail({ from: { email: 'a@b.example' }, kind: 'marketing' })).toBe(true)
    expect(isBulkMail({ from: { email: 'a@b.example' } })).toBe(false)
  })

  it('去掉回信里引用的那一截', () => {
    expect(stripQuoted('Thanks!\n> old\n> older')).toBe('Thanks!')
    expect(stripQuoted('好的\n\n在 2026年6月1日 写道：\n原文')).toBe('好的')
  })

  it('售前的问法成一簇（老产品只认售后那几类，售前全被丢了）', () => {
    expect(historyCategory('How much is the 2-pack bundle?')).toBe('pre_sales')
    const pairs = Array.from({ length: 3 }, (_, i) => ({
      thread_id: `p${i}`,
      question: 'How much is the 2-pack bundle, any discount?',
      human_answer: 'The 2-pack is listed on the product page; bundles get 10% off.',
      at: at(i + 1),
    }))
    expect(clusterHistory(pairs)[0]?.category).toBe('pre_sales')
  })

  it('认模型回的那段 JSON（带范围）', () => {
    const s = parseHistorySummary(
      '好的：```json\n{"question":"Do you ship to Canada?","answer":"Yes, 5-8 days.","stage":"presales","confidence":80}\n```',
    )
    expect(s).toEqual({
      question: 'Do you ship to Canada?',
      answer: 'Yes, 5-8 days.',
      stage: 'presales',
      confidence: 0.8,
    })
    expect(parseHistorySummary('{}')).toBeUndefined()
  })
})

describe('从网站学（纯函数那一半）', () => {
  const html = `
    <a href="/pages/faq">FAQ</a><a href="/policies/refund-policy">Refund</a>
    <a href="/products/lamp">Lamp</a><a href="/blog/post">Blog</a>
    <a href="https://other.example/help">Other</a><a href="/logo.png">x</a>`

  it('只挑同站、客服相关的链接；政策页先读、页数封顶', () => {
    const links = sameSiteLinks(html, 'https://shop.example/')
    expect(links).toEqual([
      'https://shop.example/pages/faq',
      'https://shop.example/policies/refund-policy',
      'https://shop.example/products/lamp',
    ])
    expect(planSitePages('https://shop.example/', links, 3)).toEqual([
      'https://shop.example/',
      'https://shop.example/policies/refund-policy',
      'https://shop.example/pages/faq',
    ])
    expect(isPolicyUrl('https://shop.example/policies/refund-policy')).toBe(true)
  })

  it('帮助中心站整站都读（不只按路径挑）', () => {
    expect(
      sameSiteLinks(
        '<a href="/hc/articles/1">a</a><a href="/x">b</a>',
        'https://help.shop.example/',
      ),
    ).toHaveLength(2)
  })

  it('sitemap 认页面与子 sitemap', () => {
    const xml =
      '<urlset><url><loc>https://shop.example/pages/shipping</loc></url><url><loc>https://shop.example/blog/a</loc></url>' +
      '<sitemap><loc>https://shop.example/sitemap_pages_1.xml</loc></sitemap></urlset>'
    expect(sitemapLocs(xml, 'https://shop.example/')).toEqual({
      pages: ['https://shop.example/pages/shipping'],
      sitemaps: ['https://shop.example/sitemap_pages_1.xml'],
    })
  })

  it('空答案丢掉；政策页置信度封顶；范围按模型给的', () => {
    const items = parseSiteItems(
      JSON.stringify({
        items: [
          {
            question: 'How long is the warranty?',
            answer: '12 months from delivery.',
            stage: 'postsales',
            confidence: 0.9,
          },
          {
            question: 'Do you price match?',
            answer: 'The page does not provide this information.',
          },
        ],
      }),
    )
    expect(items).toHaveLength(1)
    const c = siteCandidate(items[0] as never, 'https://shop.example/policies/warranty', at(1))
    expect(c?.stage).toBe('postsales')
    expect(c?.confidence).toBeLessThanOrEqual(0.65)
    expect(c?.provenance).toMatchObject({
      source: 'web',
      ref: 'https://shop.example/policies/warranty',
    })
    expect(c?.hold_reasons).toContain('policy_sensitive')
  })
})
