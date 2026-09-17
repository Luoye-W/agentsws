/**
 * 归因：**平台口径与订单口径两列并排，永远不合并**（57 §1）。
 *
 * 这个模块存在的全部理由是一句话：**两个数不一样是常态，不是 bug。**
 *
 * - 平台口径（Meta 报 18 单）：按它自己的归因窗口算——点击后 7 天、浏览后 1 天，
 *   跨设备靠登录态串起来。同一个人在手机上看过、在电脑上买了，平台认。
 * - 订单口径（订单表里找到 11 单）：按落地页那串 UTM 算（复用 `@agentsws/kol-core`
 *   的 `parseUtm`，**全仓同一份解析**）。浏览器清了 cookie、从收藏夹进来的、
 *   直接搜品牌名下单的，UTM 里一个字都没有。
 *
 * 两个数都是真的。把它们合成一个"真实转化数"要么偏袒平台（于是每次都该加预算），
 * 要么偏袒订单（于是每条广告看起来都在亏）——而做这个判断的人本来就该看见差多少。
 * 所以 {@link attributeAds} 回的每一行都有两列，`gap_pct` 只是把差距算出来给人看，
 * **不是**修正值。
 *
 * 第三条纪律：**匹配不上就说匹配不上**（与 `kol-core` 的归因逐字同源）。
 * 一张订单的 UTM 对不上任何一条 campaign，它进 `unmatched`，绝不按时间窗口猜给谁。
 */

import type { AdAttributionRow, AdsPlatform } from '@agentsws/contracts'
import { parseUtm } from '@agentsws/kol-core'

/** 投放生成的 UTM 的 `medium` 恒定是它——于是"这一单是广告带来的"一眼认得出。 */
export const ADS_UTM_MEDIUM = 'cpc'

/** 平台那一侧报回来的一行（适配器拉数之后的形状）。 */
export interface PlatformReportRow {
  platform: AdsPlatform
  /** campaign 名（与 UTM 的 `utm_campaign` 对齐的那个值）。 */
  campaign: string
  spend?: number
  conversions?: number
  conversion_value?: number
}

/** 订单那一侧的一行（订单表 + 落地页链接）。 */
export interface OrderRow {
  order_id: string
  /** 下单那一次的落地页链接（带 UTM）。没有就归不了因——**不猜**。 */
  landing_url?: string
  /** 订单金额（基准币种）。 */
  amount?: number
  created_at: string
}

/** 一张订单归到了哪儿（或者为什么归不上）。 */
export interface OrderAttribution {
  order_id: string
  matched: boolean
  platform?: AdsPlatform
  campaign?: string
  /** 归不上的原因，一句人话。原样进面板上"对不上的那些"。 */
  reason?: string
}

export interface AdAttributionResult {
  /** 一行一条 campaign，两列并排（文件头第一条）。 */
  rows: AdAttributionRow[]
  /** 归不上的订单（**不分摊、不猜**）。 */
  unmatched: OrderAttribution[]
  /** 每一张订单的归因结论（面板上点开一条 campaign 看到的明细）。 */
  orders: OrderAttribution[]
}

/**
 * 从 UTM 认出这是哪个平台。
 *
 * 只认我们自己生成的那种形状：`utm_medium` = `cpc` 且 `utm_source` 是四个平台之一。
 * 别的（红人那条 `utm_medium=kol`、邮件那条）一概不认——认了就会把红人带来的单
 * 算到广告头上，下一次预算就按错的数批。
 */
export function adsPlatformOfUrl(url: string): AdsPlatform | undefined {
  const utm = parseUtm(url)
  if (utm === undefined) return undefined
  if (utm.medium.toLowerCase() !== ADS_UTM_MEDIUM) return undefined
  const source = utm.source.toLowerCase()
  const known: Record<string, AdsPlatform> = {
    meta: 'meta',
    facebook: 'meta',
    instagram: 'meta',
    google: 'google',
    x: 'x',
    twitter: 'x',
    tiktok: 'tiktok',
  }
  return known[source]
}

/**
 * 两个口径各算各的，摆成一张表。
 *
 * 平台那一侧报了、订单那一侧一单都没找到的 campaign **照样出现在表里**
 * （两列一列有数一列空着）——那正是最要紧的一行：要么 UTM 没挂对，
 * 要么这条广告带来的是看看就走的人。把它从表里筛掉，问题就永远不会被发现。
 */
export function attributeAds(input: {
  platform_rows: readonly PlatformReportRow[]
  orders: readonly OrderRow[]
  observed_at: string
}): AdAttributionResult {
  const orders: OrderAttribution[] = input.orders.map((o) => {
    if (o.landing_url === undefined)
      return {
        order_id: o.order_id,
        matched: false,
        reason: '这一单没有落地页链接（直接进店、从收藏夹来、或者链接没记下来）',
      }
    const utm = parseUtm(o.landing_url)
    if (utm === undefined)
      return {
        order_id: o.order_id,
        matched: false,
        reason: '落地页链接上没有完整的 UTM（三个必填参数缺一个，归不了因）',
      }
    const platform = adsPlatformOfUrl(o.landing_url)
    if (platform === undefined)
      return {
        order_id: o.order_id,
        matched: false,
        reason: `UTM 上写的是 ${utm.source}/${utm.medium}，不是广告投放的口径——不认（认了就会把别人带来的单算到广告头上）`,
      }
    return { order_id: o.order_id, matched: true, platform, campaign: utm.campaign }
  })

  /**
   * campaign 名归一：平台那一侧与 UTM 那一侧大小写常常不一样。
   *
   * 用 JSON 拼 key 而不是拿一个分隔符去连：campaign 名是用户起的，任何一个分隔符
   * 都可能出现在名字里（`九月|桌面` 这种），拼出来就串行了。
   */
  const key = (platform: string, campaign: string) =>
    JSON.stringify([platform, campaign.toLowerCase()])

  const orderAgg = new Map<string, { count: number; value: number }>()
  for (const [i, a] of orders.entries()) {
    if (!a.matched || a.platform === undefined || a.campaign === undefined) continue
    const k = key(a.platform, a.campaign)
    const found = orderAgg.get(k) ?? { count: 0, value: 0 }
    found.count += 1
    found.value += input.orders[i]?.amount ?? 0
    orderAgg.set(k, found)
  }

  const rows: AdAttributionRow[] = input.platform_rows.map((r) => {
    const found = orderAgg.get(key(r.platform, r.campaign))
    return {
      platform: r.platform,
      campaign: r.campaign,
      ...(r.conversions === undefined ? {} : { platform_conversions: r.conversions }),
      ...(r.conversion_value === undefined ? {} : { platform_value: r.conversion_value }),
      // 平台报了、订单一单没找到的那一行照样出：0 与"没查过"在这里是两件事，
      // 而这一行恰恰是最该被看见的一行（文件头末段）
      order_conversions: found?.count ?? 0,
      order_value: found?.value ?? 0,
      ...(r.spend === undefined ? {} : { spend: r.spend }),
      observed_at: input.observed_at,
    }
  })

  // 订单那一侧有、平台那一侧没报的 campaign：也出一行（多半是 campaign 改了名）
  const reported = new Set(input.platform_rows.map((r) => key(r.platform, r.campaign)))
  for (const [k, agg] of orderAgg)
    if (!reported.has(k)) {
      const [platform = '', campaign = ''] = JSON.parse(k) as [string, string]
      rows.push({
        platform: platform as AdsPlatform,
        campaign,
        order_conversions: agg.count,
        order_value: agg.value,
        observed_at: input.observed_at,
      })
    }

  return { rows, unmatched: orders.filter((o) => !o.matched), orders }
}

/**
 * 一行上两个口径差多少（正数 = 平台报得多）。
 *
 * **这是给人看的一个百分比，不是修正值**（文件头第二条）。两边都没有数的时候
 * 回 `undefined`——不回 0："一样多"与"两边都没数"在面板上必须分得开。
 */
export function attributionGapPct(row: AdAttributionRow): number | undefined {
  const p = row.platform_conversions
  const o = row.order_conversions
  if (p === undefined && o === undefined) return undefined
  const platform = p ?? 0
  const order = o ?? 0
  if (order === 0) return platform === 0 ? 0 : Number.POSITIVE_INFINITY
  return Math.round(((platform - order) / order) * 1000) / 10
}

/**
 * 两个口径各自的 ROAS。
 *
 * 一样是两个数，**不合并**：`platform` 用平台报的转化额，`order` 用订单表里
 * 那几单的真金额。没花钱（`spend` 为 0 或没给）就回 `undefined`——除以 0
 * 得到的那个 `Infinity` 摆在面板上没有任何意义。
 */
export function roasBothViews(row: AdAttributionRow): {
  platform?: number
  order?: number
} {
  const spend = row.spend
  if (spend === undefined || spend <= 0) return {}
  const round = (n: number) => Math.round(n * 100) / 100
  return {
    ...(row.platform_value === undefined ? {} : { platform: round(row.platform_value / spend) }),
    ...(row.order_value === undefined ? {} : { order: round(row.order_value / spend) }),
  }
}
