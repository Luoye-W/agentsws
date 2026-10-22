/**
 * WP438（WP434 设计第二阶段，决策 1332–1336）：**报表**——以图表为主、取真实数据、会自己更新的一份分析。
 *
 * 一份报表 = 一个**规格**（{@link ReportSpec}）：标题、归哪个岗位 / 哪几条职责、头条数、几块积木。
 * 每块写清「取什么数 + 用哪种图」（指标 {@link REPORT_METRICS}、数据集 {@link REPORT_DATASETS}）。
 * 对话里的小报表、看板上那一行、第三栏的整页，都是**同一份规格的三种画法**。
 *
 * 三条纪律（同 29 原则 ③ / 36 §3）：
 * - **数字不经模型手**：每个数都从 `QueryContext` 的结构化行算出来；结论那三句也由数拼出来（{@link conclusionOf}）。
 * - **读不到的照实占位**：没连的数据源 → `not_connected`（块原位放「就地连接」）；连了但上游没给那一格
 *   （订单没有来源、没有行项目）→ `empty` 并说一句为什么，**不编数、不出 0**。
 * - **时间靠注入**：所有窗口从 `ctx.now` 切，按工作区时区的自然日。
 */
import type { ApprovalItem } from '@agentsws/contracts'
import { SOURCE_LABELS } from './blocks.js'
import { runQuery, sourceStatus, startOfDay } from './queries.js'
import type { DataSourceId, OrderRow, QueryContext, ScalarResult, TableResult } from './types.js'

const DAY = 86_400_000

// ── 基本类型 ──────────────────────────────────────────────────────────

/** 报表页右上角那三档（7 / 30 / 90 天，全是**完整的自然日**，到昨天为止）。 */
export type ReportRange = '1d' | '7d' | '30d' | '90d'
export const REPORT_RANGES: readonly ReportRange[] = ['7d', '30d', '90d']
export const RANGE_DAYS: Readonly<Record<ReportRange, number>> = {
  '1d': 1,
  '7d': 7,
  '30d': 30,
  '90d': 90,
}

export type ReportFormat = 'currency' | 'count' | 'percent' | 'hours' | 'position' | 'decimal'

/** `ok` 有数；`empty` 连上了但这一格上游没给 / 还没有；`not_connected` 数据源没连。 */
export type ReportStatus = 'ok' | 'empty' | 'not_connected'

/** 多久重算一次（决策 1336 甲：默认每天 06:00，打开时补最新）。 */
export type ReportRefresh = 'daily' | 'weekly' | 'on_open'

/** 缺的那一样（块原位那句「还没连」+ 连接按钮按它出）。 */
export interface ReportNeed {
  source: DataSourceId
  label: string
}

export interface ReportSourceRef {
  id: DataSourceId
  label: string
}

/** 一个数（KPI 条一格、首页关键数字一格、看板一行的头条数）。 */
export interface ReportMetricValue {
  key: string
  label: string
  format: ReportFormat
  currency?: string
  status: ReportStatus
  value?: number
  previous?: number
  /** 涨跌：百分比（`pct`）或差几个点（`pt`，比例类）。 */
  delta?: number
  delta_unit?: 'pct' | 'pt'
  /** 越小越好（退款、回复时长）。 */
  invert?: boolean
  /** 一行小字（「前 30 天 $40.7k」不在这里——前端按 previous 拼；这里放「超 24 小时 1」这类）。 */
  note?: string
  /** 这一段每天的值（小走势）。算不出每天的（GA4 汇总）没有。 */
  spark?: number[]
  source: DataSourceId
  need?: ReportNeed
}

// ── 规格 ──────────────────────────────────────────────────────────────

interface BlockBase {
  id: string
  title?: string
  subtitle?: string
  /** 两列里占满一行（大块）。 */
  wide?: boolean
}

export type ReportBlockSpec =
  | (BlockBase & { kind: 'kpis'; metrics: string[] })
  | (BlockBase & { kind: 'trend'; metric: string; events?: boolean })
  | (BlockBase & {
      kind: 'rank' | 'funnel' | 'stacked' | 'table' | 'share' | 'tiles' | 'bars'
      dataset: string
    })

/** 结论卡的动作钮：点了变成一张卡进「要你处理」（问 AI 起一件事）。 */
export interface ReportAction {
  label: string
  prompt: string
}

export interface ReportSpec {
  id: string
  title: string
  /** 归哪个岗位（岗位模板 id：`web-ops`）。 */
  position: string
  /** 职责层固定在哪几条职责上（`dtc.store`…）；岗位层一律都有。 */
  duties: string[]
  /** 取数用本人哪条职责的分配（按顺序找第一条持有的）。 */
  compute_roles: string[]
  /** 头条数（看板那一行、首页关键数字、岗位卡）——是 `kpis` 里的某个指标 key。 */
  headline: string
  /** 头条数前面那几个字（「近 30 天销售额」）。不给 = 指标名。 */
  headline_label?: string
  blocks: ReportBlockSpec[]
  origin: 'default' | 'ai'
  refresh: ReportRefresh
  default_range: ReportRange
  /** 「要留意」那一句挑哪几个数看（不给 = KPI 条全部）。 */
  watch?: string[]
  /** 指标 → 结论卡的动作钮。 */
  actions?: Record<string, ReportAction>
  /** AI 做的：哪天、因为哪句话做的。 */
  created?: { at: string; prompt: string }
}

// ── 结果 ──────────────────────────────────────────────────────────────

export interface ReportEvent {
  /** `YYYY-MM-DD`（工作区时区） */
  date: string
  label: string
}

export interface TrendPayload {
  x: string[]
  current: number[]
  previous: number[]
  format: ReportFormat
  currency?: string
  label: string
  events: ReportEvent[]
}

export interface RankPayload {
  rows: { label: string; value: number; share: number; note?: string; tag?: string }[]
  format: ReportFormat
  currency?: string
}

export interface FunnelPayload {
  steps: { label: string; value: number; rate?: number }[]
}

export interface StackedPayload {
  x: string[]
  series: { key: string; label: string; points: number[] }[]
  format: ReportFormat
}

export interface TablePayload {
  columns: {
    key: string
    label: string
    align?: 'left' | 'right'
    format?: ReportFormat | 'spark' | 'delta' | 'text'
  }[]
  rows: Record<string, string | number | number[] | null>[]
  currency?: string
}

export interface SharePayload {
  parts: { key: string; label: string; value: number; tone: 'good' | 'neutral' | 'bad' }[]
  total: number
}

export interface TilesPayload {
  items: { label: string; value: number; format: ReportFormat; tone?: 'warn' }[]
}

/** 每天几根柱 + 一条线（同一单位、一根纵轴）。 */
export interface BarsPayload {
  x: string[]
  bars: { label: string; points: number[]; tones?: ('a' | 'b')[] }
  line?: { label: string; points: number[] }
  legend?: { a: string; b?: string }
  format: ReportFormat
}

export interface KpisPayload {
  items: ReportMetricValue[]
}

export type ReportBlockData = {
  id: string
  kind: ReportBlockSpec['kind']
  title?: string
  subtitle?: string
  wide?: boolean
  status: ReportStatus
  sources: ReportSourceRef[]
  /** `not_connected` 时缺的那几样。 */
  needs?: ReportNeed[]
  /** `empty` 时那句为什么（「店铺后台给的订单没带来源」）。 */
  note?: string
  payload?:
    | KpisPayload
    | TrendPayload
    | RankPayload
    | FunnelPayload
    | StackedPayload
    | TablePayload
    | SharePayload
    | TilesPayload
    | BarsPayload
}

export interface ReportConclusion {
  /** 三句；最后一句是「要留意：…」。`**粗体**` 照写。 */
  lines: string[]
  action?: ReportAction
  /** `rules` = 由数拼出来的（没经模型）；`ai` = 定时更新时模型写的那一次。 */
  by: 'rules' | 'ai'
}

export interface ReportData {
  id: string
  title: string
  position: string
  origin: 'default' | 'ai'
  refresh: ReportRefresh
  range: ReportRange
  period: { from: string; to: string; compare_from: string; compare_to: string }
  /** 这一份是什么时候算的（快照时间）。 */
  computed_at: string
  created?: { at: string; prompt: string }
  conclusion?: ReportConclusion
  blocks: ReportBlockData[]
}

/** 看板那一行 / 首页那一格。 */
export interface ReportSummary {
  id: string
  title: string
  position: string
  origin: 'default' | 'ai'
  refresh: ReportRefresh
  headline_label: string
  headline: ReportMetricValue
  /** 近 30 天每天的头条数（小走势）。 */
  spark?: number[]
  created?: { at: string; prompt: string }
}

// ── 时间窗 ────────────────────────────────────────────────────────────

export interface ReportWindow {
  /** [from, to) */
  from: number
  to: number
}

export interface ReportWindows {
  range: ReportRange
  days: number
  current: ReportWindow
  previous: ReportWindow
  /** 这一段每天一格。 */
  daily: ReportWindow[]
  /** 上一段每天一格（和 `daily` 一一对齐）。 */
  previousDaily: ReportWindow[]
}

/**
 * 报表的时间窗：**到昨天为止**的 N 个完整自然日（工作区时区）；对比期 = 紧挨着的前 N 天。
 * 和「今天 06:00 更新」对得上：早上看到的是昨天收完的那一段，不是今天到现在的半截。
 */
export function reportWindows(range: ReportRange, now: string, tz: number): ReportWindows {
  const days = RANGE_DAYS[range]
  const today = startOfDay(Date.parse(now), tz)
  const current = { from: today - days * DAY, to: today }
  const previous = { from: today - 2 * days * DAY, to: today - days * DAY }
  const daily: ReportWindow[] = []
  const previousDaily: ReportWindow[] = []
  for (let i = 0; i < days; i += 1) {
    daily.push({ from: current.from + i * DAY, to: current.from + (i + 1) * DAY })
    previousDaily.push({ from: previous.from + i * DAY, to: previous.from + (i + 1) * DAY })
  }
  return { range, days, current, previous, daily, previousDaily }
}

/** `YYYY-MM-DD`（工作区时区）。 */
export function reportDay(ms: number, tz: number): string {
  return new Date(ms + tz * 60_000).toISOString().slice(0, 10)
}

const within = (ms: number, w: ReportWindow): boolean => ms >= w.from && ms < w.to

const round = (v: number, digits = 2): number => {
  const k = 10 ** digits
  return Math.round(v * k) / k
}

// ── 订单的几样派生 ────────────────────────────────────────────────────

const orderMs = (o: OrderRow): number => Date.parse(o.created_at)

function ordersIn(ctx: QueryContext, w: ReportWindow): OrderRow[] {
  return ctx.orders.filter((o) => within(orderMs(o), w))
}

/** 每个客人（按邮箱）第一笔单的时间——判新客 / 老客。没有邮箱的单不算进新老客。 */
function firstOrderAt(ctx: QueryContext): Map<string, number> {
  const first = new Map<string, number>()
  for (const o of ctx.orders) {
    const key = o.email.trim().toLowerCase()
    if (key === '') continue
    const at = orderMs(o)
    const prev = first.get(key)
    if (prev === undefined || at < prev) first.set(key, at)
  }
  return first
}

function isReturning(o: OrderRow, first: Map<string, number>): boolean | undefined {
  const key = o.email.trim().toLowerCase()
  if (key === '') return undefined
  const at = first.get(key)
  return at !== undefined && orderMs(o) > at
}

export type OrderChannel = 'search' | 'direct' | 'email' | 'social' | 'paid' | 'ai' | 'other'

export const ORDER_CHANNEL_LABELS: Readonly<Record<OrderChannel, string>> = {
  search: '自然搜索',
  direct: '直接访问',
  email: '邮件',
  social: '社媒',
  paid: '付费广告',
  ai: 'AI 回答里点进来',
  other: '其他网站',
}

const AI_HOSTS = [
  'chatgpt.com',
  'chat.openai.com',
  'perplexity.ai',
  'gemini.google.com',
  'copilot.microsoft.com',
  'claude.ai',
  'you.com',
  'poe.com',
]
const SEARCH_HOSTS = ['google.', 'bing.com', 'duckduckgo.com', 'yahoo.', 'baidu.com', 'yandex.']
const SOCIAL_HOSTS = [
  'facebook.com',
  'instagram.com',
  'tiktok.com',
  'x.com',
  't.co',
  'twitter.com',
  'reddit.com',
  'youtube.com',
  'pinterest.',
  'linkedin.com',
  'threads.net',
]
const MAIL_HOSTS = ['mail.', 'outlook.', 'gmail.', 'klaviyo', 'mailchi.mp']

function hostOf(raw: string): string {
  try {
    return new URL(raw.includes('://') ? raw : `https://${raw}`).hostname.toLowerCase()
  } catch {
    return raw.toLowerCase()
  }
}

function paramsOf(raw: string | undefined): URLSearchParams | undefined {
  if (raw === undefined || raw === '') return undefined
  const q = raw.indexOf('?')
  return q < 0 ? undefined : new URLSearchParams(raw.slice(q + 1))
}

/**
 * 这一单从哪来：先看落地页上的 utm / 点击 id（付费、邮件），再看进店来源的域名。
 * **两样都没有 = `undefined`**（上游没给就是不知道，不归「直接访问」）。
 */
export function orderChannel(o: OrderRow): OrderChannel | undefined {
  const params = paramsOf(o.landing_site)
  if (params !== undefined) {
    const medium = (params.get('utm_medium') ?? '').toLowerCase()
    const src = (params.get('utm_source') ?? '').toLowerCase()
    if (params.has('gclid') || params.has('fbclid') || /^(cpc|ppc|paid|paid_social)$/.test(medium))
      return 'paid'
    if (medium === 'email' || /email|newsletter|klaviyo/.test(src)) return 'email'
  }
  const ref = o.referring_site
  if (ref !== undefined && ref !== '') {
    const host = hostOf(ref)
    if (AI_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return 'ai'
    if (MAIL_HOSTS.some((h) => host.includes(h))) return 'email'
    if (SEARCH_HOSTS.some((h) => host.includes(h))) return 'search'
    if (SOCIAL_HOSTS.some((h) => host === h || host.endsWith(`.${h}`) || host.includes(h)))
      return 'social'
    return 'other'
  }
  if (o.landing_site !== undefined && o.landing_site !== '') return 'direct'
  return undefined
}

const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0)

// ── 审批项的几样派生（客服、事件标记） ──────────────────────────────────

function appliedAt(i: ApprovalItem): number | undefined {
  const attempts = i.apply?.attempts ?? []
  for (let k = attempts.length - 1; k >= 0; k -= 1) {
    const a = attempts[k]
    if (a !== undefined && a.result === 'ok') return Date.parse(a.at)
  }
  return undefined
}

const decidedAt = (i: ApprovalItem): number | undefined =>
  i.decision?.at === undefined ? undefined : Date.parse(i.decision.at)

const PENDING = ['pending', 'in_review']

const drafts = (ctx: QueryContext): ApprovalItem[] =>
  ctx.approvals.filter((i) => i.kind === 'outbound_draft')

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const changeKind = (i: ApprovalItem): string | undefined =>
  i.kind === 'staged_change' && isRecord(i.payload) && typeof i.payload.kind === 'string'
    ? i.payload.kind
    : undefined

/** 工坊替你做过的事（趋势图上的蓝点）：这一段里**真做成了**的改动，按做成的那天。 */
export function reportEvents(ctx: QueryContext, w: ReportWindow): ReportEvent[] {
  const out: { at: number; label: string }[] = []
  for (const i of ctx.approvals) {
    const at = appliedAt(i)
    if (at === undefined || !within(at, w)) continue
    if (changeKind(i) === 'refund') continue
    out.push({ at, label: i.title })
  }
  out.sort((a, b) => a.at - b.at)
  // 一天只标一件（同一天的第一件），最多 6 个点——再多图上就糊了
  const seen = new Set<string>()
  const events: ReportEvent[] = []
  for (const e of out) {
    const date = reportDay(e.at, ctx.tz_offset_minutes)
    if (seen.has(date)) continue
    seen.add(date)
    events.push({ date, label: e.label.length > 18 ? `${e.label.slice(0, 17)}…` : e.label })
  }
  return events.slice(-6)
}

// ── 指标 ──────────────────────────────────────────────────────────────

interface MetricDef {
  key: string
  label: string
  source: DataSourceId
  format: ReportFormat
  invert?: boolean
  /** 一段时间里的值（算不出 = `undefined`）。 */
  value?(ctx: QueryContext, w: ReportWindow): number | undefined
  /**
   * 不按报表窗口的「现成两段」：GA4 / Search Console 的缓存只有它自己那一段汇总，
   * 照实给那一段（`note` 写清是哪一段），没有每天的数。
   */
  fixed?(ctx: QueryContext): { value: number; previous?: number; note?: string } | undefined
  /** 存量（「现在还压着几条」）：只看现在，没有对比、没有每天。 */
  stock?(ctx: QueryContext): number | undefined
  /** 连上了却算不出时那一句。 */
  emptyNote?: string
  /** 宿主没递这一块进来时（`ctx.pr` 之类）算「还没有」。 */
  available?(ctx: QueryContext): boolean
  /**
   * 直接用一条现成的标量命名查询（近 7 天那一档；数在原查询里算好）。红人 / 投放这几份的头条数用它，
   * 和岗位面板上那一格是同一个数。
   */
  query?: string
}

const salesIn = (ctx: QueryContext, w: ReportWindow): number =>
  round(sum(ordersIn(ctx, w).map((o) => o.total_price)))

function channelSales(ctx: QueryContext, w: ReportWindow, ch: OrderChannel): number | undefined {
  const orders = ordersIn(ctx, w)
  if (!ctx.orders.some((o) => orderChannel(o) !== undefined)) return undefined
  return round(sum(orders.filter((o) => orderChannel(o) === ch).map((o) => o.total_price)))
}

function channelOrders(ctx: QueryContext, w: ReportWindow, ch: OrderChannel): number | undefined {
  if (!ctx.orders.some((o) => orderChannel(o) !== undefined)) return undefined
  return ordersIn(ctx, w).filter((o) => orderChannel(o) === ch).length
}

function ga4(ctx: QueryContext) {
  const g = ctx.search?.ga4
  if (g === undefined || g.needs_pick === true || g.current === undefined) return undefined
  return g
}

function ga4Note(ctx: QueryContext): string | undefined {
  const w = ctx.search?.ga4?.window
  return w === undefined ? undefined : `GA4 ${w.start.slice(5)} 至 ${w.end.slice(5)}`
}

function gscRows(ctx: QueryContext) {
  const g = ctx.search?.gsc
  if (g === undefined || g.needs_pick === true) return undefined
  return g.queries
}

function gscNote(ctx: QueryContext): string | undefined {
  const w = ctx.search?.gsc?.window
  return w === undefined ? undefined : `Search Console ${w.start.slice(5)} 至 ${w.end.slice(5)}`
}

const prMentions = (ctx: QueryContext) =>
  (ctx.pr?.mentions ?? []).filter((m) => (m.group ?? 'own') === 'own')

const prPosts = (ctx: QueryContext) => (ctx.pr?.external_posts ?? []).filter((p) => !p.removed)

/**
 * 指标表：一个 key 一个数。新报表（含 AI 做的）只能从这里挑——**不在表里的数不出现**（29 原则 ①）。
 */
export const REPORT_METRICS: readonly MetricDef[] = [
  // ── 店铺后台 ──
  { key: 'sales', label: '销售额', source: 'shop', format: 'currency', value: salesIn },
  {
    key: 'orders',
    label: '订单',
    source: 'shop',
    format: 'count',
    value: (ctx, w) => ordersIn(ctx, w).length,
  },
  {
    key: 'aov',
    label: '客单价',
    source: 'shop',
    format: 'currency',
    value: (ctx, w) => {
      const n = ordersIn(ctx, w).length
      return n === 0 ? undefined : round(salesIn(ctx, w) / n)
    },
  },
  {
    key: 'new_share',
    label: '新客占比',
    source: 'shop',
    format: 'percent',
    value: (ctx, w) => {
      const first = firstOrderAt(ctx)
      const known = ordersIn(ctx, w)
        .map((o) => isReturning(o, first))
        .filter((x): x is boolean => x !== undefined)
      return known.length === 0
        ? undefined
        : round((known.filter((x) => !x).length / known.length) * 100, 1)
    },
    emptyNote: '订单没带客人邮箱，分不出新老客',
  },
  {
    key: 'returning_orders',
    label: '老客回购订单',
    source: 'shop',
    format: 'count',
    value: (ctx, w) => {
      const first = firstOrderAt(ctx)
      return ordersIn(ctx, w).filter((o) => isReturning(o, first) === true).length
    },
  },
  {
    key: 'returning_sales',
    label: '老客回购收入',
    source: 'shop',
    format: 'currency',
    value: (ctx, w) => {
      const first = firstOrderAt(ctx)
      return round(
        sum(
          ordersIn(ctx, w)
            .filter((o) => isReturning(o, first) === true)
            .map((o) => o.total_price),
        ),
      )
    },
  },
  {
    key: 'refunds',
    label: '退款',
    source: 'shop',
    format: 'currency',
    invert: true,
    value: (ctx, w) => round(sum(ordersIn(ctx, w).map((o) => o.refunded_amount))),
  },
  {
    key: 'email_sales',
    label: '邮件带来',
    source: 'shop',
    format: 'currency',
    value: (ctx, w) => channelSales(ctx, w, 'email'),
    emptyNote: '店铺后台给的订单没带来源，分不出哪些是邮件带来的',
  },
  {
    key: 'email_orders',
    label: '邮件带来的订单',
    source: 'shop',
    format: 'count',
    value: (ctx, w) => channelOrders(ctx, w, 'email'),
    emptyNote: '店铺后台给的订单没带来源',
  },
  {
    key: 'search_orders',
    label: '自然搜索带来的订单',
    source: 'shop',
    format: 'count',
    value: (ctx, w) => channelOrders(ctx, w, 'search'),
    emptyNote: '店铺后台给的订单没带来源',
  },
  {
    key: 'ai_orders',
    label: 'AI 回答带来的订单',
    source: 'shop',
    format: 'count',
    value: (ctx, w) => channelOrders(ctx, w, 'ai'),
    emptyNote: '店铺后台给的订单没带来源',
  },
  {
    key: 'ai_sales',
    label: 'AI 回答带来的销售额',
    source: 'shop',
    format: 'currency',
    value: (ctx, w) => channelSales(ctx, w, 'ai'),
    emptyNote: '店铺后台给的订单没带来源',
  },
  // ── GA4（缓存里只有自己那一段汇总） ──
  {
    key: 'visitors',
    label: '访客',
    source: 'ga4',
    format: 'count',
    fixed: (ctx) => {
      const g = ga4(ctx)
      if (g?.current === undefined) return undefined
      const note = ga4Note(ctx)
      return {
        value: g.current.active_users,
        ...(g.previous === undefined ? {} : { previous: g.previous.active_users }),
        ...(note === undefined ? {} : { note }),
      }
    },
    emptyNote: 'GA4 连上了，先选一下媒体资源',
  },
  {
    key: 'sessions',
    label: '会话',
    source: 'ga4',
    format: 'count',
    fixed: (ctx) => {
      const g = ga4(ctx)
      if (g?.current === undefined) return undefined
      return {
        value: g.current.sessions,
        ...(g.previous === undefined ? {} : { previous: g.previous.sessions }),
      }
    },
    emptyNote: 'GA4 连上了，先选一下媒体资源',
  },
  {
    key: 'conversion',
    label: '转化率',
    source: 'ga4',
    format: 'percent',
    fixed: (ctx) => {
      const g = ga4(ctx)
      if (g?.current === undefined || g.current.sessions === 0) return undefined
      const rate = (t: { purchases: number; sessions: number }): number =>
        round((t.purchases / t.sessions) * 100, 2)
      return {
        value: rate(g.current),
        ...(g.previous === undefined || g.previous.sessions === 0
          ? {}
          : { previous: rate(g.previous) }),
      }
    },
    emptyNote: 'GA4 连上了，先选一下媒体资源',
  },
  // ── Search Console（缓存里只有自己那一段汇总） ──
  {
    key: 'gsc_clicks',
    label: '自然搜索点击',
    source: 'gsc',
    format: 'count',
    fixed: (ctx) => {
      const rows = gscRows(ctx)
      if (rows === undefined) return undefined
      const note = gscNote(ctx)
      return { value: sum(rows.map((r) => r.clicks)), ...(note === undefined ? {} : { note }) }
    },
    emptyNote: 'Search Console 连上了，先选一下是哪个站点',
  },
  {
    key: 'gsc_impressions',
    label: '展示',
    source: 'gsc',
    format: 'count',
    fixed: (ctx) => {
      const rows = gscRows(ctx)
      return rows === undefined ? undefined : { value: sum(rows.map((r) => r.impressions)) }
    },
    emptyNote: 'Search Console 连上了，先选一下是哪个站点',
  },
  {
    key: 'gsc_ctr',
    label: '点击率',
    source: 'gsc',
    format: 'percent',
    fixed: (ctx) => {
      const rows = gscRows(ctx)
      if (rows === undefined) return undefined
      const imp = sum(rows.map((r) => r.impressions))
      return imp === 0 ? undefined : { value: round((sum(rows.map((r) => r.clicks)) / imp) * 100) }
    },
    emptyNote: 'Search Console 连上了，先选一下是哪个站点',
  },
  {
    key: 'gsc_position',
    label: '平均排名',
    source: 'gsc',
    format: 'position',
    invert: true,
    fixed: (ctx) => {
      const rows = gscRows(ctx)
      if (rows === undefined) return undefined
      const imp = sum(rows.map((r) => r.impressions))
      // 按展示加权（与 Search Console 自己的口径一致），不是各行排名的简单平均
      return imp === 0
        ? undefined
        : { value: round(sum(rows.map((r) => r.position * r.impressions)) / imp, 1) }
    },
    emptyNote: 'Search Console 连上了，先选一下是哪个站点',
  },
  // ── 工作队列（客服） ──
  {
    key: 'pending_replies',
    label: '待回复',
    source: 'approvals',
    format: 'count',
    invert: true,
    stock: (ctx) => drafts(ctx).filter((i) => PENDING.includes(i.state)).length,
  },
  {
    key: 'reply_rate_24h',
    label: '24 小时内回复',
    source: 'approvals',
    format: 'percent',
    value: (ctx, w) => {
      const all = drafts(ctx).filter((i) => within(Date.parse(i.created_at), w))
      if (all.length === 0) return undefined
      const hit = all.filter((i) => {
        const done = decidedAt(i)
        return done !== undefined && done - Date.parse(i.created_at) <= DAY
      }).length
      return round((hit / all.length) * 100, 1)
    },
    emptyNote: '这一段还没有要回的信',
  },
  {
    key: 'drafts',
    label: 'AI 起草的回复',
    source: 'approvals',
    format: 'count',
    value: (ctx, w) => drafts(ctx).filter((i) => within(Date.parse(i.created_at), w)).length,
  },
  {
    key: 'auto_share',
    label: 'AI 自己处理',
    source: 'approvals',
    format: 'percent',
    value: (ctx, w) => {
      const decided = ctx.approvals.filter((i) => {
        const at = decidedAt(i)
        return at !== undefined && within(at, w)
      })
      if (decided.length === 0) return undefined
      const auto = decided.filter((i) => i.state === 'auto_approved').length
      return round((auto / decided.length) * 100, 1)
    },
    emptyNote: '这一段还没有处理完的事',
  },
  {
    key: 'refund_requests',
    label: '退款申请',
    source: 'approvals',
    format: 'count',
    invert: true,
    value: (ctx, w) =>
      ctx.approvals.filter((i) => changeKind(i) === 'refund' && within(Date.parse(i.created_at), w))
        .length,
  },
  { key: 'csat', label: '满意度', source: 'csat', format: 'percent' },
  // ── 公关库（Reddit / 论坛 / 监控） ──
  {
    key: 'mentions',
    label: '品牌被提到',
    source: 'pr',
    format: 'count',
    available: (ctx) => ctx.pr !== undefined,
    value: (ctx, w) => prMentions(ctx).filter((m) => within(Date.parse(m.published_at), w)).length,
  },
  {
    key: 'our_replies',
    label: '我们回帖',
    source: 'pr',
    format: 'count',
    available: (ctx) => ctx.pr !== undefined,
    value: (ctx, w) =>
      prPosts(ctx).filter(
        (p) => p.published_at !== undefined && within(Date.parse(p.published_at), w),
      ).length,
  },
  {
    key: 'reply_votes',
    label: '回帖获赞',
    source: 'pr',
    format: 'count',
    available: (ctx) => ctx.pr !== undefined,
    value: (ctx, w) =>
      sum(
        prPosts(ctx)
          .filter((p) => p.published_at !== undefined && within(Date.parse(p.published_at), w))
          .map((p) => p.score ?? 0),
      ),
  },
  {
    key: 'positive_share',
    label: '正面占比',
    source: 'pr',
    format: 'percent',
    available: (ctx) => ctx.pr !== undefined,
    value: (ctx, w) => {
      const judged = prMentions(ctx).filter(
        (m) => within(Date.parse(m.published_at), w) && m.sentiment !== undefined,
      )
      if (judged.length === 0) return undefined
      return round(
        (judged.filter((m) => m.sentiment === 'positive').length / judged.length) * 100,
        1,
      )
    },
    emptyNote: '这一段的提及还没判情绪',
  },
  {
    key: 'negative_mentions',
    label: '负面提及',
    source: 'pr',
    format: 'count',
    invert: true,
    available: (ctx) => ctx.pr !== undefined,
    value: (ctx, w) =>
      prMentions(ctx).filter(
        (m) => within(Date.parse(m.published_at), w) && m.sentiment === 'negative',
      ).length,
  },
  // ── 社媒库 ──
  {
    key: 'social_posts',
    label: '发出去的帖子',
    source: 'social',
    format: 'count',
    available: (ctx) => ctx.social !== undefined,
    value: (ctx, w) =>
      (ctx.social?.calendar ?? []).filter(
        (p) => p.published_at !== undefined && within(Date.parse(p.published_at), w),
      ).length,
  },
  {
    key: 'social_engagement',
    label: '互动',
    source: 'social',
    format: 'count',
    available: (ctx) => ctx.social !== undefined,
    value: (ctx, w) => {
      const rows = (ctx.social?.performance ?? []).filter(
        (p) =>
          p.published_at !== undefined &&
          within(Date.parse(p.published_at), w) &&
          p.observed_at !== undefined,
      )
      return sum(rows.map((p) => (p.likes ?? 0) + (p.comments ?? 0)))
    },
  },
  {
    key: 'social_pending_comments',
    label: '待回评论',
    source: 'social',
    format: 'count',
    invert: true,
    available: (ctx) => ctx.social !== undefined,
    stock: (ctx) => ctx.social?.pending_comments.length,
  },
  // ── 红人库 / 投放 / B2B（现成标量查询） ──
  {
    key: 'kol_active',
    label: '在合作的红人',
    source: 'kol',
    format: 'count',
    query: 'kol.active_count',
  },
  {
    key: 'kol_awaiting',
    label: '等红人回信',
    source: 'kol',
    format: 'count',
    query: 'kol.awaiting_reply',
  },
  {
    key: 'kol_revenue',
    label: '红人带来的销售额',
    source: 'kol',
    format: 'currency',
    query: 'kol.revenue',
  },
  {
    key: 'ads_spend_today',
    label: '今日花费',
    source: 'ads',
    format: 'currency',
    query: 'ads.spend_today',
  },
  {
    key: 'ads_roas',
    label: '广告回报 ROAS',
    source: 'ads',
    format: 'decimal',
    query: 'ads.roas_two_views',
  },
  {
    key: 'ads_stop_loss',
    label: '止损次数',
    source: 'ads',
    format: 'count',
    invert: true,
    query: 'ads.stop_loss_count',
  },
  {
    key: 'b2b_inquiries',
    label: '询盘',
    source: 'b2b',
    format: 'count',
    available: (ctx) => ctx.b2b !== undefined,
    value: (ctx, w) =>
      (ctx.b2b?.inquiries ?? []).filter((i) => within(Date.parse(i.received_at), w)).length,
  },
  {
    key: 'b2b_quotes_pending',
    label: '报价待审',
    source: 'b2b',
    format: 'count',
    available: (ctx) => ctx.b2b !== undefined,
    stock: (ctx) => ctx.b2b?.quotes_pending.length,
  },
]

const METRIC_BY_KEY = new Map(REPORT_METRICS.map((m) => [m.key, m]))

export function reportMetricDef(key: string): MetricDef | undefined {
  return METRIC_BY_KEY.get(key)
}

const needOf = (source: DataSourceId): ReportNeed => ({ source, label: SOURCE_LABELS[source] })

function connected(ctx: QueryContext, source: DataSourceId): boolean {
  // 我们自己的库永远算连上（同 blocks.ts 的口径）
  if (
    source === 'pr' ||
    source === 'approvals' ||
    source === 'kol' ||
    source === 'social' ||
    source === 'b2b'
  )
    return true
  return sourceStatus(ctx, source)
}

function deltaOf(
  value: number,
  previous: number | undefined,
  format: ReportFormat,
): { delta?: number; delta_unit?: 'pct' | 'pt' } {
  if (previous === undefined) return {}
  if (format === 'percent' || format === 'position')
    return { delta: round(value - previous, format === 'position' ? 1 : 2), delta_unit: 'pt' }
  if (previous === 0) return {}
  return { delta: round(((value - previous) / previous) * 100, 1), delta_unit: 'pct' }
}

/** 算一个数（KPI 一格）。 */
export function computeMetric(
  key: string,
  ctx: QueryContext,
  wins: ReportWindows,
): ReportMetricValue {
  const def = METRIC_BY_KEY.get(key)
  if (def === undefined)
    return { key, label: key, format: 'count', status: 'empty', source: 'approvals' }
  const base = {
    key,
    label: def.label,
    format: def.format,
    source: def.source,
    ...(def.invert === true ? { invert: true } : {}),
    ...(def.format === 'currency' ? { currency: ctx.base_currency } : {}),
  }
  if (!connected(ctx, def.source))
    return { ...base, status: 'not_connected', need: needOf(def.source) }
  if (def.available !== undefined && !def.available(ctx))
    return { ...base, status: 'empty', note: '这台机器上还没有这一块的数据' }
  if (def.query !== undefined) {
    let got: ReturnType<typeof runQuery>
    try {
      got = runQuery(def.query, ctx, 'last_7d')
    } catch {
      return { ...base, status: 'empty' }
    }
    if (got.status !== 'ok') return { ...base, status: 'not_connected', need: needOf(got.source) }
    const sc = got.data as ScalarResult
    if (typeof sc.value !== 'number') return { ...base, status: 'empty' }
    return {
      ...base,
      status: 'ok',
      value: sc.value,
      previous: sc.previous,
      ...deltaOf(sc.value, sc.previous, def.format),
      spark: sc.spark,
      note: '近 7 天',
    }
  }
  if (def.stock !== undefined) {
    const v = def.stock(ctx)
    return v === undefined ? { ...base, status: 'empty' } : { ...base, status: 'ok', value: v }
  }
  if (def.fixed !== undefined) {
    const got = def.fixed(ctx)
    if (got === undefined)
      return {
        ...base,
        status: 'empty',
        ...(def.emptyNote === undefined ? {} : { note: def.emptyNote }),
      }
    return {
      ...base,
      status: 'ok',
      value: got.value,
      ...(got.previous === undefined ? {} : { previous: got.previous }),
      ...deltaOf(got.value, got.previous, def.format),
      ...(got.note === undefined ? {} : { note: got.note }),
    }
  }
  const run = def.value
  if (run === undefined)
    return {
      ...base,
      status: 'empty',
      ...(def.emptyNote === undefined ? {} : { note: def.emptyNote }),
    }
  const value = run(ctx, wins.current)
  if (value === undefined)
    return {
      ...base,
      status: 'empty',
      ...(def.emptyNote === undefined ? {} : { note: def.emptyNote }),
    }
  const previous = run(ctx, wins.previous)
  const spark = wins.daily.map((d) => run(ctx, d) ?? 0)
  return {
    ...base,
    status: 'ok',
    value,
    ...(previous === undefined ? {} : { previous }),
    ...deltaOf(value, previous, def.format),
    spark,
  }
}

// ── 数据集（除 KPI / 趋势以外的那几种块） ─────────────────────────────

type DatasetResult =
  | { status: 'ok'; payload: NonNullable<ReportBlockData['payload']> }
  | { status: 'empty'; note: string }
  | { status: 'not_connected'; needs: ReportNeed[] }

interface DatasetDef {
  id: string
  sources: DataSourceId[]
  run(ctx: QueryContext, wins: ReportWindows): DatasetResult
}

const label = (d: string): string => d.slice(5)

/** 上一段和这一段比的百分比（上一段是 0 回 `undefined`）。 */
const pctChange = (now: number, before: number): number | undefined =>
  before === 0 ? undefined : round(((now - before) / before) * 100, 1)

function weeksBack(ctx: QueryContext, n: number): ReportWindow[] {
  const today = startOfDay(Date.parse(ctx.now), ctx.tz_offset_minutes)
  // 每周从周一起（工作区时区）
  const dow = new Date(today + ctx.tz_offset_minutes * 60_000).getUTCDay()
  const monday = today - ((dow + 6) % 7) * DAY
  const out: ReportWindow[] = []
  for (let i = n - 1; i >= 0; i -= 1)
    out.push({ from: monday - i * 7 * DAY, to: Math.min(monday - (i - 1) * 7 * DAY, today) })
  return out.filter((w) => w.to > w.from)
}

/** 新老客按周（7 天那一档按天）。 */
function bucketsFor(ctx: QueryContext, wins: ReportWindows): ReportWindow[] {
  if (wins.range === '7d' || wins.range === '1d') return wins.daily
  return weeksBack(ctx, wins.range === '30d' ? 8 : 13)
}

/** 把一个现成命名查询的表接成报表块（社媒 / 红人 / 投放 / B2B 那几份用）。 */
function fromQueryTable(name: string, ctx: QueryContext): DatasetResult {
  let result: ReturnType<typeof runQuery>
  try {
    result = runQuery(name, ctx, 'last_7d')
  } catch {
    return { status: 'empty', note: '这一块还没有' }
  }
  if (result.status !== 'ok') return { status: 'not_connected', needs: [needOf(result.source)] }
  const data = result.data as TableResult
  if (!Array.isArray(data.rows) || data.rows.length === 0)
    return { status: 'empty', note: '这一段还没有' }
  return {
    status: 'ok',
    payload: {
      columns: data.columns.slice(0, 5).map((c) => ({
        key: c.key,
        label: c.label,
        ...(c.align === undefined ? {} : { align: c.align }),
        ...(c.format === 'count' ? { format: 'count' as const } : {}),
      })),
      rows: data.rows.slice(0, 8).map((r) => {
        const out: Record<string, string | number | null> = {}
        for (const c of data.columns.slice(0, 5)) {
          const v = (r as Record<string, unknown>)[c.key]
          out[c.key] = typeof v === 'number' || typeof v === 'string' ? v : null
        }
        return out
      }),
    },
  }
}

/** 现成命名查询里的漏斗表（第一列是阶段名、找第一列数）。 */
function fromQueryFunnel(name: string, ctx: QueryContext): DatasetResult {
  let result: ReturnType<typeof runQuery>
  try {
    result = runQuery(name, ctx, 'last_7d')
  } catch {
    return { status: 'empty', note: '这一块还没有' }
  }
  if (result.status !== 'ok') return { status: 'not_connected', needs: [needOf(result.source)] }
  const data = result.data as TableResult
  const labelKey = data.columns[0]?.key
  const numKey = data.columns.find((c) =>
    data.rows.some((r) => typeof (r as Record<string, unknown>)[c.key] === 'number'),
  )?.key
  if (labelKey === undefined || numKey === undefined || data.rows.length === 0)
    return { status: 'empty', note: '这一段还没有' }
  const steps = data.rows.map((r) => {
    const rec = r as Record<string, unknown>
    return { label: String(rec[labelKey] ?? ''), value: Number(rec[numKey] ?? 0) }
  })
  return { status: 'ok', payload: { steps: withRates(steps) } }
}

function withRates(
  steps: { label: string; value: number }[],
): { label: string; value: number; rate?: number }[] {
  return steps.map((s, i) => {
    const prev = steps[i - 1]
    return prev === undefined || prev.value === 0
      ? s
      : { ...s, rate: round((s.value / prev.value) * 100, 1) }
  })
}

const GA4_FUNNEL: readonly { event: string; label: string }[] = [
  { event: 'session_start', label: '进店' },
  { event: 'view_item', label: '看了商品' },
  { event: 'add_to_cart', label: '加购' },
  { event: 'begin_checkout', label: '进结账' },
  { event: 'purchase', label: '下单' },
]

export const REPORT_DATASETS: readonly DatasetDef[] = [
  {
    id: 'shop.order_sources',
    sources: ['shop'],
    run: (ctx, wins) => {
      if (!ctx.orders.some((o) => orderChannel(o) !== undefined))
        return { status: 'empty', note: '店铺后台给的订单没带进店来源，分不出从哪来' }
      const orders = ordersIn(ctx, wins.current)
      const by = new Map<OrderChannel, { n: number; sales: number }>()
      let unknown = 0
      for (const o of orders) {
        const ch = orderChannel(o)
        if (ch === undefined) {
          unknown += 1
          continue
        }
        const got = by.get(ch) ?? { n: 0, sales: 0 }
        got.n += 1
        got.sales += o.total_price
        by.set(ch, got)
      }
      const total = sum([...by.values()].map((v) => v.n))
      if (total === 0) return { status: 'empty', note: '这一段没有带来源的订单' }
      const max = Math.max(...[...by.values()].map((v) => v.n))
      const rows = [...by.entries()]
        .sort((a, b) => b[1].n - a[1].n)
        .map(([ch, v]) => ({
          label: ORDER_CHANNEL_LABELS[ch],
          value: v.n,
          share: max === 0 ? 0 : v.n / max,
          note: `$${Math.round(v.sales).toLocaleString('en-US')}`,
          ...(ch === 'ai' ? { tag: 'AI' } : {}),
        }))
      return {
        status: 'ok',
        payload: {
          rows,
          format: 'count',
          ...(unknown > 0 ? {} : {}),
        },
      }
    },
  },
  {
    id: 'shop.top_products',
    sources: ['shop'],
    run: (ctx, wins) => {
      if (!ctx.orders.some((o) => (o.line_items ?? []).length > 0))
        return { status: 'empty', note: '店铺后台给的订单没带商品明细' }
      const buckets = 12
      const span = (wins.current.to - wins.current.from) / buckets
      const agg = new Map<string, { sales: number; units: number; prev: number; spark: number[] }>()
      const add = (o: OrderRow, w: 'cur' | 'prev'): void => {
        for (const li of o.line_items ?? []) {
          const name = (li.title ?? li.sku ?? '').trim()
          if (name === '') continue
          const got = agg.get(name) ?? {
            sales: 0,
            units: 0,
            prev: 0,
            spark: new Array<number>(buckets).fill(0),
          }
          if (w === 'cur') {
            got.sales += li.total
            got.units += li.quantity
            const k = Math.min(buckets - 1, Math.floor((orderMs(o) - wins.current.from) / span))
            got.spark[k] = (got.spark[k] ?? 0) + li.total
          } else got.prev += li.total
          agg.set(name, got)
        }
      }
      for (const o of ordersIn(ctx, wins.current)) add(o, 'cur')
      for (const o of ordersIn(ctx, wins.previous)) add(o, 'prev')
      const rows = [...agg.entries()]
        .filter(([, v]) => v.sales > 0)
        .sort((a, b) => b[1].sales - a[1].sales)
        .slice(0, 5)
        .map(([name, v]) => ({
          product: name,
          sales: round(v.sales),
          units: v.units,
          spark: v.spark.map((x) => round(x)),
          change: pctChange(v.sales, v.prev) ?? null,
        }))
      if (rows.length === 0) return { status: 'empty', note: '这一段没有卖出去的商品' }
      return {
        status: 'ok',
        payload: {
          columns: [
            { key: 'product', label: '商品' },
            { key: 'sales', label: '销售额', align: 'right', format: 'currency' },
            { key: 'units', label: '单数', align: 'right', format: 'count' },
            { key: 'spark', label: '走势', align: 'right', format: 'spark' },
            { key: 'change', label: `比前 ${wins.days} 天`, align: 'right', format: 'delta' },
          ],
          rows,
          currency: ctx.base_currency,
        },
      }
    },
  },
  {
    id: 'shop.new_vs_returning',
    sources: ['shop'],
    run: (ctx, wins) => {
      const first = firstOrderAt(ctx)
      if (first.size === 0) return { status: 'empty', note: '订单没带客人邮箱，分不出新老客' }
      const buckets = bucketsFor(ctx, wins)
      const neu: number[] = []
      const old: number[] = []
      for (const b of buckets) {
        const os = ordersIn(ctx, b)
        neu.push(os.filter((o) => isReturning(o, first) === false).length)
        old.push(os.filter((o) => isReturning(o, first) === true).length)
      }
      if (sum(neu) + sum(old) === 0) return { status: 'empty', note: '这一段没有订单' }
      return {
        status: 'ok',
        payload: {
          x: buckets.map((b) => label(reportDay(b.from, ctx.tz_offset_minutes))),
          series: [
            { key: 'new', label: '新客', points: neu },
            { key: 'returning', label: '老客', points: old },
          ],
          format: 'count',
        },
      }
    },
  },
  {
    id: 'shop.email_weekly',
    sources: ['shop'],
    run: (ctx) => {
      if (!ctx.orders.some((o) => orderChannel(o) !== undefined))
        return { status: 'empty', note: '店铺后台给的订单没带来源，分不出哪些是邮件带来的' }
      const weeks = weeksBack(ctx, 8)
      const points = weeks.map((w) =>
        round(
          sum(
            ordersIn(ctx, w)
              .filter((o) => orderChannel(o) === 'email')
              .map((o) => o.total_price),
          ),
        ),
      )
      return {
        status: 'ok',
        payload: {
          x: weeks.map((w) => label(reportDay(w.from, ctx.tz_offset_minutes))),
          bars: { label: '邮件带来的销售额', points },
          format: 'currency',
        },
      }
    },
  },
  {
    /**
     * 「邮件活动对复购有没有用」：近 8 周每周老客回购订单，**发了邮件活动的周**（这一周里有一张群发邮件的改动真发出去了）
     * 标一种颜色。哪周发了从工作队列里那几张真做成的群发卡认，不猜。
     */
    id: 'shop.returning_by_campaign',
    sources: ['shop', 'approvals'],
    run: (ctx) => {
      const first = firstOrderAt(ctx)
      if (first.size === 0) return { status: 'empty', note: '订单没带客人邮箱，分不出老客' }
      const weeks = weeksBack(ctx, 8)
      const sends = ctx.approvals
        .filter((i) => /email|campaign|newsletter/.test(changeKind(i) ?? ''))
        .map(appliedAt)
        .filter((x): x is number => x !== undefined)
      const points = weeks.map(
        (w) => ordersIn(ctx, w).filter((o) => isReturning(o, first) === true).length,
      )
      const tones = weeks.map((w) => (sends.some((s) => within(s, w)) ? 'a' : 'b') as 'a' | 'b')
      return {
        status: 'ok',
        payload: {
          x: weeks.map((w) => label(reportDay(w.from, ctx.tz_offset_minutes))),
          bars: { label: '老客回购订单', points, tones },
          legend: { a: '发了邮件活动的周', b: '没发的周' },
          format: 'count',
        },
      }
    },
  },
  {
    id: 'ga4.funnel',
    sources: ['ga4'],
    run: (ctx) => {
      const g = ctx.search?.ga4
      if (g === undefined || g.needs_pick === true)
        return { status: 'empty', note: 'GA4 连上了，先选一下媒体资源' }
      const count = (e: string): number => g.events.find((x) => x.event === e)?.count ?? 0
      const steps = GA4_FUNNEL.map((s) => ({ label: s.label, value: count(s.event) }))
      if (steps.every((s) => s.value === 0))
        return { status: 'empty', note: 'GA4 里还没有这几步的事件（看商品、加购、进结账）' }
      return { status: 'ok', payload: { steps: withRates(steps) } }
    },
  },
  {
    id: 'gsc.queries',
    sources: ['gsc'],
    run: (ctx) => {
      const g = ctx.search?.gsc
      if (g === undefined || g.needs_pick === true)
        return { status: 'empty', note: 'Search Console 连上了，先选一下是哪个站点' }
      const rows = [...g.queries].sort((a, b) => b.clicks - a.clicks).slice(0, 6)
      if (rows.length === 0) return { status: 'empty', note: '这一段还没有搜索词' }
      return {
        status: 'ok',
        payload: {
          columns: [
            { key: 'query', label: '搜索词' },
            { key: 'clicks', label: '点击', align: 'right', format: 'count' },
            { key: 'impressions', label: '展示', align: 'right', format: 'count' },
            { key: 'position', label: '排名', align: 'right', format: 'position' },
          ],
          rows: rows.map((r) => ({
            query: r.key,
            clicks: r.clicks,
            impressions: r.impressions,
            position: round(r.position, 1),
          })),
        },
      }
    },
  },
  {
    id: 'gsc.pages',
    sources: ['gsc'],
    run: (ctx) => {
      const g = ctx.search?.gsc
      if (g === undefined || g.needs_pick === true)
        return { status: 'empty', note: 'Search Console 连上了，先选一下是哪个站点' }
      const rows = [...g.pages].sort((a, b) => b.clicks - a.clicks).slice(0, 6)
      if (rows.length === 0) return { status: 'empty', note: '这一段还没有落地页数据' }
      const max = Math.max(...rows.map((r) => r.clicks), 1)
      return {
        status: 'ok',
        payload: {
          rows: rows.map((r) => ({
            label: r.key.replace(/^https?:\/\/[^/]+/, '') || '/',
            value: r.clicks,
            share: r.clicks / max,
            note: `排名 ${round(r.position, 1)}`,
          })),
          format: 'count',
        },
      }
    },
  },
  {
    id: 'shop.ai_orders_daily',
    sources: ['shop'],
    run: (ctx, wins) => {
      if (!ctx.orders.some((o) => orderChannel(o) !== undefined))
        return {
          status: 'empty',
          note: '店铺后台给的订单没带来源，认不出哪些是从 AI 回答里点进来的',
        }
      const ai = wins.daily.map(
        (d) => ordersIn(ctx, d).filter((o) => orderChannel(o) === 'ai').length,
      )
      const search = wins.daily.map(
        (d) => ordersIn(ctx, d).filter((o) => orderChannel(o) === 'search').length,
      )
      return {
        status: 'ok',
        payload: {
          x: wins.daily.map((d) => label(reportDay(d.from, ctx.tz_offset_minutes))),
          bars: { label: '自然搜索带来的订单', points: search },
          line: { label: 'AI 回答带来的订单', points: ai },
          format: 'count',
        },
      }
    },
  },
  {
    id: 'seo.geo_visibility',
    sources: ['approvals'],
    run: (ctx) => fromQueryTable('seo.geo_visibility', ctx),
  },
  // WP448：技术体检、改版回归（我们自己跑出来的结论）、每周抢词（Search Console）
  {
    id: 'site.tech_audit',
    sources: ['site'],
    run: (ctx) => fromQueryTable('site.tech_audit', ctx),
  },
  {
    id: 'site.drift',
    sources: ['site'],
    run: (ctx) => fromQueryTable('site.drift', ctx),
  },
  {
    id: 'seo.cannibalization',
    sources: ['gsc'],
    run: (ctx) => fromQueryTable('seo.cannibalization', ctx),
  },
  {
    id: 'email.campaigns',
    sources: ['email_marketing'],
    run: (ctx) => fromQueryTable('email.campaign_performance', ctx),
  },
  {
    id: 'email.flows',
    sources: ['email_marketing'],
    run: (ctx) => fromQueryTable('email.flows', ctx),
  },
  {
    id: 'ads.overview',
    sources: ['ads'],
    run: (ctx) => {
      if (!sourceStatus(ctx, 'ads'))
        return {
          status: 'not_connected',
          needs: [needOf('ads_meta'), needOf('ads_google')],
        }
      return fromQueryTable('ads.campaigns', ctx)
    },
  },
  // ── 客服 ──
  {
    id: 'support.daily',
    sources: ['approvals'],
    run: (ctx, wins) => {
      const all = drafts(ctx)
      const made = wins.daily.map(
        (d) => all.filter((i) => within(Date.parse(i.created_at), d)).length,
      )
      const done = wins.daily.map(
        (d) =>
          all.filter((i) => {
            const at = decidedAt(i)
            return at !== undefined && within(at, d)
          }).length,
      )
      return {
        status: 'ok',
        payload: {
          x: wins.daily.map((d) => label(reportDay(d.from, ctx.tz_offset_minutes))),
          bars: { label: '进来要回的', points: made },
          line: { label: '回出去的', points: done },
          format: 'count',
        },
      }
    },
  },
  {
    id: 'support.handling',
    sources: ['approvals'],
    run: (ctx, wins) => {
      const decided = ctx.approvals.filter((i) => {
        const at = decidedAt(i)
        return at !== undefined && within(at, wins.current)
      })
      if (decided.length === 0) return { status: 'empty', note: '这一段还没有处理完的事' }
      const auto = decided.filter((i) => i.state === 'auto_approved').length
      const edited = decided.filter((i) => i.state === 'approved_edited').length
      const rejected = decided.filter((i) => i.state === 'rejected').length
      const asIs = decided.length - auto - edited - rejected
      return {
        status: 'ok',
        payload: {
          parts: [
            { key: 'auto', label: 'AI 自己处理', value: auto, tone: 'good' },
            { key: 'as_is', label: '你点了通过', value: asIs, tone: 'neutral' },
            { key: 'edited', label: '你改过再发', value: edited, tone: 'neutral' },
            { key: 'rejected', label: '没要', value: rejected, tone: 'bad' },
          ],
          total: decided.length,
        },
      }
    },
  },
  {
    id: 'support.kinds',
    sources: ['approvals'],
    run: (ctx, wins) => {
      const items = ctx.approvals.filter((i) => within(Date.parse(i.created_at), wins.current))
      if (items.length === 0) return { status: 'empty', note: '这一段还没有进来的事' }
      const by = new Map<string, number>()
      for (const i of items) {
        const k =
          i.kind === 'outbound_draft'
            ? '回复客人'
            : changeKind(i) === 'refund'
              ? '退款'
              : i.kind === 'staged_change'
                ? '改动'
                : '其他'
        by.set(k, (by.get(k) ?? 0) + 1)
      }
      const max = Math.max(...by.values())
      return {
        status: 'ok',
        payload: {
          rows: [...by.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([k, n]) => ({ label: k, value: n, share: n / max })),
          format: 'count',
        },
      }
    },
  },
  // ── Reddit / 公关 ──
  {
    id: 'pr.daily',
    sources: ['pr'],
    run: (ctx, wins) => {
      if (ctx.pr === undefined) return { status: 'empty', note: '这台机器上还没有公关岗位的数据' }
      const ms = prMentions(ctx)
      const ps = prPosts(ctx)
      return {
        status: 'ok',
        payload: {
          x: wins.daily.map((d) => label(reportDay(d.from, ctx.tz_offset_minutes))),
          bars: {
            label: '被提到',
            points: wins.daily.map(
              (d) => ms.filter((m) => within(Date.parse(m.published_at), d)).length,
            ),
          },
          line: {
            label: '我们回帖',
            points: wins.daily.map(
              (d) =>
                ps.filter(
                  (p) => p.published_at !== undefined && within(Date.parse(p.published_at), d),
                ).length,
            ),
          },
          format: 'count',
        },
      }
    },
  },
  {
    id: 'pr.venues',
    sources: ['pr'],
    run: (ctx, wins) => {
      if (ctx.pr === undefined) return { status: 'empty', note: '这台机器上还没有公关岗位的数据' }
      const ms = prMentions(ctx).filter((m) => within(Date.parse(m.published_at), wins.current))
      if (ms.length === 0) return { status: 'empty', note: '这一段没有人提到品牌' }
      const by = new Map<string, number>()
      for (const m of ms) by.set(m.origin, (by.get(m.origin) ?? 0) + 1)
      const replies = new Map<string, number>()
      for (const p of prPosts(ctx))
        if (p.published_at !== undefined && within(Date.parse(p.published_at), wins.current))
          replies.set(p.venue, (replies.get(p.venue) ?? 0) + 1)
      const sorted = [...by.entries()].sort((a, b) => b[1] - a[1])
      const top = sorted.slice(0, 5)
      const rest = sum(sorted.slice(5).map(([, n]) => n))
      const max = Math.max(...top.map(([, n]) => n))
      return {
        status: 'ok',
        payload: {
          rows: [
            ...top.map(([venue, n]) => ({
              label: venue,
              value: n,
              share: n / max,
              note: `回 ${replies.get(venue) ?? 0}`,
            })),
            ...(rest > 0 ? [{ label: '其他', value: rest, share: rest / max }] : []),
          ],
          format: 'count',
        },
      }
    },
  },
  {
    id: 'pr.sentiment',
    sources: ['pr'],
    run: (ctx, wins) => {
      if (ctx.pr === undefined) return { status: 'empty', note: '这台机器上还没有公关岗位的数据' }
      const ms = prMentions(ctx).filter(
        (m) => within(Date.parse(m.published_at), wins.current) && m.sentiment !== undefined,
      )
      if (ms.length === 0) return { status: 'empty', note: '这一段的提及还没判情绪' }
      const n = (s: string): number => ms.filter((m) => m.sentiment === s).length
      const neutral = ms.length - n('positive') - n('negative')
      return {
        status: 'ok',
        payload: {
          parts: [
            { key: 'positive', label: '正面', value: n('positive'), tone: 'good' },
            { key: 'neutral', label: '中性', value: neutral, tone: 'neutral' },
            { key: 'negative', label: '负面', value: n('negative'), tone: 'bad' },
          ],
          total: ms.length,
        },
      }
    },
  },
  {
    id: 'pr.top_posts',
    sources: ['pr'],
    run: (ctx, wins) => {
      if (ctx.pr === undefined) return { status: 'empty', note: '这台机器上还没有公关岗位的数据' }
      const ps = prPosts(ctx)
        .filter(
          (p) => p.published_at !== undefined && within(Date.parse(p.published_at), wins.current),
        )
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
        .slice(0, 5)
      if (ps.length === 0) return { status: 'empty', note: '这一段我们还没回帖' }
      return {
        status: 'ok',
        payload: {
          columns: [
            { key: 'post', label: '帖子', format: 'text' },
            { key: 'score', label: '赞', align: 'right', format: 'count' },
            { key: 'replies', label: '回复', align: 'right', format: 'count' },
          ],
          rows: ps.map((p) => ({
            post: p.excerpt,
            sub: `${p.venue} · ${reportDay(Date.parse(p.published_at ?? ''), ctx.tz_offset_minutes).slice(5)}`,
            score: p.score ?? null,
            replies: p.replies ?? null,
          })),
        },
      }
    },
  },
  {
    id: 'pr.offsite',
    sources: ['google_alerts'],
    run: (ctx, wins) => {
      if (!sourceStatus(ctx, 'google_alerts'))
        return { status: 'not_connected', needs: [needOf('google_alerts')] }
      const ms = (ctx.pr?.mentions ?? []).filter(
        (m) => m.source === 'google_alerts' && within(Date.parse(m.published_at), wins.current),
      )
      if (ms.length === 0) return { status: 'empty', note: '这一段站外没有新的提及' }
      return {
        status: 'ok',
        payload: {
          columns: [
            { key: 'excerpt', label: '在哪说的', format: 'text' },
            { key: 'date', label: '日期', align: 'right', format: 'text' },
          ],
          rows: ms.slice(0, 6).map((m) => ({
            excerpt: m.excerpt,
            date: reportDay(Date.parse(m.published_at), ctx.tz_offset_minutes).slice(5),
          })),
        },
      }
    },
  },
  // ── 其余岗位：接现成的命名查询（数在原查询里算好） ──
  { id: 'kol.funnel', sources: ['kol'], run: (ctx) => fromQueryFunnel('kol.outreach_funnel', ctx) },
  { id: 'kol.top', sources: ['kol'], run: (ctx) => fromQueryTable('kol.top_creators', ctx) },
  { id: 'kol.collabs', sources: ['kol'], run: (ctx) => fromQueryTable('kol.collaborations', ctx) },
  {
    id: 'social.calendar',
    sources: ['social'],
    run: (ctx) => fromQueryTable('social.content_calendar', ctx),
  },
  {
    id: 'social.queue',
    sources: ['social'],
    run: (ctx) => fromQueryTable('social.publish_queue', ctx),
  },
  {
    id: 'social.comments',
    sources: ['social'],
    run: (ctx) => fromQueryTable('social.pending_comments', ctx),
  },
  { id: 'ads.campaigns', sources: ['ads'], run: (ctx) => fromQueryTable('ads.campaigns', ctx) },
  { id: 'ads.stop_loss', sources: ['ads'], run: (ctx) => fromQueryTable('ads.stop_loss_log', ctx) },
  { id: 'b2b.inquiries', sources: ['b2b'], run: (ctx) => fromQueryTable('b2b.inquiries', ctx) },
  { id: 'b2b.quotes', sources: ['b2b'], run: (ctx) => fromQueryTable('b2b.quotes_pending', ctx) },
  {
    id: 'b2b.sequence',
    sources: ['b2b'],
    run: (ctx) => fromQueryFunnel('b2b.sequence_funnel', ctx),
  },
]

const DATASET_BY_ID = new Map(REPORT_DATASETS.map((d) => [d.id, d]))

export function reportDatasetIds(): string[] {
  return REPORT_DATASETS.map((d) => d.id)
}

// ── 算一份 ────────────────────────────────────────────────────────────

const refsOf = (sources: DataSourceId[]): ReportSourceRef[] =>
  sources.map((id) => ({ id, label: SOURCE_LABELS[id] }))

function computeBlock(
  spec: ReportBlockSpec,
  ctx: QueryContext,
  wins: ReportWindows,
): ReportBlockData {
  const head = {
    id: spec.id,
    kind: spec.kind,
    ...(spec.title === undefined ? {} : { title: spec.title }),
    ...(spec.subtitle === undefined ? {} : { subtitle: spec.subtitle }),
    ...(spec.wide === true ? { wide: true } : {}),
  }
  if (spec.kind === 'kpis') {
    const items = spec.metrics.map((k) => computeMetric(k, ctx, wins))
    const sources = [...new Set(items.map((i) => i.source))]
    return {
      ...head,
      status: items.some((i) => i.status === 'ok') ? 'ok' : (items[0]?.status ?? 'empty'),
      sources: refsOf(sources),
      payload: { items },
    }
  }
  if (spec.kind === 'trend') {
    const def = METRIC_BY_KEY.get(spec.metric)
    if (def === undefined) return { ...head, status: 'empty', sources: [], note: '这一块还没有' }
    const sources = refsOf([def.source])
    if (!connected(ctx, def.source))
      return { ...head, status: 'not_connected', sources, needs: [needOf(def.source)] }
    const run = def.value
    if (run === undefined)
      return {
        ...head,
        status: 'empty',
        sources,
        note: `${SOURCE_LABELS[def.source]}只给了一段汇总，没有每天的数`,
      }
    const current = wins.daily.map((d) => run(ctx, d))
    if (current.every((v) => v === undefined))
      return { ...head, status: 'empty', sources, note: def.emptyNote ?? '这一段还没有' }
    const previous = wins.previousDaily.map((d) => run(ctx, d) ?? 0)
    return {
      ...head,
      status: 'ok',
      sources,
      payload: {
        x: wins.daily.map((d) => reportDay(d.from, ctx.tz_offset_minutes)),
        current: current.map((v) => v ?? 0),
        previous,
        format: def.format,
        ...(def.format === 'currency' ? { currency: ctx.base_currency } : {}),
        label: def.label,
        events: spec.events === true ? reportEvents(ctx, wins.current) : [],
      },
    }
  }
  const ds = DATASET_BY_ID.get(spec.dataset)
  if (ds === undefined) return { ...head, status: 'empty', sources: [], note: '这一块还没有' }
  const sources = refsOf(ds.sources)
  const missing = ds.sources.filter((s) => !connected(ctx, s))
  if (missing.length > 0 && spec.dataset !== 'ads.overview')
    return { ...head, status: 'not_connected', sources, needs: missing.map(needOf) }
  const got = ds.run(ctx, wins)
  if (got.status === 'ok') return { ...head, status: 'ok', sources, payload: got.payload }
  if (got.status === 'empty') return { ...head, status: 'empty', sources, note: got.note }
  return { ...head, status: 'not_connected', sources, needs: got.needs }
}

export interface ComputeReportOptions {
  /** 快照时间（默认 `ctx.now`）。 */
  at?: string
}

export function computeReport(
  spec: ReportSpec,
  ctx: QueryContext,
  range: ReportRange = spec.default_range,
  options: ComputeReportOptions = {},
): ReportData {
  const wins = reportWindows(range, ctx.now, ctx.tz_offset_minutes)
  const blocks = spec.blocks.map((b) => computeBlock(b, ctx, wins))
  const tz = ctx.tz_offset_minutes
  const conclusion = conclusionOf(spec, blocks, wins)
  return {
    id: spec.id,
    title: spec.title,
    position: spec.position,
    origin: spec.origin,
    refresh: spec.refresh,
    range,
    period: {
      from: reportDay(wins.current.from, tz),
      to: reportDay(wins.current.to - 1, tz),
      compare_from: reportDay(wins.previous.from, tz),
      compare_to: reportDay(wins.previous.to - 1, tz),
    },
    computed_at: options.at ?? ctx.now,
    ...(spec.created === undefined ? {} : { created: spec.created }),
    ...(conclusion === undefined ? {} : { conclusion }),
    blocks,
  }
}

/** 近 N 天每天一格的值（首页关键数字那条两周小走势）；算不出每天的回 `undefined`。 */
export function metricSpark(key: string, ctx: QueryContext, days = 14): number[] | undefined {
  const def = METRIC_BY_KEY.get(key)
  const run = def?.value
  if (def === undefined || run === undefined || !connected(ctx, def.source)) return undefined
  const today = startOfDay(Date.parse(ctx.now), ctx.tz_offset_minutes)
  const out: number[] = []
  for (let i = days; i >= 1; i -= 1)
    out.push(run(ctx, { from: today - i * DAY, to: today - (i - 1) * DAY }) ?? 0)
  return out
}

/** 看板那一行：头条数（近 30 天）+ 每天的小走势。 */
export function summarizeReport(spec: ReportSpec, ctx: QueryContext): ReportSummary {
  const wins = reportWindows('30d', ctx.now, ctx.tz_offset_minutes)
  const { spark: _drop, ...headline } = computeMetric(spec.headline, ctx, wins)
  const spark = _drop
  const def = METRIC_BY_KEY.get(spec.headline)
  const hasDaily = def?.value !== undefined && def.stock === undefined
  return {
    id: spec.id,
    title: spec.title,
    position: spec.position,
    origin: spec.origin,
    refresh: spec.refresh,
    headline_label:
      spec.headline_label ?? (hasDaily ? `近 30 天${headline.label}` : headline.label),
    headline,
    ...(spark === undefined ? {} : { spark }),
    ...(spec.created === undefined ? {} : { created: spec.created }),
  }
}

// ── 数的写法（结论那三句用；前端有自己那一份，口径一致） ─────────────

export function formatReportValue(v: number, format: ReportFormat, currency = 'USD'): string {
  const sign = currency === 'USD' ? '$' : currency === 'EUR' ? '€' : currency === 'GBP' ? '£' : ''
  const compact = (x: number): string => {
    const a = Math.abs(x)
    if (a >= 1_000_000) return `${round(x / 1_000_000, 1)}m`
    if (a >= 10_000) return `${round(x / 1000, 1)}k`
    return Math.round(x).toLocaleString('en-US')
  }
  switch (format) {
    case 'currency':
      return sign === '' ? `${compact(v)} ${currency}` : `${sign}${compact(v)}`
    case 'percent':
      return `${round(v, 2)}%`
    case 'hours':
      return `${round(v, 1)} 小时`
    case 'position':
      return String(round(v, 1))
    case 'decimal':
      return String(round(v, 2))
    default:
      return compact(v)
  }
}

function deltaText(m: ReportMetricValue): string | undefined {
  if (m.delta === undefined) return undefined
  const s = m.delta > 0 ? '+' : ''
  return m.delta_unit === 'pt' ? `${s}${m.delta} 个点` : `${s}${m.delta}%`
}

/** 涨跌对人来说是好是坏（越小越好的指标反过来）。 */
function goodness(m: ReportMetricValue): number {
  if (m.delta === undefined) return 0
  const scaled = m.delta_unit === 'pt' ? m.delta * 5 : m.delta
  return m.invert === true ? -scaled : scaled
}

/**
 * 结论卡的三句（由数拼出来，`by: 'rules'`）：
 * ① 头条数这一段多少、比前一段怎样（能分来源的话，说多出来的主要从哪来）；
 * ② 这一段工坊做过的第一件事前后，头条数每天的平均变了多少（没有事件就说第二个数）；
 * ③ 「要留意：」变差最多的那个数；都没变差就说缺的那个数据源。
 */
export function conclusionOf(
  spec: ReportSpec,
  blocks: ReportBlockData[],
  wins: ReportWindows,
): ReportConclusion | undefined {
  const kpis = blocks.find((b) => b.kind === 'kpis')?.payload as KpisPayload | undefined
  const items = kpis?.items ?? []
  const head = items.find((m) => m.key === spec.headline) ?? items[0]
  if (head === undefined || head.status !== 'ok' || head.value === undefined) return undefined
  const lines: string[] = []
  const cur = head.currency ?? 'USD'
  const d = deltaText(head)
  let first = `${head.label} **${formatReportValue(head.value, head.format, cur)}**`
  if (d !== undefined) first += `，比前 ${wins.days} 天 **${d}**`
  const sources = blocks.find((b) => b.id.endsWith('sources') && b.status === 'ok')?.payload as
    | RankPayload
    | undefined
  const top = sources?.rows[0]
  if (top !== undefined && (head.delta ?? 0) > 0) first += `；单子最多来自${top.label}`
  lines.push(`${first}。`)

  const trend = blocks.find((b) => b.kind === 'trend' && b.status === 'ok')?.payload as
    | TrendPayload
    | undefined
  const ev = trend?.events.find((e) => {
    const i = trend.x.indexOf(e.date)
    return i >= 3 && i <= trend.x.length - 4
  })
  if (trend !== undefined && ev !== undefined) {
    const i = trend.x.indexOf(ev.date)
    const avg = (xs: number[]): number => (xs.length === 0 ? 0 : sum(xs) / xs.length)
    const before = avg(trend.current.slice(Math.max(0, i - 7), i))
    const after = avg(trend.current.slice(i + 1, i + 8))
    const fmt = (v: number): string => formatReportValue(v, trend.format, trend.currency ?? cur)
    lines.push(
      `${ev.date.slice(5)}「${ev.label}」之后，每天${trend.label}从 ${fmt(before)} ${after >= before ? '升' : '降'}到 ${fmt(after)} 上下。`,
    )
  } else {
    const second = items.find((m) => m !== head && m.status === 'ok' && m.value !== undefined)
    if (second?.value !== undefined) {
      const sd = deltaText(second)
      lines.push(
        `${second.label} ${formatReportValue(second.value, second.format, second.currency ?? cur)}${sd === undefined ? '' : `（${sd}）`}。`,
      )
    }
  }

  const watch = (spec.watch ?? items.map((m) => m.key))
    .map((k) => items.find((m) => m.key === k))
    .filter((m): m is ReportMetricValue => m !== undefined && m.status === 'ok')
  const worst = [...watch].sort((a, b) => goodness(a) - goodness(b))[0]
  let action: ReportAction | undefined
  if (worst !== undefined && goodness(worst) < 0 && worst.value !== undefined) {
    const wd = deltaText(worst)
    lines.push(
      `要留意：**${worst.label}${(worst.delta ?? 0) < 0 ? '降' : '涨'}了**（${formatReportValue(worst.value, worst.format, worst.currency ?? cur)}${wd === undefined ? '' : `，${wd}`}）。`,
    )
    action = spec.actions?.[worst.key]
  } else {
    const missing = blocks.find((b) => b.status === 'not_connected')
    if (missing !== undefined) {
      const what = (missing.needs ?? []).map((n) => n.label).join(' / ')
      lines.push(`要留意：${what}还没连，「${missing.title ?? ''}」那一块还看不到。`)
    } else lines.push('要留意：这一段没有变差的数。')
  }
  return { lines, by: 'rules', ...(action === undefined ? {} : { action }) }
}

/** 规格里用到的全部数据源（权限判定要它：无权的那几块直接不出）。 */
export function reportSources(spec: ReportSpec): DataSourceId[] {
  const out = new Set<DataSourceId>()
  for (const b of spec.blocks) {
    if (b.kind === 'kpis')
      for (const k of b.metrics) {
        const d = METRIC_BY_KEY.get(k)
        if (d !== undefined) out.add(d.source)
      }
    else if (b.kind === 'trend') {
      const d = METRIC_BY_KEY.get(b.metric)
      if (d !== undefined) out.add(d.source)
    } else for (const s of DATASET_BY_ID.get(b.dataset)?.sources ?? []) out.add(s)
  }
  return [...out]
}

/** 校验一份规格（AI 做的那份进库前过这一道：指标与数据集只能来自表里）。 */
export function validateReportSpec(spec: ReportSpec): string[] {
  const problems: string[] = []
  if (!METRIC_BY_KEY.has(spec.headline)) problems.push(`头条数不在指标表里：${spec.headline}`)
  for (const b of spec.blocks) {
    if (b.kind === 'kpis') {
      for (const k of b.metrics) if (!METRIC_BY_KEY.has(k)) problems.push(`没有这个指标：${k}`)
    } else if (b.kind === 'trend') {
      if (!METRIC_BY_KEY.has(b.metric)) problems.push(`没有这个指标：${b.metric}`)
    } else if (!DATASET_BY_ID.has(b.dataset)) problems.push(`没有这个数据集：${b.dataset}`)
  }
  return problems
}

/** 一份规格里 KPI 条的指标（结论、组合报表用）。 */
export function kpiKeys(spec: ReportSpec): string[] {
  return spec.blocks.flatMap((b) => (b.kind === 'kpis' ? b.metrics : []))
}
