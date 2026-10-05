/**
 * WP224（docs/91 §2.2 #3）：**盈亏线**——按毛利率算的那条 ROAS 线，以及它与现在那条
 * 固定止损线的对照。
 *
 * 一句话：毛利 40% 的货，广告每花 1 块要卖回 2.5 块才不亏（盈亏线 ROAS = 1 / 毛利率）。
 * 现在的自动止损线是固定的「ROAS < 1」（57 §6），于是 ROAS 落在 1 到 2.5 之间那一段——
 * 一直在亏钱——不会报警。
 *
 * 三条纪律：
 *
 * 1. **只显示，不改止损。** 这里没有一个函数会去动 `stop_loss_roas_below`；
 *    `compareLines` 算的是「换成盈亏线的话会不会停」，结论只进对照表（Luoye 10-05：先并排两周再定）。
 * 2. **没填毛利率就是没填。** 毛利率缺 → 盈亏线缺 → 那一格写「没填毛利率」；
 *    不拿 1、不拿行业平均、不拿上一次的数顶上。
 * 3. **小的盖大的**：SKU 那一格盖品类、品类盖品牌（`resolveGrossMargin`）。
 *
 * 纯函数：无 IO、无时钟、无随机。
 */
import type {
  AdsCaps,
  AdsLineCompareRow,
  AdsLineCompareView,
  BreakEvenView,
  GrossMarginEntry,
  LineOutcome,
} from '@agentsws/contracts'
import { GROSS_MARGIN_FILL_PATH } from '@agentsws/contracts'
import { stopLossVerdict } from './budget.js'

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100

/** 一个能用的毛利率：大于 0、不超过 100。别的（负毛利、填错成 4000）一律当没填。 */
export function isUsableMargin(margin_pct: number | undefined): margin_pct is number {
  return (
    margin_pct !== undefined && Number.isFinite(margin_pct) && margin_pct > 0 && margin_pct <= 100
  )
}

/** 盈亏线 ROAS = 1 / 毛利率（毛利率是百分数：40 → 2.5）。毛利率不能用就没有。 */
export function breakEvenRoas(margin_pct: number | undefined): number | undefined {
  return isUsableMargin(margin_pct) ? round2(100 / margin_pct) : undefined
}

/** 找这一件货该用哪一格毛利率：SKU → 品类 → 品牌。都没有就 `undefined`。 */
export function resolveGrossMargin(
  entries: readonly GrossMarginEntry[],
  target: { sku?: string; category?: string } = {},
): GrossMarginEntry | undefined {
  const usable = entries.filter((e) => isUsableMargin(e.margin_pct))
  const norm = (s: string | undefined): string => (s ?? '').trim().toLowerCase()
  if (target.sku !== undefined) {
    const hit = usable.find((e) => e.scope === 'sku' && norm(e.key) === norm(target.sku))
    if (hit !== undefined) return hit
  }
  if (target.category !== undefined) {
    const hit = usable.find((e) => e.scope === 'category' && norm(e.key) === norm(target.category))
    if (hit !== undefined) return hit
  }
  return usable.find((e) => e.scope === 'brand')
}

/** 卡面 / 日报上 ROAS 旁边那一格。 */
export function breakEvenView(margin_pct: number | undefined): BreakEvenView {
  const line = breakEvenRoas(margin_pct)
  if (line === undefined || margin_pct === undefined)
    return { note: '没填毛利率', fill_url: GROSS_MARGIN_FILL_PATH }
  return {
    margin_pct,
    break_even_roas: line,
    note: `盈亏线 ROAS ${line}（毛利率 ${margin_pct}%）`,
  }
}

/**
 * 高于现在的止损线、低于盈亏线——「在亏钱但不会被停」的那一段。
 *
 * 只用来在 campaign 旁边标一个提示图标（不自动停、不出新卡）。缺任何一个数都不标。
 */
export function betweenLines(
  roas: number | undefined,
  break_even: number | undefined,
  fixed_line = 1,
): boolean {
  if (roas === undefined || break_even === undefined) return false
  return roas >= fixed_line && roas < break_even
}

/**
 * 同一条 campaign 同一天，两条线各自会不会停。
 *
 * 花费那一条判据（占日预算的百分比）两边一样，只换 ROAS 那条线——比的就是线本身。
 */
export function compareLines(input: {
  roas?: number
  spend?: number
  daily_budget?: number
  caps?: Partial<AdsCaps>
  margin_pct?: number
}): {
  fixed: Exclude<LineOutcome, 'no_margin'>
  break_even: LineOutcome
  break_even_roas?: number
} {
  const metrics = {
    ...(input.roas === undefined ? {} : { roas: input.roas }),
    ...(input.spend === undefined ? {} : { spend: input.spend }),
    ...(input.daily_budget === undefined ? {} : { daily_budget: input.daily_budget }),
  }
  const fixed = stopLossVerdict({
    ...metrics,
    ...(input.caps === undefined ? {} : { caps: input.caps }),
  })
  const line = breakEvenRoas(input.margin_pct)
  if (line === undefined) return { fixed: fixed.outcome, break_even: 'no_margin' }
  const shadow = stopLossVerdict({
    ...metrics,
    caps: { ...(input.caps ?? {}), stop_loss_roas_below: line },
  })
  return { fixed: fixed.outcome, break_even: shadow.outcome, break_even_roas: line }
}

/** 对照表要记满几天（Luoye 10-05：两周）。 */
export const LINE_COMPARE_DAYS = 14

/**
 * 把逐日的对照行汇成那张表：按 campaign，两条线各会停几天。
 *
 * `started_on` 是第一行的日期（合并之后第一次记）；满 14 个不同的日子算「够两周了」。
 */
export function summarizeLineCompare(
  rows: readonly AdsLineCompareRow[],
  days = LINE_COMPARE_DAYS,
): AdsLineCompareView {
  const sorted = [...rows].sort((a, b) =>
    a.date === b.date ? a.campaign_id.localeCompare(b.campaign_id) : a.date.localeCompare(b.date),
  )
  const dates = [...new Set(sorted.map((r) => r.date))]
  const window = new Set(dates.slice(0, days))
  const inWindow = sorted.filter((r) => window.has(r.date))
  const by = new Map<string, AdsLineCompareView['summary'][number]>()
  for (const r of inWindow) {
    const s = by.get(r.campaign_id) ?? {
      campaign_id: r.campaign_id,
      platform: r.platform,
      name: r.name,
      days: 0,
      fixed_stop_days: 0,
      break_even_stop_days: 0,
      only_break_even_days: 0,
      no_margin_days: 0,
    }
    s.days += 1
    if (r.fixed === 'trigger') s.fixed_stop_days += 1
    if (r.break_even === 'trigger') s.break_even_stop_days += 1
    if (r.break_even === 'trigger' && r.fixed !== 'trigger') s.only_break_even_days += 1
    if (r.break_even === 'no_margin') s.no_margin_days += 1
    by.set(r.campaign_id, s)
  }
  return {
    ...(dates[0] === undefined ? {} : { started_on: dates[0] }),
    days: window.size,
    complete: window.size >= days,
    rows: inWindow,
    summary: [...by.values()].sort(
      (a, b) => b.only_break_even_days - a.only_break_even_days || a.name.localeCompare(b.name),
    ),
  }
}

/* ── 毛利瀑布（`unit-economics` 技能那张表的算式） ─────────────────── */

/** 一件货从售价扣到毛利的八项成本（docs/91 §2.2 #3 那张清单，顺序即瀑布的顺序）。 */
export const COST_ITEMS = [
  { key: 'procurement', zh: '采购' },
  { key: 'first_mile', zh: '头程' },
  { key: 'storage', zh: '仓储' },
  { key: 'platform_fee', zh: '平台佣金' },
  { key: 'ads', zh: '广告' },
  { key: 'last_mile', zh: '尾程' },
  { key: 'returns', zh: '退货损耗' },
  { key: 'fx', zh: '汇率' },
] as const

export type CostItemKey = (typeof COST_ITEMS)[number]['key']

export interface MarginWaterfall {
  price: number
  steps: { key: CostItemKey; zh: string; amount?: number; left_after?: number }[]
  /** 八项里哪几项没给数（瀑布照样出，但这几项要在卡上明说「没算」）。 */
  missing: CostItemKey[]
  /** 落地成本（给了数的那几项加起来）。 */
  landed_cost: number
  margin: number
  /** 毛利率（百分数）。售价不是正数就没有。 */
  margin_pct?: number
  /** 算式（卡上原样附这一行：改价 / 折扣要附算式）。 */
  formula: string
}

/**
 * 一件货的毛利瀑布：售价逐项扣掉八项成本。
 *
 * 没给的那一项**不按 0 算进结论里装作算全了**：照样往下扣（等于 0），但列进 `missing`，
 * 卡上要写「这几项没算」。
 */
export function marginWaterfall(input: {
  price: number
  costs: Partial<Record<CostItemKey, number>>
}): MarginWaterfall {
  let left = input.price
  const steps: MarginWaterfall['steps'] = []
  const missing: CostItemKey[] = []
  const parts: string[] = []
  for (const item of COST_ITEMS) {
    const amount = input.costs[item.key]
    if (amount === undefined || !Number.isFinite(amount)) {
      missing.push(item.key)
      steps.push({ key: item.key, zh: item.zh })
      continue
    }
    left = round2(left - amount)
    parts.push(`${item.zh} ${round2(amount)}`)
    steps.push({ key: item.key, zh: item.zh, amount: round2(amount), left_after: left })
  }
  const landed_cost = round2(input.price - left)
  const margin_pct = input.price > 0 ? round2((left / input.price) * 100) : undefined
  return {
    price: input.price,
    steps,
    missing,
    landed_cost,
    margin: left,
    ...(margin_pct === undefined ? {} : { margin_pct }),
    formula: `${round2(input.price)} − (${parts.join(' + ') || '0'}) = ${left}${
      margin_pct === undefined ? '' : `，毛利率 ${margin_pct}%`
    }`,
  }
}
