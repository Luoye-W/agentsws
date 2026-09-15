/**
 * 51 §2.1 异常卡：销售骤降 / 库存断货 / 转化异常。
 *
 * 三条纪律，和这个包里其余部分一样：
 *
 * 1. **数不经模型手**（29 原则 ③）。跌了多少、断了几个 SKU，全部从
 *    `QueryContext` 里的结构化行算出来；模型一个数都碰不到。
 * 2. **阈值不硬写**。什么叫"骤降"，卖家具的和卖快消的不是一个数——所以阈值从
 *    职责 yml 的 `thresholds` 来（`ANOMALY_DEFAULTS` 只是宿主忘了传时的兜底）。
 * 3. **算不出就不出卡**。转化率要 GA4，GA4 没连就**不出转化异常卡**，而不是
 *    拿一个 0 去和昨天比然后报"跌了 100%"——那种卡比没有更糟（36 §3）。
 *
 * 这一层只产**结论**（`Anomaly`），不产 `DeckCard`：卡是审批 / 告警那一侧的东西，
 * 有 id、有版本、有五动作矩阵；这里的职责到"有没有不正常、不正常在哪"为止。
 */
import { dayLabel, rangeWindows, thresholdOf } from './queries.js'
import type { QueryContext, RangeName } from './types.js'

/** 异常的种类。加一种就在这里加一行，`detectAnomalies` 自己会多出一条判断。 */
export type AnomalyKind = 'sales_drop' | 'stock_out' | 'conversion_drop'

export interface Anomaly {
  kind: AnomalyKind
  /** 一句人话（界面上卡面的标题），已经把数字填进去了。 */
  title: string
  /** 触发它的那条阈值名（`thresholds` 里的键），排查时对得上。 */
  threshold_key: string
  threshold: number
  /** 实测值（跌幅百分比 / 断货 SKU 数）。 */
  actual: number
  /** 这张卡说的是哪一天（工作区本地日期）。 */
  date: string
  /** 出这条结论用到的对象（断货的那几个 SKU）。 */
  refs?: string[]
}

const round2 = (v: number): number => Math.round(v * 100) / 100

/**
 * 跌幅（百分比，正数 = 跌了多少）。
 *
 * 对比期是 0 的时候回 `undefined` 而不是 `Infinity`：从 0 涨到任何数都不是"跌"，
 * 而从 0 到 0 更不是——两种情况都不该出卡。
 */
function dropPct(current: number, previous: number): number | undefined {
  if (previous <= 0) return undefined
  if (current >= previous) return undefined
  return round2(((previous - current) / previous) * 100)
}

export interface AnomalyInput {
  ctx: QueryContext
  range: RangeName
  /**
   * 转化率（当期 / 对比期，百分比）。**GA4 连上了才有**——`undefined` 就是
   * "我们不知道"，这时一张转化异常卡都不出。
   */
  conversion?: { value: number; previous: number }
}

/** 51 §2.1：出哪几张异常卡。没有不正常就返回空数组（不出"一切正常"卡）。 */
export function detectAnomalies(input: AnomalyInput): Anomaly[] {
  const { ctx, range } = input
  const w = rangeWindows(range, ctx.now, ctx.tz_offset_minutes)
  const date = dayLabel(w.current.from, ctx.tz_offset_minutes)
  const out: Anomaly[] = []

  // ① 销售骤降
  const inWindow = (at: string, from: number, to: number): boolean => {
    const ms = Date.parse(at)
    return ms >= from && ms < to
  }
  const salesOf = (from: number, to: number): number =>
    round2(
      ctx.orders
        .filter((o) => inWindow(o.created_at, from, to))
        .reduce((n, o) => n + o.total_price, 0),
    )
  const salesDropCap = thresholdOf(ctx, 'sales_drop_pct')
  const drop = dropPct(
    salesOf(w.current.from, w.current.to),
    salesOf(w.previous.from, w.previous.to),
  )
  if (drop !== undefined && drop >= salesDropCap) {
    out.push({
      kind: 'sales_drop',
      title: `销售额比上一期跌了 ${drop}%`,
      threshold_key: 'sales_drop_pct',
      threshold: salesDropCap,
      actual: drop,
      date,
    })
  }

  // ② 库存断货：`quantity <= 0` 才叫断货，"告急"是另一回事（那是库存告急表）
  const out_of_stock = (ctx.inventory ?? []).filter((r) => r.quantity <= 0)
  if (out_of_stock.length > 0) {
    out.push({
      kind: 'stock_out',
      title: `${out_of_stock.length} 个 SKU 已经断货`,
      threshold_key: 'low_stock_quantity',
      threshold: thresholdOf(ctx, 'low_stock_quantity'),
      actual: out_of_stock.length,
      date,
      refs: out_of_stock.slice(0, 20).map((r) => r.sku ?? r.id),
    })
  }

  // ③ 转化异常：算不出就不出卡（GA4 没连 = 我们不知道，不是"转化率是 0"）
  const conv = input.conversion
  const convCap = thresholdOf(ctx, 'conversion_drop_pct')
  const convDrop = conv === undefined ? undefined : dropPct(conv.value, conv.previous)
  if (convDrop !== undefined && convDrop >= convCap) {
    out.push({
      kind: 'conversion_drop',
      title: `转化率比上一期跌了 ${convDrop}%`,
      threshold_key: 'conversion_drop_pct',
      threshold: convCap,
      actual: convDrop,
      date,
    })
  }

  return out
}
