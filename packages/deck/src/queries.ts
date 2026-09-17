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
import { designDutyOfRole, SOCIAL_CHANNELS, socialChannelOfRole } from '@agentsws/contracts'
import { DeckError } from './errors.js'
import { SOCIAL_SOURCE_BY_CHANNEL } from './sources.js'
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

/* ── WP72（56 §2）：社媒运营面板的九块 ──────────────────────────────────
 *
 * 分两层，因为"没连就明说"这句话只对得上其中一层（36 §3）：
 *
 * - **我们自己库里那七块**（内容日历 / 待发布队列 / 待回评论 / 待审入群 /
 *   待处理帖子 / 群发队列 / 转客服）走 `social` 这个源——它永远算连上。
 *   一个平台都没连，内容日历上那几条照样在那儿摆着：**那是我们自己排的**。
 * - **平台那一侧那两块**（近 30 天表现 / 活跃度）走这条渠道自己的源
 *   （`social_meta` / `social_discord` …）。连上 Discord 不会把 TikTok 那一块
 *   点亮——那正是不合成一个 `social_channel` 的理由。
 *
 * 两层都按 `ctx.role_id` 那条渠道筛：九条职责共用一份投影（`socialDeckData`），
 * 面板这一层各看各的——一个人同时挂着 Meta 与 Discord 时，他看到的是两个岗位视图，
 * 每个视图里各几块，而不是一个视图里十几块（同 48 §5.1 红人那条）。
 */

/** 这条职责是哪条渠道；不是社媒职责就没有——那时一行都不出。 */
function channelOfRole(role_id: string): string | undefined {
  return socialChannelOfRole(role_id)?.id
}

/** 只留这条职责自己那条渠道的行。 */
function ofChannel<T extends { channel: string }>(rows: readonly T[], ctx: QueryContext): T[] {
  const channel = channelOfRole(ctx.role_id)
  // 认不出渠道（不是社媒职责）就一行不出——**不是**把九条渠道全端出来
  return channel === undefined ? [] : rows.filter((r) => r.channel === channel)
}

/** 时刻那一列拿不到就留空串，不写"未知"——空着本身就说明了问题。 */
const when = (iso: string | undefined): string => iso ?? ''

/* ── WP76（58 §3）：设计岗位五块 ─────────────────────────────────────── */

/**
 * 五条设计职责共用**一份**投影（`designDeckData`），面板这一层各看各的那一条。
 *
 * 与社媒那一层逐字同理：一个人同时挂着「独立站设计」与「Amazon 设计」时，
 * 他看到的是两个岗位视图、每个视图里五块，而不是一个视图里十块。
 *
 * 认不出职责（不是设计职责）就一行不出——**不是**把五条全端出来。
 */
function dutyOfRole(role_id: string): string | undefined {
  return designDutyOfRole(role_id)?.id
}

function ofDuty<T extends { duty: string }>(rows: readonly T[], ctx: QueryContext): T[] {
  const duty = dutyOfRole(ctx.role_id)
  return duty === undefined ? [] : rows.filter((r) => r.duty === duty)
}

const DESIGN_QUERIES: QueryDef[] = [
  {
    name: 'design.request_queue',
    source: 'design',
    returns: 'table',
    run: (ctx) => ({
      columns: [
        { key: 'from', label: '谁下的' },
        { key: 'title', label: '要什么' },
        { key: 'need', label: '需求原文' },
        { key: 'due_at', label: '什么时候要' },
      ],
      rows: ofDuty(ctx.design?.request_queue ?? [], ctx).map((r) => ({
        from: r.from,
        title: r.title,
        // 原样截断，不改写（外部文本，21 §1）
        need: r.excerpt,
        // 过期的那一行把话说出来：**这件事没做成**，不是"逾期"，也不靠颜色表达
        due_at: r.overdue ? `${when(r.due_at)}（已经过了）` : when(r.due_at),
      })),
    }),
  },
  {
    name: 'design.in_progress',
    source: 'design',
    returns: 'table',
    run: (ctx) => ({
      columns: [
        { key: 'title', label: '要什么' },
        { key: 'from', label: '谁下的' },
        { key: 'status', label: '到哪一步' },
        { key: 'progress', label: '出了几张' },
      ],
      rows: ofDuty(ctx.design?.in_progress ?? [], ctx).map((r) => ({
        title: r.title,
        from: r.from,
        status: r.status,
        // 「计划几张 / 出了几张」写成一格给人看，但两个数在投影里是分开的——
        // 合成一个百分比就再也看不出"计划了六张、一张没出"与"计划三张、出了三张"
        progress: `${r.generated} / ${r.planned}`,
      })),
    }),
  },
  {
    name: 'design.awaiting_pick',
    source: 'design',
    returns: 'table',
    run: (ctx) => ({
      columns: [
        { key: 'stage', label: '球在谁那儿' },
        { key: 'spec', label: '尺寸' },
        { key: 'goal', label: '这张图要干什么' },
        { key: 'created_at', label: '什么时候出的' },
      ],
      rows: ofDuty(ctx.design?.awaiting_pick ?? [], ctx).map((r) => ({
        // 04 §6：待挑 = 等你看一眼；待定稿 = 你点过了、在等那张 L1 卡。
        // 两句话不一样，所以不缩写成一个状态词。
        stage: r.stage === 'waiting_pick' ? '等你挑一张' : '你挑好了，等你点入库',
        spec: r.spec,
        goal: r.goal ?? '',
        created_at: r.created_at,
      })),
    }),
  },
  {
    name: 'design.asset_library',
    source: 'design',
    returns: 'table',
    run: (ctx) => ({
      columns: [
        { key: 'use', label: '用途' },
        { key: 'final', label: '定稿' },
        { key: 'count', label: '一共' },
      ],
      // 素材库按用途分组；没打标的归「没打标」，**不藏起来**——
      // 藏起来的结果是三个月后有人把同一张图重做一遍
      rows: (ctx.design?.library ?? []).map((g) => ({
        use: g.use,
        final: g.final,
        count: g.count,
      })),
    }),
  },
  {
    name: 'design.weekly_output',
    source: 'design',
    returns: 'table',
    run: (ctx) => {
      const week = ctx.design?.weekly
      return {
        columns: [
          { key: 'metric', label: '这一周' },
          { key: 'value', label: '几张' },
        ],
        rows:
          week === undefined
            ? []
            : [
                // **产出 = 定稿**。出图张数只是分母——把它当产出的结果是
                // 这个数永远好看，而没有一张图真的上线了。
                { metric: '定稿（真能用的）', value: week.final },
                { metric: '出了多少张变体', value: week.variants },
                ...week.by_use.map((u) => ({ metric: `定稿 · ${u.use}`, value: u.count })),
              ],
      }
    },
  },
]

const SOCIAL_QUERIES: QueryDef[] = [
  {
    name: 'social.content_calendar',
    source: 'social',
    returns: 'table',
    run: (ctx) => ({
      columns: [
        { key: 'scheduled_at', label: '什么时候' },
        { key: 'account', label: '账号' },
        { key: 'kind', label: '形态' },
        { key: 'status', label: '状态' },
        { key: 'body', label: '内容' },
      ],
      rows: ofChannel(ctx.social?.calendar ?? [], ctx).map((r) => ({
        // 排期的看排期，已发的看发出去那一刻——日历上"什么时候"那一列不该空着
        scheduled_at: when(r.scheduled_at ?? r.published_at),
        account: r.account,
        kind: r.kind,
        status: r.status,
        // 被平台退回来的那条要把原话带上——混进"排期中"里就再也没人发现它没发出去
        body: r.failure_reason === undefined ? r.excerpt : `${r.excerpt}（${r.failure_reason}）`,
      })),
    }),
  },
  {
    name: 'social.publish_queue',
    source: 'social',
    returns: 'table',
    run: (ctx) => ({
      columns: [
        { key: 'scheduled_at', label: '排在' },
        { key: 'account', label: '账号' },
        { key: 'status', label: '状态' },
        { key: 'body', label: '内容' },
      ],
      rows: ofChannel(ctx.social?.queue ?? [], ctx).map((r) => ({
        scheduled_at: when(r.scheduled_at),
        account: r.account,
        status: r.status,
        body: r.excerpt,
      })),
    }),
  },
  {
    name: 'social.pending_comments',
    source: 'social',
    returns: 'table',
    run: (ctx) => ({
      columns: [
        { key: 'created_at', label: '什么时候' },
        { key: 'author', label: '谁说的' },
        { key: 'triage', label: '归类' },
        { key: 'body', label: '内容' },
      ],
      // 判成客户问题的那些已经转出去了，不在这张表里（56 边界行，投影那一层就切了）
      rows: ofChannel(ctx.social?.pending_comments ?? [], ctx).map((r) => ({
        created_at: r.created_at,
        author: r.author,
        triage: r.triage ?? '',
        body: r.excerpt,
      })),
    }),
  },
  {
    name: 'social.pending_members',
    source: 'social',
    returns: 'table',
    run: (ctx) => ({
      columns: [
        { key: 'applied_at', label: '什么时候递的' },
        { key: 'handle', label: '谁' },
        { key: 'account', label: '哪个群' },
        { key: 'answers', label: '答了几题', align: 'right' as const, format: 'count' as const },
      ],
      rows: ofChannel(ctx.social?.pending_members ?? [], ctx).map((r) => ({
        applied_at: when(r.applied_at),
        handle: r.display_name === undefined ? r.handle : `${r.display_name}（${r.handle}）`,
        account: r.account,
        // 答案原文不上面板（外部文本，21 §1）——只报条数
        answers: r.answers,
      })),
    }),
  },
  {
    name: 'social.pending_threads',
    source: 'social',
    returns: 'table',
    run: (ctx) => ({
      columns: [
        { key: 'created_at', label: '什么时候' },
        { key: 'author', label: '谁说的' },
        { key: 'surface', label: '在哪儿' },
        { key: 'triage', label: '归类' },
        { key: 'body', label: '内容' },
      ],
      rows: ofChannel(ctx.social?.pending_threads ?? [], ctx).map((r) => ({
        created_at: r.created_at,
        author: r.author,
        surface: r.surface,
        triage: r.triage ?? '',
        body: r.excerpt,
      })),
    }),
  },
  {
    name: 'social.broadcast_queue',
    source: 'social',
    returns: 'table',
    run: (ctx) => ({
      columns: [
        { key: 'scheduled_at', label: '排在' },
        { key: 'account', label: '发到哪儿' },
        // 受众数**不是钱**：不标 `count` 的话前端会把 860 渲染成 US$860.00
        { key: 'audience', label: '发给', align: 'right' as const, format: 'count' as const },
        { key: 'body', label: '内容' },
      ],
      rows: ofChannel(ctx.social?.broadcasts ?? [], ctx).map((r) => ({
        scheduled_at: when(r.scheduled_at),
        account: r.account,
        audience: r.audience ?? 0,
        body: r.excerpt,
      })),
    }),
  },
  {
    name: 'social.support_handoffs',
    source: 'social',
    returns: 'table',
    run: (ctx) => ({
      columns: [
        { key: 'created_at', label: '什么时候' },
        { key: 'author', label: '谁问的' },
        { key: 'status', label: '到哪一步了' },
        { key: 'body', label: '问的是什么' },
      ],
      // 这条职责**没有**答客户问题，但它要看得见自己转出去了多少（56 边界行）
      rows: ofChannel(ctx.social?.handoffs ?? [], ctx).map((r) => ({
        created_at: r.created_at,
        author: r.author,
        status: r.status,
        body: r.excerpt,
      })),
    }),
  },
]

/*
 * 平台那一侧的两块：**一条渠道一个查询**，因为它们各自的"连没连"不一样。
 *
 * 查询名带渠道后缀（`social.performance_30d.meta`），积木那一层按职责挑对应那一条
 * （`blocks.ts` 的 `SOCIAL_CONTENT_BLOCKS` / `SOCIAL_COMMUNITY_BLOCKS`）。
 * Facebook 群组不在这里——它没有连接器（Groups API 已停），平台那一侧的数要等
 * WP73 的浏览器执行器；在那之前它的面板上只有我们自己库里那几块，**不出一块
 * 永远写着"还没连"的空表**（36 §3：说不出所以然的空图比没有更糟）。
 */
for (const spec of SOCIAL_CHANNELS) {
  const source = SOCIAL_SOURCE_BY_CHANNEL[spec.id]
  if (source === undefined) continue
  SOCIAL_QUERIES.push({
    name: `social.performance_30d.${spec.id}`,
    source,
    returns: 'table',
    run: (ctx) => ({
      columns: [
        { key: 'published_at', label: '什么时候发的' },
        { key: 'body', label: '内容' },
        // 五个数都不是钱。拿不到的一律空着——**不补 0**：
        // "这个平台不给这个数"与"这个数是 0"在面板上必须分得开
        { key: 'impressions', label: '曝光', align: 'right' as const, format: 'count' as const },
        { key: 'views', label: '播放', align: 'right' as const, format: 'count' as const },
        { key: 'likes', label: '互动', align: 'right' as const, format: 'count' as const },
        { key: 'new_followers', label: '涨粉', align: 'right' as const, format: 'count' as const },
      ],
      rows: ofChannel(ctx.social?.performance ?? [], ctx).map((r) => ({
        published_at: when(r.published_at),
        body: r.excerpt,
        impressions: r.impressions ?? '',
        views: r.views ?? '',
        likes: r.likes ?? '',
        new_followers: r.new_followers ?? '',
      })),
    }),
  })
  SOCIAL_QUERIES.push({
    name: `social.community_activity.${spec.id}`,
    source,
    returns: 'table',
    run: (ctx) => ({
      columns: [
        { key: 'account', label: '群' },
        { key: 'members', label: '成员', align: 'right' as const, format: 'count' as const },
        {
          key: 'active_7d',
          label: '近 7 天发过言',
          align: 'right' as const,
          format: 'count' as const,
        },
        { key: 'pending', label: '等着进群', align: 'right' as const, format: 'count' as const },
        { key: 'open', label: '没处理的', align: 'right' as const, format: 'count' as const },
        { key: 'observed_at', label: '看到于' },
      ],
      // 三个数各是各的，不合成一个"健康分"——合了没人答得上到底哪儿不对
      rows: ofChannel(ctx.social?.activity ?? [], ctx).map((r) => ({
        account: r.account,
        members: r.member_count ?? r.followers ?? '',
        active_7d: r.active_7d,
        pending: r.pending_members,
        open: r.open_threads,
        observed_at: r.observed_at,
      })),
    }),
  })
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
  // ── WP67（48 §5.1）：红人营销面板五块 ────────────────────────────────
  //
  // 五条都走 `kol` 这个源（我们自己的库，永远算连上）。`ctx.kol` 不给 = 这台机器上
  // 还没有红人岗位，五块一律空表——**与"还没连"不是一回事**（36 §3）：
  // 前者是"还没有人，先导入一张表"，后者是"去连接页把 YouTube 连上"。
  //
  // 数字一个都不在这里现算：分是 `kol-core` 的 `rankCreators` 算完的，
  // 点击 / 订单 / 收入是归因那一跳回填进库的（29 §1「数字不经模型手」）。
  {
    name: 'kol.discovery',
    source: 'kol',
    returns: 'table',
    run: (ctx) => ({
      columns: [
        { key: 'name', label: '红人' },
        { key: 'channel', label: '渠道' },
        // 粉丝数与分**不是钱**：不标 `count` 的话前端会把 48000 渲染成 US$48,000.00
        { key: 'followers', label: '粉丝', align: 'right' as const, format: 'count' as const },
        { key: 'score', label: '分', align: 'right' as const, format: 'count' as const },
        { key: 'note', label: '备注' },
      ],
      rows: (ctx.kol?.discovery ?? []).slice(0, 20).map((r) => ({
        name: r.display_name,
        channel: r.channel,
        followers: r.followers ?? 0,
        score: r.score,
        // 刷粉护栏那句话就在清单上说——把人悄悄拿掉，用户会以为我们没搜到他
        note: r.blocked ?? '',
      })),
    }),
  },
  {
    name: 'kol.outreach_funnel',
    source: 'kol',
    returns: 'table',
    run: (ctx) => ({
      columns: [
        { key: 'stage', label: '阶段' },
        { key: 'count', label: '人数', align: 'right' as const, format: 'count' as const },
      ],
      // 空的格子也出（`collaborationFunnel` 那一条）：漏斗的形状不能随数据变
      rows: (ctx.kol?.funnel ?? []).map((b) => ({ stage: b.label, count: b.count })),
    }),
  },
  {
    name: 'kol.collaborations',
    source: 'kol',
    returns: 'table',
    run: (ctx) => ({
      columns: [
        { key: 'name', label: '红人' },
        { key: 'channel', label: '渠道' },
        { key: 'stage', label: '阶段' },
        { key: 'budget', label: '预算', align: 'right' as const },
      ],
      rows: (ctx.kol?.collaborations ?? []).slice(0, 20).map((r) => ({
        name: r.display_name,
        channel: r.channel,
        stage: r.stage_label,
        budget: r.budget ?? 0,
        currency: r.currency,
      })),
    }),
  },
  {
    name: 'kol.pending_deliverables',
    source: 'kol',
    returns: 'table',
    run: (ctx) => ({
      columns: [
        { key: 'name', label: '红人' },
        { key: 'kind', label: '形态' },
        { key: 'due_at', label: '交付期限' },
        { key: 'url', label: '链接' },
      ],
      // 按期限正序：最急的在最上面，这就是队列本身（同 `orders.unfulfilled`）
      rows: (ctx.kol?.pending_deliverables ?? [])
        .slice()
        .sort((a, b) => Date.parse(a.due_at) - Date.parse(b.due_at))
        .slice(0, 20)
        .map((r) => ({
          name: r.display_name,
          kind: r.kind,
          due_at: r.due_at,
          url: r.url ?? '',
        })),
    }),
  },
  {
    name: 'kol.attribution',
    source: 'kol',
    returns: 'table',
    run: (ctx) => ({
      columns: [
        { key: 'name', label: '红人' },
        { key: 'channel', label: '渠道' },
        // 点击与订单是条数，只有收入是钱
        { key: 'clicks', label: '点击', align: 'right' as const, format: 'count' as const },
        { key: 'orders', label: '订单', align: 'right' as const, format: 'count' as const },
        { key: 'revenue', label: '收入', align: 'right' as const, format: 'money' as const },
      ],
      // 按收入倒序。归不上的订单一分钱都不在这张表里（`attribution.ts` 的 `unmatched`）——
      // 这个数宁可小，不能是猜的。
      rows: (ctx.kol?.attribution ?? [])
        .slice()
        .sort((a, b) => b.revenue - a.revenue)
        .slice(0, 20)
        .map((r) => ({
          name: r.display_name,
          channel: r.channel,
          clicks: r.clicks,
          orders: r.orders,
          revenue: r.revenue,
          currency: r.currency,
        })),
    }),
  },
  ...SOCIAL_QUERIES,
  // WP76（58 §3）：设计岗位五块
  ...DESIGN_QUERIES,
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
