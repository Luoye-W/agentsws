/**
 * WP398（docs/106 §5.6 / §13 A8）：**Amazon 词库**的数据形状。
 *
 * 一期只有三种来源有数：Amazon 前台搜索框联想词（内置浏览器读，自报 Agent 身份）、竞品 Listing 的标题 / 五点、
 * 自家 Listing 的标题 / 五点。**一期没有搜索量，排不了先后**：只出词表，和「竞品有、你没有」的差距词——
 * 差距词按「出现在几家竞品里」排，这是一期唯一的排序（卡上照实写 {@link AMAZON_KEYWORD_SORT_NOTE_ZH}）。
 *
 * 二期最先接广告搜索词报告（随「亚马逊广告」职责），品牌注册的再加品牌分析「搜索词表现」报告——
 * 这份形状要装得下：来源里已经留了 `search_term_report` / `brand_analytics`，数字格 {@link AmazonKeywordMetrics}
 * 一期**一律空着，不填估算值**。广告和 Listing 改写读的是同一份词库（A8）。
 *
 * 词库按品牌存本机（品牌目录下一份），不上云。
 */
import type { Iso8601 } from './common.js'

/* ── 来源与标记 ───────────────────────────────────────────────────── */

/**
 * 词从哪来。后两种（广告搜索词报告、品牌分析）二期才有数据；`user` 是用户自己加的。
 */
export type AmazonKeywordSource =
  | 'autocomplete'
  | 'competitor_listing'
  | 'own_listing'
  | 'search_term_report'
  | 'brand_analytics'
  | 'user'

export const AMAZON_KEYWORD_SOURCES: readonly AmazonKeywordSource[] = [
  'autocomplete',
  'competitor_listing',
  'own_listing',
  'search_term_report',
  'brand_analytics',
  'user',
]

/** 二期才有数据的来源（一期界面上的筛选不列它们）。 */
export const AMAZON_KEYWORD_LATER_SOURCES: readonly AmazonKeywordSource[] = [
  'search_term_report',
  'brand_analytics',
]

export const AMAZON_KEYWORD_SOURCE_LABELS: Readonly<
  Record<AmazonKeywordSource, { zh: string; en: string }>
> = {
  autocomplete: { zh: '搜索框联想', en: 'Search suggestions' },
  competitor_listing: { zh: '竞品 Listing', en: 'Competitor listings' },
  own_listing: { zh: '自家 Listing', en: 'Your listings' },
  search_term_report: { zh: '广告搜索词', en: 'Ad search terms' },
  brand_analytics: { zh: '品牌分析', en: 'Brand Analytics' },
  user: { zh: '自己加的', en: 'Added by you' },
}

/** 用户标记：核心词 / 不要 / 已埋进 Listing。 */
export type AmazonKeywordMark = 'core' | 'exclude' | 'in_listing'

export const AMAZON_KEYWORD_MARKS: readonly AmazonKeywordMark[] = ['core', 'exclude', 'in_listing']

export const AMAZON_KEYWORD_MARK_LABELS: Readonly<
  Record<AmazonKeywordMark, { zh: string; en: string }>
> = {
  core: { zh: '核心', en: 'Core' },
  exclude: { zh: '不要', en: 'Exclude' },
  in_listing: { zh: '已埋进 Listing', en: 'In listing' },
}

/* ── 一个词 ───────────────────────────────────────────────────────── */

/** 在哪见过这个词（同一来源 + 同一竞品 / ASIN / 前缀只记一条，刷新只更新时间）。 */
export interface AmazonKeywordSeen {
  source: AmazonKeywordSource
  /** 竞品文本：`BrandWatchCompetitor.id`。 */
  competitor_id?: string
  /** 竞品名快照（界面直接显示）。 */
  competitor?: string
  /** 来自哪个 ASIN（竞品或自家文本）。 */
  asin?: string
  /** 联想词：用哪个前缀读到的（`electric bike a`）。 */
  prefix?: string
  /** Listing 文本：标题还是五点。 */
  field?: 'title' | 'bullets'
  first_seen_at: Iso8601
  last_seen_at: Iso8601
}

/**
 * 词的数字格。**一期一律不填**（前台联想词没有搜索量；不估）。
 * 二期：广告搜索词报告给曝光 / 点击 / 订单，品牌分析给搜索频率排名等；`period` 写数的时间段。
 */
export interface AmazonKeywordMetrics {
  search_volume?: number
  /** 品牌分析的搜索频率排名（越小越热）。 */
  search_frequency_rank?: number
  impressions?: number
  clicks?: number
  orders?: number
  period?: { from: Iso8601; to: Iso8601 }
  /** 这几个数来自哪份报告。 */
  source?: AmazonKeywordSource
}

export interface AmazonKeyword {
  /** `${marketplace}:${norm}`。 */
  id: string
  /** 显示用的写法（第一次见到时的样子，小写）。 */
  term: string
  /** 归一化后的键（小写、单数、去停用词与品牌名，词之间一个空格）。 */
  norm: string
  /** 站点国家码（`US`）。 */
  marketplace: string
  /** 语言（`en`）。 */
  language: string
  /** 来源（去重、按 {@link AMAZON_KEYWORD_SOURCES} 的顺序）。 */
  sources: AmazonKeywordSource[]
  /** 见过它的地方（同一出处只一条）。 */
  seen: AmazonKeywordSeen[]
  first_seen_at: Iso8601
  last_seen_at: Iso8601
  /**
   * 词里含别家的品牌名（竞品名、文本里认出的品牌）：**不能填进后台关键词**（Amazon 不许），界面单独标出。
   */
  other_brand?: string
  /** 一期一律没有（见 {@link AmazonKeywordMetrics}）。 */
  metrics?: AmazonKeywordMetrics
  /** 用户标记。 */
  marks: AmazonKeywordMark[]
  marked_at?: Iso8601
}

/* ── 拆词的原料：一段 Listing 文本 ────────────────────────────────── */

/**
 * 一条 Listing 的标题 / 五点（竞品来自竞品快照 WP392 / WP394，自家来自 Listing 体检 WP396 或品牌档案）。
 * 词库按 `side + asin` 只留最新一份。
 */
export interface AmazonListingText {
  side: 'own' | 'competitor'
  asin: string
  marketplace: string
  title: string
  /** 五点（没读到不填）。 */
  bullets?: string[]
  /** 这条 Listing 自己的品牌（拆词时去掉）。 */
  brand?: string
  /** 竞品：`BrandWatchCompetitor.id`。 */
  competitor_id?: string
  /** 竞品名（也当品牌名去掉）。 */
  competitor?: string
  read_at: Iso8601
}

/* ── 差距：竞品有、你没有 ─────────────────────────────────────────── */

export interface AmazonKeywordGapTerm {
  /** 词库里的 id（`${marketplace}:${norm}`）。 */
  id: string
  term: string
  norm: string
  /** 出现在几家竞品的标题 / 五点里（**一期唯一的排序**）。 */
  competitors: number
  competitor_names: string[]
  /** 在哪几个竞品 ASIN 里见到。 */
  asins: string[]
  /** 自家标题 / 五点里缺的那几个词（Amazon 按词收录，缺一个就搜不到这个组合）。 */
  missing_words: string[]
  other_brand?: string
}

/** 一个自家 ASIN 的差距词。 */
export interface AmazonKeywordGap {
  asin: string
  marketplace: string
  title?: string
  /** 按竞品出现次数从多到少（同数按词序）。 */
  terms: AmazonKeywordGapTerm[]
  /** 和几家竞品比的。 */
  competitors_compared: number
  /**
   * 体检卡那一行的数：「常用」差距词几个——不止一家竞品在用的（只和一家比时 = 全部）。
   */
  common: number
  computed_at: Iso8601
}

/* ── 一次刷新 ─────────────────────────────────────────────────────── */

/**
 * 联想词这一次读得怎么样：
 * `ok` 读完了这一批；`partial` 读了一部分（中途有几页没读成）；`blocked` Amazon 出了验证页、这一轮停了（不绕、不重试）；
 * `quota` 内置浏览器这一小时的额度满了；`unavailable` 这里没有内置浏览器（不是桌面版）；
 * `no_seeds` 没有种子词（品牌档案里没有品类、也没有自家商品标题）；`failed` 一页都没读成。
 */
export type AmazonAutocompleteStatus =
  | 'ok'
  | 'partial'
  | 'blocked'
  | 'quota'
  | 'unavailable'
  | 'no_seeds'
  | 'failed'

export interface AmazonKeywordRefresh {
  id: string
  started_at: Iso8601
  finished_at: Iso8601
  /** `manual` 面板上点的；`tool` AI 调的；`schedule` 定时。 */
  trigger: 'manual' | 'tool' | 'schedule'
  autocomplete: {
    status: AmazonAutocompleteStatus
    marketplace?: string
    /** 这一批用的种子词。 */
    seed?: string
    /** 这一批打算读几页 / 读成了几页。 */
    planned: number
    read: number
    /** 读到几条联想词 / 其中几条是新词。 */
    suggestions: number
    added: number
    /** 人话（没读成为什么；被拦照实说）。 */
    message?: string
  }
  /** 这一次拆了几条 Listing 文本（自家 / 竞品）。 */
  listings: { own: number; competitor: number }
  /** 这一次新进词库几个词。 */
  added: number
  /** 这一次算出几个差距词（所有自家 ASIN 合起来、去重）。 */
  gap_terms: number
}

/* ── 面板 / 第三栏 / 工具看到的那一份 ─────────────────────────────── */

/** 卡上固定那一句：一期没有搜索量，差距词按竞品里出现的次数排。 */
export const AMAZON_KEYWORD_SORT_NOTE_ZH = '没有搜索量，按竞品里出现的次数排'
export const AMAZON_KEYWORD_SORT_NOTE_EN =
  'No search volume yet; sorted by how many competitors use the term'

/** 他牌名那一行的提醒。 */
export const AMAZON_KEYWORD_OTHER_BRAND_ZH = '含别家品牌名，不能填进后台关键词'
export const AMAZON_KEYWORD_OTHER_BRAND_EN =
  'Contains another brand’s name; do not put it in backend search terms'

/**
 * 联想词每次最多读一批：一个种子词本身 + 后面接 a–z，共 27 页（每页算进内置浏览器每小时的额度，决策 914）。
 * 种子词多的，下一次接着读下一个。
 */
export const AMAZON_AUTOCOMPLETE_BATCH_PAGES = 27

export interface AmazonKeywordBankView {
  /** 词库里几个词（不含标了「不要」的）。 */
  total: number
  /** 差距词几个（所有自家 ASIN 合起来、去重）。 */
  gap_terms: number
  /** 含他牌名的几个。 */
  other_brand_terms: number
  by_source: Partial<Record<AmazonKeywordSource, number>>
  /** 最近一次更新（刷新或标记）。没有 = 还没有词库。 */
  updated_at?: Iso8601
  last_refresh?: AmazonKeywordRefresh
  /** 每个自家 ASIN 的差距词（体检卡那一行读这里）。 */
  gaps: AmazonKeywordGap[]
  /** 拆过几条 Listing 文本。 */
  listings: { own: number; competitor: number }
  /** 这里能不能读 Amazon 前台联想词（没有内置浏览器 = false）。 */
  reader_ready: boolean
  sort_note: { zh: string; en: string }
}

export interface AmazonKeywordQuery {
  source?: AmazonKeywordSource
  mark?: AmazonKeywordMark
  /** 只看差距词（任一自家 ASIN 缺的）。 */
  gap?: boolean
  /** 只看含他牌名的。 */
  other_brand?: boolean
  /** 标了「不要」的也列出来（默认不列）。 */
  include_excluded?: boolean
  marketplace?: string
  /** 包含这几个字。 */
  q?: string
  limit?: number
  offset?: number
}

/** 词表的一行：词 + 「在几家竞品里」+ 自家写进去了没有。 */
export interface AmazonKeywordRow extends AmazonKeyword {
  /** 出现在几家竞品的标题 / 五点里。 */
  competitors: number
  /** 自家标题 / 五点里已经有这几个词（任一自家 ASIN）。 */
  in_own_text: boolean
  /** 是不是差距词（任一自家 ASIN 缺）。 */
  gap: boolean
}

export interface AmazonKeywordPage {
  items: AmazonKeywordRow[]
  total: number
  sort_note: { zh: string; en: string }
}

/** 改标记（加 / 去），或用户自己加一个词。 */
export interface AmazonKeywordMarkPatch {
  /** 已有词的 id；用户自己加词时不给、给 `term`。 */
  id?: string
  term?: string
  marketplace?: string
  add?: AmazonKeywordMark[]
  remove?: AmazonKeywordMark[]
}
