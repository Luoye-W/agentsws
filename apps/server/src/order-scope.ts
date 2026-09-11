/**
 * WP47 / 44 G2 的**读**那一半：订单按产品线切。
 *
 * 一个岗位挂的是"整家店"时，这一层什么都不做——整店的过滤下推 19 §3 早就做完了
 * （范围为空的岗位压根查不到）。挂的是**产品线**时才有事干，分两步：
 *
 * 1. **能下推的下推**：Shopify 的集合 / 标签 / 供应商 / 商品类型四个字段
 *    Admin GraphQL 的 `query:` 直接认，翻成搜索语法交给上游先切一刀
 *    （`shopifyLineQuery()`，在 `@agentsws/roles` 里）。
 * 2. **不能下推的本地切**：拉回来按**行项目**再切一次，金额只算自己那部分行。
 *    一张混了两条产品线的订单两边都看得见，但两边的数字各算各的一半（44 §3 G2）。
 *
 * 一条硬限制写在这里，别让后来的人以为是 bug：**`list_orders` 的返回没有行项目**。
 * 要切就得对每张订单补一次 `get_order`——面板不是导数据工具，所以只对**近 7 天**的
 * 订单补（`LINE_ITEM_BACKFILL_DAYS`）。更早的订单没有行项目，切不动，于是
 * **不进产品线视角的结果**（宁可少算也不把别人的钱算到你头上）。
 */
import type { ProductLine, RangeRef } from '@agentsws/contracts'
import type { OrderLineItem, OrderRow } from '@agentsws/deck'
import { productLineMatches, type RangeTarget, shopifyLineQuery } from '@agentsws/roles'

/** 补行项目只补近几天的（见文件头）。 */
export const LINE_ITEM_BACKFILL_DAYS = 7

/** 活数据源要知道的那点制度（岗位挂了什么范围、产品线长什么样）。 */
export interface OrderScopePort {
  /** 这条分配挂的范围（已展开；分配不存在回空数组）。 */
  rangesOf(assignment_id: string): RangeRef[]
  /** 按 id 取产品线定义。 */
  productLine(id: string): ProductLine | undefined
  /** 本工作区的全部产品线（一条都没有 → 整条路短路，一次 `get_order` 都不花）。 */
  productLines(): ProductLine[]
  /** 本工作区活着的分配（算"要不要下推"时用）。 */
  activeRanges(): RangeRef[][]
}

/** 岗位视角：`orders(view)` 的入参。 */
export interface OrderView {
  assignment_id?: string
}

/**
 * 19 §3 过滤下推：这一轮刷新能不能让上游先切一刀。
 *
 * 条件苛刻是故意的——这份缓存是**全工作区共用**的一份，下推等于把别人的数据也切掉了。
 * 所以只有"这个工作区里所有活着的岗位都只挂产品线，而且这些产品线的判据都翻得成
 * Shopify 搜索语法"时才下推；只要有一个人挂着整家店，就老老实实全拉回来本地切。
 */
export function pushdownQueryOf(scope: OrderScopePort | undefined): string | undefined {
  if (scope === undefined) return undefined
  if (scope.productLines().length === 0) return undefined
  const all = scope.activeRanges().filter((ranges) => ranges.length > 0)
  if (all.length === 0) return undefined
  const lineIds = new Set<string>()
  for (const ranges of all) {
    for (const r of ranges) {
      // 有人挂着整家店 / 整个账号：下推会把他要看的也切掉，这一轮不下推
      if (r.kind !== 'product_line') return undefined
      lineIds.add(r.id)
    }
  }
  const clauses: string[] = []
  for (const id of [...lineIds].sort()) {
    const line = scope.productLine(id)
    if (line === undefined) return undefined
    const clause = shopifyLineQuery(line.rule)
    // 翻不成搜索语法（亚马逊 / 手填清单 / 空判据）→ 全拉回来本地切
    if (clause === undefined) return undefined
    clauses.push(clause)
  }
  return clauses.length === 0 ? undefined : clauses.join(' OR ')
}

/** 这条分配挂的产品线（挂了整店 / 整账号就回 `undefined`——它看全部）。 */
export function linesOf(
  scope: OrderScopePort,
  assignment_id: string,
): ProductLine[] | undefined | 'unassigned' {
  const ranges = scope.rangesOf(assignment_id)
  if (ranges.length === 0) return 'unassigned'
  if (ranges.some((r) => r.kind !== 'product_line')) return undefined
  const lines: ProductLine[] = []
  for (const r of ranges) {
    const line = scope.productLine(r.id)
    if (line !== undefined) lines.push(line)
  }
  return lines
}

/** 一行商品说成 `targetInRange` 认识的目标（判据靠它对）。 */
function targetOfLine(item: OrderLineItem): RangeTarget {
  return {
    platform: 'shopify',
    ...(item.product_id === undefined ? {} : { product_ids: [item.product_id] }),
    ...(item.sku === undefined ? {} : { skus: [item.sku] }),
    attributes: {
      ...(item.vendor === undefined ? {} : { vendor: item.vendor }),
      ...(item.product_type === undefined ? {} : { product_type: item.product_type }),
    },
  }
}

const round2 = (n: number): number => Math.round(n * 100) / 100

/**
 * 把一张订单切成"这条产品线的那一半"。
 *
 * - 一行都不命中 → `undefined`（这张订单不属于他）；
 * - 全命中 → 原样回（`partial` 不置位，数字块看到的就是整单）；
 * - 部分命中 → 金额只算命中的那几行，退款按占比折算，`partial: true` +
 *   `full_total_price` 留着整单金额，好让界面说得出"这是你那一半"。
 */
export function sliceOrder(order: OrderRow, lines: readonly ProductLine[]): OrderRow | undefined {
  const items = order.line_items
  // 没有行项目就切不动——切不动就不给（宁可少算，也不把别人的钱算到你头上）
  if (items === undefined || items.length === 0) return undefined
  const mine = items.filter((item) =>
    lines.some((line) => productLineMatches(line.rule, targetOfLine(item))),
  )
  if (mine.length === 0) return undefined
  if (mine.length === items.length) return order
  const total = round2(mine.reduce((sum, item) => sum + item.total, 0))
  const full = order.total_price
  const share = full > 0 ? total / full : 0
  return {
    ...order,
    line_items: mine,
    total_price: total,
    refunded_amount: round2(order.refunded_amount * share),
    partial: true,
    full_total_price: full,
  }
}

/**
 * 岗位视角的订单表（44 G2 读那一半的入口）。
 *
 * 没给视角 / 没装制度口子 → 原样回（老调用方一个字不用改）。
 */
export function scopedOrders(
  all: readonly OrderRow[],
  scope: OrderScopePort | undefined,
  view: OrderView | undefined,
): OrderRow[] {
  const id = view?.assignment_id
  if (scope === undefined || id === undefined || id === '') return [...all]
  const lines = linesOf(scope, id)
  // 一条范围都没有：05 §5，这个岗位看不到任何店铺数据
  if (lines === 'unassigned') return []
  // 挂的是整家店 / 整个账号：看全部
  if (lines === undefined) return [...all]
  if (lines.length === 0) return []
  const out: OrderRow[] = []
  for (const order of all) {
    const sliced = sliceOrder(order, lines)
    if (sliced !== undefined) out.push(sliced)
  }
  return out
}
