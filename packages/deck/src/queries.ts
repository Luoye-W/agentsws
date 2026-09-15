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

/** WP64：这张卡是不是某一条变更种类的 staged_change。 */
const isChangeKind = (i: ApprovalItem, kind: string): boolean =>
  i.kind === 'staged_change' && isRecord(i.payload) && i.payload.kind === kind

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

/**
 * WP63（51 §2.1 面板）：待审改动的四条车道 —— 车道名 → 它收哪几种 `ChangeKind`。
 *
 * 顺序就是面板上的顺序。加一条车道只要在这里加一行，查询注册表自己就多一条。
 */
export const PENDING_LANES: readonly { lane: string; label: string; kinds: readonly string[] }[] = [
  {
    lane: 'listing',
    label: '文案与详情页',
    kinds: ['listing_edit', 'collection_edit'],
  },
  { lane: 'price', label: '改价', kinds: ['price_change'] },
  { lane: 'publish', label: '上下架', kinds: ['publish_product', 'unpublish_product'] },
  { lane: 'promotion', label: '促销与折扣', kinds: ['discount_code', 'promotion'] },
  // 51 §2.2：内容那条职责自己的车道（博客发布）
  { lane: 'publish_post', label: '待发布', kinds: ['publish_post'] },
]

const kindOfItem = (i: ApprovalItem): string | undefined => {
  const p = i.payload
  return isRecord(p) && typeof p.kind === 'string' ? p.kind : undefined
}

/** 一条车道的命名查询：同一份审批项按 `payload.kind` 切一刀，按建卡时间倒序。 */
function laneQuery(spec: (typeof PENDING_LANES)[number]): QueryDef {
  return {
    name: `changes.pending_${spec.lane}`,
    source: 'approvals',
    returns: 'table',
    run: (ctx) => {
      const rows = ctx.approvals
        .filter((i) => i.kind === 'staged_change' && PENDING.includes(i.state))
        .filter((i) => {
          const k = kindOfItem(i)
          return k !== undefined && spec.kinds.includes(k)
        })
        .sort((a, b) => createdMs(b) - createdMs(a))
        .slice(0, 20)
        .map((i) => ({
          title: i.title,
          kind: kindOfItem(i) ?? '',
          created_at: i.created_at,
          state: i.state,
        }))
      return {
        columns: [
          { key: 'title', label: spec.label },
          { key: 'kind', label: '种类' },
          { key: 'created_at', label: '提上来的时间' },
          { key: 'state', label: '状态' },
        ],
        rows,
      }
    },
  }
}

/** 职责 yml 的 `thresholds`；宿主没传就用默认值（阈值不该硬写在积木里，也不该缺了就崩）。 */
export const ANOMALY_DEFAULTS: Readonly<Record<string, number>> = {
  low_stock_quantity: 5,
  sales_drop_pct: 30,
  conversion_drop_pct: 25,
  bad_review_rating: 3,
}

export function thresholdOf(ctx: QueryContext, key: string): number {
  return ctx.thresholds?.[key] ?? ANOMALY_DEFAULTS[key] ?? 0
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
  // ── WP64（51 §2.4）：订单履约 ────────────────────────────────────────
  {
    name: 'orders.unfulfilled',
    source: 'shop',
    returns: 'table',
    run: (ctx) => {
      // 「待发货」= 已付款但还没发货。按下单时间正序——先来的先发，这就是队列本身。
      // 与「超期未发」用的是同一批结构化字段，差别只在那条 3 天的线。
      const rows = ctx.orders
        .filter((o) => o.fulfillment_status === 'unfulfilled')
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
    name: 'fulfillments.today',
    source: 'approvals',
    returns: 'scalar',
    run: (ctx, w) => {
      // 「今日发货数」是**我们标记发货了几单**，所以按施行时间从账本上数，
      // 不从订单的 fulfillment_status 数（那是存量，昨天发的今天还在里面）。
      const points: Point[] = []
      for (const i of ctx.approvals) {
        if (!isChangeKind(i, 'create_fulfillment')) continue
        const at = appliedMs(i)
        if (at === undefined) continue
        points.push({ at, v: 1 })
      }
      return scalarFrom(points, w)
    },
  },
  // ── WP64（51 §2.3）：邮件营销 ───────────────────────────────────────
  {
    name: 'email.pending_sends',
    source: 'approvals',
    returns: 'scalar',
    run: (ctx, w) => {
      // 待审发送是**存量**：现在还压着几条群发等人点头（发送永远 L1，所以这条永远有值）。
      const sends = ctx.approvals.filter((i) => isChangeKind(i, 'campaign_send'))
      const value = sends.filter((i) => PENDING.includes(i.state)).length
      const previous = sends.filter(
        (i) => PENDING.includes(i.state) && createdMs(i) < w.current.from,
      ).length
      const spark = w.spark.map((b) => sends.filter((i) => inWindow(createdMs(i), b)).length)
      return {
        value,
        previous,
        ...(previous === 0 ? {} : { delta_pct: round2(((value - previous) / previous) * 100) }),
        spark,
      }
    },
  },
  // ── WP63（51 §2.1 / §2.2）：店铺管理与内容那几块 ───────────────────

  // 待审改动的四条车道。每一条只是同一份审批项按 `payload.kind` 切一刀——
  // 数从结构化字段来，`title` / `summary` 只当人话用（29 原则 ③）。
  ...PENDING_LANES.map(laneQuery),
  {
    /**
     * 「待发布」这个数字块（51 §2.2）：此刻有几篇压着等人点头。
     *
     * 与 `approvals.pending_replies` 分开：那一个数的是**回信**，这一个数的是**发文**。
     * 同一个"待"字，压着不放的后果完全不同——回信压着客户在等，发文压着没人在等。
     */
    name: 'content.pending_count',
    source: 'approvals',
    returns: 'scalar',
    run: (ctx, w) => {
      const posts = ctx.approvals.filter(
        (i) => i.kind === 'staged_change' && kindOfItem(i) === 'publish_post',
      )
      const value = posts.filter((i) => PENDING.includes(i.state)).length
      const previous = posts.filter(
        (i) => PENDING.includes(i.state) && createdMs(i) < w.current.from,
      ).length
      return {
        value,
        previous,
        ...(previous === 0 ? {} : { delta_pct: round2(((value - previous) / previous) * 100) }),
        spark: w.spark.map((b) => posts.filter((i) => inWindow(createdMs(i), b)).length),
      }
    },
  },
  {
    name: 'inventory.low_stock',
    source: 'shop',
    returns: 'table',
    run: (ctx) => {
      const floor = thresholdOf(ctx, 'low_stock_quantity')
      const rows = (ctx.inventory ?? [])
        .filter((r) => r.quantity <= floor)
        .sort((a, b) => a.quantity - b.quantity)
        .slice(0, 50)
        .map((r) => ({
          sku: r.sku ?? r.id,
          title: r.title,
          quantity: r.quantity,
          location: r.location ?? '',
        }))
      return {
        columns: [
          { key: 'sku', label: 'SKU' },
          { key: 'title', label: '商品' },
          { key: 'quantity', label: '可售', align: 'right' as const, format: 'count' as const },
          { key: 'location', label: '仓' },
        ],
        rows,
      }
    },
  },
  {
    // 「库存告急数」这个数字块。存量指标：现在有几个 SKU 在线以下——
    // 环比拿不到（我们只有此刻的库存快照，没有历史），所以 previous 与 spark 都按
    // 当前值铺平，**不编一条假的走势**。
    name: 'inventory.low_count',
    source: 'shop',
    returns: 'scalar',
    run: (ctx) => {
      const floor = thresholdOf(ctx, 'low_stock_quantity')
      const value = (ctx.inventory ?? []).filter((r) => r.quantity <= floor).length
      return { value, previous: value, spark: new Array(SPARK_BUCKETS).fill(value) }
    },
  },
  {
    name: 'reviews.negative',
    source: 'reviews',
    returns: 'table',
    run: (ctx) => {
      const floor = thresholdOf(ctx, 'bad_review_rating')
      const rows = (ctx.reviews ?? [])
        .filter((r) => r.rating < floor && r.replied !== true)
        .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
        .slice(0, 20)
        .map((r) => ({
          rating: r.rating,
          product: r.product_title ?? r.product_id ?? '',
          author: r.author ?? '',
          at: r.created_at,
          body: r.body.slice(0, 120),
        }))
      return {
        columns: [
          { key: 'rating', label: '评分', align: 'right' as const, format: 'count' as const },
          { key: 'product', label: '商品' },
          { key: 'at', label: '时间' },
          { key: 'body', label: '内容' },
        ],
        rows,
      }
    },
  },
  {
    name: 'content.drafts',
    source: 'shop',
    returns: 'table',
    run: (ctx) => {
      const rows = (ctx.posts ?? [])
        .filter((p) => !p.published)
        .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))
        .slice(0, 20)
        .map((p) => ({
          title: p.title,
          kind: p.kind === 'article' ? '博客' : '页面',
          updated_at: p.updated_at,
          author: p.author ?? '',
        }))
      return {
        columns: [
          { key: 'title', label: '标题' },
          { key: 'kind', label: '类型' },
          { key: 'updated_at', label: '最后改动' },
          { key: 'author', label: '谁写的' },
        ],
        rows,
      }
    },
  },
  {
    // 近 30 天发布与流量。`clicks` 来自 Search Console——**没连就是没有这一格**，
    // 表照出（发了哪几篇是店铺后台的事），流量那一列留空而不是填 0
    // （填 0 会被读成"这篇没人看"，而事实是"我们不知道"）。
    name: 'content.recent_posts',
    source: 'shop',
    returns: 'table',
    run: (ctx) => {
      const since = Date.parse(ctx.now) - 30 * DAY
      const rows = (ctx.posts ?? [])
        .filter((p) => p.published && p.published_at !== undefined)
        .filter((p) => Date.parse(p.published_at as string) >= since)
        .sort((a, b) => Date.parse(b.published_at as string) - Date.parse(a.published_at as string))
        .slice(0, 30)
        .map((p) => ({
          title: p.title,
          published_at: p.published_at ?? '',
          clicks: p.clicks ?? '—',
        }))
      return {
        columns: [
          { key: 'title', label: '标题' },
          { key: 'published_at', label: '发布时间' },
          {
            key: 'clicks',
            label: '自然点击（30 天）',
            align: 'right' as const,
            format: 'count' as const,
          },
        ],
        rows,
      }
    },
  },
  {
    /**
     * 日报卡（51 §2.1 数据日报那一面唯一的产出，L3 自动出、看完归档）。
     *
     * 它是 `kv`：一行一个数，没有图。数全部从结构化行算出来——日报最容易变成
     * "模型写的一段漂亮话"，而 29 原则 ③ 说数字不经模型手。
     */
    name: 'store.daily_report',
    source: 'shop',
    returns: 'table',
    run: (ctx, w) => {
      const money = (n: number) => `${ctx.base_currency} ${n.toFixed(2)}`
      const sales = sum(
        orderPoints(ctx, (o) => o.total_price),
        w.current,
      )
      const prevSales = sum(
        orderPoints(ctx, (o) => o.total_price),
        w.previous,
      )
      const orders = sum(
        orderPoints(ctx, () => 1),
        w.current,
      )
      const floor = thresholdOf(ctx, 'low_stock_quantity')
      const low = (ctx.inventory ?? []).filter((r) => r.quantity <= floor).length
      const pending = ctx.approvals.filter(
        (i) => i.kind === 'staged_change' && PENDING.includes(i.state),
      ).length
      const deltaText =
        prevSales === 0 ? '没有对比期' : `${round2(((sales - prevSales) / prevSales) * 100)}%`
      const at = dayLabel(w.current.from, ctx.tz_offset_minutes)
      return {
        columns: [
          { key: 'item', label: at },
          { key: 'value', label: '', align: 'right' as const },
        ],
        rows: [
          { item: '销售额', value: money(sales) },
          { item: '环比', value: deltaText },
          { item: '订单数', value: String(orders) },
          { item: '库存告急', value: `${low} 个 SKU` },
          { item: '待审改动', value: `${pending} 条` },
        ],
      }
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
  // WP64：邮件营销后台与物流追踪的连接器还是骨架（目录 + 只读动作 + 原生表单，
  // 真调用没接）。查询先在册——积木、面板、权限都按它装配好；连上那天换的是 `run`，
  // 不是面板。在此之前这几块一律走「去连接」那一支，一个编出来的数字都没有。
  { name: 'email.flows', source: 'email_marketing', returns: 'table', run: () => EMPTY_TABLE },
  {
    name: 'email.campaign_performance',
    source: 'email_marketing',
    returns: 'table',
    run: () => EMPTY_TABLE,
  },
  { name: 'shipments.exceptions', source: 'tracking', returns: 'table', run: () => EMPTY_TABLE },
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
