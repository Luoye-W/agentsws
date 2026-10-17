/**
 * WP381 ②：关键事实在**原始 HTML**（不开 JS 抓到的那份）里有没有。
 *
 * 多数 AI 爬虫不跑 JS——价格、库存、卖点、政策要是只靠前端脚本画出来，它们读到的就是一页空壳。
 * 做法：同一页抓两次，一次不开 JS（原始），一次渲染后（浏览器跑完脚本），拿店铺后台的说法逐样找：
 * 原始里有 = 好；只有渲染后有 = 「只靠 JS」；两边都没有 = 「没写」。没渲染成的只看原始那一份。
 *
 * 「有没有」看三处：页面文字、JSON-LD、`og:` / `product:` meta（这三处不跑 JS 的爬虫都读得到）。
 */

import { jsonLdNodes, squash, visibleText } from '@agentsws/brand-intake'
import type { RawHtmlFactCheck, SiteFactKind } from '@agentsws/contracts'

/** 一样要找的事实。`patterns` 任一命中就算有（不给 = 按 `expected` 原文找，不分大小写）。 */
export interface FactExpectation {
  fact: SiteFactKind
  expected: string
  patterns?: RegExp[]
}

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** 不跑 JS 的爬虫读得到的那份文字：页面文字 + JSON-LD 原文 + meta 内容。 */
export function crawlerReadableText(html: string): string {
  const text = visibleText(html, 400_000)
  const ld = jsonLdNodes(html)
    .map((n) => JSON.stringify(n))
    .join(' ')
  const metas = [...html.matchAll(/<meta\b[^>]*\bcontent\s*=\s*["']([^"']*)["'][^>]*>/gi)]
    .map((m) => m[1] ?? '')
    .join(' ')
  return squash(`${text} ${ld} ${metas}`)
}

/** 价格 → 几种写法（`29.99` / `29,99`；整数价也认 `29`）。 */
export function priceExpectation(price: string): FactExpectation {
  const [int, dec] = price.split('.')
  const patterns = [new RegExp(`(?<![\\d.,])${esc(int ?? '')}[.,]${esc(dec ?? '00')}(?!\\d)`)]
  if (dec === '00') patterns.push(new RegExp(`[$€£¥]\\s?${esc(int ?? '')}(?![\\d.,])`))
  return { fact: 'price', expected: price, patterns }
}

/** 有货 / 缺货的几种写法（含 schema.org 的值）。 */
export function availabilityExpectation(inStock: boolean): FactExpectation {
  return inStock
    ? {
        fact: 'availability',
        expected: 'in_stock',
        patterns: [
          /schema\.org\/InStock/i,
          /\bin stock\b/i,
          /add to (cart|bag)/i,
          /加入购物车|现货/,
        ],
      }
    : {
        fact: 'availability',
        expected: 'out_of_stock',
        patterns: [/schema\.org\/OutOfStock/i, /sold out|out of stock/i, /售罄|缺货/],
      }
}

/** 退货天数（「30 days」「30-day」「30 天」）。 */
export function returnDaysExpectation(days: number): FactExpectation {
  const n = String(days)
  return {
    fact: 'return_policy',
    expected: `${n} days`,
    patterns: [new RegExp(`\\b${n}\\s?-?\\s?days?\\b`, 'i'), new RegExp(`${n}\\s?天`)],
  }
}

/** 卖点：描述里第一句（取前 60 个字符、去掉标点差异后找）。 */
export function sellingPointExpectation(
  description: string | undefined,
): FactExpectation | undefined {
  const first = squash((description ?? '').replace(/<[^>]+>/g, ' '))
    .split(/(?<=[.!?。！？])\s/)[0]
    ?.trim()
  if (first === undefined || first.length < 12) return undefined
  const head = first.slice(0, 60).replace(/[^\p{L}\p{N}]+$/u, '')
  const words = head.split(/[^\p{L}\p{N}]+/u).filter((w) => w !== '')
  if (words.length === 0) return undefined
  return {
    fact: 'selling_point',
    expected: head,
    patterns: [new RegExp(words.map(esc).join('[^\\p{L}\\p{N}]+'), 'iu')],
  }
}

export function factPresent(readable: string, e: FactExpectation): boolean {
  const pats = e.patterns ?? [new RegExp(esc(e.expected), 'i')]
  return pats.some((p) => p.test(readable))
}

/** 一页：原始那份必有（抓不到给 `undefined`），渲染那份可没有。 */
export function compareRawRendered(input: {
  url: string
  page: RawHtmlFactCheck['page']
  raw: string | undefined
  rendered?: string
  expectations: readonly FactExpectation[]
}): RawHtmlFactCheck[] {
  const raw = input.raw === undefined ? undefined : crawlerReadableText(input.raw)
  const rendered = input.rendered === undefined ? undefined : crawlerReadableText(input.rendered)
  return input.expectations.map((e) => {
    const rawHas = raw === undefined ? undefined : factPresent(raw, e)
    const rendHas = rendered === undefined ? undefined : factPresent(rendered, e)
    const verdict: RawHtmlFactCheck['verdict'] =
      rawHas === undefined ? 'unknown' : rawHas ? 'ok' : rendHas === true ? 'js_only' : 'missing'
    return {
      url: input.url,
      page: input.page,
      fact: e.fact,
      expected: e.expected,
      raw: rawHas === undefined ? 'unknown' : rawHas ? 'present' : 'absent',
      rendered: rendHas === undefined ? 'not_checked' : rendHas ? 'present' : 'absent',
      verdict,
    }
  })
}
