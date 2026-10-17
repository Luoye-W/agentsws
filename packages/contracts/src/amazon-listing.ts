/**
 * WP396（docs/106 §13，A1 ②「Listing 与关键词」）：**自家 Listing 体检**的形状。
 *
 * 一期只读 Amazon 前台商品页（内置浏览器自报 Agent 身份，被拦就停、不绕；读页积木见 WP394），
 * 按一张**规则表**逐条判，出「哪条规则（带出处）/ 现在是什么 / 建议怎么改」。只出建议，不写 Amazon。
 *
 * - 规则表是**数据**（`seo-core` 的 `amazon-listing-rules.json`），每条带出处与核对日期；
 *   过了 {@link LISTING_RULE_STALE_DAYS} 天没核对的标「这条规则可能过时」（§13.4：规则在变）。
 * - 有争议的阈值（标题长度这类）是**建议值**，用户能改（{@link ListingRuleOverride}）——不替用户定运营规矩。
 * - 数字（评分、评论数、价格）照页面原样写，读不到就是读不到，不估。
 * - 前台看不到的（被压制、不可售原因、后台关键词、品类审批）不猜：卡底固定 {@link LISTING_CHECKUP_FOOTER_ZH}。
 */
import type { Iso8601 } from './common.js'

/** 前台商品页上读到的（读不到的格子不出现）。 */
export interface AmazonListingFacts {
  asin: string
  /** 站点国家码（`US` / `GB` …）。 */
  marketplace: string
  url: string
  read_at: Iso8601
  title?: string
  brand?: string
  /** 五点（原文，按页面顺序；空的那几条也留着，长度为 0）。 */
  bullets: string[]
  /** 商品描述有没有字。 */
  has_description: boolean
  /** A+（品牌故事 / 图文模块）有没有。 */
  has_aplus: boolean
  /** 图片张数（主图 + 副图；读不到 = 没有这一格）。 */
  image_count?: number
  /** 主图有没有（没有主图 Amazon 会压制这条 Listing）。 */
  has_main_image: boolean
  /** 有没有商品视频。 */
  has_video: boolean
  /** 变体：页面上有没有选款式的那块、子体 ASIN、哪几个子体买不了。 */
  variants: {
    present: boolean
    child_asins: string[]
    unavailable_count: number
  }
  /** 评分（页面原样，如 4.3）。 */
  rating?: number
  /** 评分 / 评论数（页面原样）。 */
  reviews_count?: number
  /** 现价（页面原样带币种符号，如 `$39.99`）。 */
  price?: string
  /** 划线价（List Price / Was）。 */
  list_price?: string
  /** 币种（按价格符号认：USD / GBP / EUR …；认不出没有这一格）。 */
  currency?: string
  /** 优惠券那一句（原样）。 */
  coupon?: string
  /** 有没有货：`in_stock` / `out_of_stock`；读不出 `unknown`。 */
  availability: 'in_stock' | 'out_of_stock' | 'unknown'
  availability_text?: string
  /** 购物车（Featured Offer）：有没有、谁卖、谁发货。 */
  buybox: {
    present: boolean
    seller?: string
    ships_from?: string
  }
  /** 页面写着「不能配送到你选的地址」（配送邮编没设对，这次读数作废）。 */
  undeliverable: boolean
}

/** 规则管哪一块（面板与卡片按它分组）。 */
export type ListingRuleArea =
  | 'title'
  | 'bullets'
  | 'content'
  | 'images'
  | 'variants'
  | 'reviews'
  | 'offer'
  | 'claims'

export const LISTING_RULE_AREAS: readonly ListingRuleArea[] = [
  'offer',
  'title',
  'bullets',
  'content',
  'images',
  'variants',
  'reviews',
  'claims',
]

/**
 * 多严重：`blocker` 影响能不能买（没货、购物车不在 / 不是你）；`search` 影响能不能被搜到 /
 * 会被压制（标题、五点不合规矩）；`improve` 能卖但可以更好（图少、没 A+）。
 */
export type ListingSeverity = 'blocker' | 'search' | 'improve'

export const LISTING_SEVERITY_ORDER: readonly ListingSeverity[] = ['blocker', 'search', 'improve']

/** 规则怎么判（引擎里一种判法一个分支；表里只写参数）。 */
export type ListingCheckKind =
  | 'title_max_chars'
  | 'title_repeat_words'
  | 'title_special_chars'
  | 'title_promo_words'
  | 'title_all_caps'
  | 'bullets_min_count'
  | 'bullets_empty'
  | 'bullets_length'
  | 'bullets_special_chars'
  | 'description_or_aplus'
  | 'aplus_present'
  | 'main_image_present'
  | 'images_min_count'
  | 'video_present'
  | 'variants_broken'
  | 'variants_unavailable'
  | 'rating_min'
  | 'reviews_min'
  | 'in_stock'
  | 'buybox_present'
  | 'buybox_own'
  | 'claims'

/** 参数值（建议值）：数字、一串词、开关。 */
export type ListingRuleParam = number | string | boolean | string[]

/** 出处：`official` = Amazon 卖家帮助 / 官方公告；`practice` = 公开运营资料里的通行做法（不是 Amazon 的硬规矩）。 */
export interface ListingRuleSource {
  kind: 'official' | 'practice'
  title: string
  url?: string
}

/** 规则表里的一条。 */
export interface ListingRule {
  id: string
  area: ListingRuleArea
  check: ListingCheckKind
  severity: ListingSeverity
  name: { zh: string; en: string }
  /** 建议值（用户能改；`params` 的键由判法认）。 */
  params: Record<string, ListingRuleParam>
  source: ListingRuleSource
  /** 最近一次对着出处核对的日期（YYYY-MM-DD）。 */
  checked_at: string
  /** 一句「建议怎么改」（判出来的「现在是什么」由引擎拼）。 */
  advice: { zh: string; en: string }
  enabled: boolean
}

/** 用户改过的一条（只存改了的格子）。 */
export interface ListingRuleOverride {
  enabled?: boolean
  params?: Record<string, ListingRuleParam>
  /** 人 / AI 对着出处重新核过 → 改核对日期。 */
  checked_at?: string
}

/** 规则核对日期过了多少天算「可能过时」。 */
export const LISTING_RULE_STALE_DAYS = 180

/** 一处问题。 */
export interface ListingIssue {
  rule_id: string
  area: ListingRuleArea
  severity: ListingSeverity
  rule_name: string
  source: ListingRuleSource
  rule_checked_at: string
  /** 规则核对日期太久了：卡上标「这条规则可能过时」。 */
  rule_stale: boolean
  /** 现在是什么（读到的原样，一句）。 */
  now: string
  /** 建议怎么改（一句）。 */
  suggestion: string
  /** 文案类：一版草稿（照着页面上的原文改的，人可以再改）。 */
  draft?: string
  /** 图片类：向设计岗下需求单用的标题与需求（卡上一个按钮）。 */
  design_request?: { title: string; need: string }
  /** 拿不准、建议人看一眼的（变体断开这类）。 */
  needs_human?: boolean
}

/** 一个 ASIN 这次体检的结果。 */
export interface ListingCheckupItem {
  asin: string
  marketplace: string
  label?: string
  url: string
  /**
   * `checked` 读到并判完；`blocked` Amazon 出了验证页（这一轮就停了）；`failed` 没读成 / 读数作废；
   * `skipped` 前面被拦了，这一个没去读。
   */
  status: 'checked' | 'blocked' | 'failed' | 'skipped'
  message?: string
  title?: string
  /** 页面原样读到的几个数（读不到的格子没有，界面写「没读到」）。 */
  facts?: Pick<
    AmazonListingFacts,
    | 'rating'
    | 'reviews_count'
    | 'price'
    | 'list_price'
    | 'currency'
    | 'coupon'
    | 'availability'
    | 'image_count'
  > & { buybox_seller?: string }
  issues: ListingIssue[]
  /** 要人看一眼的（主图白底、文字水印这类要看图的，一期不让模型下结论）。 */
  human_checks: string[]
  /** 和上一次体检比：上次几处、修了几处、新冒出几处。第一次体检没有。 */
  previous?: { at: Iso8601; issues: number; fixed: number; added: number }
}

/** 一次体检。 */
export interface ListingCheckupRun {
  id: string
  started_at: Iso8601
  finished_at: Iso8601
  /** `manual` 面板 / 对话里点的；`tool` AI 调的。 */
  trigger: 'manual' | 'tool'
  items: ListingCheckupItem[]
  summary: {
    asins: number
    checked: number
    issues: number
    blockers: number
    /** 最严重的一条（面板摘要那一行）。 */
    worst?: { asin: string; rule_name: string; now: string; severity: ListingSeverity }
  }
  /** 这一轮为什么停了（被拦 / 这一小时额度满了 / 这里没有读页的那块）。 */
  stopped?: 'blocked' | 'quota' | 'unavailable'
  stopped_message?: string
}

/** 面板 / 卡片那一份（最近一次 + 规则表 + 自家 ASIN 有几个）。 */
export interface ListingCheckupView {
  latest?: ListingCheckupRun
  own_asins: number
  rules: ListingRule[]
  /** 这里能不能读 Amazon 前台（没有桌面壳 / 读页那块还没接上 = false）。 */
  reader_ready: boolean
  footer: { zh: string; en: string }
}

/** 体检卡底部固定那一句（前台看不到的照实说，不猜）。 */
export const LISTING_CHECKUP_FOOTER_ZH = '连上 Amazon 店铺后能查到更多（被压制、买不了的原因）'
export const LISTING_CHECKUP_FOOTER_EN =
  'Connect your Amazon store to see more (suppressed listings, why an item can’t be bought)'

/** 配置卡「自家 ASIN」的设置目标 id（WP394 的对标款方案卡复用同一个）。 */
export const AMAZON_OWN_ASINS_TARGET = 'amazon.own_asins'
