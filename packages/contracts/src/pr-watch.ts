/**
 * WP386（docs/103 v2，Luoye 10-17）：公共关系「**信息监控**」（`pr.monitoring`，原「品牌监控」）的数据形状。
 *
 * 盯四组：自家舆情 / 竞品动向 / 行业品类 / 指定网站（{@link MonitorGroup}）。同一套机制，只是标签不同。
 *
 * - {@link MonitorSource}：一条监控源（一条 Google Alerts 的 RSS、或某个网站自己的 RSS）。
 *   **来源无关**（docs/103 U2）：`kind` 以后会加 `email`（邮件提醒）、`api`（云端接口）、`browser`（插件）、
 *   `page_diff`（网页比对）。不管从哪个口进来，进来后都走同一条管道（拉取 → 过滤 → 去重 → 判类 → 入库）；
 *   哪个口被平台关掉，换一个口接上，用户那边感觉不到。本期只有 `google_alerts` 和 `rss` 两种。
 * - {@link MonitorPlanItem}：AI 建议要建的一条 Google 提醒（查询语句、语言、地区、组、理由），用户在配置卡上
 *   勾选 / 修改 / 确认后存下。用户贴回 RSS 链接（本期），或由 BrowserSkill 代建后读回链接（WP387），
 *   就挂上一条 {@link MonitorSource}（`plan_item_id` / `source_id` 两头互指）。
 * - {@link PrWatchStore}：存储接口（每个品牌一份，落在这个品牌自己的库里）。WP387 从本文件拉分支，
 *   **这份形状提交后不再改**；以后只加不删。
 *
 * 纪律（照 `pr-core/channels/alerts.ts` 文件头）：**拉不到就照实说**——一条源失败记在 `status: 'failed'` +
 * `last_error`（人话），面板与简报照实写「没拉到」，**绝不显示成 0 条**。
 * 频率只给默认值（一天一次、本地 9 点后），用户能改，不写死任何运营规矩。
 */
import type { Iso8601, WorkspaceId } from './common.js'

/* ── 分组 ─────────────────────────────────────────────────────────── */

/** 盯的是谁：自家 / 竞品 / 行业品类 / 指定网站。 */
export type MonitorGroup = 'own' | 'competitor' | 'industry' | 'site'

export const MONITOR_GROUPS: readonly MonitorGroup[] = ['own', 'competitor', 'industry', 'site']

/** 四组的人话名（卡面、提及表、简报读它）。 */
export const MONITOR_GROUP_LABELS: Readonly<Record<MonitorGroup, { zh: string; en: string }>> = {
  own: { zh: '自家', en: 'Own brand' },
  competitor: { zh: '竞品', en: 'Competitors' },
  industry: { zh: '行业', en: 'Industry' },
  site: { zh: '指定网站', en: 'Sites' },
}

/* ── 监控源 ───────────────────────────────────────────────────────── */

/**
 * 进料口的种类。本期两种：
 * - `google_alerts`：Google Alerts 的 RSS（`google.com/alerts/feeds/…`），feed 本身已经按查询语句筛过；
 * - `rss`：任意网站的 RSS / Atom（拉回来的是这个站的全部新内容，按 `keywords` 在本地过滤）。
 *
 * 以后只加（`email` / `api` / `browser` / `page_diff`），不改这两种的意思。
 */
export type MonitorSourceKind = 'google_alerts' | 'rss'

/** 一条源现在的状态：拉到过 / 最近一次拉失败 / 还没拉过。 */
export type MonitorSourceStatus = 'ok' | 'failed' | 'unchecked'

/** 这条源是怎么进来的：用户贴的 / 浏览器代建读回的（WP387）/ AI 建议、用户确认的。 */
export type MonitorSourceAddedVia = 'paste' | 'browser' | 'suggest'

/** 一条监控源。 */
export interface MonitorSource {
  /** 本机 id（`ms_…`）。 */
  id: string
  workspace_id: WorkspaceId
  kind: MonitorSourceKind
  /**
   * feed 地址。Google Alerts 的地址**本身就是钥匙**（谁拿到谁能读这条提醒）：只存在这台电脑上这个品牌的库里，
   * 不进事件、不进模型上下文、不进截图；给人看时用 {@link maskFeedUrl}。
   */
  url: string
  group: MonitorGroup
  /** 人话名：Google Alerts 从 feed 标题里拆出来的那个词（`Google Alert - Super73` → `Super73`），或网站名。 */
  label: string
  /** Google 查询语句（`"Aventon" -job`）；知道才有。 */
  query?: string
  /** 本地过滤用的词（`rss` 才用：整词命中至少一个才算一条提及；Google Alerts 不再过滤）。 */
  keywords?: string[]
  /** 排除词（命中就丢；`rss` 才用）。 */
  exclude?: string[]
  /** 语言（`en`、`zh-CN`…）。 */
  language?: string
  /** 地区（`US`、`DE`…；`any` = 不限）。 */
  region?: string
  /** 盯的是哪个竞品（`group: 'competitor'` 时）。 */
  competitor?: string
  /**
   * 隔几小时拉一次（默认 24 = 一天一次、本地 `day_start_hour` 之后）。
   * Google Alerts 一条 feed 只留最近约 20 条：哪次拉回来 20 条全是新的，自动改成 4（R6），并记 `boosted_at`。
   */
  every_hours: number
  status: MonitorSourceStatus
  /** 上次拉成的时刻。 */
  last_ok_at?: Iso8601
  /** 上次试的时刻（成没成都算；失败隔一小时再试）。 */
  last_try_at?: Iso8601
  /** 上次失败的一句人话（`status: 'failed'` 时有）。 */
  last_error?: string
  /** 上次拉回来几条、其中新的几条（拉成才有）。 */
  last_fetched?: number
  last_fresh?: number
  /** 因为「满 20 条全新」自动加拉的时刻（简报里写一句）。 */
  boosted_at?: Iso8601
  added_via: MonitorSourceAddedVia
  /** 对应配置卡上的哪一行提醒（有的话）。 */
  plan_item_id?: string
  /** 用户暂停了这一条（不删、不拉）。 */
  paused?: true
  created_at: Iso8601
}

/** 默认一天一次。 */
export const MONITOR_DEFAULT_EVERY_HOURS = 24
/** 满 20 条全新时自动改成每 4 小时一次（R6）。 */
export const MONITOR_BOOST_EVERY_HOURS = 4
/** Google Alerts 一条 feed 大约只留这么多条（拉回来这么多且全是新的 = 可能漏了）。 */
export const GOOGLE_ALERTS_FEED_CAP = 20

/**
 * Google Alerts 的 feed 地址前缀（贴进来的不是它、也不是能读的 RSS，就当场说「这条还是邮箱投递」）。
 */
export const GOOGLE_ALERTS_FEED_PREFIX = 'https://www.google.com/alerts/feeds/'

/**
 * 建一条 Google 提醒时那几项**必须**这样设（教程与 WP387 代建读同一份）：
 * 频率「即时」、来源「自动」、数量「所有结果」（默认「只要最好的」会漏很多）、投递「RSS」（不许用邮箱）。
 */
export const GOOGLE_ALERTS_REQUIRED_SETTINGS = {
  frequency: 'as_it_happens',
  sources: 'automatic',
  how_many: 'all_results',
  deliver_to: 'rss',
} as const

/** 给人看的 feed 地址（只留域名和末尾几位，免得截图 / 日志里露出整条钥匙）。 */
export function maskFeedUrl(url: string): string {
  try {
    const u = new URL(url)
    const tail = u.pathname.replace(/\/+$/u, '').slice(-4)
    return `${u.hostname}/…${tail}`
  } catch {
    return url.length <= 8 ? '…' : `…${url.slice(-4)}`
  }
}

/* ── AI 建议的提醒清单 ─────────────────────────────────────────────── */

/** 清单上一行现在怎样：待建 / 已挂上监控源 / 用户勾掉了。 */
export type MonitorPlanItemStatus = 'planned' | 'linked' | 'skipped'

/** AI 建议要建的一条 Google 提醒（用户在配置卡上勾选、修改、确认后存下）。 */
export interface MonitorPlanItem {
  /** 本机 id（`mp_…`）。 */
  id: string
  workspace_id: WorkspaceId
  group: MonitorGroup
  /** 人话名（`Aventon`）；贴回的 feed 按标题里的词对上是哪一行。 */
  label: string
  /** Google 查询语句（`"Aventon" -job`、`"Aventon" OR "Aventon ebike"`）。 */
  query: string
  /** 语言（`en`、`de`…）。 */
  language: string
  /** 地区（`US`…；`any` = 不限）。 */
  region: string
  /** 盯的是哪个竞品（`group: 'competitor'` 时）。 */
  competitor?: string
  /** 一句理由（为什么要盯这一条）。 */
  why: string
  /** 用户勾上了没有（勾掉的 `status: 'skipped'`）。 */
  selected: boolean
  status: MonitorPlanItemStatus
  /** 挂上的那条监控源（贴回 / 代建读回之后才有）。 */
  source_id?: string
  created_at: Iso8601
  updated_at: Iso8601
}

/* ── 设置与每一轮 ─────────────────────────────────────────────────── */

/** 每个品牌一份的监控设置（只给默认值，用户能改）。 */
export interface MonitorSettings {
  /** 总开关。 */
  enabled: boolean
  /** 一天一次时本地几点之后跑（默认 9）。 */
  day_start_hour: number
  /** 新加的源默认隔几小时拉一次（默认 24）。 */
  default_every_hours: number
  /**
   * Reddit 那一路搜什么（走 `read_reddit` 同一条取数路由：接口中台 / 浏览器只读，决策 76、R10）。
   * 空 = 这一路不跑（按条计积分，不替用户默认开）。
   */
  reddit_queries: string[]
}

export const MONITOR_SETTINGS_DEFAULTS: Readonly<MonitorSettings> = {
  enabled: true,
  day_start_hour: 9,
  default_every_hours: MONITOR_DEFAULT_EVERY_HOURS,
  reddit_queries: [],
}

/** 一轮里一条源（或 Reddit 那一路）的结局。 */
export interface MonitorRunPart {
  /** 监控源 id；Reddit 那一路是 `reddit`。 */
  source_id: string
  label: string
  status: 'ok' | 'failed' | 'skipped'
  /** 拉回来几条 / 其中新的几条 / 过滤后留下几条（拉成才有意义）。 */
  fetched: number
  fresh: number
  kept: number
  /** 一句人话（失败 / 跳过 / 自动加拉）。 */
  message?: string
}

/** 一轮监控（定时 / 立即）。 */
export interface MonitorRun {
  id: string
  workspace_id: WorkspaceId
  trigger: 'schedule' | 'manual' | 'added'
  started_at: Iso8601
  finished_at?: Iso8601
  parts: MonitorRunPart[]
  /** 这一轮新入库几条提及。 */
  created: number
  /** 给简报的几句（自动加拉、哪几条没拉到…）。 */
  notes: string[]
}

/* ── 存储接口（每品牌一份；WP387 依赖它，形状不再改）────────────────── */

export interface PrWatchStore {
  readonly workspace_id: WorkspaceId
  sources(): MonitorSource[]
  source(id: string): MonitorSource | undefined
  putSource(row: MonitorSource): void
  removeSource(id: string): void
  planItems(): MonitorPlanItem[]
  planItem(id: string): MonitorPlanItem | undefined
  putPlanItem(row: MonitorPlanItem): void
  removePlanItem(id: string): void
  settings(): MonitorSettings
  putSettings(next: MonitorSettings): void
  /** 新的在前。 */
  runs(limit?: number): MonitorRun[]
  putRun(run: MonitorRun): void
  /** 杂项（每条源见过的条目键…）。 */
  kv<T>(key: string): T | undefined
  setKv(key: string, value: unknown): void
}
