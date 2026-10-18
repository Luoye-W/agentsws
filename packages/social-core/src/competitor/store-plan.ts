/**
 * WP393（docs/104 C5 / C8）：店铺管理「竞品动向」的三样纯函数——服务进程、工作台日报、模拟世界共用一份：
 *
 * - **哪条算重要**（{@link isImportantChange}）：只按用户在方案卡上确认过的规则判；没有确认过的方案 = 一条都不算
 *   （C5：不预设规矩，简报这一段就不出）；
 * - **简报那一段**（{@link competitorBriefSection}）：有重要变化或有哪家没读到才出，没有就不出（docs/96 P3）；
 * - **对标款**（{@link suggestPairs} / {@link ownRefFromPairs}）：AI 没回话时的规则版——按标题词和价位给竞品款配一款自家款，
 *   人在方案卡上改过的（`by: 'user'`）不动；比价只在两边币种一样时才比。
 */
import type {
  CatalogSnapshotRow,
  CompetitorChange,
  CompetitorImportanceRules,
  CompetitorProductPair,
  OwnShopProduct,
} from '@agentsws/contracts'
import type { OwnRef } from './diff.js'
import { describeChange } from './query.js'

/* ── 哪条算重要 ──────────────────────────────────────────────────── */

/** 一条变化按用户确认过的规则算不算重要（`rules` 没给 = 没确认过 = 都不算）。 */
export function isImportantChange(
  c: CompetitorChange,
  rules: CompetitorImportanceRules | undefined,
): boolean {
  if (rules === undefined) return false
  switch (c.kind) {
    case 'price': {
      const pcts = [c.pct, ...(c.pct_range ?? [])].filter((n): n is number => n !== undefined)
      const drop = pcts.length === 0 ? 0 : -Math.min(...pcts)
      if (drop <= 0) return false
      if (rules.price_drop_pct !== undefined && drop >= rules.price_drop_pct) return true
      return rules.cheaper_than_own === true && c.vs_own !== undefined && c.vs_own.diff < 0
    }
    case 'new':
      return rules.new_products === true
    case 'discount_start':
      return rules.discounts === true
    case 'out_of_stock':
    case 'back_in_stock':
      return rules.stock === true
    case 'removed':
      return rules.removed === true
    default:
      return false
  }
}

/* ── 简报那一段 ──────────────────────────────────────────────────── */

export interface CompetitorBriefSection {
  /** 段名（「竞品动向」）。 */
  title: string
  /** 一条重要变化一句（带竞品名、和自家比的差价）。 */
  lines: string[]
  /** 没读到的那几家（「Aventon 这次没读到」）。 */
  failed: string[]
  /** 重要变化一共几条（`lines` 最多列 `max` 条）。 */
  important: number
}

/**
 * 简报里的「竞品动向」：方案没确认过 → 不出；有重要变化或有哪家没读到才出，没有就不出。
 * `failed` 是这一轮没读到的竞品名（照实写，不显示成 0）。
 */
export function competitorBriefSection(input: {
  changes: readonly CompetitorChange[]
  rules: CompetitorImportanceRules | undefined
  failed?: readonly string[]
  lang?: 'zh' | 'en'
  max?: number
}): CompetitorBriefSection | undefined {
  if (input.rules === undefined) return undefined
  const en = input.lang === 'en'
  const important = input.changes.filter((c) => isImportantChange(c, input.rules))
  const failed = [...new Set(input.failed ?? [])]
  if (important.length === 0 && failed.length === 0) return undefined
  const max = input.max ?? 5
  const lines = important
    .slice(0, max)
    .map((c) => describeChange(c, { withCompetitor: true, ...(en ? { lang: 'en' as const } : {}) }))
  if (important.length > max)
    lines.push(en ? `…and ${important.length - max} more` : `…还有 ${important.length - max} 条`)
  return {
    title: en ? 'Competitor moves' : '竞品动向',
    lines,
    failed: failed.map((n) => (en ? `${n}: couldn't read this time` : `${n} 这次没读到`)),
    important: important.length,
  }
}

/* ── 对标款 ──────────────────────────────────────────────────────── */

const STOP = new Set([
  'the',
  'and',
  'with',
  'for',
  'new',
  'by',
  'of',
  'in',
  'a',
  'an',
  'edition',
  'version',
  'v2',
  'v3',
])

/** 标题 → 词（小写、去品牌名与虚词）。 */
export function titleTokens(title: string, drop: readonly string[] = []): Set<string> {
  const skip = new Set([
    ...STOP,
    ...drop.flatMap((d) => d.toLowerCase().split(/[^\p{L}\p{N}]+/u)).filter((x) => x !== ''),
  ])
  return new Set(
    title
      .normalize('NFKC')
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((t) => t.length >= 2 && !skip.has(t)),
  )
}

const jaccard = (a: Set<string>, b: Set<string>): number => {
  if (a.size === 0 || b.size === 0) return 0
  let both = 0
  for (const x of a) if (b.has(x)) both += 1
  return both / (a.size + b.size - both)
}

const priceSim = (a: number | undefined, b: number | undefined): number =>
  a === undefined || b === undefined || a <= 0 || b <= 0 ? 0 : 1 - Math.abs(a - b) / Math.max(a, b)

/** 一个竞品商品（多个款式合成一件：取最低价）。 */
interface RivalProduct {
  competitor_id: string
  product_key: string
  title: string
  price?: number
  currency?: string
}

/** 快照行 → 一件一行（同一商品多个款式取最低价）。 */
export function productsOfRows(rows: readonly CatalogSnapshotRow[]): RivalProduct[] {
  const out = new Map<string, RivalProduct>()
  for (const r of rows) {
    const k = `${r.competitor_id}|${r.product_key}`
    const cur = out.get(k)
    const price =
      cur?.price === undefined
        ? r.price
        : r.price === undefined
          ? cur.price
          : Math.min(cur.price, r.price)
    out.set(k, {
      competitor_id: r.competitor_id,
      product_key: r.product_key,
      title: cur?.title ?? r.title,
      ...(price === undefined ? {} : { price }),
      ...((cur?.currency ?? r.currency) === undefined
        ? {}
        : { currency: cur?.currency ?? r.currency }),
    })
  }
  return [...out.values()]
}

/**
 * 规则版对标（AI 没回话时用；也是 AI 回话后的兜底校验）：每一款自家商品、在每一家竞品里找**一款**最像的——
 * 标题词重合（去掉两边品牌名）+ 价位接近（差不到四成）。人改过的（`by: 'user'`）原样留着、那一款竞品不再配。
 */
export function suggestPairs(input: {
  rivals: readonly { competitor_id: string; name: string; rows: readonly CatalogSnapshotRow[] }[]
  own: readonly OwnShopProduct[]
  own_brand: string
  keep?: readonly CompetitorProductPair[]
}): CompetitorProductPair[] {
  const kept = (input.keep ?? []).filter((p) => p.by === 'user')
  const taken = new Set(kept.map((p) => `${p.competitor_id}|${p.product_key}`))
  const out: CompetitorProductPair[] = [...kept]
  for (const rival of input.rivals) {
    const products = productsOfRows(rival.rows).filter(
      (p) => !taken.has(`${p.competitor_id}|${p.product_key}`),
    )
    // 每一款竞品只配一款自家的（分最高的那一对）
    const best = new Map<string, { own: OwnShopProduct; score: number }>()
    for (const mine of input.own) {
      const ownTokens = titleTokens(mine.title, [input.own_brand])
      let top: { p: RivalProduct; score: number } | undefined
      for (const p of products) {
        if (mine.currency !== undefined && p.currency !== undefined && mine.currency !== p.currency)
          continue
        const ps = priceSim(p.price, mine.price)
        const ts = jaccard(ownTokens, titleTokens(p.title, [rival.name]))
        if (ps < 0.6 || (ts === 0 && ps < 0.9)) continue
        const score = ts * 0.5 + ps * 0.5
        if (top === undefined || score > top.score) top = { p, score }
      }
      if (top === undefined) continue
      const cur = best.get(top.p.product_key)
      if (cur === undefined || top.score > cur.score)
        best.set(top.p.product_key, { own: mine, score: top.score })
    }
    for (const p of products) {
      const b = best.get(p.product_key)
      if (b === undefined) continue
      out.push({
        competitor_id: rival.competitor_id,
        product_key: p.product_key,
        title: p.title,
        own_key: b.own.key,
        own_title: b.own.title,
        by: 'ai',
      })
    }
  }
  return out
}

/** 对标款 + 自家商品 → 比价口（C8）：自家那一款读得到价、两边币种一样才比。 */
export function ownRefFromPairs(
  pairs: readonly CompetitorProductPair[],
  own: readonly OwnShopProduct[],
): ((row: CatalogSnapshotRow) => OwnRef | undefined) | undefined {
  if (pairs.length === 0 || own.length === 0) return undefined
  const byKey = new Map(own.map((o) => [o.key.toLowerCase(), o]))
  const byPair = new Map(pairs.map((p) => [`${p.competitor_id}|${p.product_key}`, p]))
  return (row) => {
    const pair = byPair.get(`${row.competitor_id}|${row.product_key}`)
    const mine = pair === undefined ? undefined : byKey.get(pair.own_key.toLowerCase())
    if (mine?.price === undefined) return undefined
    if (mine.currency !== undefined && row.currency !== undefined && mine.currency !== row.currency)
      return undefined
    return {
      own_key: mine.key,
      own_title: mine.title,
      own_price: mine.price,
      ...((mine.currency ?? row.currency) === undefined
        ? {}
        : { currency: mine.currency ?? row.currency }),
    }
  }
}

/* ── 方案卡上那一格（一行一对：「竞品 · 款 = 你的款」）──────────────── */

const PAIR_SPLIT = /[；;\n]/u
const PAIR_ARROW = /\s*(?:=|→|->|⇒|对标)\s*/u

/** 对标款 → 卡上那一串。 */
export function formatPairs(
  pairs: readonly CompetitorProductPair[],
  names: ReadonlyMap<string, string>,
): string {
  return pairs
    .map((p) => {
      const who = names.get(p.competitor_id)
      const left = `${who === undefined ? '' : `${who} · `}${p.title ?? p.product_key}`
      return `${left} = ${p.own_title ?? p.own_key}`
    })
    .join('；')
}

const norm = (s: string): string => s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()

/**
 * 人改过的那一串 → 对标款。左边认竞品款（`竞品 · 标题` 或只写标题），右边认自家款（标题或 handle）；
 * 认不出的那几对原样回在 `bad` 里（卡上照实说）。
 */
export function parsePairs(
  text: string,
  catalog: {
    rivals: readonly { competitor_id: string; name: string; rows: readonly CatalogSnapshotRow[] }[]
    own: readonly OwnShopProduct[]
  },
): { pairs: CompetitorProductPair[]; bad: string[] } {
  const pairs: CompetitorProductPair[] = []
  const bad: string[] = []
  const products = catalog.rivals.flatMap((r) =>
    productsOfRows(r.rows).map((p) => ({ ...p, name: r.name })),
  )
  for (const raw of text.split(PAIR_SPLIT)) {
    const item = raw.trim()
    if (item === '') continue
    const [l, r] = item.split(PAIR_ARROW)
    if (l === undefined || r === undefined || l.trim() === '' || r.trim() === '') {
      bad.push(item)
      continue
    }
    const left = norm(l)
    const right = norm(r)
    const rival =
      products.find((p) => norm(`${p.name} · ${p.title}`) === left) ??
      products.find((p) => norm(p.title) === left || norm(`${p.name} ${p.title}`) === left) ??
      products.find((p) => left.endsWith(norm(p.title)))
    const mine =
      catalog.own.find((o) => norm(o.title) === right || o.key.toLowerCase() === right) ??
      catalog.own.find((o) => norm(o.title).includes(right))
    if (rival === undefined || mine === undefined) {
      bad.push(item)
      continue
    }
    pairs.push({
      competitor_id: rival.competitor_id,
      product_key: rival.product_key,
      title: rival.title,
      own_key: mine.key,
      own_title: mine.title,
      by: 'user',
    })
  }
  return { pairs, bad }
}
