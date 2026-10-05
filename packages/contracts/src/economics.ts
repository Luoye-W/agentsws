/**
 * WP224（docs/91 §2.2 #1 / #3、§6 P1 #5 #6）：**单位经济与经营一页纸**的契约。
 *
 * 三样东西：
 *
 * 1. **毛利率事实卡**：品牌事实里的一格（可按品类 / SKU 覆盖）。它就是知识库里的一张
 *    事实卡（`subject.type = gross_margin`），负责人在「公司 → 品牌」页填；没填就是没填，
 *    任何地方都不替它补一个「行业平均」。
 * 2. **盈亏线 ROAS = 1 / 毛利率**：只**并排显示**在止损卡与投放日报上（Luoye 10-05 定：
 *    先并排两周再定），自动止损线 `stop_loss_roas_below` 一个字不动。两条线各自会不会停，
 *    从合并那天起每天记一行（{@link AdsLineCompareRow}），两周后出一张对照表给人定。
 * 3. **本周经营一页纸**：情况 / 发现 / 影响 / 建议 / 下一步，每条发现带一个数和出处
 *    （{@link WeeklyReviewPayload}）。数字只从各岗位已有面板取，取不到写「没接」。
 *
 * 只加不删：新文件，一个旧签名没碰。
 */
import type { Iso8601, PersonId } from './common.js'

/** 毛利率事实卡在知识库里的 `subject.type`。 */
export const GROSS_MARGIN_SUBJECT_TYPE = 'gross_margin' as const

/** 毛利率管多大一块：整个品牌、某个品类、某个 SKU（小的盖大的）。 */
export type GrossMarginScope = 'brand' | 'category' | 'sku'

/** 一格毛利率（一张生效的事实卡）。 */
export interface GrossMarginEntry {
  scope: GrossMarginScope
  /** 品类名 / SKU；`brand` 没有。 */
  key?: string
  /** 毛利率，百分数（40 = 40%）。 */
  margin_pct: number
  /** 那张事实卡的 id（去知识库能找到它、看到谁什么时候填的）。 */
  fact_card_id?: string
  updated_at?: Iso8601
  updated_by?: PersonId
}

export interface GrossMarginsView {
  entries: GrossMarginEntry[]
}

/** 填 / 改 / 清一格。`margin_pct: null` = 清掉（旧卡退役，留痕不删）。 */
export interface GrossMarginInput {
  scope: GrossMarginScope
  key?: string
  margin_pct: number | null
}

/** 事实卡的 `subject.key`：`gross_margin:brand` / `gross_margin:category:<品类>` / `gross_margin:sku:<SKU>`。 */
export function grossMarginKey(scope: GrossMarginScope, key?: string): string {
  return scope === 'brand' ? 'gross_margin:brand' : `gross_margin:${scope}:${(key ?? '').trim()}`
}

/**
 * 谁检索得到 / 看得到毛利率事实卡（Luoye 10-05 定）：负责人、店铺管理、投放四条。
 *
 * 客服、社媒、公关、红人这些**对外说话**的岗位一律检索不到——毛利率是公司内部的账，
 * 模型拿到了就有可能写进一封回信、一条评论里。按职责白名单做（知识可见范围本来按
 * 数据域 / 敏感度 / 范围过滤，没有按职责的那一刀，这里加最小的一刀，见 `ROLE_SCOPED_FACT_SUBJECTS`）。
 */
export const GROSS_MARGIN_VISIBLE_ROLES: readonly string[] = [
  'common.owner',
  'dtc.store',
  'ads.meta',
  'ads.google',
  'ads.tiktok',
  'ads.x',
]

/** 「没填毛利率」那一格的去填入口（公司 → 品牌）。 */
export const GROSS_MARGIN_FILL_PATH = '/org?tab=brands&focus=gross-margin'

/**
 * 盈亏线那一格（卡面 / 日报上 ROAS 旁边那一格）。
 *
 * `break_even_roas` 缺 = 没填毛利率（不是 0、不是 1）——那时 `note` 是「没填毛利率」，
 * 界面给 `fill_url` 去填。
 */
export interface BreakEvenView {
  margin_pct?: number
  break_even_roas?: number
  /** 给人看的一句（「盈亏线 2.5（毛利率 40%）」/「没填毛利率」）。 */
  note: string
  fill_url?: string
}

/** 一条线下这一天会不会停（`no_margin` = 没填毛利率，这条线判不了）。 */
export type LineOutcome = 'trigger' | 'hold' | 'unknown' | 'no_margin'

/**
 * 两条线的对照：**一天一个 campaign 一行**。
 *
 * `fixed` 是现在真在用的那条（ROAS < `stop_loss_roas_below` 且花费超过日预算的
 * `stop_loss_spend_pct`）；`break_even` 是把 ROAS 那条换成盈亏线、花费那条不变时的结论。
 * 只是记下来，**不据此停任何东西**。
 */
export interface AdsLineCompareRow {
  /** 这一天（工作区时区的 `YYYY-MM-DD`）。 */
  date: string
  campaign_id: string
  platform: string
  name: string
  roas?: number
  spend?: number
  daily_budget?: number
  margin_pct?: number
  break_even_roas?: number
  fixed: Exclude<LineOutcome, 'no_margin'>
  break_even: LineOutcome
  recorded_at: Iso8601
}

/** 对照表（两周后给 Luoye 定止损线用）。 */
export interface AdsLineCompareView {
  /** 第一行是哪天记的（= 合并后第一次跑）。还没记过就没有。 */
  started_on?: string
  /** 记了几天。 */
  days: number
  /** 是否满两周。 */
  complete: boolean
  rows: AdsLineCompareRow[]
  /** 按 campaign 汇总：两条线各会停几天、只有盈亏线会停的几天。 */
  summary: {
    campaign_id: string
    platform: string
    name: string
    days: number
    fixed_stop_days: number
    break_even_stop_days: number
    /** 现在的线不停、换成盈亏线会停的天数（这就是「一直在亏钱那段不报警」的量）。 */
    only_break_even_days: number
    /** 没填毛利率、判不了的天数。 */
    no_margin_days: number
  }[]
}

/* ── 经营一页纸 ─────────────────────────────────────────────────────── */

/** 一页纸取数的那几块面板（docs/91 §2.2 #1 点名的六样）。 */
export type WeeklyReviewPanel =
  | 'store_sales'
  | 'ads_roas'
  | 'ads_break_even'
  | 'content_revenue'
  | 'social_30d'
  | 'kol_attribution'
  | 'support_volume'

/** 一条发现：一句话 + 一个数 + 出处（出处进界面的 tooltip）。 */
export interface WeeklyReviewFinding {
  panel: WeeklyReviewPanel
  text: string
  /** 那一个数（面板上显示的样子，原样）。 */
  value: string
  /** 出处：哪个岗位、哪块面板、什么时间窗。 */
  source: string
}

/** 一块取不到的面板（一页纸上写「没接」，不估）。 */
export interface WeeklyReviewGap {
  panel: WeeklyReviewPanel
  label: string
  /** 为什么取不到（没人担这条职责 / 没连 / 还没出过数）。 */
  reason: string
}

export interface WeeklyReviewPayload {
  kind: 'weekly_review'
  /** 这一周的周一（`YYYY-MM-DD`）。 */
  week_of: string
  brand?: string
  situation: string
  findings: WeeklyReviewFinding[]
  impact: string[]
  recommendations: string[]
  next_steps: string[]
  not_connected: WeeklyReviewGap[]
  /** 全文多长（汉字按字、英文按词数）；上限 500。 */
  length: number
}

/** 一页纸的长度上限（docs/91 §5 #9：≤ 500，中文按字数）。 */
export const WEEKLY_REVIEW_MAX_LENGTH = 500

/**
 * 一页纸什么时候推（设置里那一行）：每周几、几点（工作区时区）。默认周一 08:00。
 * `weekday` 用 cron 的写法：0 = 周日、1 = 周一 … 6 = 周六。
 */
export interface WeeklyReviewScheduleView {
  weekday: number
  /** `HH:MM`（24 小时）。 */
  time: string
  /** 这条定时现在停着没有（没人担「公司设置与授权」时自动停）。 */
  paused: boolean
  /** 还没建（这个品牌还没有能挂的岗位）。 */
  missing?: boolean
}
