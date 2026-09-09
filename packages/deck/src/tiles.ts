/**
 * 36 §3 首页核心数据条：每岗位 3–4 个数字块，用户可换、可增减、上限 6。
 *
 * 「数字块只显示：值、环比箭头、迷你走势线」——所以这里出的 `StatTile` 就只有这三样，
 * 没有图表也没有表格（那些在岗位面板里）。
 */
import type { RoleId } from '@agentsws/contracts'
import { DeckError } from './errors.js'
import { queryDef, runQuery, sourceStatus } from './queries.js'
import type { QueryContext, RangeName, StatTile, TileFormat, TileSpec } from './types.js'

/** 36 §3：上限 6 / 岗位。 */
export const MAX_TILES_PER_POSITION = 6

const tile = (
  id: string,
  label: string,
  query: string,
  format: TileFormat,
  range_default: RangeName = 'yesterday',
): TileSpec => ({ id, label, query, format, range_default })

/**
 * 数字块库：用户「换一个数字块」只能从这里挑（29 原则 ①：组件与查询只能来自注册表）。
 */
export const TILE_LIBRARY: readonly TileSpec[] = [
  tile('sales_total', '总销售额', 'sales.total', 'money'),
  tile('orders_count', '订单数', 'orders.count', 'count'),
  tile('refunds_total', '退款额', 'refunds.total', 'money'),
  tile('conversion_rate', '转化率', 'analytics.conversion_rate', 'percent'),
  tile('active_users', '活跃用户', 'analytics.active_users', 'count'),
  tile('pending_replies', '待回复', 'approvals.pending_replies', 'count'),
  tile('reply_rate_24h', '24h 回复率', 'approvals.reply_rate_24h', 'percent'),
  tile('refund_requests', '退款申请', 'approvals.refund_requests', 'count'),
  tile('csat', '满意度', 'csat.score', 'ratio'),
  tile('ads_spend', '花费', 'ads.spend', 'money'),
  tile('ads_roas', 'ROAS', 'ads.roas', 'ratio'),
  tile('ads_cpa', 'CPA', 'ads.cpa', 'money'),
  tile('ads_ctr', '点击率', 'ads.ctr', 'percent'),
]

const BY_ID = new Map(TILE_LIBRARY.map((t) => [t.id, t]))

export function tileSpec(id: string): TileSpec {
  const spec = BY_ID.get(id)
  if (spec === undefined) throw new DeckError('UNKNOWN_TILE', `数字块库里没有：${id}`, { id })
  return spec
}

/**
 * 36 §3「示例默认值」：
 * - 独立站运营（`dtc.analytics`）= 总销售额、订单数、退款额、转化率
 * - 独立站售后客服（`dtc.aftersales`）= 待回复、24h 内回复率、退款申请数、满意度
 * - 投放-Meta（`ads.meta`）= 花费、ROAS、CPA、点击率
 */
export const DEFAULT_HOME_TILES: Readonly<Record<RoleId, readonly string[]>> = {
  'dtc.analytics': ['sales_total', 'orders_count', 'refunds_total', 'conversion_rate'],
  'dtc.aftersales': ['pending_replies', 'reply_rate_24h', 'refund_requests', 'csat'],
  'ads.meta': ['ads_spend', 'ads_roas', 'ads_cpa', 'ads_ctr'],
}

export function defaultTilesFor(role_id: RoleId): string[] {
  return [...(DEFAULT_HOME_TILES[role_id] ?? [])]
}

/** 校验用户挑的那组块：都在库里，且不超过上限。 */
export function validateTileSelection(ids: string[]): string[] {
  if (ids.length > MAX_TILES_PER_POSITION) {
    throw new DeckError(
      'TOO_MANY_TILES',
      `首页每个岗位最多 ${MAX_TILES_PER_POSITION} 个数字块（收到 ${ids.length} 个）`,
      { max: MAX_TILES_PER_POSITION, got: ids.length },
    )
  }
  const seen = new Set<string>()
  const out: string[] = []
  for (const id of ids) {
    tileSpec(id)
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

/** 跑一个数字块：数在服务端算好，前端只渲染（29 原则 ③）。 */
export function computeTile(spec: TileSpec, ctx: QueryContext, range: RangeName): StatTile {
  const def = queryDef(spec.query)
  const base = {
    id: spec.id,
    label: spec.label,
    format: spec.format,
    source: def.source,
    range,
  }
  if (!sourceStatus(ctx, def.source)) {
    return { ...base, status: 'not_connected', spark: [] }
  }
  const result = runQuery(spec.query, ctx, range)
  if (result.status !== 'ok') return { ...base, status: 'not_connected', spark: [] }
  const data = result.data
  if (!('value' in data)) {
    // 数字块只接标量查询；面板里的表 / 图走 blocks.ts。
    throw new DeckError('PAYLOAD_INVALID', `数字块 ${spec.id} 的查询不是标量：${spec.query}`)
  }
  const direction = data.value > data.previous ? 'up' : data.value < data.previous ? 'down' : 'flat'
  return {
    ...base,
    status: 'ok',
    value: data.value,
    previous: data.previous,
    ...(data.delta_pct === undefined ? {} : { delta_pct: data.delta_pct }),
    direction,
    spark: data.spark,
    ...(data.currency === undefined ? {} : { currency: data.currency }),
  }
}

export function computeTiles(ids: string[], ctx: QueryContext, range: RangeName): StatTile[] {
  return ids.map((id) => computeTile(tileSpec(id), ctx, range))
}
