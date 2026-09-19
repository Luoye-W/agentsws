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
import {
  ADS_PLATFORMS,
  adsPlatformOfRole,
  designDutyOfRole,
  SOCIAL_CHANNELS,
  socialChannelOfRole,
} from '@agentsws/contracts'
import { DeckError } from './errors.js'
import { ADS_SOURCE_BY_PLATFORM, SOCIAL_SOURCE_BY_CHANNEL } from './sources.js'
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
  /*
   * WP77（59 §3）：建站那三条车道。
   *
   * 三条**不合成一条**："这张卡要不要我点"在三条上的答案不一样，合成一张表
   * 之后人得自己一行行看 kind 才知道（59 §3 明写三条车道）。
   *
   * 车道走 `approvals` 这个源而不是 `site`：它读的是**审批项**，与建站库里那三张表
   * 没有关系——一条主题发布卡在建站库里连一行都没有。
   */
  { lane: 'theme_publish', label: '待发布的主题', kinds: ['publish_theme', 'theme_install'] },
  { lane: 'email_enable', label: '待启用的模板', kinds: ['email_template_edit'] },
  { lane: 'app_install', label: '待装 / 待卸的 App', kinds: ['app_install', 'app_config'] },
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

/* ── WP77（59 §3）：建站面板那五块 ────────────────────────────────────
 *
 * 五块全走 `site` 这个源（我们自己的库，永远算连上）。三条待审车道读的是
 * **同一份待审列表**，各自按 kind 筛——把三条合成一张表的话，"这张卡要不要我点"
 * 就得靠人自己一行行看 kind（59 §3 明写三条车道）。
 *
 * 检查单那一块的 `state` 原样出：**缺项与"没读到"是两种颜色**，合成一种
 * 就等于把"这家店没有收款方式"与"这次没读到支付设置"说成同一句话。
 */
const SITE_QUERIES: QueryDef[] = [
  {
    name: 'site.launch_checklist',
    source: 'site',
    returns: 'table',
    run: (ctx) => ({
      columns: [
        { key: 'item', label: '这一项' },
        { key: 'state', label: '结论' },
        { key: 'detail', label: '现在是什么样' },
        { key: 'fix', label: '怎么补' },
      ],
      rows: (ctx.site?.checklist ?? []).map((r) => ({
        item: r.title,
        // 三种说法各不相同：过了 / 缺（分能不能开门）/ 这次没读到
        state:
          r.state === 'ok'
            ? '过了'
            : r.state === 'unknown'
              ? '没读到'
              : r.severity === 'blocker'
                ? '缺（买不成）'
                : '缺（迟早出事）',
        detail: r.detail,
        // `fix` 原样出：补不了的那两项（支付 / 税）在纯函数那一层写的就已经是
        // "去后台自己点"，这里再按 `fixable` 改写一遍等于把同一句话说两个版本。
        // `fixable` 留在 `SiteDeckData` 上给界面上那个「去补」按钮判要不要出。
        fix: r.fix,
      })),
    }),
  },
  {
    name: 'site.theme_copies',
    source: 'site',
    returns: 'table',
    run: (ctx) => ({
      columns: [
        { key: 'name', label: '主题' },
        { key: 'role', label: '在哪' },
        { key: 'preview', label: '预览' },
        { key: 'updated_at', label: '改于' },
      ],
      rows: (ctx.site?.themes ?? []).map((r) => ({
        name: r.name,
        role: r.role === 'live' ? '线上' : '副本',
        // 没有预览链接的副本要看得出来：没有它发布卡根本提不出去（12 §2）
        preview: r.preview_url ?? '',
        updated_at: when(r.updated_at),
      })),
    }),
  },
  {
    name: 'site.installed_apps',
    source: 'site',
    returns: 'table',
    run: (ctx) => ({
      columns: [
        { key: 'name', label: 'App' },
        { key: 'installed', label: '装了吗' },
        { key: 'note', label: '说明' },
      ],
      rows: (ctx.site?.apps ?? []).map((r) => ({
        name: r.name,
        installed: r.installed ? '已装' : '没装',
        // 三句话各不相同，别合成一句
        note: !r.known
          ? '不在我们的目录里——它要了什么权限得你自己去后台看'
          : r.connectable
            ? '装了，但我们这边还没连上它的 API'
            : '',
      })),
    }),
  },
  {
    name: 'site.email_templates',
    source: 'site',
    returns: 'table',
    run: (ctx) => ({
      columns: [
        { key: 'name', label: '这封信' },
        { key: 'enabled', label: '在用吗' },
        { key: 'missing', label: '缺变量', align: 'right' as const, format: 'count' as const },
        { key: 'draft', label: '有草稿' },
      ],
      rows: (ctx.site?.email_templates ?? []).map((r) => ({
        name: r.name,
        enabled: r.enabled ? '在用' : '出厂那一份',
        missing: r.missing_variables,
        draft: r.has_draft ? '有一份等你点' : '',
      })),
    }),
  },
]

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

/** 只取到天（`2026-09-21`）。设计的期限从来不是"下午三点"，时分秒只是噪音。 */
const day = (iso: string | undefined): string => (iso ?? '').slice(0, 10)

/**
 * 需求单的状态 → 人话。
 *
 * 英文状态名在面板上没有意义（`generating` 对用户是一个谜），而翻译这件事
 * 只该做一次——所以这张表在这里，不在渲染层。
 */
const DESIGN_STATUS_ZH: Record<string, string> = {
  queued: '排着队',
  briefed: '出了 brief',
  generating: '正在出图',
  awaiting_pick: '等你挑',
  delivered: '交付了',
  cancelled: '取消了',
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
        // 过期的那一行把话说出来：**这件事没做成**，不是"逾期"，也不靠颜色表达。
        // 只取到天：设计的期限从来不是"下午三点"，写出时分秒只是噪音。
        due_at: r.overdue ? `${day(r.due_at)}（已经过了）` : day(r.due_at),
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
        status: DESIGN_STATUS_ZH[r.status] ?? r.status,
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
        // 张数不是钱：不说 `count` 的列按金额渲染，`4` 会变成 `US$4.00`（WP63 那条）
        { key: 'final', label: '定稿', format: 'count', align: 'right' },
        { key: 'count', label: '一共', format: 'count', align: 'right' },
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
          { key: 'value', label: '几张', format: 'count', align: 'right' },
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

/* ── WP78（60 §3）：公关面板的五块 ─────────────────────────────────────
 *
 * 与社媒那九块同一种分层（36 §3「没连就明说」只对得上其中一层）：
 *
 * - **我们自己库里那三块**（待发新闻稿 / pitch 漏斗 / 外部露出）走 `pr`
 *   这个源——它永远算连上。一个平台都没连，稿子照样写得出来。
 * - **外面那一侧两块**（提及流 / 负面预警）走 `google_alerts`。
 *
 * 不按职责筛行：四条职责挑的是**不同的块**（`blocks.ts` 的三组），
 * 而不是同一块里各看各的行——公关这四条职责看的是同一批提及、同一批稿子。
 * 社媒那边要按渠道筛，是因为九条职责对着九个互不相干的号。
 */
/**
 * 面板上那几列的**人话**。
 *
 * 枚举值（`routed_to_support` / `blocked`）是给机器看的；面板上印一个下划线
 * 拼起来的英文词，等于让人自己去猜。这张表只管"怎么念"，不改任何判断——
 * 认不出来的原样端出去（**不编一个词**）。
 */
const MENTION_STATUS_WORDS: Readonly<Record<string, string>> = {
  new: '刚看到',
  triaged: '判过了',
  routed_to_support: '转给客服了',
  responded: '回过了',
  archived: '归档',
}
const EXTERNAL_POST_WORDS: Readonly<Record<string, string>> = {
  draft: '草稿',
  approved: '批了，等发',
  published: '发出去了',
  blocked: '版规不让',
  removed: '被删了',
}
const word = (table: Readonly<Record<string, string>>, value: string): string =>
  table[value] ?? value

const PR_QUERIES: QueryDef[] = [
  {
    name: 'pr.mentions',
    source: 'google_alerts',
    returns: 'table',
    run: (ctx) => ({
      columns: [
        { key: 'published_at', label: '什么时候' },
        { key: 'origin', label: '在哪儿' },
        { key: 'sentiment', label: '情绪' },
        { key: 'triage', label: '归谁' },
        { key: 'body', label: '说了什么' },
      ],
      rows: (ctx.pr?.mentions ?? []).map((r) => ({
        published_at: r.published_at,
        origin: r.origin,
        // 没判过就空着——**不写"中性"**：没判与判成中性是两件事
        sentiment: r.sentiment ?? '',
        triage: r.triage ?? '',
        body: r.excerpt,
      })),
    }),
  },
  {
    name: 'pr.negative_alerts',
    /*
     * 这一块走 `pr` 而不是 `google_alerts`，与上面那一块**故意不一样**：
     *
     * 提及流是**外面那一侧**——没连 feed 的时候它必须说"去连接"，因为
     * 一张空表在这里等于说"今天没人提我们"，而那是这条职责上最贵的一种谎。
     * 负面预警不同：一条预警是**我们自己判出来并开出来的卡**，空的意思就是
     * "现在没有着火的"——那句话是真的，不需要加条件。
     */
    source: 'pr',
    returns: 'table',
    run: (ctx) => ({
      columns: [
        { key: 'published_at', label: '什么时候' },
        { key: 'origin', label: '谁在说' },
        // 被转了几次 = 要不要升级的判据（去重那一步算出来的，不在这儿现算）
        {
          key: 'seen_count',
          label: '被转了几次',
          align: 'right' as const,
          format: 'count' as const,
        },
        { key: 'body', label: '说了什么' },
      ],
      rows: (ctx.pr?.negative_alerts ?? []).map((r) => ({
        published_at: r.published_at,
        origin: r.author === undefined ? r.origin : `${r.author}（${r.origin}）`,
        seen_count: r.seen_count ?? '',
        body: r.excerpt,
      })),
    }),
  },
  {
    name: 'pr.release_queue',
    source: 'pr',
    returns: 'table',
    run: (ctx) => ({
      columns: [
        { key: 'headline', label: '标题' },
        { key: 'status', label: '状态' },
        // 两个数不等 = 稿子里有数没出处（19 §3）。合成一个"合规"钩子的话，
        // 人看不出差在哪儿
        { key: 'figures', label: '有几个数', align: 'right' as const, format: 'count' as const },
        { key: 'cited', label: '有出处的', align: 'right' as const, format: 'count' as const },
        { key: 'embargo_until', label: '禁发至' },
      ],
      rows: (ctx.pr?.releases ?? []).map((r) => ({
        headline: r.headline,
        status: r.status,
        figures: r.figures,
        cited: r.facts_cited,
        embargo_until: when(r.embargo_until),
      })),
    }),
  },
  {
    name: 'pr.pitch_funnel',
    source: 'pr',
    returns: 'table',
    run: (ctx) => ({
      columns: [
        { key: 'label', label: '到哪一步了' },
        { key: 'count', label: '几个人', align: 'right' as const, format: 'count' as const },
      ],
      // 六档都出一行，没有人的那一档也是 0——"这一档没人"本身就是一句话
      rows: (ctx.pr?.pitch_funnel ?? []).map((r) => ({ label: r.label, count: r.count })),
    }),
  },
  {
    name: 'pr.external_posts',
    source: 'pr',
    returns: 'table',
    run: (ctx) => ({
      columns: [
        { key: 'venue', label: '发到哪儿' },
        { key: 'status', label: '状态' },
        { key: 'rules', label: '版规' },
        { key: 'score', label: '赞', align: 'right' as const, format: 'count' as const },
        { key: 'replies', label: '回复', align: 'right' as const, format: 'count' as const },
        { key: 'body', label: '内容' },
      ],
      rows: (ctx.pr?.external_posts ?? []).map((r) => ({
        venue: `${r.platform}／${r.venue}`,
        // 被删掉的那一条要看得见——混进"已发布"里就再也没人知道它没了
        status:
          r.removed === true
            ? word(EXTERNAL_POST_WORDS, 'removed')
            : word(EXTERNAL_POST_WORDS, r.status),
        // 版规拦下来的理由**原样**显示：与 guardrail 那一侧是同一个字符串
        rules: r.rules_ok ? '过了' : (r.rules_reasons ?? '没过'),
        score: r.score ?? '',
        replies: r.replies ?? '',
        body: r.excerpt,
      })),
    }),
  },
  {
    name: 'pr.support_handoffs',
    source: 'pr',
    returns: 'table',
    run: (ctx) => ({
      columns: [
        { key: 'published_at', label: '什么时候' },
        { key: 'origin', label: '在哪儿说的' },
        { key: 'status', label: '到哪一步了' },
        { key: 'body', label: '说了什么' },
      ],
      rows: (ctx.pr?.handoffs ?? []).map((r) => ({
        published_at: r.published_at,
        origin: r.author === undefined ? r.origin : `${r.author}（${r.origin}）`,
        status: word(MENTION_STATUS_WORDS, r.status),
        body: r.excerpt,
      })),
    }),
  },
]

/* ── WP75（57 §3）：投放面板那九块 ──────────────────────────────────────
 *
 * 分两层，理由与社媒那九块逐字相同（36 §3）：
 *
 * - **我们自己算出来的那几块**（今日花费 / 总闸剩余、ROAS 两口径、止损次数、
 *   campaign 表、待审四车道、止损记录、归因、日报）走 `ads` 这个源。
 * - **平台那一侧那两块**（转化数、像素健康）走**这条职责自己的平台源**——
 *   连上 Meta 不会把 Google 的像素那一块点亮。
 *
 * 除了"今日花费 / 总闸剩余"，每一块都按 `ctx.role_id` 那个平台筛：
 * 四条职责共用一份投影（宿主算的），面板这一层各看各的。
 *
 * **总闸那一块不筛**：它是岗位级的（04 §5），四个平台加起来算的那一个数。
 * 按平台筛的话，挂着 Meta 的人看到的"还剩多少"会是一个偏大的数——
 * 而他正要拿这个数去决定加不加预算。
 */

/** 这条职责是哪个平台；不是投放职责就没有——那时一行都不出。 */
function platformOfRole(role_id: string): string | undefined {
  return adsPlatformOfRole(role_id)?.id
}

/** 只留这条职责自己那个平台的行。 */
function ofPlatform<T extends { platform: string }>(rows: readonly T[], ctx: QueryContext): T[] {
  const platform = platformOfRole(ctx.role_id)
  // 认不出平台（不是投放职责）就一行不出——**不是**把四个平台全端出来
  return platform === undefined ? [] : rows.filter((r) => r.platform === platform)
}

/** 数字块拿不到数就空着（**不补 0**：没拉到数与真的是 0 要分得开）。 */
const numOrBlank = (v: number | undefined): number | string => v ?? ''

const ADS_QUERIES: QueryDef[] = [
  {
    /*
     * 今日花费 / 总闸剩余。**一个岗位一份**，不按平台筛（见本节开头）。
     *
     * `value` 是今天花了多少、`previous` 是总闸那个数——于是面板上那一格
     * 天然读成"花了 X / 上限 Y"。`spark` 是四个平台各花了多少（最多四根），
     * 一眼看得出钱花在哪一边。
     */
    name: 'ads.spend_today',
    source: 'ads',
    returns: 'scalar',
    run: (ctx) => {
      const gate = ctx.ads?.spend_gate
      if (gate === undefined) return { value: 0, previous: 0, spark: [] }
      return {
        value: gate.spent,
        previous: gate.cap,
        spark: gate.by_platform.map((r) => r.spend),
        ...(gate.currency === undefined ? {} : { currency: gate.currency }),
      }
    },
  },
  {
    /*
     * ROAS 两口径。**一格里放不下两个数**，所以这一格放的是**订单口径**
     * （`value`）与**平台口径**（`previous`）——面板上那一格读成
     * "订单口径 X（平台说 Y）"。合成一个数在 57 §1 里是明令禁止的。
     */
    name: 'ads.roas_two_views',
    source: 'ads',
    returns: 'scalar',
    run: (ctx) => {
      const rows = ofPlatform(ctx.ads?.attribution ?? [], ctx)
      if (rows.length === 0) return { value: 0, previous: 0, spark: [] }
      const avg = (pick: (r: (typeof rows)[number]) => number | undefined): number => {
        const got = rows.map(pick).filter((v): v is number => v !== undefined)
        return got.length === 0
          ? 0
          : Math.round((got.reduce((a, b) => a + b, 0) / got.length) * 100) / 100
      }
      return {
        value: avg((r) => r.order_roas),
        previous: avg((r) => r.platform_roas),
        spark: rows.map((r) => r.order_roas ?? 0),
      }
    },
  },
  {
    name: 'ads.stop_loss_count',
    source: 'ads',
    returns: 'scalar',
    run: (ctx) => {
      const rows = ofPlatform(ctx.ads?.stop_losses ?? [], ctx)
      return { value: rows.length, previous: 0, spark: [] }
    },
  },
  {
    name: 'ads.campaigns',
    source: 'ads',
    returns: 'table',
    run: (ctx) => ({
      columns: [
        { key: 'name', label: 'campaign' },
        { key: 'account', label: '账户' },
        { key: 'status', label: '状态' },
        { key: 'daily_budget', label: '日预算', align: 'right' as const, format: 'money' as const },
        { key: 'spend', label: '今天花了', align: 'right' as const, format: 'money' as const },
        { key: 'roas', label: 'ROAS（平台口径）', align: 'right' as const },
        { key: 'observed_at', label: '看到于' },
      ],
      rows: ofPlatform(ctx.ads?.campaigns ?? [], ctx).map((r) => ({
        name: r.name,
        account: r.account,
        status: r.status,
        daily_budget: numOrBlank(r.daily_budget),
        spend: numOrBlank(r.spend),
        roas: numOrBlank(r.roas),
        observed_at: r.observed_at ?? '',
      })),
    }),
  },
  {
    /*
     * 待审改动**四条车道**（57 §3）。
     *
     * 为什么分车道而不是一张"待审 6 条"：这四种卡该看的东西不一样——
     * 新建看预算与受众、改预算看幅度与总闸、改出价看幅度、换素材看文案与图。
     * 混成一张，人只能一张张点开看它到底是哪一类（同 51 §2.1 店铺那四条车道）。
     */
    name: 'ads.pending_changes',
    source: 'ads',
    returns: 'table',
    run: (ctx) => ({
      columns: [
        { key: 'lane', label: '车道' },
        { key: 'target', label: '改哪条' },
        { key: 'summary', label: '改成什么' },
        { key: 'created_at', label: '提于' },
      ],
      rows: ofPlatform(ctx.ads?.pending ?? [], ctx).map((r) => ({
        lane: r.lane,
        target: r.target,
        summary: r.summary,
        created_at: r.created_at ?? '',
      })),
    }),
  },
  {
    name: 'ads.stop_loss_log',
    source: 'ads',
    returns: 'table',
    run: (ctx) => ({
      columns: [
        { key: 'at', label: '什么时候停的' },
        { key: 'name', label: 'campaign' },
        { key: 'roas', label: 'ROAS', align: 'right' as const },
        { key: 'spend', label: '停之前花了', align: 'right' as const, format: 'money' as const },
        // 判据那句话原样端出去：人要看的是"为什么停"，不是"停了"
        { key: 'reason', label: '判据' },
      ],
      rows: ofPlatform(ctx.ads?.stop_losses ?? [], ctx).map((r) => ({
        at: r.at,
        name: r.name,
        roas: numOrBlank(r.roas),
        spend: numOrBlank(r.spend),
        reason: r.reason,
      })),
    }),
  },
  {
    /*
     * 归因：**两列并排，永不合并**（57 §1）。
     *
     * `gap_pct` 那一列是算给人看的差距，不是修正值——它旁边的两列一个数都没动。
     */
    name: 'ads.daily_report',
    source: 'ads',
    returns: 'table',
    run: (ctx) => ({
      columns: [
        { key: 'campaign', label: 'campaign' },
        {
          key: 'platform_conversions',
          label: '平台口径转化',
          align: 'right' as const,
          format: 'count' as const,
        },
        {
          key: 'order_conversions',
          label: '订单口径转化',
          align: 'right' as const,
          format: 'count' as const,
        },
        { key: 'gap_pct', label: '差多少', align: 'right' as const },
        { key: 'observed_at', label: '看到于' },
      ],
      rows: ofPlatform(ctx.ads?.attribution ?? [], ctx).map((r) => ({
        campaign: r.campaign,
        platform_conversions: numOrBlank(r.platform_conversions),
        order_conversions: numOrBlank(r.order_conversions),
        gap_pct: r.gap_pct === undefined ? '' : `${r.gap_pct}%`,
        observed_at: r.observed_at ?? '',
      })),
    }),
  },
]

/*
 * 平台那一侧的两块：**一个平台一个查询**，因为它们各自的"连没连"不一样
 * （同社媒那两块）。查询名带平台后缀（`ads.pixel_health.meta`），
 * 积木那一层按职责挑对应那一条。
 */
for (const spec of ADS_PLATFORMS) {
  const source = ADS_SOURCE_BY_PLATFORM[spec.id]
  if (source === undefined) continue
  ADS_QUERIES.push({
    name: `ads.conversions.${spec.id}`,
    source,
    returns: 'scalar',
    run: (ctx) => {
      const rows = ofPlatform(ctx.ads?.campaigns ?? [], ctx)
      const got = rows.map((r) => r.conversions).filter((v): v is number => v !== undefined)
      return {
        value: got.reduce((a, b) => a + b, 0),
        previous: 0,
        spark: got,
      }
    },
  })
  ADS_QUERIES.push({
    name: `ads.pixel_health.${spec.id}`,
    source,
    returns: 'table',
    run: (ctx) => ({
      columns: [
        { key: 'event_name', label: '事件' },
        { key: 'status', label: '状态' },
        {
          key: 'count_24h',
          label: '近 24 小时',
          align: 'right' as const,
          format: 'count' as const,
        },
        { key: 'last_fired_at', label: '上次收到' },
        // 平台说的原话原样显示，不翻译成"出错了"
        { key: 'note', label: '平台怎么说' },
      ],
      rows: ofPlatform(ctx.ads?.pixels ?? [], ctx).map((r) => ({
        event_name: r.event_name,
        status: r.status,
        count_24h: numOrBlank(r.count_24h),
        last_fired_at: r.last_fired_at ?? '',
        note: r.note ?? '',
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
    /*
     * WP117b（Luoye 待定项的默认做法）：**演练漏斗单独一块。**
     *
     * 上面那块「建联漏斗」从此一条演练数据都不含——它是拿来做判断的数，
     * 掺进 24 个合成红人之后就再也不能看了。演练开着时这一块才有行；
     * 关掉演练 `sandbox_funnel` 连同它一起没有（**不是清零**）。
     */
    name: 'kol.sandbox_funnel',
    source: 'kol',
    returns: 'table',
    run: (ctx) => ({
      columns: [
        { key: 'stage', label: '阶段' },
        { key: 'count', label: '人数', align: 'right' as const, format: 'count' as const },
      ],
      rows: (ctx.kol?.sandbox_funnel ?? []).map((b) => ({ stage: b.label, count: b.count })),
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
  ...SITE_QUERIES,
  ...ADS_QUERIES,
  // WP78（60 §3）：公关五块
  ...PR_QUERIES,
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
