/**
 * WP381 ①：商品信息机器可读体检——店铺后台是真源，逐处对照。
 *
 * 规矩：
 * - 只比读到了的那几处（`read: false` 的不出不一致，进体检的「没读到」那几句）；
 * - 价格按两位小数比；促销价算价格（后台的 `price` 就是现在卖的价）；
 * - 带没带日期单独数（`dating`）：结构化数据的价格有效期 / 更新时间、feed 的更新时间——
 *   AI 回答「现在多少钱」时，带日期的说法更容易被当真；过了有效期的价格标「过期」。
 */
import type { ProductFactIssue, ProductFactSource, ProductSourceDating } from '@agentsws/contracts'
import type { OfferAvailability, SourceSnapshot } from './extract.js'

/** 店铺后台里的一件商品（真源）。 */
export interface ProductTruth {
  id: string
  title: string
  handle: string
  /** 网店上的地址（没上架 = 没有）。 */
  url?: string
  description?: string
  vendor?: string
  product_type?: string
  image?: string
  /** 多规格时的规格名（颜色 / 尺码）。 */
  options?: string[]
  variants: {
    id: string
    title?: string
    sku?: string
    price: string
    available?: boolean
    barcode?: string
  }[]
}

/** 店铺层面的事实（币种、政策）。 */
export interface StoreTruth {
  currency: string
  name?: string
  /** 退货政策里写的天数。 */
  return_days?: number
  /** 包邮门槛（两位小数）。 */
  free_shipping_over?: string
  policy_urls?: { refund?: string; shipping?: string; privacy?: string; terms?: string }
}

const SEVERITY_RANK = { high: 0, medium: 1, low: 2 } as const

const priceRange = (p: ProductTruth): string => {
  const prices = [...new Set(p.variants.map((v) => v.price))].sort((a, b) => Number(a) - Number(b))
  return prices.length <= 1 ? (prices[0] ?? '') : `${prices[0]}–${prices[prices.length - 1]}`
}

const adminAvailability = (p: ProductTruth): OfferAvailability | undefined => {
  const known = p.variants.filter((v) => v.available !== undefined)
  if (known.length === 0) return undefined
  return known.some((v) => v.available === true) ? 'in_stock' : 'out_of_stock'
}

/** 这件商品在这一处的不一致清单。 */
export function compareProductSource(
  product: ProductTruth,
  store: StoreTruth,
  snap: SourceSnapshot,
  today: string,
): ProductFactIssue[] {
  if (!snap.read) return []
  const out: ProductFactIssue[] = []
  const base = {
    product_id: product.id,
    product_title: product.title,
    handle: product.handle,
    source: snap.source,
    ...(snap.label === undefined ? {} : { source_label: snap.label }),
  }
  const truthPrices = new Set(product.variants.map((v) => v.price))
  const range = priceRange(product)

  if (snap.source === 'page') {
    const amounts = snap.amounts ?? []
    if (amounts.length > 0 && !amounts.some((a) => truthPrices.has(a)))
      out.push({
        ...base,
        field: 'price',
        kind: 'mismatch',
        expected: range,
        found: amounts[0] as string,
        severity: 'medium',
      })
  } else {
    const priced = snap.offers.filter((o) => o.price !== undefined)
    if (priced.length === 0)
      out.push({
        ...base,
        field: 'price',
        kind: 'missing',
        expected: range,
        severity: snap.source === 'platform' ? 'medium' : 'high',
      })
    const wrong = priced.find((o) => !truthPrices.has(o.price as string))
    if (wrong !== undefined)
      out.push({
        ...base,
        field: 'price',
        kind: 'mismatch',
        expected: range,
        found: wrong.price as string,
        severity: 'high',
      })
    const cur = priced.find(
      (o) => o.currency !== undefined && o.currency !== store.currency.toUpperCase(),
    )
    if (cur !== undefined && snap.source !== 'platform')
      out.push({
        ...base,
        field: 'currency',
        kind: 'mismatch',
        expected: store.currency.toUpperCase(),
        found: cur.currency as string,
        severity: 'high',
      })
    if (
      snap.source === 'jsonld' &&
      priced.length > 0 &&
      priced.every((o) => o.currency === undefined)
    )
      out.push({
        ...base,
        field: 'currency',
        kind: 'missing',
        expected: store.currency.toUpperCase(),
        severity: 'medium',
      })

    const truthAvail = adminAvailability(product)
    const said = snap.offers
      .map((o) => o.availability)
      .filter((a) => a !== undefined && a !== 'unknown')
    if (said.length === 0 && snap.source !== 'platform')
      out.push({
        ...base,
        field: 'availability',
        kind: 'missing',
        ...(truthAvail === undefined ? {} : { expected: truthAvail }),
        severity: 'medium',
      })
    else if (truthAvail !== undefined && said.length > 0) {
      const anyIn = said.some((a) => a === 'in_stock' || a === 'preorder' || a === 'backorder')
      const sayAvail: OfferAvailability = anyIn ? 'in_stock' : 'out_of_stock'
      if (sayAvail !== truthAvail)
        out.push({
          ...base,
          field: 'availability',
          kind: 'mismatch',
          expected: truthAvail,
          found: sayAvail,
          severity: 'high',
        })
    }
    if (
      snap.variant_count !== undefined &&
      product.variants.length > 1 &&
      snap.variant_count !== product.variants.length
    )
      out.push({
        ...base,
        field: 'variants',
        kind: 'mismatch',
        expected: String(product.variants.length),
        found: String(snap.variant_count),
        severity: 'low',
      })

    // 日期：带没带、过没过期
    const valid = snap.offers.map((o) => o.valid_until).find((d) => d !== undefined)
    if (valid !== undefined && valid.slice(0, 10) < today)
      out.push({
        ...base,
        field: 'date',
        kind: 'expired',
        found: valid.slice(0, 10),
        severity: 'medium',
      })
    else if (
      (snap.source === 'jsonld' || snap.source === 'feed') &&
      valid === undefined &&
      snap.date === undefined
    )
      out.push({ ...base, field: 'date', kind: 'undated', severity: 'low' })
  }
  if (
    snap.return_days !== undefined &&
    store.return_days !== undefined &&
    snap.return_days !== store.return_days
  )
    out.push({
      ...base,
      field: 'return_policy',
      kind: 'mismatch',
      expected: `${String(store.return_days)}`,
      found: `${String(snap.return_days)}`,
      severity: 'medium',
    })
  return out
}

/** 一批商品 × 几处来源 → 不一致清单（按严重度排）+ 每处带日期的件数。 */
export function checkProductFacts(
  rows: { product: ProductTruth; sources: SourceSnapshot[] }[],
  store: StoreTruth,
  today: string,
): { issues: ProductFactIssue[]; dating: ProductSourceDating[] } {
  const issues: ProductFactIssue[] = []
  const dating = new Map<string, ProductSourceDating>()
  for (const { product, sources } of rows) {
    for (const snap of sources) {
      issues.push(...compareProductSource(product, store, snap, today))
      if (!snap.read || snap.source === 'page') continue
      const key = `${snap.source}|${snap.label ?? ''}`
      const d = dating.get(key) ?? {
        source: snap.source as ProductFactSource,
        ...(snap.label === undefined ? {} : { source_label: snap.label }),
        checked: 0,
        dated: 0,
      }
      d.checked += 1
      if (snap.date !== undefined || snap.offers.some((o) => o.valid_until !== undefined))
        d.dated += 1
      dating.set(key, d)
    }
  }
  issues.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
  return { issues, dating: [...dating.values()] }
}

/** 一件不一致 → 交给网站运营的一行人话（派单正文用）。 */
export function issueLine(i: ProductFactIssue): string {
  const where =
    i.source === 'page'
      ? '商品页文字'
      : i.source === 'jsonld'
        ? '结构化数据'
        : i.source === 'feed'
          ? `商品 feed（${i.source_label ?? ''}）`
          : `${i.source_label ?? '其他平台'} 上架页`
  const field = {
    price: '价格',
    currency: '币种',
    availability: '库存状态',
    variants: '规格数',
    return_policy: '退货天数',
    shipping_policy: '配送政策',
    date: '日期',
  }[i.field]
  const what =
    i.kind === 'mismatch'
      ? `写的是 ${i.found ?? '?'}，后台是 ${i.expected ?? '?'}`
      : i.kind === 'missing'
        ? `没写${i.expected === undefined ? '' : `（后台是 ${i.expected}）`}`
        : i.kind === 'expired'
          ? `价格有效期 ${i.found ?? ''} 已过`
          : '没带日期'
  return `「${i.product_title}」${where}的${field}${what}`
}
