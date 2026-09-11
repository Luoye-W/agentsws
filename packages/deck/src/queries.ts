/**
 * 29 §1 命名查询 + §2 渲染管线的**查询那一段**。
 *
 * 三条纪律在这里落地：
 * - **数字不经模型手**：每个数都从 `QueryContext` 里的结构化行算出来，没有一处读 title / summary。
 * - **组件与查询只能来自注册表**：不在 `QUERIES` 里的名字直接抛 `UNKNOWN_QUERY`。
 * - **时间靠注入**：所有窗口从 `ctx.now` 切，没有 `Date.now()`。
 *
 * v1 是内存实现：店铺侧的行来自 mock OpenConnector 的订单，审批侧来自审批项存储；
 * GA4 / Search Console / 广告后台没接连接，一律回 `not_connected`（界面显示「去连接」而不是空图）。
 */
import type { ApprovalItem, Iso8601 } from '@agentsws/contracts'
import { DeckError } from './errors.js'
import type {
  DataSourceId,
  QueryContext,
  QueryData,
  QueryResult,
  RangeName,
  RecordRow,
  ScalarResult,
  SeriesResult,
  TableResult,
} from './types.js'

const DAY = 86_400_000
const SPARK_BUCKETS = 7

export interface Window {
  /** [from, to) */
  from: number
  to: number
}

/** 按工作区时区切当天零点。 */
export function startOfDay(ms: number, tzOffsetMinutes: number): number {
  const shift = tzOffsetMinutes * 60_000
  return Math.floor((ms + shift) / DAY) * DAY - shift
}

/** 日期标签按工作区时区取，不按 UTC（+8 时区用 UTC 日期整条横轴会错一天）。 */
export function dayLabel(ms: number, tzOffsetMinutes: number): string {
  return new Date(ms + tzOffsetMinutes * 60_000).toISOString().slice(0, 10)
}

export interface RangeWindows {
  current: Window
  previous: Window
  /** 迷你走势的分桶（固定 7 天，最后一桶与 current 的最后一天对齐） */
  spark: Window[]
}

/**
 * 36 §3 的两档，含义按 WP49 修正：
 *
 * - **昨天** = 本地昨天 0 点 → 今天 0 点；对比期 = 前天。迷你走势最后一桶 = 昨天。
 * - **近 7 天** = 本地 6 天前 0 点 → **现在**（含今天，共 7 个自然日，今天是不完整的一天）；
 *   对比期 = 再往前 7 整天（13 天前 0 点 → 6 天前 0 点）。迷你走势最后一桶 = 今天（到现在为止）。
 *
 * 改的原因（1d 真店验收）：原来「近 7 天」是 `[今天 0 点 − 7 天, 今天 0 点)`，今天被排在窗外，
 * 于是今天刚下的订单已经拉回来了、面板上还是 0。用户嘴里的「近 7 天」本来就包含今天。
 */
export function rangeWindows(
  range: RangeName,
  now: Iso8601,
  tzOffsetMinutes: number,
): RangeWindows {
  const nowMs = Date.parse(now)
  const today = startOfDay(nowMs, tzOffsetMinutes)
  const spark: Window[] = []
  if (range === 'yesterday') {
    for (let i = SPARK_BUCKETS - 1; i >= 0; i -= 1) {
      spark.push({ from: today - (i + 1) * DAY, to: today - i * DAY })
    }
    return {
      current: { from: today - DAY, to: today },
      previous: { from: today - 2 * DAY, to: today - DAY },
      spark,
    }
  }
  // 近 7 天：今天在窗内，最后一桶到「现在」为止，不是到今天 24 点。
  for (let i = SPARK_BUCKETS - 1; i >= 0; i -= 1) {
    spark.push({ from: today - i * DAY, to: i === 0 ? nowMs : today - (i - 1) * DAY })
  }
  const span = (SPARK_BUCKETS - 1) * DAY
  // 对比期截到同一时刻（Luoye 09-11 定）：本期是 6 整天 + 今天到现在，
  // 对比期就是 7 天前的同一段——否则早上看环比天生偏低。
  return {
    current: { from: today - span, to: nowMs },
    previous: { from: today - span - SPARK_BUCKETS * DAY, to: nowMs - SPARK_BUCKETS * DAY },
    spark,
  }
}

const inWindow = (ms: number, w: Window): boolean => ms >= w.from && ms < w.to

interface Point {
  at: number
  v: number
}

function sum(points: Point[], w: Window): number {
  let total = 0
  for (const p of points) if (inWindow(p.at, w)) total += p.v
  return round2(total)
}

function round2(v: number): number {
  return Math.round(v * 100) / 100
}

function scalarFrom(points: Point[], windows: RangeWindows, currency?: string): ScalarResult {
  const value = sum(points, windows.current)
  const previous = sum(points, windows.previous)
  const spark = windows.spark.map((w) => sum(points, w))
  return {
    value,
    previous,
    ...(previous === 0 ? {} : { delta_pct: round2(((value - previous) / previous) * 100) }),
    spark,
    ...(currency === undefined ? {} : { currency }),
  }
}

/** 比例类（回复率、转化率…）：分子分母各自求和后再相除，不是「每天比例的平均」。 */
function ratioFrom(hits: Point[], total: Point[], windows: RangeWindows): ScalarResult {
  const ratio = (w: Window): number => {
    const d = sum(total, w)
    return d === 0 ? 0 : round2((sum(hits, w) / d) * 100)
  }
  const value = ratio(windows.current)
  const previous = ratio(windows.previous)
  return {
    value,
    previous,
    ...(previous === 0 ? {} : { delta_pct: round2(((value - previous) / previous) * 100) }),
    spark: windows.spark.map(ratio),
  }
}

// ── 审批项上的几个时间点 ───────────────────────────────────────────────

const createdMs = (i: ApprovalItem): number => Date.parse(i.created_at)

function decidedMs(i: ApprovalItem): number | undefined {
  const at = i.decision?.at
  return at === undefined ? undefined : Date.parse(at)
}

function appliedMs(i: ApprovalItem): number | undefined {
  const attempts = i.apply?.attempts ?? []
  for (let k = attempts.length - 1; k >= 0; k -= 1) {
    const a = attempts[k]
    if (a !== undefined && a.result === 'ok') return Date.parse(a.at)
  }
  return undefined
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function refundAmount(i: ApprovalItem): number | undefined {
  const p = i.payload
  if (!isRecord(p)) return undefined
  const money = p.money
  if (isRecord(money) && typeof money.amount_base === 'number') return money.amount_base
  if (isRecord(money) && typeof money.amount === 'number') return money.amount
  const after = p.after
  if (isRecord(after) && typeof after.refund_amount === 'number') return after.refund_amount
  return undefined
}

const isRefund = (i: ApprovalItem): boolean =>
  i.kind === 'staged_change' && isRecord(i.payload) && i.payload.kind === 'refund'

const PENDING: readonly string[] = ['pending', 'in_review']

// ── 注册表 ─────────────────────────────────────────────────────────────

type Runner = (ctx: QueryContext, windows: RangeWindows, range: RangeName) => QueryData

export interface QueryDef {
  name: string
  source: DataSourceId
  /** 返回形状；`GET /blocks/{id}/data` 用它对着组件的 payload_schema 校验 */
  returns: 'scalar' | 'table' | 'series' | 'records'
  run: Runner
}

function orderPoints(
  ctx: QueryContext,
  value: (o: QueryContext['orders'][number]) => number,
): Point[] {
  return ctx.orders.map((o) => ({ at: Date.parse(o.created_at), v: value(o) }))
}

const QUERY_LIST: QueryDef[] = [
  {
    name: 'sales.total',
    source: 'shop',
    returns: 'scalar',
    run: (ctx, w) =>
      scalarFrom(
        orderPoints(ctx, (o) => o.total_price),
        w,
        ctx.base_currency,
      ),
  },
  {
    name: 'orders.count',
    source: 'shop',
    returns: 'scalar',
    run: (ctx, w) =>
      scalarFrom(
        orderPoints(ctx, () => 1),
        w,
      ),
  },
  {
    name: 'refunds.total',
    source: 'shop',
    returns: 'scalar',
    run: (ctx, w) => {
      // 退款额按**施行时间**计（15 §5：通过 ≠ 施行），不是按订单下单时间。
      const points: Point[] = []
      for (const i of ctx.approvals) {
        if (!isRefund(i)) continue
        const at = appliedMs(i)
        const amount = refundAmount(i)
        if (at === undefined || amount === undefined) continue
        points.push({ at, v: amount })
      }
      return scalarFrom(points, w, ctx.base_currency)
    },
  },
  {
    name: 'approvals.pending_replies',
    source: 'approvals',
    returns: 'scalar',
    run: (ctx, w) => {
      // 存量指标：现在还压着几条；环比 = 本窗口开始时就已经压着的那几条。
      const drafts = ctx.approvals.filter((i) => i.kind === 'outbound_draft')
      const value = drafts.filter((i) => PENDING.includes(i.state)).length
      const previous = drafts.filter(
        (i) => PENDING.includes(i.state) && createdMs(i) < w.current.from,
      ).length
      const spark = w.spark.map((b) => drafts.filter((i) => inWindow(createdMs(i), b)).length)
      return {
        value,
        previous,
        ...(previous === 0 ? {} : { delta_pct: round2(((value - previous) / previous) * 100) }),
        spark,
      }
    },
  },
  {
    name: 'approvals.reply_rate_24h',
    source: 'approvals',
    returns: 'scalar',
    run: (ctx, w) => {
      const hits: Point[] = []
      const total: Point[] = []
      for (const i of ctx.approvals) {
        if (i.kind !== 'outbound_draft') continue
        const at = createdMs(i)
        total.push({ at, v: 1 })
        const done = decidedMs(i)
        if (done !== undefined && done - at <= DAY) hits.push({ at, v: 1 })
      }
      return ratioFrom(hits, total, w)
    },
  },
  {
    name: 'approvals.refund_requests',
    source: 'approvals',
    returns: 'scalar',
    run: (ctx, w) =>
      scalarFrom(
        ctx.approvals.filter(isRefund).map((i) => ({ at: createdMs(i), v: 1 })),
        w,
      ),
  },
  {
    name: 'orders.recent',
    source: 'shop',
    returns: 'table',
    run: (ctx) => {
      // 「最近订单」就是字面意思：按下单时间倒序取最新 20 条，**不受时间窗限制**。
      // （WP49：窗内取会让刚下的单在「昨天」档看不见，也会让淡季的窗口整张表空掉。）
      const rows = ctx.orders
        .slice()
        .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
        .slice(0, 20)
        .map((o) => ({
          order: o.name,
          created_at: o.created_at,
          total: o.total_price,
          currency: o.currency,
          status: o.fulfillment_status,
        }))
      return {
        columns: [
          { key: 'order', label: '订单' },
          { key: 'created_at', label: '下单时间' },
          { key: 'total', label: '金额', align: 'right' as const },
          { key: 'status', label: '履约' },
        ],
        rows,
      }
    },
  },
  {
    name: 'orders.overdue',
    source: 'shop',
    returns: 'table',
    run: (ctx) => {
      // 「超期未发」= 下单超过 3 天还没发货（结构化字段判定，不猜）。
      const cutoff = Date.parse(ctx.now) - 3 * DAY
      const rows = ctx.orders
        .filter((o) => o.fulfillment_status === 'unfulfilled' && Date.parse(o.created_at) < cutoff)
        .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
        .slice(0, 20)
        .map((o) => ({
          order: o.name,
          created_at: o.created_at,
          total: o.total_price,
          currency: o.currency,
          status: o.financial_status,
        }))
      return {
        columns: [
          { key: 'order', label: '订单' },
          { key: 'created_at', label: '下单时间' },
          { key: 'total', label: '金额', align: 'right' as const },
          { key: 'status', label: '支付' },
        ],
        rows,
      }
    },
  },
  {
    name: 'sales.trend',
    source: 'shop',
    returns: 'series',
    run: (ctx, w) => {
      const points = orderPoints(ctx, (o) => o.total_price)
      const counts = orderPoints(ctx, () => 1)
      return {
        x: w.spark.map((b) => dayLabel(b.from, ctx.tz_offset_minutes)),
        series: [
          { key: 'sales', label: '销售额', points: w.spark.map((b) => sum(points, b)) },
          { key: 'orders', label: '订单数', points: w.spark.map((b) => sum(counts, b)) },
        ],
        currency: ctx.base_currency,
      }
    },
  },
  {
    name: 'records.timeline',
    source: 'approvals',
    returns: 'records',
    run: (ctx) => {
      const rows: RecordRow[] = ctx.approvals
        .slice()
        .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))
        .slice(0, 50)
        .map((i) => ({
          id: i.id,
          at: i.updated_at,
          kind: i.kind,
          title: i.title,
          summary: i.summary,
          state: i.state,
          ref: i.subject.object,
        }))
      return { rows }
    },
  },
  // ── 没接的数据源：查询在册，执行时按连接状态短路（36 §3「显示去连接卡而不是空图」）
  { name: 'analytics.conversion_rate', source: 'ga4', returns: 'scalar', run: () => EMPTY_SCALAR },
  { name: 'analytics.active_users', source: 'ga4', returns: 'scalar', run: () => EMPTY_SCALAR },
  { name: 'analytics.events', source: 'ga4', returns: 'table', run: () => EMPTY_TABLE },
  { name: 'gsc.top_queries', source: 'gsc', returns: 'table', run: () => EMPTY_TABLE },
  { name: 'gsc.landing_pages', source: 'gsc', returns: 'table', run: () => EMPTY_TABLE },
  { name: 'csat.score', source: 'csat', returns: 'scalar', run: () => EMPTY_SCALAR },
  { name: 'ads.spend', source: 'ads', returns: 'scalar', run: () => EMPTY_SCALAR },
  { name: 'ads.roas', source: 'ads', returns: 'scalar', run: () => EMPTY_SCALAR },
  { name: 'ads.cpa', source: 'ads', returns: 'scalar', run: () => EMPTY_SCALAR },
  { name: 'ads.ctr', source: 'ads', returns: 'scalar', run: () => EMPTY_SCALAR },
  { name: 'ads.trend', source: 'ads', returns: 'series', run: () => EMPTY_SERIES },
]

const EMPTY_SCALAR: ScalarResult = { value: 0, previous: 0, spark: [0, 0, 0, 0, 0, 0, 0] }
const EMPTY_TABLE: TableResult = { columns: [], rows: [] }
const EMPTY_SERIES: SeriesResult = { x: [], series: [] }

export const QUERIES: ReadonlyMap<string, QueryDef> = new Map(QUERY_LIST.map((q) => [q.name, q]))

export function queryNames(): string[] {
  return [...QUERIES.keys()].sort()
}

export function queryDef(name: string): QueryDef {
  const def = QUERIES.get(name)
  if (def === undefined) throw new DeckError('UNKNOWN_QUERY', `没有这个命名查询：${name}`, { name })
  return def
}

export function sourceStatus(ctx: QueryContext, source: DataSourceId): boolean {
  return ctx.sources.find((s) => s.id === source)?.connected ?? false
}

/** 29 §2 渲染管线的执行段：查名字 → 看连接 → 跑查询。权限判定在网关（Casbin）已经做过。 */
export function runQuery(name: string, ctx: QueryContext, range: RangeName): QueryResult {
  const def = queryDef(name)
  if (!sourceStatus(ctx, def.source)) return { status: 'not_connected', source: def.source }
  const windows = rangeWindows(range, ctx.now, ctx.tz_offset_minutes)
  return { status: 'ok', source: def.source, data: def.run(ctx, windows, range) }
}
