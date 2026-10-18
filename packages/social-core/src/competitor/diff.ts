/**
 * WP392（docs/104 §3.3）：**快照对比引擎**——把这一次读回来的几行和上一次的快照比，比出变化（纯函数）。
 *
 * 规矩（每一条都有测试钉着，`test/competitor-diff.test.ts`）：
 * - **第一次读只当底子**，不出任何变化（不报「上新 398 件」）；
 * - 上新：快照里第一次出现的商品，且商品创建时间在最近 `new_within_days` 天内（读不到创建时间就只看第一次出现）；
 *   重新上架的老货（快照里有过、判过下架）不算上新；老商品新加一个款式也不算；
 * - 下架：**连续两次读全了**都没读到才算（防一次没读全）；某次读得不完整（翻页断了、被挡）整次不判下架；
 *   只有一个商品的所有款式都不见了才出一条「下架」；
 * - 改价：款式现价变了，记前后价和幅度；同一商品几个款式一起变，合成一条「N 个款式降价 X%–Y%」；
 * - 打折开始 / 结束：划线价高于现价从无到有 / 从有到无（这一行就不再另出「改价」）；Amazon 的优惠券从无到有 / 从有到无也算；
 * - 断货 / 补货：有没有货翻转（同一商品几个款式一起翻，合成一条）；
 * - Amazon：评分（保留一位小数后变了才算）、评论数（变了就记）、BSR（每个类目的名次变了就记）——**算出来就记**，
 *   哪些算重要不在这里判（C5）；
 * - **不用店铺自己的 `updated_at`**：比的只有价、划线价、有没有货、评分、评论数、BSR、优惠券这几格，别的格怎么跳都不出变化；
 * - 快照只存每一行的最新值 + 第一次 / 最近一次读到的时间 + 连续没读到几次，不存整页原文。
 */
import {
  type CatalogReadResult,
  type CatalogSnapshot,
  type CatalogSnapshotRow,
  type CatalogStateRow,
  type CatalogUnreadField,
  COMPETITOR_REMOVED_AFTER_MISSES,
  type CompetitorChange,
  type CompetitorChangeKind,
  type CompetitorChangeValue,
  type CompetitorSourceKind,
  type CompetitorVsOwn,
  type Iso8601,
  type WorkspaceId,
} from '@agentsws/contracts'

/** 自家对标款（C8）：竞品这一行对标自家哪一款、自家那一款现在多少钱。 */
export interface OwnRef {
  own_key: string
  own_title?: string
  own_price: number
  currency?: string
}

export interface CatalogDiffInput {
  workspace_id: WorkspaceId
  source: { id: string; kind: CompetitorSourceKind; competitor_id: string }
  /** 竞品名快照。 */
  competitor: string
  /** 上一次快照（没有 = 第一次读，只当底子）。 */
  previous: CatalogSnapshot | undefined
  read: Pick<CatalogReadResult, 'rows' | 'complete'>
  now: Iso8601
  /** 「上新」只认最近几天内创建的（默认 7）。 */
  new_within_days?: number
  /** C8：这一行对标自家哪一款（不给 = 不比）。 */
  ownRef?(row: CatalogSnapshotRow): OwnRef | undefined
}

export interface CatalogDiffOutput {
  snapshot: CatalogSnapshot
  changes: CompetitorChange[]
  /** 这一次只建了底子（第一次读）。 */
  baseline: boolean
}

const rowKey = (r: Pick<CatalogSnapshotRow, 'product_key' | 'variant_key'>): string =>
  `${r.product_key}\u0000${r.variant_key ?? ''}`

const round1 = (n: number): number => Math.round(n * 10) / 10
const round2 = (n: number): number => Math.round(n * 100) / 100
const samePrice = (a: number, b: number): boolean => Math.abs(a - b) < 0.005

/** 幅度（%，一位小数，带正负）；前值是 0 算不出 = `undefined`。 */
export function pctChange(before: number, after: number): number | undefined {
  if (before === 0) return undefined
  return round1(((after - before) / before) * 100)
}

/** 在打折：划线价高于现价。 */
const onSale = (r: CatalogSnapshotRow): boolean =>
  r.price !== undefined && r.compare_at_price !== undefined && r.compare_at_price > r.price

/** 变化 id：同一来源、同一商品、同一种类、同一时刻 = 同一条（重跑不重记）。 */
export function competitorChangeId(parts: readonly string[]): string {
  // FNV-1a 两遍（不同种子）拼 16 位十六进制：纯函数、Workers 里也能跑
  const fnv = (s: string, seed: number): string => {
    let h = seed >>> 0
    for (let i = 0; i < s.length; i += 1) {
      h ^= s.charCodeAt(i)
      h = Math.imul(h, 0x01000193) >>> 0
    }
    return h.toString(16).padStart(8, '0')
  }
  const s = parts.join('\u0001')
  return `cc_${fnv(s, 0x811c9dc5)}${fnv(s, 0x2b992ddf)}`
}

interface Entry {
  kind: CompetitorChangeKind
  prev?: CatalogSnapshotRow
  row: CatalogSnapshotRow
  before?: CompetitorChangeValue
  after?: CompetitorChangeValue
  pct?: number
  category?: string
  /** 合成时按它分组（同一商品同一种类；BSR 再按类目、优惠券单独一组）。 */
  group: string
}

/** WP394：这一行这一格没读到（云端那一路没有划线价 / 优惠券）。 */
const unread = (r: CatalogSnapshotRow, f: CatalogUnreadField): boolean =>
  r.fields_unread?.includes(f) === true

const toState = (
  row: CatalogSnapshotRow,
  now: Iso8601,
  prev?: CatalogStateRow,
): CatalogStateRow => {
  const out: CatalogStateRow = {
    ...row,
    read_at: now,
    first_seen_at: prev?.first_seen_at ?? now,
    last_seen_at: now,
    missing: 0,
  }
  // WP394：这次没读到的格子留着上一次读到的值（下一次能读到时和它比，不和「空」比）
  if (prev !== undefined && row.fields_unread !== undefined) {
    const still: CatalogUnreadField[] = []
    for (const f of row.fields_unread) {
      const was = prev[f]
      if (was !== undefined && !unread(prev, f)) Object.assign(out, { [f]: was })
      else still.push(f)
    }
    if (still.length === 0) delete out.fields_unread
    else out.fields_unread = still
  }
  return out
}

/** 把这一次读到的和上一次的快照比，交回新快照与比出来的变化。 */
export function diffCatalog(input: CatalogDiffInput): CatalogDiffOutput {
  const { now } = input
  const current = new Map<string, CatalogSnapshotRow>()
  for (const r of input.read.rows) current.set(rowKey(r), r)
  const reads = (input.previous?.reads ?? 0) + 1
  const base = { source_id: input.source.id, workspace_id: input.workspace_id, reads, read_at: now }

  // 第一次读：只当底子
  if (input.previous === undefined) {
    return {
      snapshot: { ...base, rows: [...current.values()].map((r) => toState(r, now)) },
      changes: [],
      baseline: true,
    }
  }

  const prevRows = new Map<string, CatalogStateRow>()
  const prevProducts = new Set<string>()
  for (const r of input.previous.rows) {
    prevRows.set(rowKey(r), r)
    prevProducts.add(r.product_key)
  }
  // 一行都没读到却说「读全了」：多半是对方挡了，照「没读全」处理（不判下架）
  const complete = input.read.complete && current.size > 0
  const entries: Entry[] = []
  const fresh = new Map<string, CatalogSnapshotRow[]>()
  const nextRows: CatalogStateRow[] = []

  for (const [key, row] of current) {
    const p = prevRows.get(key)
    nextRows.push(toState(row, now, p))
    if (p === undefined) {
      // 老商品新加的款式不算上新；整个商品第一次出现才是候选
      if (!prevProducts.has(row.product_key))
        fresh.set(row.product_key, [...(fresh.get(row.product_key) ?? []), row])
      continue
    }
    entries.push(...compareRow(p, row))
  }

  // 上新：第一次出现，且创建时间在最近 N 天内（读不到创建时间就只看第一次出现）
  const windowMs = (input.new_within_days ?? 7) * 86_400_000
  const nowMs = Date.parse(now)
  for (const [product, rows] of fresh) {
    const created = rows.find((r) => r.product_created_at !== undefined)?.product_created_at
    if (created !== undefined && nowMs - Date.parse(created) > windowMs) continue
    const first = rows[0] as CatalogSnapshotRow
    const prices = rows.map((r) => r.price).filter((n): n is number => n !== undefined)
    entries.push({
      kind: 'new',
      row: first,
      ...(prices.length === 0 ? {} : { after: Math.min(...prices) }),
      group: `new|${product}`,
    })
  }

  // 下架：只在读全了的那一次数「没读到」，连续两次才算
  const goneNow = new Map<string, CatalogStateRow[]>()
  for (const [key, p] of prevRows) {
    if (current.has(key)) continue
    if (!complete || p.removed === true) {
      nextRows.push(p)
      continue
    }
    const missing = p.missing + 1
    if (missing >= COMPETITOR_REMOVED_AFTER_MISSES) {
      nextRows.push({ ...p, missing, removed: true })
      goneNow.set(p.product_key, [...(goneNow.get(p.product_key) ?? []), p])
    } else nextRows.push({ ...p, missing })
  }
  const stillThere = new Set([...current.values()].map((r) => r.product_key))
  for (const [product, rows] of goneNow) {
    // 只有整个商品都不见了才出一条「下架」（少了一个款式不算）
    if (stillThere.has(product)) continue
    const stillPending = nextRows.some(
      (r) => r.product_key === product && r.removed !== true && !current.has(rowKey(r)),
    )
    if (stillPending) continue
    entries.push({ kind: 'removed', row: rows[0] as CatalogStateRow, group: `removed|${product}` })
  }

  return {
    snapshot: { ...base, rows: nextRows },
    changes: merge(entries, input),
    baseline: false,
  }
}

/** 同一行前后两次比：价、打折、有没有货、Amazon 三项、优惠券。 */
function compareRow(p: CatalogSnapshotRow, row: CatalogSnapshotRow): Entry[] {
  const out: Entry[] = []
  const pk = row.product_key
  const priceMoved =
    p.price !== undefined && row.price !== undefined && !samePrice(p.price, row.price)
  const pricePct =
    priceMoved && p.price !== undefined && row.price !== undefined
      ? pctChange(p.price, row.price)
      : undefined
  // WP394：任一边划线价没读到（云端那一路）就不判打折起止，只看价本身
  const saleKnown = !unread(p, 'compare_at_price') && !unread(row, 'compare_at_price')
  if (saleKnown && onSale(p) !== onSale(row)) {
    // 打折开始 / 结束本身就说明了价怎么变的：这一行不再另出一条「改价」。
    // 幅度：价真变了就是价的涨跌；价没变（只是加 / 去了划线价）就是划线价和现价差几成。
    const start = onSale(row)
    const r = start ? row : p
    const depth =
      r.price !== undefined && r.compare_at_price !== undefined
        ? pctChange(r.compare_at_price, r.price)
        : undefined
    const pct = pricePct ?? depth
    out.push({
      kind: start ? 'discount_start' : 'discount_end',
      prev: p,
      row,
      before: p.price ?? null,
      after: row.price ?? null,
      ...(pct === undefined ? {} : { pct }),
      group: `${start ? 'discount_start' : 'discount_end'}|${pk}`,
    })
  } else if (priceMoved)
    out.push({
      kind: 'price',
      prev: p,
      row,
      before: p.price ?? null,
      after: row.price ?? null,
      ...(pricePct === undefined ? {} : { pct: pricePct }),
      group: `price|${pk}`,
    })
  const couponBefore = p.coupon?.trim() || undefined
  const couponAfter = row.coupon?.trim() || undefined
  if (
    !unread(p, 'coupon') &&
    !unread(row, 'coupon') &&
    (couponBefore === undefined) !== (couponAfter === undefined)
  ) {
    const start = couponAfter !== undefined
    out.push({
      kind: start ? 'discount_start' : 'discount_end',
      prev: p,
      row,
      before: couponBefore ?? null,
      after: couponAfter ?? null,
      category: 'coupon',
      group: `${start ? 'discount_start' : 'discount_end'}|coupon|${pk}|${row.variant_key ?? ''}`,
    })
  }
  if (p.available !== undefined && row.available !== undefined && p.available !== row.available)
    out.push({
      kind: row.available ? 'back_in_stock' : 'out_of_stock',
      prev: p,
      row,
      before: p.available,
      after: row.available,
      group: `${row.available ? 'back' : 'out'}|${pk}`,
    })
  if (p.rating !== undefined && row.rating !== undefined && round1(p.rating) !== round1(row.rating))
    out.push({
      kind: 'rating',
      prev: p,
      row,
      before: round1(p.rating),
      after: round1(row.rating),
      group: `rating|${pk}|${row.variant_key ?? ''}`,
    })
  if (p.reviews !== undefined && row.reviews !== undefined && p.reviews !== row.reviews) {
    const pct = pctChange(p.reviews, row.reviews)
    out.push({
      kind: 'reviews',
      prev: p,
      row,
      before: p.reviews,
      after: row.reviews,
      ...(pct === undefined ? {} : { pct }),
      group: `reviews|${pk}|${row.variant_key ?? ''}`,
    })
  }
  for (const b of row.bsr ?? []) {
    const was = p.bsr?.find((x) => x.category === b.category)
    if (was === undefined || was.rank === b.rank) continue
    const pct = pctChange(was.rank, b.rank)
    out.push({
      kind: 'bsr',
      prev: p,
      row,
      before: was.rank,
      after: b.rank,
      ...(pct === undefined ? {} : { pct }),
      category: b.category,
      group: `bsr|${pk}|${row.variant_key ?? ''}|${b.category}`,
    })
  }
  return out
}

/** 同一商品同一种类的几条合成一条（「3 个款式降价 10%–15%」）。 */
function merge(entries: Entry[], input: CatalogDiffInput): CompetitorChange[] {
  const groups = new Map<string, Entry[]>()
  for (const e of entries) groups.set(e.group, [...(groups.get(e.group) ?? []), e])
  const out: CompetitorChange[] = []
  for (const list of groups.values()) {
    // 变得最多的那一款当代表（前后值、幅度用它的）
    const lead = [...list].sort((a, b) => Math.abs(b.pct ?? 0) - Math.abs(a.pct ?? 0))[0] as Entry
    const row = lead.row
    const pcts = list.map((e) => e.pct).filter((n): n is number => n !== undefined)
    const variants = new Set(list.map((e) => e.row.variant_key ?? ''))
    const change: CompetitorChange = {
      id: competitorChangeId([input.source.id, lead.group, input.now]),
      workspace_id: input.workspace_id,
      kind: lead.kind,
      competitor_id: input.source.competitor_id,
      competitor: input.competitor,
      source_id: input.source.id,
      source_kind: input.source.kind,
      product_key: row.product_key,
      title: row.title,
      detected_at: input.now,
    }
    const keys = list.map((e) => e.row.variant_key).filter((k): k is string => k !== undefined)
    if (keys.length > 0) change.variant_keys = [...new Set(keys)]
    if (variants.size >= 2) change.variants = variants.size
    if (row.url !== undefined) change.url = row.url
    if (row.image !== undefined) change.image = row.image
    if (lead.before !== undefined) change.before = lead.before
    if (lead.after !== undefined) change.after = lead.after
    if (lead.pct !== undefined) change.pct = lead.pct
    if (pcts.length >= 2 && Math.min(...pcts) !== Math.max(...pcts))
      change.pct_range = [Math.min(...pcts), Math.max(...pcts)]
    if (lead.category !== undefined) change.category = lead.category
    if (row.currency !== undefined) change.currency = row.currency
    const vs = vsOwnOf(lead, input)
    if (vs !== undefined) change.vs_own = vs
    out.push(change)
  }
  return out.sort(
    (a, b) => a.competitor.localeCompare(b.competitor) || a.title.localeCompare(b.title),
  )
}

/** C8：和自家对标款比差价（价有关的几种才比；币种不一样不比）。 */
function vsOwnOf(e: Entry, input: CatalogDiffInput): CompetitorVsOwn | undefined {
  if (input.ownRef === undefined) return undefined
  if (!['price', 'discount_start', 'discount_end', 'new'].includes(e.kind)) return undefined
  const price = e.row.price
  if (price === undefined) return undefined
  const own = input.ownRef(e.row)
  if (own === undefined) return undefined
  if (own.currency !== undefined && e.row.currency !== undefined && own.currency !== e.row.currency)
    return undefined
  return {
    own_key: own.own_key,
    ...(own.own_title === undefined ? {} : { own_title: own.own_title }),
    own_price: own.own_price,
    diff: round2(price - own.own_price),
    ...((own.currency ?? e.row.currency) === undefined
      ? {}
      : { currency: (own.currency ?? e.row.currency) as string }),
  }
}
