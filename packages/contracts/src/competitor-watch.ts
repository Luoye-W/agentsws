/**
 * WP392（docs/104 v1，决策 1101–1108，Luoye 10-18）：**竞品监控积木**的数据形状。
 *
 * 盯竞品独立站的上新 / 下架 / 改价 / 打折 / 断货，和 Amazon 上几款对标商品的价格、优惠券、评分、评论数、BSR。
 * 和公关信息监控（`pr-watch.ts`，docs/103）**共用一套监控源**（{@link CompetitorWatchSource} 就是一条 `MonitorSource`），
 * 不一样的只有一处：信息监控是「新来一条就算一条」，这里是「**和上一次的快照比出差别才算一条**」。
 *
 * - 竞品清单**只有一份**（C3）：`BrandWatch.competitors`（`seo.ts`），竞品身上加 `store` / `amazon` 两格；
 *   自家的 Amazon 商品在 `BrandWatch.brand.amazon`（C8 对照）。监控源由这份清单同步出来，不另建清单。
 * - {@link CatalogSnapshotRow}：一次读取里的一行（一个商品的一个款式；Amazon 一个 ASIN 一行）。
 * - {@link CompetitorIntakeAdapter}：进料口适配器——每种来源一个（独立站 WP393、Amazon WP394），只管「读一次、交回几行」，
 *   判变化、入库、调度都在同一条管道里（WP392）。
 * - {@link CompetitorChange}：比出来的一条变化（竞品变化表的一行；报告积木里是 `WatchItem.kind = 'change'`）。
 * - {@link CompetitorWatchStore}：存储接口（每个品牌一份）。**只存每一行的最新值 + 每次读到过的时间，不存整页原文**。
 *
 * **WP393 / WP394 从本文件所在的提交拉分支：这份形状提交后不再改，以后只加不删。**
 *
 * 纪律：
 * - 第一次读只当底子，不出任何变化（不报「上新 398 件」）；
 * - 不用店铺自己的 `updated_at` 判「改了」（实测天天被插件批量刷），一律自己存快照比；
 * - 什么算「重要」、多大幅度才提醒一律不在这里判（C5，不替用户定运营规矩）：算出来就记，`importance` 二期才填；
 * - 读不到就照实说：一条源失败记 `status: 'failed'` + `last_error`（人话），面板与简报照实写「没读到」，**不显示成 0**；
 * - 用户看得到的字不提任何数据供应商名，只说「从他店里公开的商品数据读的」「工坊云端数据」。
 */
import type { Iso8601, WorkspaceId } from './common.js'
import type { MonitorRunPart, MonitorSource } from './pr-watch.js'

/* ── 监控源 ───────────────────────────────────────────────────────── */

/** 竞品监控的两种进料口（`MonitorSourceKind` 里 WP392 加的那两种）。 */
export type CompetitorSourceKind = 'shop_catalog' | 'amazon_asin'

export const COMPETITOR_SOURCE_KINDS: readonly CompetitorSourceKind[] = [
  'shop_catalog',
  'amazon_asin',
]

/** 自家（C8 对照）在 `competitor_id` 里的写法（竞品用 `BrandWatchCompetitor.id`）。 */
export const OWN_BRAND_COMPETITOR_ID = '_own'

/** 这一次是走哪条路读到的（连接卡 / 方案卡上用一句话说清，不提供应商名）。 */
export type CatalogReadVia = 'direct' | 'browser' | 'cloud' | 'official'

/**
 * 一条竞品监控源（一家竞品的独立站，或一家竞品在某个 Amazon 站点上的那几款）。
 *
 * 就是一条 `MonitorSource`（连接卡、计划卡、简报和信息监控读同一个形状），多几格：
 * - `url`：独立站是店铺首页；Amazon 是站点首页（`https://www.amazon.com`）；
 * - `label`：竞品名（自家写品牌名）；`competitor`：竞品名快照；`group`：竞品 `competitor`、自家 `own`；
 * - 由 `BrandWatch` 同步出来，`added_via: 'suggest'`（AI 建议、用户在方案卡上确认的）。
 */
export interface CompetitorWatchSource extends MonitorSource {
  kind: CompetitorSourceKind
  /** `BrandWatchCompetitor.id`；自家 = {@link OWN_BRAND_COMPETITOR_ID}。 */
  competitor_id: string
  /** 独立站：平台（照 `BrandWatchStore.platform`）。 */
  platform?: 'shopify' | 'woocommerce' | 'other' | 'unknown'
  /** Amazon：站点国家码（`US`）。 */
  marketplace?: string
  /** Amazon：这一组盯哪几个 ASIN（照 `BrandWatchAmazonItem`）。 */
  asins?: string[]
  /** 上一次读全了没有（翻页断了、被挡 = `false`：那一次整次不判下架）。 */
  last_complete?: boolean
  /** 上一次读到几行。 */
  last_rows?: number
  /** 上一次走哪条路读到的。 */
  last_via?: CatalogReadVia
}

/* ── 快照 ─────────────────────────────────────────────────────────── */

/** Amazon 的一档 BSR（大类或小类里排第几）。 */
export interface CatalogBsr {
  rank: number
  /** 类目名（`Sports & Outdoors`、`Electric Bikes`）。 */
  category: string
}

/** 一次读取里的一行：一个商品的一个款式（独立站按变体；Amazon 一个 ASIN 一行，`variant_key` 不填）。 */
export interface CatalogSnapshotRow {
  source_id: string
  competitor_id: string
  /** 商品键：Shopify 商品 id / WooCommerce 商品 id / ASIN。 */
  product_key: string
  /** 变体键：Shopify 变体 id / WooCommerce 变体 id；没有变体不填。 */
  variant_key?: string
  /** 商品标题。 */
  title: string
  /** 款式名（`Large / Black`）；没有不填。 */
  variant_title?: string
  /** 商品页链接。 */
  url?: string
  /** 主图链接。 */
  image?: string
  /** 现价（主币种单位，`1599` = $1,599）。读不到不填。 */
  price?: number
  /** 划线价（原价）；比现价高 = 在打折。没有不填。 */
  compare_at_price?: number
  /** 币种（`USD`）。 */
  currency?: string
  /** 有没有货；读不到不填。 */
  available?: boolean
  /** Amazon：评分（0–5）。 */
  rating?: number
  /** Amazon：评论数。 */
  reviews?: number
  /** Amazon：BSR，第一项是大类，其余是小类。 */
  bsr?: CatalogBsr[]
  /** Amazon：优惠券文字（`Save $50 with coupon`）；没有不填。 */
  coupon?: string
  /**
   * Amazon：五点（WP398 词库拆词用；只加的一格，`amazon_asin` 进料口读商品页时顺手填，读不到不填）。
   */
  bullets?: string[]
  /** 商品创建时间（Shopify `created_at`；判「上新」用）。读不到不填，就只看「第一次出现」。 */
  product_created_at?: Iso8601
  /** 这一行是什么时候读到的。 */
  read_at: Iso8601
  /**
   * WP394：这一次**这条路读不到**的格子（云端那一路没有划线价、优惠券）。写在这里的格子照实空着，
   * 对比时不拿「空」当「没了」（不报「打折结束」），快照里留着上一次读到的值。
   */
  fields_unread?: CatalogUnreadField[]
}

/** WP394：一条路可能读不到的那几格。 */
export type CatalogUnreadField = 'compare_at_price' | 'coupon'

/** 快照里存的一行：这一行的最新值 + 每次读到过的时间。 */
export interface CatalogStateRow extends CatalogSnapshotRow {
  /** 第一次读到。 */
  first_seen_at: Iso8601
  /** 最近一次读到。 */
  last_seen_at: Iso8601
  /** 连续几次**读全了**都没读到（读不全的那一次不算）；到 2 判下架。 */
  missing: number
  /** 已经判过下架（再出现 = 重新上架，不算上新）。 */
  removed?: true
}

/** 一条监控源的「上一次快照」（下一次读回来就和它比）。 */
export interface CatalogSnapshot {
  source_id: string
  workspace_id: WorkspaceId
  rows: CatalogStateRow[]
  /** 读成过几次（第一次 = 只当底子）。 */
  reads: number
  /** 最近一次读成的时刻。 */
  read_at: Iso8601
}

/** 进料口交回来的一次读取。 */
export interface CatalogReadResult {
  rows: CatalogSnapshotRow[]
  /**
   * 读全了没有。翻页断了、某页被挡、只读到一部分 = `false`：这一次照样比价 / 比库存，但**整次不判下架**。
   */
  complete: boolean
  /** 这一次没读成（一行都没有）的一句人话（`读不到 aventon.com 的商品数据：对方挡了`）。有它 = 这条源记失败。 */
  error?: string
  via?: CatalogReadVia
  /** 走云端时扣了几个积分（有才填）。 */
  credits?: number
  /** 给简报 / 连接卡的几句（`第 2 页没读到`、`被拦了，改走工坊云端数据`）。 */
  notes?: string[]
}

/** 进料口读一次时的上下文。 */
export interface CatalogReadContext {
  workspace_id: WorkspaceId
  now: Iso8601
  signal?: AbortSignal
}

/**
 * 进料口适配器：每种来源一个（`shop_catalog` WP393、`amazon_asin` WP394）。只管读一次、交回几行；
 * 判变化、入库、调度、连接卡状态都在同一条管道里（WP392 的 `competitor-watch` 服务）。
 * 读不到别抛：回 `{ rows: [], complete: false, error }`（抛了也会被管道接住、记成失败）。
 */
export interface CompetitorIntakeAdapter {
  kind: CompetitorSourceKind
  read(source: CompetitorWatchSource, ctx: CatalogReadContext): Promise<CatalogReadResult>
}

/* ── 变化 ─────────────────────────────────────────────────────────── */

/** 比出来的变化有哪几种（docs/104 §3.3）。 */
export type CompetitorChangeKind =
  | 'new'
  | 'removed'
  | 'price'
  | 'discount_start'
  | 'discount_end'
  | 'out_of_stock'
  | 'back_in_stock'
  | 'rating'
  | 'reviews'
  | 'bsr'

export const COMPETITOR_CHANGE_KINDS: readonly CompetitorChangeKind[] = [
  'new',
  'removed',
  'price',
  'discount_start',
  'discount_end',
  'out_of_stock',
  'back_in_stock',
  'rating',
  'reviews',
  'bsr',
]

/** 变化种类的人话名（变化表、报告、简报读它）。 */
export const COMPETITOR_CHANGE_KIND_LABELS: Readonly<
  Record<CompetitorChangeKind, { zh: string; en: string }>
> = {
  new: { zh: '上新', en: 'New' },
  removed: { zh: '下架', en: 'Removed' },
  price: { zh: '改价', en: 'Price' },
  discount_start: { zh: '开始打折', en: 'Sale started' },
  discount_end: { zh: '打折结束', en: 'Sale ended' },
  out_of_stock: { zh: '断货', en: 'Out of stock' },
  back_in_stock: { zh: '补货', en: 'Back in stock' },
  rating: { zh: '评分', en: 'Rating' },
  reviews: { zh: '评论数', en: 'Reviews' },
  bsr: { zh: '排名', en: 'Best Sellers Rank' },
}

/** 前值 / 后值（价是数、评分是数、BSR 是名次、优惠券是文字、有没有货是真假；没有 = `null`）。 */
export type CompetitorChangeValue = number | string | boolean | null

/** C8：和自家对标款比（`vs_own` 写了、自家那一款读得到、币种一样才有）。 */
export interface CompetitorVsOwn {
  /** 自家那一款的键（ASIN 或独立站商品 handle）。 */
  own_key: string
  own_title?: string
  /** 自家现价。 */
  own_price: number
  /** 竞品现价 − 自家现价（负数 = 他比你便宜）。 */
  diff: number
  currency?: string
}

/** 比出来的一条变化（竞品变化表的一行）。 */
export interface CompetitorChange {
  /** 本机 id（`cc_…`）。 */
  id: string
  workspace_id: WorkspaceId
  kind: CompetitorChangeKind
  competitor_id: string
  /** 竞品名快照（改名不影响历史）。 */
  competitor: string
  source_id: string
  source_kind: CompetitorSourceKind
  product_key: string
  /** 哪几个款式一起变的（同一商品多个变体合成一条时）。 */
  variant_keys?: string[]
  /** 一起变的款式数（≥ 2 才填：「3 个款式降价 10%–15%」）。 */
  variants?: number
  title: string
  url?: string
  image?: string
  /** 前值 / 后值（多款式合成时是变得最多的那一款）。 */
  before?: CompetitorChangeValue
  after?: CompetitorChangeValue
  /** 幅度（%，带正负：`-12.5` = 降 12.5%）；多款式合成时是变得最多的那一款。 */
  pct?: number
  /** 多款式合成时的幅度范围（`[-15, -10]`）。 */
  pct_range?: [number, number]
  /** BSR：哪个类目。 */
  category?: string
  currency?: string
  detected_at: Iso8601
  vs_own?: CompetitorVsOwn
  /** 重不重要（二期由规则 + 模型判；本期不填）。 */
  importance?: 'high' | 'normal'
}

/** 查变化表的条件。 */
export interface CompetitorChangeQuery {
  /** 按发现时间（含 since，不含 until）。 */
  since?: Iso8601
  until?: Iso8601
  competitor_id?: string
  kinds?: CompetitorChangeKind[]
  source_id?: string
  source_kind?: CompetitorSourceKind
  limit?: number
}

/* ── 设置与每一轮 ─────────────────────────────────────────────────── */

/** 每个品牌一份的竞品监控设置（只给默认值，用户能改；决策 668）。 */
export interface CompetitorWatchSettings {
  enabled: boolean
  /** 一天一次时本地几点之后读（默认 9）。 */
  day_start_hour: number
  /** 隔几小时读一次（默认 24 = 一天一次）。 */
  every_hours: number
  /** 「上新」只认创建时间在最近几天内的（默认 7；重新上架的老货不算）。 */
  new_within_days: number
}

export const COMPETITOR_WATCH_SETTINGS_DEFAULTS: Readonly<CompetitorWatchSettings> = {
  enabled: true,
  day_start_hour: 9,
  every_hours: 24,
  new_within_days: 7,
}

/** 下架要连续几次读全了都没读到（防一次没读全）。 */
export const COMPETITOR_REMOVED_AFTER_MISSES = 2

/** 一轮里一条源的结局（`MonitorRunPart` 多几格）。 */
export interface CompetitorWatchRunPart extends MonitorRunPart {
  /** 这条源这一次比出几条变化。 */
  changes: number
  /** 读全了没有。 */
  complete?: boolean
  via?: CatalogReadVia
  /** 第一次读、只建了底子。 */
  baseline?: true
}

/** 一轮竞品监控（定时 / 立即）。 */
export interface CompetitorWatchRun {
  id: string
  workspace_id: WorkspaceId
  trigger: 'schedule' | 'manual' | 'added'
  started_at: Iso8601
  finished_at?: Iso8601
  parts: CompetitorWatchRunPart[]
  /** 这一轮新记了几条变化。 */
  changes: number
  /** 给简报的几句（哪家没读到、哪家只读到一部分…）。 */
  notes: string[]
}

/* ── 存储接口（每品牌一份；WP393 / WP394 依赖它，形状不再改）────────── */

export interface CompetitorWatchStore {
  readonly workspace_id: WorkspaceId
  /** 监控源（含各来源最近一次读的结果：`status` / `last_ok_at` / `last_error` / `last_complete`…）。 */
  sources(): CompetitorWatchSource[]
  source(id: string): CompetitorWatchSource | undefined
  putSource(row: CompetitorWatchSource): void
  removeSource(id: string): void
  /** 取上一次快照（没有 = 还没读成过）。 */
  snapshot(source_id: string): CatalogSnapshot | undefined
  /** 写快照（整条源覆盖）。 */
  putSnapshot(snapshot: CatalogSnapshot): void
  removeSnapshot(source_id: string): void
  /** 写变化（同 id 覆盖）。 */
  putChanges(changes: readonly CompetitorChange[]): void
  /** 按窗口 / 竞品 / 种类 / 来源查变化（新的在前）。 */
  changes(query?: CompetitorChangeQuery): CompetitorChange[]
  settings(): CompetitorWatchSettings
  putSettings(next: CompetitorWatchSettings): void
  /** 新的在前。 */
  runs(limit?: number): CompetitorWatchRun[]
  putRun(run: CompetitorWatchRun): void
  kv<T>(key: string): T | undefined
  setKv(key: string, value: unknown): void
}

/* ── 工作台读的视图（连接卡 / 计划卡 / 报表卡）──────────────────────── */

/** 各监控源状态汇总成一句（连接卡：「5 家 · 1 家没读到」）。 */
export interface CompetitorWatchSummary {
  /** 几条源（不含暂停的）。 */
  sources: number
  /** 盯了几家（竞品 + 自家，按 `competitor_id` 数）。 */
  competitors: number
  ok: number
  failed: number
  /** 上一次只读到一部分的。 */
  partial: number
  unchecked: number
  /** 没读到的那几家（人话名，照实说）。 */
  failed_labels: string[]
}

/** `GET /v1/competitor-watch` 回的那一份。 */
export interface CompetitorWatchView {
  settings: CompetitorWatchSettings
  sources: CompetitorWatchSource[]
  summary: CompetitorWatchSummary
  /** 下一次读的时刻（计划卡）。 */
  next_read_at?: Iso8601
  last_run?: CompetitorWatchRun
  /** 有源、但这类进料口这台机器还没接上（WP393 / WP394 还没装时照实说）。 */
  missing_adapters: CompetitorSourceKind[]
}
