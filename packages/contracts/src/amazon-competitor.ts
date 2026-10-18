/**
 * WP394（docs/104 一期 B，C4 / C5 / C6 / C8；docs/106 §13 A9，Luoye 10-18）：Amazon 运营 · 亚马逊店铺运营
 * 「竞品动向」那一块——盯竞品在 Amazon 上几款**对标款**的价格、划线价 / 优惠券、评分、评论数、BSR、有没有货。
 *
 * 读、比、存都在 WP392 那条管道里（`competitor-watch.ts`，来源种类 `amazon_asin`）；这里只放本块自己的几样：
 *
 * - {@link AMAZON_AGENT_TOKEN}：内置浏览器访问 Amazon 时 User-Agent 末尾自报的身份（Agent Policy，硬规矩）；
 * - {@link AMAZON_DELIVERY_ZIPS}：每个站点默认设的「配送到」邮编（不登录，只是 Amazon 的地址 cookie）；
 * - {@link AmazonCompetitorPlan}：方案卡存下的那一份——哪几种变化算「重要」（AI 按品类建议、用户确认，C5 不预设）。
 *   对标款本身（盯哪些 ASIN、各对标自家哪一款）存在唯一工作清单 `BrandWatch.competitors[].amazon`（C3）。
 *
 * 纪律：只读前台公开页面，不登录、不碰 Seller Central、不出审批卡；被拦就停、不绕、不重试，退工坊云端数据；
 * 用户看得到的字不提任何数据供应商名，只说「工坊内置浏览器」「工坊云端数据」。
 */
import type { Iso8601 } from './common.js'

/** 内置浏览器访问 Amazon 时 User-Agent 末尾加的那一段（docs/106 A9：每个请求都自报身份）。 */
export const AMAZON_AGENT_TOKEN = 'Agent/AgentsWorkshop'

/** 方案卡的设置目标 id（`request_setup` / 工具回 `needs_setup` 认它）。 */
export const AMAZON_COMPETITOR_TARGET = 'amazon.competitor_watch'

/** 云端兜底那一路的能力名（按个扣积分，和决策 897 搜索一个规矩）。 */
export const AMAZON_CLOUD_CAPABILITY = 'amazon.product'

/** 一个品牌最多盯几个 ASIN（技术上限，和云端接口一次最多 100 个一致；不另定规矩，C6）。 */
export const AMAZON_ASINS_MAX = 100

/**
 * 每个站点默认设的「配送到」邮编（不登录，只是 Amazon 记在这个品牌内置浏览器里的地址 cookie）。
 * 美国站 `10001` 是派工单定的；其余是各站首都 / 大城市的一个公开邮编，**只读通、没专门调**（docs/106 §13.3）。
 * 不在表里的站点不设，只靠「币种 / 不能配送」检查照实说。
 */
export const AMAZON_DELIVERY_ZIPS: Readonly<Record<string, string>> = {
  US: '10001',
  CA: 'M5V 3L9',
  GB: 'SW1A 1AA',
  UK: 'SW1A 1AA',
  DE: '10115',
  FR: '75001',
  IT: '00184',
  ES: '28001',
  JP: '100-0001',
}

/**
 * 哪几种变化算「重要」——AI 按品类给建议、用户在方案卡上确认（C5：不预设）。
 * **没有确认过的方案 = 一条都不算重要**：变化照样进变化表，只是不进「重要」那几句。
 */
export interface AmazonImportanceRules {
  /** 对标款降价幅度到这个数（%）及以上算重要；不填 = 不按幅度算。 */
  price_drop_pct?: number
  /** 降价后比你的对标款便宜就算重要（要读到你那一款的价）。 */
  cheaper_than_own?: boolean
  /** 划线价 / 优惠券开始或结束算重要。 */
  discounts?: boolean
  /** 断货 / 补货算重要。 */
  stock?: boolean
  /** 评分跌破这个数算重要（如 4.0）；不填 = 不按评分算。 */
  rating_below?: number
  /** BSR 名次变化到这个幅度（%）及以上算重要；不填 = 不按排名算。 */
  bsr_move_pct?: number
}

/** 方案卡存下的那一份（每个品牌一份，存在竞品监控库的杂项里）。 */
export interface AmazonCompetitorPlan {
  rules: AmazonImportanceRules
  /** 用户点「就这样」/ 改完保存的时刻。 */
  confirmed_at: Iso8601
  /** AI 给建议时按的品类（卡上那句理由里用）。 */
  category?: string
  /** 站点（方案卡上选的那一个；默认按品牌目标市场，读不到用美国站）。 */
  marketplace: string
}
