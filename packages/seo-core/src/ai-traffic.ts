/**
 * WP381 ③：AI 来源流量——从 chatgpt.com、perplexity.ai、gemini.google.com、copilot.microsoft.com、claude.ai…
 * 来的访问与成交。数是 Shopify 自己记的（订单的首次 / 最后一次进店来源、店铺报表里的会话来源），
 * 规则认来源、不经模型，标「实测」——GEO 的引用数是「AI 说了什么」，这是「真来了多少人、成了几单」，两边并排看。
 *
 * 来源清单是数据（{@link DEFAULT_AI_REFERRERS}），品牌可以加减（只存差异）。
 *
 * 一单只算一次：最后一次进店来自某个 AI 就记它；否则首次进店来自某个 AI 记那个；都不是就不算 AI。
 */
import type {
  AiReferrer,
  AiTrafficRow,
  AiTrafficSummary,
  SiteHealthListOverrides,
} from '@agentsws/contracts'

export const DEFAULT_AI_REFERRERS: readonly AiReferrer[] = [
  {
    platform: 'ChatGPT',
    hosts: ['chatgpt.com', 'chat.openai.com'],
    utm_sources: ['chatgpt.com', 'chatgpt'],
  },
  {
    platform: 'Perplexity',
    hosts: ['perplexity.ai'],
    utm_sources: ['perplexity', 'perplexity.ai'],
  },
  { platform: 'Gemini', hosts: ['gemini.google.com', 'bard.google.com'], utm_sources: ['gemini'] },
  {
    platform: 'Copilot',
    hosts: ['copilot.microsoft.com', 'copilot.cloud.microsoft'],
    utm_sources: ['copilot'],
  },
  { platform: 'Claude', hosts: ['claude.ai'], utm_sources: ['claude.ai', 'claude'] },
  { platform: 'DeepSeek', hosts: ['chat.deepseek.com'] },
  { platform: 'Meta AI', hosts: ['meta.ai'] },
  { platform: 'Grok', hosts: ['grok.com'] },
  { platform: 'Mistral', hosts: ['chat.mistral.ai'] },
  { platform: 'Kimi', hosts: ['kimi.com', 'kimi.moonshot.cn'] },
  { platform: '豆包', hosts: ['doubao.com'] },
]

/** 默认清单 + 品牌的加减（同名以品牌加的为准）。 */
export function effectiveReferrers(
  overrides: SiteHealthListOverrides = {},
  base: readonly AiReferrer[] = DEFAULT_AI_REFERRERS,
): AiReferrer[] {
  const removed = new Set((overrides.referrers_remove ?? []).map((p) => p.toLowerCase()))
  const added = overrides.referrers_add ?? []
  const names = new Set(added.map((r) => r.platform.toLowerCase()))
  return [...base.filter((r) => !names.has(r.platform.toLowerCase())), ...added].filter(
    (r) => !removed.has(r.platform.toLowerCase()),
  )
}

const hostOf = (v: string): string | undefined => {
  const s = v.trim()
  if (s === '') return undefined
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`).hostname.toLowerCase()
  } catch {
    return undefined
  }
}

const hostMatches = (host: string, hosts: readonly string[]): boolean =>
  hosts.some((h) => host === h || host.endsWith(`.${h}`))

/** 一次进店（Shopify 的 CustomerVisit 那几格）。 */
export interface VisitLike {
  referrer_url?: string
  landing_page?: string
  /** Shopify 归的来源名（「chatgpt.com」「Google」「direct」…）。 */
  source?: string
}

/** 这次进店是不是从某个 AI 来的（来源网址主机 → 落地页的 utm_source → Shopify 归的来源名）。 */
export function aiPlatformOf(
  visit: VisitLike | undefined,
  list: readonly AiReferrer[] = DEFAULT_AI_REFERRERS,
): string | undefined {
  if (visit === undefined) return undefined
  const ref = visit.referrer_url === undefined ? undefined : hostOf(visit.referrer_url)
  if (ref !== undefined) {
    const hit = list.find((r) => hostMatches(ref, r.hosts))
    if (hit !== undefined) return hit.platform
  }
  if (visit.landing_page !== undefined) {
    let utm: string | null = null
    try {
      utm = new URL(visit.landing_page, 'https://shop.invalid').searchParams.get('utm_source')
    } catch {
      utm = null
    }
    if (utm !== null) {
      const u = utm.toLowerCase()
      const hit = list.find((r) => (r.utm_sources ?? []).includes(u) || hostMatches(u, r.hosts))
      if (hit !== undefined) return hit.platform
    }
  }
  const src = visit.source === undefined ? undefined : hostOf(visit.source)
  if (src !== undefined) return list.find((r) => hostMatches(src, r.hosts))?.platform
  return undefined
}

/** 一张订单（只要金额与两次进店，不带任何顾客信息）。 */
export interface TrafficOrder {
  total: number
  currency: string
  created_at: string
  first?: VisitLike
  last?: VisitLike
}

/** 店铺报表里按来源域名汇总的会话（没授权就没有）。 */
export interface TrafficSessions {
  referrer_domain: string
  sessions: number
}

export function summarizeAiTraffic(input: {
  orders: readonly TrafficOrder[]
  /** `undefined` = 没读会话（看 `visits_state`）。 */
  sessions?: readonly TrafficSessions[]
  visits_state: AiTrafficSummary['visits']
  since: string
  until: string
  currency: string
  now: string
  list?: readonly AiReferrer[]
}): AiTrafficSummary {
  const list = input.list ?? DEFAULT_AI_REFERRERS
  const rows = new Map<string, AiTrafficRow>()
  const row = (platform: string): AiTrafficRow => {
    const r = rows.get(platform) ?? { platform, orders: 0, revenue: 0 }
    rows.set(platform, r)
    return r
  }
  const inWindow = input.orders.filter(
    (o) => o.created_at >= input.since && o.created_at <= input.until,
  )
  let aiOrders = 0
  let aiRevenue = 0
  for (const o of inWindow) {
    const p = aiPlatformOf(o.last, list) ?? aiPlatformOf(o.first, list)
    if (p === undefined) continue
    const r = row(p)
    r.orders += 1
    r.revenue = Math.round((r.revenue + o.total) * 100) / 100
    aiOrders += 1
    aiRevenue = Math.round((aiRevenue + o.total) * 100) / 100
  }
  if (input.visits_state === 'ok')
    for (const s of input.sessions ?? []) {
      const host = hostOf(s.referrer_domain)
      const p = host === undefined ? undefined : list.find((r) => hostMatches(host, r.hosts))
      if (p === undefined) continue
      const r = row(p.platform)
      r.visits = (r.visits ?? 0) + s.sessions
    }
  // 清单顺序出（ChatGPT 在前），没数的不出行
  const order = list.map((r) => r.platform)
  return {
    measured: true,
    since: input.since,
    until: input.until,
    currency: input.currency,
    rows: [...rows.values()].sort((a, b) => order.indexOf(a.platform) - order.indexOf(b.platform)),
    total_orders: inWindow.length,
    ai_orders: aiOrders,
    ai_revenue: aiRevenue,
    visits: input.visits_state,
    computed_at: input.now,
  }
}

/**
 * 周报一行：「AI 带来 3 单 / $149.97（实测）· ChatGPT 2 单」。没有 AI 来的单也照实写 0（这是实测，0 也是数）。
 */
export function aiTrafficBrief(s: AiTrafficSummary): string {
  const top = s.rows.filter((r) => r.orders > 0).sort((a, b) => b.orders - a.orders)[0]
  const visits = s.rows.reduce((n, r) => n + (r.visits ?? 0), 0)
  return [
    `AI 带来 ${String(s.ai_orders)} 单 / ${s.currency} ${s.ai_revenue.toFixed(2)}（实测）`,
    ...(s.visits === 'ok' ? [`访问 ${String(visits)}`] : []),
    ...(top === undefined ? [] : [`${top.platform} ${String(top.orders)} 单`]),
  ].join(' · ')
}
