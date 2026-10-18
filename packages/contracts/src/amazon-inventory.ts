/**
 * WP397（docs/106 §13.3 二期第二批、A14）：**Amazon 库存与补货的公式**——数一律由这里算，不让模型估。
 *
 * 口径与出处（`amazon-inventory` 技能正文逐条写着同一套）：
 *
 * - 断货风险线 **14 天**：Amazon 自己的分析口径「可售天数 < 14 → 有断货风险」（官方 seller-analytics
 *   技能；kangise/ecommerce-ai-skills `inventory.stockout_warning_threshold` 同为 14 天）。官方
 *   stockout-prevention 的 7 / 21 天分档只当预警：14–21 天是「快到了」（docs/106 §13.4 统一成 14 天）。
 * - 安全库存 = Z × σ_d × √L；补货点 = 日均销量 × L + 安全库存；可售天数 = (可售 + 在途) ÷ 日均销量
 *   （kangise `inventory.safety_stock_formula` / `reorder_point_formula` / `days_of_stock_formula`，CC0，核对 2026-08）。
 * - 断货期的零销量不算进日均：断货那几天卖 0 不代表没人要（kangise `forecast.stockout_data_handling`）。
 *   调用方标了 `in_stock: false` 的那天剔除；没标的，连续 ≥ 3 天卖 0 按断货剔除（那条约束自己注明
 *   「3 天是工程约定」，所以做成参数，默认 3，传 0 关掉）。
 * - Lead Time 取最近 3–5 次实际值的**最大值**，旺季另加缓冲（kangise `inventory.lead_time_safety_rule`）。
 * - 库龄 181 天起有超龄附加费、365 天起更高（kangise `amazon.fba.inventory.aged_surcharge_*`）。
 *   **费用金额不写死**：以 Amazon 当期收费页为准（docs/106 §13.4）。
 *
 * 纯函数、不联网；缺数回 `missing`，不按 0 顶上。
 */

/** Amazon 的断货风险线：可售天数少于这么多天。 */
export const AMAZON_STOCKOUT_RISK_DAYS = 14
/** 官方 stockout-prevention 的预警上沿：14 到这个数之间说「快到了」。 */
export const AMAZON_STOCKOUT_EARLY_WARNING_DAYS = 21
/** 库龄从这一天起收超龄附加费。 */
export const AMAZON_AGED_SURCHARGE_FROM_DAYS = 181
/** 库龄从这一天起超龄附加费更高。 */
export const AMAZON_AGED_SURCHARGE_HIGH_FROM_DAYS = 365

/** 服务水平 → Z 值（kangise `inventory.service_level_z_factors`）。 */
export const SERVICE_LEVEL_Z: Readonly<Record<'0.9' | '0.95' | '0.975' | '0.99', number>> = {
  '0.9': 1.28,
  '0.95': 1.65,
  '0.975': 1.96,
  '0.99': 2.33,
}

export interface DailyUnits {
  /** `YYYY-MM-DD`。 */
  date: string
  units: number
  /** 这一天有没有货；`false` 的那天不算进日均。不知道就不写。 */
  in_stock?: boolean
}

export interface VelocityResult {
  avg_daily_units: number
  /** 日销量的标准差（总体口径）。 */
  std_daily_units: number
  /** 算进去的天数。 */
  days_used: number
  /** 按断货剔除的日期。 */
  excluded_dates: string[]
}

const finiteNonNeg = (n: unknown): n is number =>
  typeof n === 'number' && Number.isFinite(n) && n >= 0

/**
 * 有货那几天的日均销量与波动。一天都剩不下（全在断货）回 `undefined`——这时没法算，照实说。
 *
 * `zero_streak_as_stockout`：没标 `in_stock` 的日子里，连续这么多天卖 0 当断货剔除；0 = 不推断。
 */
export function inStockVelocity(
  days: readonly DailyUnits[],
  options: { zero_streak_as_stockout?: number } = {},
): VelocityResult | undefined {
  const streak = options.zero_streak_as_stockout ?? 3
  for (const d of days) {
    if (!finiteNonNeg(d.units)) throw new RangeError(`销量不是非负数：${d.date}`)
  }
  const sorted = [...days].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  const excluded = new Set<string>()
  for (const d of sorted) if (d.in_stock === false) excluded.add(d.date)
  if (streak > 0) {
    let run: DailyUnits[] = []
    const flush = (): void => {
      if (run.length >= streak) for (const d of run) excluded.add(d.date)
      run = []
    }
    for (const d of sorted) {
      if (d.in_stock === undefined && d.units === 0) run.push(d)
      else flush()
    }
    flush()
  }
  const used = sorted.filter((d) => !excluded.has(d.date))
  if (used.length === 0) return undefined
  const avg = used.reduce((s, d) => s + d.units, 0) / used.length
  const variance = used.reduce((s, d) => s + (d.units - avg) ** 2, 0) / used.length
  return {
    avg_daily_units: avg,
    std_daily_units: Math.sqrt(variance),
    days_used: used.length,
    excluded_dates: sorted.filter((d) => excluded.has(d.date)).map((d) => d.date),
  }
}

/** 安全库存 = Z × σ_d × √L。 */
export function safetyStock(input: {
  z: number
  std_daily_units: number
  lead_time_days: number
}): number {
  const { z, std_daily_units, lead_time_days } = input
  if (![z, std_daily_units, lead_time_days].every(finiteNonNeg)) {
    throw new RangeError('安全库存的参数要是非负数')
  }
  return z * std_daily_units * Math.sqrt(lead_time_days)
}

/** 补货点 = 日均销量 × L + 安全库存。 */
export function reorderPoint(input: {
  avg_daily_units: number
  lead_time_days: number
  safety_stock: number
}): number {
  const { avg_daily_units, lead_time_days, safety_stock } = input
  if (![avg_daily_units, lead_time_days, safety_stock].every(finiteNonNeg)) {
    throw new RangeError('补货点的参数要是非负数')
  }
  return avg_daily_units * lead_time_days + safety_stock
}

/** 可售天数 = (可售 + 在途) ÷ 日均销量。卖不动（日均 0）回 `undefined`：天数无穷，不是 0。 */
export function daysOfCover(input: {
  fulfillable: number
  inbound?: number
  avg_daily_units: number
}): number | undefined {
  const inbound = input.inbound ?? 0
  if (![input.fulfillable, inbound, input.avg_daily_units].every(finiteNonNeg)) {
    throw new RangeError('可售天数的参数要是非负数')
  }
  if (input.avg_daily_units === 0) return undefined
  return (input.fulfillable + inbound) / input.avg_daily_units
}

export type StockoutBand = 'at_risk' | 'approaching' | 'ok'

/** 按 14 天线分档：< 14 有风险；14–21 快到了；≥ 21 没事。 */
export function stockoutBand(days_of_cover: number | undefined): StockoutBand {
  if (days_of_cover === undefined) return 'ok'
  if (days_of_cover < AMAZON_STOCKOUT_RISK_DAYS) return 'at_risk'
  if (days_of_cover < AMAZON_STOCKOUT_EARLY_WARNING_DAYS) return 'approaching'
  return 'ok'
}

export type AgedBand = 'none' | 'surcharge' | 'surcharge_high'

/** 库龄在哪一档（金额不在这里：以 Amazon 当期收费页为准）。 */
export function agedInventoryBand(age_days: number): AgedBand {
  if (!finiteNonNeg(age_days)) throw new RangeError('库龄要是非负数')
  if (age_days >= AMAZON_AGED_SURCHARGE_HIGH_FROM_DAYS) return 'surcharge_high'
  if (age_days >= AMAZON_AGED_SURCHARGE_FROM_DAYS) return 'surcharge'
  return 'none'
}

/** 计划用的 Lead Time：最近 3–5 次实际值取最大（多给的只取最近 5 次），再加旺季缓冲。 */
export function planningLeadTime(
  recent_actual_days: readonly number[],
  peak_buffer_days = 0,
): number {
  if (recent_actual_days.length === 0) throw new RangeError('至少要一次实际 Lead Time')
  if (![...recent_actual_days, peak_buffer_days].every(finiteNonNeg)) {
    throw new RangeError('Lead Time 要是非负数')
  }
  return Math.max(...recent_actual_days.slice(-5)) + peak_buffer_days
}

export interface RestockInput {
  sku: string
  /** 现在可售的件数（FBA fulfillable）。 */
  fulfillable?: number
  /** 在途件数（已发出、还没上架的）。 */
  inbound?: number
  /** 最近一段的每日销量；断货日标 `in_stock: false`。 */
  daily?: readonly DailyUnits[]
  /** 计划用的 Lead Time（下单到能卖，含入仓），见 {@link planningLeadTime}。 */
  lead_time_days?: number
  /** 服务水平（默认 95%）。 */
  service_level?: keyof typeof SERVICE_LEVEL_Z
  /** 到货后还想再撑多少天（下一次补货的间隔）。 */
  cover_days_after_arrival?: number
}

export type RestockPlan =
  | {
      status: 'ok'
      sku: string
      avg_daily_units: number
      std_daily_units: number
      days_used: number
      excluded_dates: string[]
      /** 卖不动时为 `undefined`。 */
      days_of_cover: number | undefined
      band: StockoutBand
      safety_stock: number
      reorder_point: number
      /** 现在就该下单：可售 + 在途 ≤ 补货点。 */
      reorder_now: boolean
      /** 建议补货量（向上取整，不会是负数）。 */
      quantity: number
      /** 每一步的算式（给人看，回答里照抄）。 */
      formulas: string[]
    }
  | { status: 'missing'; sku: string; missing: string[] }

const r1 = (n: number): string => (Math.round(n * 10) / 10).toString()

/**
 * 一个 SKU 的补货建议：日均（剔除断货日）→ 可售天数 → 安全库存 → 补货点 → 补多少。
 *
 * 补货量 = 日均 × (L + 到货后要撑的天数) + 安全库存 − 可售 − 在途，取整、不小于 0。
 * 少任何一个数都回 `missing`（列出缺哪几样），不按 0 顶上。
 */
export function restockPlan(input: RestockInput): RestockPlan {
  const missing: string[] = []
  if (input.fulfillable === undefined) missing.push('fulfillable')
  if (input.daily === undefined || input.daily.length === 0) missing.push('daily')
  if (input.lead_time_days === undefined) missing.push('lead_time_days')
  if (input.cover_days_after_arrival === undefined) missing.push('cover_days_after_arrival')
  const velocity = input.daily === undefined ? undefined : inStockVelocity(input.daily)
  if (input.daily !== undefined && input.daily.length > 0 && velocity === undefined) {
    missing.push('in_stock_days')
  }
  if (
    missing.length > 0 ||
    velocity === undefined ||
    input.fulfillable === undefined ||
    input.lead_time_days === undefined ||
    input.cover_days_after_arrival === undefined
  ) {
    return { status: 'missing', sku: input.sku, missing }
  }
  const inbound = input.inbound ?? 0
  const level = input.service_level ?? '0.95'
  const z = SERVICE_LEVEL_Z[level]
  const L = input.lead_time_days
  const avg = velocity.avg_daily_units
  const ss = safetyStock({ z, std_daily_units: velocity.std_daily_units, lead_time_days: L })
  const rop = reorderPoint({ avg_daily_units: avg, lead_time_days: L, safety_stock: ss })
  const cover = daysOfCover({ fulfillable: input.fulfillable, inbound, avg_daily_units: avg })
  const raw = avg * (L + input.cover_days_after_arrival) + ss - input.fulfillable - inbound
  const quantity = Math.max(0, Math.ceil(raw - 1e-9))
  return {
    status: 'ok',
    sku: input.sku,
    avg_daily_units: avg,
    std_daily_units: velocity.std_daily_units,
    days_used: velocity.days_used,
    excluded_dates: velocity.excluded_dates,
    days_of_cover: cover,
    band: stockoutBand(cover),
    safety_stock: ss,
    reorder_point: rop,
    reorder_now: input.fulfillable + inbound <= rop,
    quantity,
    formulas: [
      `日均 = ${velocity.days_used} 天有货的销量 ÷ ${velocity.days_used} = ${r1(avg)}（剔除断货 ${velocity.excluded_dates.length} 天）`,
      cover === undefined
        ? '可售天数：日均为 0，算不出天数'
        : `可售天数 = (${input.fulfillable} + ${inbound}) ÷ ${r1(avg)} = ${r1(cover)}`,
      `安全库存 = ${z} × ${r1(velocity.std_daily_units)} × √${L} = ${r1(ss)}`,
      `补货点 = ${r1(avg)} × ${L} + ${r1(ss)} = ${r1(rop)}`,
      `补货量 = ${r1(avg)} × (${L} + ${input.cover_days_after_arrival}) + ${r1(ss)} − ${input.fulfillable} − ${inbound} = ${quantity}`,
    ],
  }
}
