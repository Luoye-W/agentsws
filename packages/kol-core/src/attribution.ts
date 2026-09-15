/**
 * UTM 生成与解析、联盟码、订单归因（48 §5.2「UTM 与归因」）。
 *
 * 归因这件事上唯一要紧的纪律：**匹配不上就说匹配不上**。
 * 一张订单归错了合作，下一次预算就按错的数字批——比"这张订单没归上"糟得多。
 * 所以 {@link attributeOrders} 只认两条硬判据（落地页带的 `utm_campaign`、
 * 订单用的折扣码），两条都对不上就进 `unmatched`，绝不按时间窗口"猜"给谁。
 */
import type { KolChannel, KolUtm } from '@agentsws/contracts'

/** 我们自己生成的 UTM 的 `medium` 恒定是它——于是"这一单是红人带来的"一眼认得出。 */
export const KOL_UTM_MEDIUM = 'kol'

/** UTM 值归一：转小写、空白与不安全字符换成 `-`，去掉首尾的 `-`。 */
export function utmSlug(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * 给一次合作生成 UTM。
 *
 * - `source` = 渠道（`youtube` / `tiktok`…）：报表按渠道分组靠它；
 * - `medium` = {@link KOL_UTM_MEDIUM}：跟广告、邮件分得开；
 * - `campaign` = campaign 的 slug；
 * - `content` = 合作 id 的 slug：**同一次 campaign 里的两个红人靠这一格分得开**。
 *   不放红人的名字：UTM 会出现在公开链接上，等于把合作名单贴出去。
 */
export function buildUtm(input: {
  channel: KolChannel
  campaign: string
  collaboration_id: string
  term?: string
}): KolUtm {
  return {
    source: input.channel,
    medium: KOL_UTM_MEDIUM,
    campaign: utmSlug(input.campaign),
    content: utmSlug(input.collaboration_id),
    ...(input.term === undefined ? {} : { term: utmSlug(input.term) }),
  }
}

/** 把 UTM 挂到一条链接上（已有的同名参数被覆盖；其余参数原样留着）。 */
export function applyUtm(url: string, utm: KolUtm): string {
  const u = new URL(url)
  u.searchParams.set('utm_source', utm.source)
  u.searchParams.set('utm_medium', utm.medium)
  u.searchParams.set('utm_campaign', utm.campaign)
  if (utm.term !== undefined) u.searchParams.set('utm_term', utm.term)
  if (utm.content !== undefined) u.searchParams.set('utm_content', utm.content)
  return u.toString()
}

/**
 * 从一条落地页链接里读回 UTM。
 *
 * 三个必填参数缺一个就回 `undefined`——半份 UTM 归不了因，留着它只会让
 * 归因表上多一行"来源：youtube，合作：不知道"。
 */
export function parseUtm(url: string): KolUtm | undefined {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return undefined
  }
  const source = u.searchParams.get('utm_source')
  const medium = u.searchParams.get('utm_medium')
  const campaign = u.searchParams.get('utm_campaign')
  if (source === null || medium === null || campaign === null) return undefined
  if (source === '' || medium === '' || campaign === '') return undefined
  const term = u.searchParams.get('utm_term')
  const content = u.searchParams.get('utm_content')
  return {
    source,
    medium,
    campaign,
    ...(term === null || term === '' ? {} : { term }),
    ...(content === null || content === '' ? {} : { content }),
  }
}

/**
 * 生成联盟码。
 *
 * 形状是 `<handle 的前 8 位><两位数字>`，全大写、只留字母数字——
 * 码要让人在视频里念得出来、在手机上打得对。冲突由调用方查库解决
 * （这里不查库），所以给了 `attempt` 那一格：撞了就 +1 再来一次。
 */
export function affiliateCode(input: { handle: string; attempt?: number }): string {
  const base = input.handle
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 8)
  const n = (input.attempt ?? 0) % 100
  return `${base === '' ? 'KOL' : base}${String(10 + n).padStart(2, '0')}`
}

/** 归因要看的那一份追踪链接（调用方从库里取）。 */
export interface TrackedLinkLike {
  id: string
  collaboration_id: string
  utm: KolUtm
  affiliate_code?: string
}

/** 归因要看的那一份订单（从连接器的只读 Action 来）。 */
export interface OrderLike {
  id: string
  /** 订单的落地页（Shopify 的 `landing_site`）。没有就是没有，别编。 */
  landing_site?: string
  /** 订单用的折扣码（可能有好几个）。 */
  discount_codes?: readonly string[]
  /** 订单金额（归因表上的"收入"那一列）。 */
  total: number
  currency: string
}

export type AttributionBasis = 'utm_content' | 'affiliate_code'

export interface AttributedOrder {
  order_id: string
  tracked_link_id: string
  collaboration_id: string
  /** 凭什么归给它。两条判据在卡面与归因表上都要写出来。 */
  basis: AttributionBasis
  revenue: number
  currency: string
}

export interface AttributionResult {
  matched: AttributedOrder[]
  /** 归不上的那些订单 id。**不猜**，见文件头。 */
  unmatched: string[]
  /** 按追踪链接汇总（归因表那一块直接用它）。 */
  by_link: {
    tracked_link_id: string
    collaboration_id: string
    orders: number
    revenue: number
    currency: string
  }[]
}

/**
 * 把订单归到追踪链接上。
 *
 * 判据的**优先级**是固定的：折扣码 > UTM。理由是折扣码是顾客**主动**输进去的，
 * 而 `landing_site` 会被各种跳转、社交 App 的内嵌浏览器改掉。两条都命中时按
 * 折扣码算，并在 `basis` 上写清楚——事后有人问"为什么算给了他"，答得出来。
 *
 * 一张订单只归给一条链接（第一条命中的）。不做分成：把一单拆给两个红人各半单，
 * 在任何一张报表上都解释不清。
 */
export function attributeOrders(
  links: readonly TrackedLinkLike[],
  orders: readonly OrderLike[],
): AttributionResult {
  const byCode = new Map<string, TrackedLinkLike>()
  for (const l of links)
    if (l.affiliate_code !== undefined && l.affiliate_code.trim() !== '')
      byCode.set(l.affiliate_code.trim().toUpperCase(), l)
  const byContent = new Map<string, TrackedLinkLike>()
  for (const l of links) if (l.utm.content !== undefined) byContent.set(l.utm.content, l)

  const matched: AttributedOrder[] = []
  const unmatched: string[] = []

  for (const o of orders) {
    let hit: { link: TrackedLinkLike; basis: AttributionBasis } | undefined
    for (const raw of o.discount_codes ?? []) {
      const link = byCode.get(raw.trim().toUpperCase())
      if (link !== undefined) {
        hit = { link, basis: 'affiliate_code' }
        break
      }
    }
    if (hit === undefined && o.landing_site !== undefined) {
      const utm = parseUtm(o.landing_site)
      // `medium` 也要对上：别人家的 `utm_content` 撞上我们的合作 id 不是不可能
      if (utm !== undefined && utm.medium === KOL_UTM_MEDIUM && utm.content !== undefined) {
        const link = byContent.get(utm.content)
        if (link !== undefined) hit = { link, basis: 'utm_content' }
      }
    }
    if (hit === undefined) {
      unmatched.push(o.id)
      continue
    }
    matched.push({
      order_id: o.id,
      tracked_link_id: hit.link.id,
      collaboration_id: hit.link.collaboration_id,
      basis: hit.basis,
      revenue: o.total,
      currency: o.currency,
    })
  }

  const agg = new Map<string, AttributionResult['by_link'][number]>()
  for (const m of matched) {
    const row = agg.get(m.tracked_link_id) ?? {
      tracked_link_id: m.tracked_link_id,
      collaboration_id: m.collaboration_id,
      orders: 0,
      revenue: 0,
      currency: m.currency,
    }
    row.orders += 1
    row.revenue = Math.round((row.revenue + m.revenue) * 100) / 100
    agg.set(m.tracked_link_id, row)
  }
  return { matched, unmatched, by_link: [...agg.values()] }
}
