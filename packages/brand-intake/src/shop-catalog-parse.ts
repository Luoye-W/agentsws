/**
 * WP393（docs/104 §2.1 / §2.2）：竞品独立站**公开商品数据**的解析（纯函数，测试塞录好的样本）。
 *
 * | 平台 | 地址 | 拿什么 |
 * |---|---|---|
 * | Shopify | `/products.json?limit=250&page=N` | 每个款式的现价 `price`、划线价 `compare_at_price`、有没有货 `available`、商品 `created_at` |
 * | Shopify | `/collections/all.atom` | 按上架时间排的最新 25 件（补「上新」；解析交给 feedsmith，与信息监控同一个库） |
 * | WooCommerce | `/wp-json/wc/store/v1/products?per_page=100&page=N` | `prices.price` / `regular_price` / `sale_price`（按 `currency_minor_unit` 换算）、`is_in_stock` |
 *
 * 纪律：
 * - **不用店铺自己的 `updated_at`**（实测天天被插件批量刷）——这里压根不读它；
 * - 认不出形状回 `undefined`（「不是这种店」），不回空数组假装「这家店没商品」；
 * - 只留比价要的几格（标题、链接、主图、价、划线价、有没有货、创建时间），不存整页原文。
 */
import type { CatalogSnapshotRow } from '@agentsws/contracts'
import { parseAtomFeed } from 'feedsmith'

/** 解析出来的一行（来源 id / 竞品 id / 读到的时间由进料口补上）。 */
export type CatalogRowDraft = Omit<CatalogSnapshotRow, 'source_id' | 'competitor_id' | 'read_at'>

/** 一页解出来的样子。 */
export interface CatalogPage {
  rows: CatalogRowDraft[]
  /** 这一页有几件商品（翻页按它判「还有没有下一页」）。 */
  products: number
  /** 页面自己带着的币种（WooCommerce 有；Shopify 的 products.json 没有）。 */
  currency?: string
}

type Loose = Record<string, unknown>
const rec = (v: unknown): Loose | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Loose) : undefined
const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== ''
    ? v.trim()
    : typeof v === 'number'
      ? String(v)
      : undefined

const ENTITIES: Readonly<Record<string, string>> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&#039;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
}
/** 标题里的实体（WooCommerce 的 `name` 是转义过的）。 */
const clean = (s: string): string =>
  s
    .replace(/&#(\d+);/g, (_, c: string) => String.fromCodePoint(Number(c)))
    .replace(/&[a-z#0-9]+;/gi, (m) => ENTITIES[m.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300)

/** 价格字符串（`"1599.00"`）→ 数；读不出 / 负数 = `undefined`。 */
export function priceOf(v: unknown): number | undefined {
  const s = typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim() : ''
  if (s === '' || !/^\d+(\.\d+)?$/.test(s)) return undefined
  const n = Number(s)
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : undefined
}

/** WooCommerce 的价是最小货币单位（`"129900"` + `minor_unit: 2` = 1299）。 */
export function wooPrice(v: unknown, minorUnit: unknown): number | undefined {
  const s = typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim() : ''
  if (s === '' || !/^\d+$/.test(s)) return undefined
  const unit =
    typeof minorUnit === 'number' && Number.isInteger(minorUnit) && minorUnit >= 0 && minorUnit <= 4
      ? minorUnit
      : 2
  return Math.round((Number(s) / 10 ** unit) * 100) / 100
}

const isoOf = (v: unknown): string | undefined => {
  const s = str(v)
  if (s === undefined) return undefined
  const t = Date.parse(s)
  return Number.isNaN(t) ? undefined : new Date(t).toISOString()
}

const jsonOf = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

/** Shopify `products.json` 的一页；不是这个形状回 `undefined`。 */
export function parseShopifyProductsPage(text: string, origin: string): CatalogPage | undefined {
  const products = rec(jsonOf(text))?.products
  if (!Array.isArray(products)) return undefined
  const rows: CatalogRowDraft[] = []
  for (const raw of products) {
    const p = rec(raw)
    const id = str(p?.id)
    const title = str(p?.title)
    if (p === undefined || id === undefined || title === undefined) continue
    const handle = str(p.handle)
    const url = handle === undefined ? undefined : `${origin}/products/${handle}`
    const image = str(rec(Array.isArray(p.images) ? p.images[0] : undefined)?.src)
    const created = isoOf(p.created_at)
    const variants = Array.isArray(p.variants) ? p.variants : []
    for (const rv of variants) {
      const v = rec(rv)
      const vid = str(v?.id)
      if (v === undefined || vid === undefined) continue
      const price = priceOf(v.price)
      const compare = priceOf(v.compare_at_price)
      const vt = str(v.title)
      rows.push({
        product_key: id,
        variant_key: vid,
        title: clean(title),
        ...(vt === undefined || /^default title$/i.test(vt) ? {} : { variant_title: clean(vt) }),
        ...(url === undefined ? {} : { url }),
        ...(image === undefined ? {} : { image }),
        ...(price === undefined ? {} : { price }),
        // 划线价不高于现价 = 没在打折（店里常把它填成和现价一样）
        ...(compare === undefined || price === undefined || compare <= price
          ? {}
          : { compare_at_price: compare }),
        ...(typeof v.available === 'boolean' ? { available: v.available } : {}),
        ...(created === undefined ? {} : { product_created_at: created }),
      })
    }
  }
  return { rows, products: products.length }
}

/** WooCommerce Store API 商品列表的一页（一个商品一行）；不是这个形状回 `undefined`。 */
export function parseWooProductsPage(text: string): CatalogPage | undefined {
  const list = jsonOf(text)
  if (!Array.isArray(list)) return undefined
  // 空数组也算（翻到底了）；有内容就要像 Store API 的商品
  if (list.length > 0 && rec(list[0])?.prices === undefined) return undefined
  const rows: CatalogRowDraft[] = []
  let currency: string | undefined
  for (const raw of list) {
    const p = rec(raw)
    const id = str(p?.id)
    const name = str(p?.name)
    const prices = rec(p?.prices)
    if (p === undefined || id === undefined || name === undefined || prices === undefined) continue
    const unit = prices.currency_minor_unit
    const price = wooPrice(prices.price, unit)
    const regular = wooPrice(prices.regular_price, unit)
    const cur = str(prices.currency_code)?.toUpperCase()
    currency ??= cur
    const url = str(p.permalink)
    const image = str(rec(Array.isArray(p.images) ? p.images[0] : undefined)?.src)
    rows.push({
      product_key: id,
      title: clean(name),
      ...(url === undefined ? {} : { url }),
      ...(image === undefined ? {} : { image }),
      ...(price === undefined ? {} : { price }),
      ...(regular === undefined || price === undefined || regular <= price
        ? {}
        : { compare_at_price: regular }),
      ...(cur === undefined ? {} : { currency: cur }),
      ...(typeof p.is_in_stock === 'boolean' ? { available: p.is_in_stock } : {}),
    })
  }
  return { rows, products: list.length, ...(currency === undefined ? {} : { currency }) }
}

/** `all.atom` 里的一件（最新上架的 25 件之一）。 */
export interface AtomProduct {
  /** Shopify 商品 id（从 `<id>` 末尾那串数字来）；拿不到用 handle。 */
  product_key: string
  handle?: string
  title: string
  url?: string
  /** 上架时间（重新上架也会变，只拿来补「第一次出现」的那几件）。 */
  published?: string
  /** 第一个款式的价（`<s:price>`）。 */
  price?: number
  currency?: string
}

/** 某一件在原文里的那一段里，第一个 `<s:price currency="USD">1299.00</s:price>`。 */
const atomPrices = (xml: string): Map<string, { price: number; currency?: string }> => {
  const out = new Map<string, { price: number; currency?: string }>()
  for (const m of xml.matchAll(/<entry\b[\s\S]*?<\/entry>/g)) {
    const chunk = m[0]
    const id = /<id>([^<]+)<\/id>/.exec(chunk)?.[1]?.trim()
    const pm = /<s:price(?:\s+currency="([A-Za-z]{3})")?\s*>([^<]+)<\/s:price>/.exec(chunk)
    const price = priceOf(pm?.[2])
    if (id !== undefined && price !== undefined)
      out.set(id, { price, ...(pm?.[1] === undefined ? {} : { currency: pm[1].toUpperCase() }) })
  }
  return out
}

/** Shopify `collections/all.atom`；不是 feed 回 `undefined`。 */
export function parseShopifyAtom(xml: string): AtomProduct[] | undefined {
  let feed: ReturnType<typeof parseAtomFeed>
  try {
    feed = parseAtomFeed(xml)
  } catch {
    return undefined
  }
  const prices = atomPrices(xml)
  const out: AtomProduct[] = []
  for (const e of feed.entries ?? []) {
    const id = str(e.id)
    const title = str(rec(e.title)?.value ?? e.title)
    if (id === undefined || title === undefined) continue
    const link = (e.links ?? []).find((l) => l.rel === undefined || l.rel === 'alternate')?.href
    const handle = link === undefined ? undefined : /\/products\/([^/?#]+)/.exec(link)?.[1]
    const numeric = /\/products\/(\d+)\/?$/.exec(id)?.[1]
    const key = numeric ?? handle
    if (key === undefined) continue
    const published = isoOf(e.published ?? e.updated)
    const p = prices.get(id)
    out.push({
      product_key: key,
      ...(handle === undefined ? {} : { handle }),
      title: clean(title),
      ...(link === undefined ? {} : { url: link }),
      ...(published === undefined ? {} : { published }),
      ...(p === undefined ? {} : { price: p.price }),
      ...(p?.currency === undefined ? {} : { currency: p.currency }),
    })
  }
  return out
}
