/**
 * WP392（docs/104 §3.5）：竞品变化表的纯计算——一句人话、按条件筛、出参白名单、变成报告积木的通用条目。
 *
 * - {@link describeChange}：一条变化的一句人话（变化表、报告条目、简报都读它）；不提任何数据供应商名；
 * - {@link queryCompetitorChanges}：`list_competitor_changes` 工具与面板共用的筛选 + 计数；
 *   出参只有**计数、标题、链接、前后值、幅度、时间**（白名单），不带图、不带内部键；
 * - {@link watchItemOfChange}：一条变化 → 报告积木的 `WatchItem`（`kind: 'change'`，`platform: 'competitor'`）。
 */
import {
  COMPETITOR_CHANGE_KIND_LABELS,
  COMPETITOR_CHANGE_KINDS,
  type CompetitorChange,
  type CompetitorChangeKind,
  type CompetitorChangeValue,
  type CompetitorSourceKind,
  type Iso8601,
  type WatchItem,
} from '@agentsws/contracts'

/** 报告积木里竞品变化那一份的平台名。 */
export const COMPETITOR_WATCH_PLATFORM = 'competitor'

const SYMBOL: Readonly<Record<string, string>> = {
  USD: '$',
  EUR: '€',
  GBP: '£',
  JPY: '¥',
  CNY: '¥',
  CAD: 'CA$',
  AUD: 'A$',
}

/** 钱的写法（`$1,599`、`1,599 SEK`）。 */
export function formatMoney(n: number, currency?: string): string {
  const digits = Number.isInteger(n) ? 0 : 2
  const num = Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
  const sign = n < 0 ? '-' : ''
  const sym = currency === undefined ? undefined : SYMBOL[currency.toUpperCase()]
  if (sym !== undefined) return `${sign}${sym}${num}`
  return currency === undefined ? `${sign}${num}` : `${sign}${num} ${currency.toUpperCase()}`
}

const pctText = (p: number): string => `${Math.abs(p)}%`

const rangeText = (c: CompetitorChange): string | undefined => {
  if (c.pct_range !== undefined) {
    const [a, b] = c.pct_range
    // 同向才写成「10%–15%」；一涨一跌就写变得最多的那一款
    if (Math.sign(a) === Math.sign(b)) {
      const lo = Math.min(Math.abs(a), Math.abs(b))
      const hi = Math.max(Math.abs(a), Math.abs(b))
      return `${lo}%–${hi}%`
    }
  }
  return c.pct === undefined ? undefined : pctText(c.pct)
}

const money = (v: CompetitorChangeValue | undefined, cur?: string): string | undefined =>
  typeof v === 'number' ? formatMoney(v, cur) : undefined

/** 一条变化的一句人话（不带竞品名；要带用 `withCompetitor`）。 */
export function describeChange(
  c: CompetitorChange,
  options: { lang?: 'zh' | 'en'; withCompetitor?: boolean } = {},
): string {
  const en = options.lang === 'en'
  const who = options.withCompetitor === true ? `${c.competitor} · ` : ''
  const n = c.variants !== undefined && c.variants >= 2 ? c.variants : undefined
  const subject =
    n === undefined ? c.title : en ? `${c.title} (${n} variants)` : `${c.title}（${n} 个款式）`
  const b = money(c.before, c.currency)
  const a = money(c.after, c.currency)
  const fromTo = b !== undefined && a !== undefined ? `${b} → ${a}` : undefined
  const r = rangeText(c)
  let line: string
  switch (c.kind) {
    case 'price': {
      const down = (c.pct ?? 0) < 0
      line = en
        ? `${subject}: price ${down ? 'down' : 'up'}${r === undefined ? '' : ` ${r}`}${fromTo === undefined ? '' : ` (${fromTo})`}`
        : `${subject}：${down ? '降价' : '涨价'}${r ?? ''}${fromTo === undefined ? '' : `（${fromTo}）`}`
      break
    }
    case 'discount_start':
    case 'discount_end': {
      const start = c.kind === 'discount_start'
      if (c.category === 'coupon') {
        const text = String((start ? c.after : c.before) ?? '')
        line = en
          ? `${subject}: coupon ${start ? 'added' : 'removed'}${text === '' ? '' : ` "${text}"`}`
          : `${subject}：优惠券${start ? '上了' : '没了'}${text === '' ? '' : `「${text}」`}`
      } else
        line = en
          ? `${subject}: sale ${start ? 'started' : 'ended'}${fromTo === undefined ? '' : ` (${fromTo})`}`
          : `${subject}：${start ? '开始打折' : '打折结束'}${fromTo === undefined ? '' : `（${fromTo}）`}`
      break
    }
    case 'new':
      line = en
        ? `New: ${subject}${a === undefined ? '' : ` at ${a}`}`
        : `上新：${subject}${a === undefined ? '' : `，${a}`}`
      break
    case 'removed':
      line = en ? `Removed: ${subject}` : `下架：${subject}`
      break
    case 'out_of_stock':
      line = en ? `${subject}: out of stock` : `${subject}：断货`
      break
    case 'back_in_stock':
      line = en ? `${subject}: back in stock` : `${subject}：补货了`
      break
    case 'rating':
      line = en
        ? `${subject}: rating ${String(c.before)} → ${String(c.after)}`
        : `${subject}：评分 ${String(c.before)} → ${String(c.after)}`
      break
    case 'reviews': {
      const d = Number(c.after) - Number(c.before)
      line = en
        ? `${subject}: reviews ${String(c.before)} → ${String(c.after)} (${d >= 0 ? '+' : ''}${d})`
        : `${subject}：评论数 ${String(c.before)} → ${String(c.after)}（${d >= 0 ? '+' : ''}${d}）`
      break
    }
    case 'bsr':
      line = en
        ? `${subject}: #${String(c.before)} → #${String(c.after)}${c.category === undefined ? '' : ` in ${c.category}`}`
        : `${subject}：${c.category === undefined ? '' : `${c.category} `}排名 ${String(c.before)} → ${String(c.after)}`
      break
  }
  const vs = c.vs_own
  if (vs !== undefined && vs.diff !== 0) {
    const d = formatMoney(Math.abs(vs.diff), vs.currency ?? c.currency)
    const own = vs.own_title ?? vs.own_key
    line += en
      ? `; ${d} ${vs.diff < 0 ? 'cheaper' : 'pricier'} than your ${own}`
      : `，比你的 ${own} ${vs.diff < 0 ? '便宜' : '贵'} ${d}`
  }
  return `${who}${line}`
}

/** 查变化表的条件（工具入参解析后的样子）。 */
export interface CompetitorChangeFilter {
  /** 竞品 id 或名字（不分大小写）。 */
  competitor?: string
  kinds?: CompetitorChangeKind[]
  source_kind?: CompetitorSourceKind
  source_id?: string
}

/** 出参白名单里的一行。 */
export interface CompetitorChangeLine {
  kind: CompetitorChangeKind
  kind_label: string
  competitor: string
  title: string
  url?: string
  before?: CompetitorChangeValue
  after?: CompetitorChangeValue
  pct?: number
  pct_range?: [number, number]
  variants?: number
  category?: string
  currency?: string
  /** 和自家对标款差多少（负数 = 他比你便宜）。 */
  vs_own_diff?: number
  vs_own?: string
  at: Iso8601
  /** 一句人话。 */
  text: string
}

export interface CompetitorChangeQueryResult {
  totals: {
    changes: number
    by_kind: Partial<Record<CompetitorChangeKind, number>>
    by_competitor: Record<string, number>
  }
  items: CompetitorChangeLine[]
  /** 多于 `limit` 没列出来的。 */
  more: number
}

/** 解析种类入参（认得的才留）。 */
export function parseChangeKinds(v: unknown): CompetitorChangeKind[] | undefined {
  const raw = Array.isArray(v) ? v : typeof v === 'string' ? [v] : []
  const out = raw.filter((k): k is CompetitorChangeKind =>
    (COMPETITOR_CHANGE_KINDS as readonly unknown[]).includes(k),
  )
  return out.length === 0 ? undefined : [...new Set(out)]
}

/** 筛、数、列（新的在前）。 */
export function queryCompetitorChanges(input: {
  changes: readonly CompetitorChange[]
  window?: { since: Iso8601; until: Iso8601 }
  filter?: CompetitorChangeFilter
  limit?: number
  lang?: 'zh' | 'en'
}): CompetitorChangeQueryResult {
  const f = input.filter ?? {}
  const who = f.competitor?.trim().toLowerCase()
  const lo = input.window === undefined ? undefined : Date.parse(input.window.since)
  const hi = input.window === undefined ? undefined : Date.parse(input.window.until)
  const hits = input.changes
    .filter((c) => {
      const t = Date.parse(c.detected_at)
      if (lo !== undefined && hi !== undefined && !(t >= lo && t <= hi)) return false
      if (
        who !== undefined &&
        who !== '' &&
        c.competitor_id.toLowerCase() !== who &&
        c.competitor.toLowerCase() !== who
      )
        return false
      if (f.kinds !== undefined && f.kinds.length > 0 && !f.kinds.includes(c.kind)) return false
      if (f.source_kind !== undefined && c.source_kind !== f.source_kind) return false
      if (f.source_id !== undefined && c.source_id !== f.source_id) return false
      return true
    })
    .sort((a, b) => b.detected_at.localeCompare(a.detected_at) || a.title.localeCompare(b.title))
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200)
  const by_kind: Partial<Record<CompetitorChangeKind, number>> = {}
  const by_competitor: Record<string, number> = {}
  for (const c of hits) {
    by_kind[c.kind] = (by_kind[c.kind] ?? 0) + 1
    by_competitor[c.competitor] = (by_competitor[c.competitor] ?? 0) + 1
  }
  const lang = input.lang ?? 'zh'
  return {
    totals: { changes: hits.length, by_kind, by_competitor },
    items: hits.slice(0, limit).map((c) => lineOf(c, lang)),
    more: Math.max(0, hits.length - limit),
  }
}

function lineOf(c: CompetitorChange, lang: 'zh' | 'en'): CompetitorChangeLine {
  const line: CompetitorChangeLine = {
    kind: c.kind,
    kind_label: COMPETITOR_CHANGE_KIND_LABELS[c.kind][lang],
    competitor: c.competitor,
    title: c.title,
    at: c.detected_at,
    text: describeChange(c, { lang }),
  }
  if (c.url !== undefined) line.url = c.url
  if (c.before !== undefined) line.before = c.before
  if (c.after !== undefined) line.after = c.after
  if (c.pct !== undefined) line.pct = c.pct
  if (c.pct_range !== undefined) line.pct_range = c.pct_range
  if (c.variants !== undefined) line.variants = c.variants
  if (c.category !== undefined) line.category = c.category
  if (c.currency !== undefined) line.currency = c.currency
  if (c.vs_own !== undefined) {
    line.vs_own_diff = c.vs_own.diff
    line.vs_own = c.vs_own.own_title ?? c.vs_own.own_key
  }
  return line
}

/** 一条变化 → 报告积木的通用条目（外部、地点 = 竞品名、时间 = 发现时间）。 */
export function watchItemOfChange(c: CompetitorChange): WatchItem {
  const item: WatchItem = {
    id: c.id,
    platform: COMPETITOR_WATCH_PLATFORM,
    kind: 'change',
    scope: 'external',
    place: c.competitor,
    created_at: c.detected_at,
    url: c.url ?? '',
    title: c.title,
    text: describeChange(c),
    topic: {
      key: `competitor:${c.competitor_id}`,
      label: `竞品：${c.competitor}`,
    },
    change: c,
  }
  return item
}
