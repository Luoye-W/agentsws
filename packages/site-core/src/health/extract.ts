/**
 * WP381：从几处来源里把商品的「机器读得到的说法」读出来——结构化数据、店铺公开商品数据、商品 feed、页面文字、政策页。
 *
 * 全是纯函数、全是锚定的正则 / JSON（同 `@agentsws/brand-intake` 的 `html.ts`：不装 DOM 解析器）。
 * 读不出就是读不出（`read: false`），不编。
 */

import { decodeEntities, jsonLdNodes, squash, visibleText } from '@agentsws/brand-intake'
import type { ProductFactSource } from '@agentsws/contracts'

export type OfferAvailability = 'in_stock' | 'out_of_stock' | 'preorder' | 'backorder' | 'unknown'

/** 一处来源里的一条报价。 */
export interface SourceOffer {
  price?: string
  currency?: string
  availability?: OfferAvailability
  sku?: string
  /** 价格有效期（JSON-LD `priceValidUntil`）。 */
  valid_until?: string
}

/** 一处来源对一件商品的说法。 */
export interface SourceSnapshot {
  source: ProductFactSource
  label?: string
  /** 这一处读到了没有（`false` = 抓不到 / 没有这件商品，不出不一致）。 */
  read: boolean
  offers: SourceOffer[]
  variant_count?: number
  /** 这一处自己写的更新时间（`dateModified` / feed 更新时间）。 */
  date?: string
  /** 写明的退货天数。 */
  return_days?: number
  /** 页面上能看到的金额（只有 `page` 有）。 */
  amounts?: string[]
}

/** 金额统一成两位小数的字符串（`29.9` → `29.90`；读不出回 undefined）。 */
export function money(v: unknown): string | undefined {
  const s = typeof v === 'number' ? String(v) : typeof v === 'string' ? v : undefined
  if (s === undefined) return undefined
  const m = /-?\d+(?:[.,]\d+)?/.exec(s.replace(/[\s ]/g, '').replace(/,(?=\d{3}\b)/g, ''))
  if (m === null) return undefined
  const n = Number(m[0].replace(',', '.'))
  return Number.isFinite(n) ? n.toFixed(2) : undefined
}

/** schema.org / Google feed / Shopify 各种写法 → 我们的五个值。 */
export function availabilityOf(v: unknown): OfferAvailability | undefined {
  if (typeof v === 'boolean') return v ? 'in_stock' : 'out_of_stock'
  if (typeof v !== 'string' || v.trim() === '') return undefined
  const s = v
    .toLowerCase()
    .replace(/^https?:\/\/schema\.org\//, '')
    .replace(/[\s_-]/g, '')
  if (s === 'instock' || s === 'limitedavailability' || s === 'instoreonly') return 'in_stock'
  if (s === 'outofstock' || s === 'soldout' || s === 'discontinued') return 'out_of_stock'
  if (s === 'preorder' || s === 'presale') return 'preorder'
  if (s === 'backorder') return 'backorder'
  return 'unknown'
}

const rec = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined ? [] : [v])
const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== ''
    ? v.trim()
    : typeof v === 'number'
      ? String(v)
      : undefined
const typeIs = (n: Record<string, unknown>, re: RegExp): boolean =>
  list(n['@type']).some((t) => typeof t === 'string' && re.test(t))

/** 一个 Offer / AggregateOffer → 报价（AggregateOffer 拆成最低价、最高价两条）。 */
function offersOf(v: unknown): SourceOffer[] {
  const out: SourceOffer[] = []
  for (const o of list(v).map(rec)) {
    const currency = str(o.priceCurrency) ?? str(rec(o.priceSpecification).priceCurrency)
    const availability = availabilityOf(o.availability)
    const valid = str(o.priceValidUntil)
    const common = {
      ...(currency === undefined ? {} : { currency: currency.toUpperCase() }),
      ...(availability === undefined ? {} : { availability }),
      ...(valid === undefined ? {} : { valid_until: valid }),
    }
    if (typeIs(o, /aggregateoffer/i)) {
      for (const p of [o.lowPrice, o.highPrice]) {
        const price = money(p)
        if (price !== undefined) out.push({ ...common, price })
      }
      out.push(...offersOf(o.offers))
      continue
    }
    const price = money(o.price) ?? money(rec(o.priceSpecification).price)
    const sku = str(o.sku)
    out.push({
      ...common,
      ...(price === undefined ? {} : { price }),
      ...(sku === undefined ? {} : { sku }),
    })
  }
  return out
}

/** 退货天数（JSON-LD `hasMerchantReturnPolicy.merchantReturnDays`）。 */
function returnDaysOf(n: Record<string, unknown>): number | undefined {
  for (const p of [
    ...list(n.hasMerchantReturnPolicy),
    ...list(rec(n.offers).hasMerchantReturnPolicy),
  ].map(rec)) {
    const d = Number(p.merchantReturnDays)
    if (Number.isFinite(d) && d > 0) return d
  }
  return undefined
}

/** 页面里 JSON-LD 的 Product（或 ProductGroup）→ 一份说法。没有 Product 节点 = `read: false`。 */
export function jsonLdSnapshot(
  html: string,
  source: ProductFactSource = 'jsonld',
  label?: string,
): SourceSnapshot {
  const nodes = jsonLdNodes(html)
  const products = nodes.filter((n) => typeIs(n, /^(product|productgroup)$/i))
  const base = { source, ...(label === undefined ? {} : { label }) }
  if (products.length === 0) return { ...base, read: false, offers: [] }
  const offers: SourceOffer[] = []
  let variants = 0
  let date: string | undefined
  let returnDays: number | undefined
  for (const p of products) {
    offers.push(...offersOf(p.offers))
    const has = list(p.hasVariant).map(rec)
    variants += has.length
    for (const v of has) offers.push(...offersOf(v.offers))
    date ??= str(p.dateModified) ?? str(p.datePublished)
    returnDays ??= returnDaysOf(p)
  }
  return {
    ...base,
    read: true,
    offers,
    ...(variants > 0 ? { variant_count: variants } : {}),
    ...(date === undefined ? {} : { date }),
    ...(returnDays === undefined ? {} : { return_days: returnDays }),
  }
}

/**
 * 店铺公开商品数据（`/products/<handle>.js`）：价格以分为单位、带 `available`。
 * 许多 feed 应用与 AI 爬虫直接读它，所以当作一处「feed」来源比。
 */
export function shopifyProductJsSnapshot(json: string, label = 'store_json'): SourceSnapshot {
  let data: Record<string, unknown>
  try {
    data = rec(JSON.parse(json))
  } catch {
    return { source: 'feed', label, read: false, offers: [] }
  }
  const variants = list(data.variants).map(rec)
  if (variants.length === 0) return { source: 'feed', label, read: false, offers: [] }
  const offers = variants.map((v) => {
    const cents = Number(v.price)
    const availability = availabilityOf(v.available)
    const sku = str(v.sku)
    return {
      ...(Number.isFinite(cents) ? { price: (cents / 100).toFixed(2) } : {}),
      ...(availability === undefined ? {} : { availability }),
      ...(sku === undefined ? {} : { sku }),
    }
  })
  const date = str(data.updated_at) ?? str(data.published_at)
  return {
    source: 'feed',
    label,
    read: true,
    offers,
    variant_count: variants.length,
    ...(date === undefined ? {} : { date }),
  }
}

/** Google Merchant 那种 XML / RSS / Atom feed 里的一条。 */
export interface FeedItem {
  id?: string
  group_id?: string
  link?: string
  title?: string
  price?: string
  currency?: string
  sale_price?: string
  availability?: OfferAvailability
  gtin?: string
  updated?: string
}

const tag = (block: string, name: string): string | undefined => {
  const re = new RegExp(`<(?:g:)?${name}\\b[^>]*>([\\s\\S]*?)<\\/(?:g:)?${name}>`, 'i')
  const m = re.exec(block)
  if (m?.[1] === undefined) return undefined
  const v = decodeEntities(m[1].replace(/^<!\[CDATA\[|\]\]>$/g, '')).trim()
  return v === '' ? undefined : v
}

/** 读整份 feed（`<item>` 或 `<entry>`）；读不出回空数组 + feed 自己的更新时间。 */
export function parseMerchantFeed(xml: string): { items: FeedItem[]; updated?: string } {
  const items: FeedItem[] = []
  for (const m of xml.matchAll(/<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const b = m[2] ?? ''
    const priceRaw = tag(b, 'price')
    const currency = priceRaw === undefined ? undefined : /[A-Z]{3}/.exec(priceRaw)?.[0]
    const price = money(priceRaw)
    const sale = money(tag(b, 'sale_price'))
    const availability = availabilityOf(tag(b, 'availability'))
    const link = tag(b, 'link') ?? /<link[^>]+href="([^"]+)"/i.exec(b)?.[1]
    const pick: [keyof FeedItem, string | undefined][] = [
      ['id', tag(b, 'id')],
      ['group_id', tag(b, 'item_group_id')],
      ['link', link],
      ['title', tag(b, 'title')],
      ['price', price],
      ['currency', currency],
      ['sale_price', sale],
      ['gtin', tag(b, 'gtin')],
      ['updated', tag(b, 'updated')],
    ]
    const item: FeedItem = {}
    for (const [k, v] of pick) if (v !== undefined) (item as Record<string, string>)[k] = v
    if (availability !== undefined) item.availability = availability
    items.push(item)
  }
  const head = xml.split(/<(?:item|entry)\b/i)[0] ?? ''
  const updated = tag(head, 'lastBuildDate') ?? tag(head, 'updated') ?? tag(head, 'pubDate')
  return { items, ...(updated === undefined ? {} : { updated }) }
}

/** feed 里属于这件商品的那几条 → 一份说法（按链接里的 handle 或 id 里带的商品号认）。 */
export function feedSnapshotFor(
  feed: { items: FeedItem[]; updated?: string },
  product: { id: string; handle: string },
  label = 'merchant_feed',
): SourceSnapshot {
  const numeric = /(\d+)$/.exec(product.id)?.[1]
  const mine = feed.items.filter(
    (i) =>
      (i.link !== undefined && new RegExp(`/products/${product.handle}(?:[/?#]|$)`).test(i.link)) ||
      (numeric !== undefined &&
        [i.id, i.group_id].some(
          (x) => x !== undefined && new RegExp(`(?:^|_)${numeric}(?:_|$)`).test(x),
        )),
  )
  if (mine.length === 0) return { source: 'feed', label, read: false, offers: [] }
  const date = mine.find((i) => i.updated !== undefined)?.updated ?? feed.updated
  return {
    source: 'feed',
    label,
    read: true,
    offers: mine.map((i) => ({
      ...((i.sale_price ?? i.price) ? { price: (i.sale_price ?? i.price) as string } : {}),
      ...(i.currency === undefined ? {} : { currency: i.currency }),
      ...(i.availability === undefined ? {} : { availability: i.availability }),
    })),
    variant_count: mine.length,
    ...(date === undefined ? {} : { date }),
  }
}

/** 页面文字里带货币符号 / 代码的金额（去重、按出现先后）。 */
export function pageAmounts(html: string): string[] {
  // 包邮门槛、满减这类「over $50」不是商品价，先去掉
  const text = visibleText(html, 200_000).replace(
    /(?:over|above|from|orders of|满|超过)\s?(?:[$€£¥]|US\$)?\s?\d+(?:[.,]\d{2})?/gi,
    ' ',
  )
  const out: string[] = []
  const re =
    /(?:[$€£¥]|US\$|CA\$|A\$|HK\$|RM|R\$|kr|zł)\s?(\d{1,3}(?:[,.\s]\d{3})*(?:[.,]\d{2})?|\d+(?:[.,]\d{2})?)|(\d+(?:[.,]\d{2})?)\s?(?:USD|EUR|GBP|CAD|AUD|JPY|€)/g
  for (const m of text.matchAll(re)) {
    const v = money(m[1] ?? m[2])
    if (v !== undefined && !out.includes(v)) out.push(v)
  }
  return out
}

/** 页面（商品页）→ 一份说法：页面上的金额 + 页面里写的退货天数。 */
export function pageSnapshot(html: string | undefined): SourceSnapshot {
  if (html === undefined) return { source: 'page', read: false, offers: [] }
  const text = visibleText(html, 200_000)
  const days = returnDaysIn(text)
  return {
    source: 'page',
    read: true,
    offers: [],
    amounts: pageAmounts(html),
    ...(days === undefined ? {} : { return_days: days }),
  }
}

/** 一段文字里写的退货 / 退款天数（「30-day returns」「30 天无理由退货」）。 */
export function returnDaysIn(text: string): number | undefined {
  const t = squash(text)
  const m =
    /(\d{1,3})\s?-?\s?(?:day|days)\b[^.。]{0,60}?\b(?:return|refund|money[- ]back)/i.exec(t) ??
    /\b(?:return|refund)[^.。]{0,80}?\bwithin\s+(\d{1,3})\s?(?:day|days)\b/i.exec(t) ??
    /(\d{1,3})\s?天[^。]{0,20}?(?:退货|退款|退换)/.exec(t)
  const n = m === null ? Number.NaN : Number(m[1])
  return Number.isFinite(n) && n > 0 && n <= 365 ? n : undefined
}

/** 一段文字里写的包邮门槛（「Free shipping on orders over $50」→ `50.00`）。 */
export function freeShippingOverIn(text: string): string | undefined {
  const t = squash(text)
  const m =
    /free (?:standard )?shipping[^.。]{0,40}?(?:over|above|from|\+)\s?[$€£]?\s?(\d+(?:[.,]\d{2})?)/i.exec(
      t,
    ) ?? /满\s?[$€£¥]?\s?(\d+(?:\.\d{2})?)[^。]{0,6}?包邮/.exec(t)
  return m === null ? undefined : money(m[1])
}
