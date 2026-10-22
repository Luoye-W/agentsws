/**
 * WP385（决策 1076）：网站运营 / 内容与搜索**读体检结论**的只读工具 `query_site_health`——给模型看的名字、描述、
 * 参数，回来的数据形状，以及 stub 运行时那一段剧本。真正干活在服务端（`apps/server/src/site-health-tools.ts`）。
 *
 * 体检设置（商品 feed、其他平台上架页、AI 爬虫 / AI 来源清单的加减）不另开工具：用户在对话里说一句，
 * AI 调通用的 `request_setup`（`setting: site.health` + 建议值），出「我打算改成这样」的卡，点头就存、重新体检一次。
 *
 * 纪律：只读，不现跑体检、不产生 staged / applied。
 */
import type { RunRequest, ToolDef } from '@agentsws/contracts'
import { REQUEST_SETUP_TOOL } from './setup-request.js'

export const QUERY_SITE_HEALTH_TOOL = 'query_site_health'

/** 体检设置的配置卡目标（服务端登记的那一个）。 */
export const SITE_HEALTH_SETUP_TARGET = 'site.health'

/** 一个工具（`tools.allow` 要字节稳定）。 */
export const SITE_HEALTH_TOOL_NAMES: readonly string[] = [QUERY_SITE_HEALTH_TOOL]

/** 网站运营那两条职责：店铺管理、SEO 与 GEO（WP446 起技术体检归它）。 */
export function isSiteHealthRole(role_id: string): boolean {
  return role_id === 'dtc.store' || role_id === 'dtc.seo'
}

const PARTS = [
  'all',
  'crawlers',
  'raw_html',
  'products',
  'chatgpt_shopping',
  'ai_traffic',
  'settings',
  // WP448：技术体检与改版回归
  'tech',
  'drift',
]

export const SITE_HEALTH_TOOL_DEFS: readonly ToolDef[] = [
  {
    name: QUERY_SITE_HEALTH_TOOL,
    description:
      '读最近一次网站 / 商品体检的结论和近 7 天 AI 带来的成交（实测）：AI 爬虫有没有被 robots.txt 挡、' +
      '价格库存这些关键事实不开 JS 看不看得到、店铺后台和商品页 / 结构化数据 / 商品 feed / 其他平台上架页对不对得上、' +
      '能否进 ChatGPT 购物；技术体检（收录、规范网址、跳转与死链、站点地图、hreflang、结构化数据、页面速度）与最近一次改版回归；' +
      '还有现在的体检设置。只读：不会现跑体检（每周一自动跑；正在跑就等它跑完再回）。' +
      '写周报、回答「我们站 AI 进得来吗」「AI 带来多少单」时用；数字照抄，没体检过就照实说。' +
      '用户说了商品 feed 地址、其他平台上架页、要加减 AI 爬虫或 AI 来源时，调 request_setup：setting 填 site.health，' +
      'suggestions 给 feed_url（网址）、listings_add（「平台 | 商品 handle | 网址」，多条用 ; 隔开）、listings_remove（网址）、' +
      'crawlers_add（「UA 名 | search 或 user 或 training」）、crawlers_remove（UA 名）、referrers_add（「平台 | 来源域名」）、' +
      'referrers_remove（平台名）；用户点头就存好并重新体检一次。',
    input_schema: {
      type: 'object',
      properties: {
        part: {
          type: 'string',
          enum: PARTS,
          description: '只看哪一块（不给 = 全部）',
        },
      },
    },
  },
]

export const SITE_HEALTH_TOOL_DEF_BY_NAME: ReadonlyMap<string, ToolDef> = new Map(
  SITE_HEALTH_TOOL_DEFS.map((d) => [d.name, d]),
)

/** 工具回的数据（服务端白名单出参）。 */
export interface SiteHealthQueryData {
  ok: boolean
  /** 体检还在跑（等了一会儿还没完）：下面是上一次的。 */
  running?: boolean
  checked_at?: string
  status?: 'ok' | 'partial' | 'failed'
  origin?: string
  crawlers?: {
    /** 被挡（整站 / 一部分）的 AI 搜索、替用户打开那两类。 */
    blocked: {
      token: string
      platform?: string
      purpose: string
      state: string
      rule?: string
    }[]
    /** 被挡的训练类（不算问题，只列出）。 */
    training_blocked: string[]
    allowed: number
  }
  /** 只靠 JS / 没写的关键事实。 */
  raw_html?: { url: string; fact: string; verdict: string }[]
  products?: {
    checked: number
    issues: { line: string; severity: string }[]
    more?: number
  }
  chatgpt_shopping?: { verdict: string; missing: string[] }
  notes?: string[]
  dispatched?: { matter_id: string; issues: number }
  ai_traffic?: {
    measured: true
    since: string
    until: string
    currency: string
    ai_orders: number
    ai_revenue: number
    total_orders: number
    visits: string
    rows: { platform: string; orders: number; revenue: number; visits?: number }[]
    previous?: { ai_orders: number; ai_revenue: number }
  }
  /** WP448：技术体检（只列有问题的；交给了建站哪条）。 */
  tech?: {
    indexing: string
    speed: string
    issues: { line: string; severity: string; owner: string }[]
    more?: number
    dispatched?: { owner: string; matter_id: string }[]
  }
  /** WP448：最近一次改版回归（三级；严重的交给了建站）。 */
  drift?: {
    at: string
    trigger: string
    change_id?: string
    status: string
    findings: { line: string; severity: string }[]
    dispatched?: string
  }
  settings?: {
    feed_url?: string
    listings: { platform: string; handle: string; url: string }[]
    crawlers_added: string[]
    crawlers_removed: string[]
    referrers_added: string[]
    referrers_removed: string[]
  }
  /** 一句话结论（给模型转述）。 */
  message: string
}

export function siteHealthQueryDataOf(data: unknown): SiteHealthQueryData | undefined {
  const o = data !== null && typeof data === 'object' ? (data as Record<string, unknown>) : {}
  return typeof o.ok === 'boolean' && typeof o.message === 'string'
    ? (o as unknown as SiteHealthQueryData)
    : undefined
}

const URL_RE = /https?:\/\/[^\s，。；;、"'」）)>]+/gi
const FEED_WORDS = /商品\s*feed|feed\s*(?:地址|网址|链接)|product\s*feed|merchant\s*feed|商品源/i
const LISTING_WORDS = /上架页|商品页|listing/i
const PLATFORM_WORDS: readonly [RegExp, string][] = [
  [/amazon|亚马逊/i, 'Amazon'],
  [/walmart|沃尔玛/i, 'Walmart'],
  [/ebay/i, 'eBay'],
  [/tiktok\s*shop|tiktok/i, 'TikTok Shop'],
  [/etsy/i, 'Etsy'],
  [/temu/i, 'Temu'],
  [/aliexpress|速卖通/i, 'AliExpress'],
]
const ASK_WORDS =
  /体检|AI\s*(?:爬虫|进得来|进不进得来|读得到|看得到)|robots\.txt|AI\s*带来|ChatGPT\s*购物/i
const HANDLE_RE = /(?:商品|handle)\s*(?:handle\s*)?(?:是|为|:|：)\s*([a-z0-9][a-z0-9-]{0,199})/i

/** stub 的一步：要一张体检设置卡，或读体检结论。 */
export type SiteHealthStep =
  | { kind: 'setup'; tool: string; input: Record<string, unknown> }
  | { kind: 'query'; tool: string; input: Record<string, unknown> }

/**
 * stub 的岔口（演示用剧本）：工具面里有 `query_site_health`，
 * - 话里给了商品 feed 地址 / 某平台上架页网址 → 调 `request_setup`（`site.health` + 建议值）；
 * - 话里问体检 / AI 爬虫 / AI 带来的成交 → 调 `query_site_health`。
 * 否则 undefined（stub 的其余路径一个字节不变）。
 */
export function siteHealthBranch(req: RunRequest, text: string): SiteHealthStep | undefined {
  if (!req.tools.allow.includes(QUERY_SITE_HEALTH_TOOL)) return undefined
  const urls = [...text.matchAll(URL_RE)].map((m) => m[0])
  if (req.tools.allow.includes(REQUEST_SETUP_TOOL) && urls.length > 0) {
    const suggestions: { key: string; value: string; why: string }[] = []
    const platform = PLATFORM_WORDS.find(([re]) => re.test(text))?.[1]
    if (FEED_WORDS.test(text) && urls[0] !== undefined)
      suggestions.push({ key: 'feed_url', value: urls[0], why: '你刚才说的' })
    else if (platform !== undefined && LISTING_WORDS.test(text)) {
      const listing = urls.find((u) => !/\/products\/[a-z0-9-]+/i.test(u)) ?? urls[0]
      const own = urls.map((u) => /\/products\/([a-z0-9-]+)/i.exec(u)?.[1]).find((h) => h)
      const handle = HANDLE_RE.exec(text)?.[1] ?? own
      if (listing !== undefined)
        suggestions.push({
          key: 'listings_add',
          value: [platform, handle ?? '', listing].join(' | '),
          why: '你刚才说的',
        })
    }
    if (suggestions.length > 0)
      return {
        kind: 'setup',
        tool: REQUEST_SETUP_TOOL,
        input: { setting: SITE_HEALTH_SETUP_TARGET, why: '按你说的记进体检设置。', suggestions },
      }
  }
  if (ASK_WORDS.test(text)) return { kind: 'query', tool: QUERY_SITE_HEALTH_TOOL, input: {} }
  return undefined
}

const PURPOSE_ZH: Readonly<Record<string, string>> = {
  search: 'AI 搜索',
  user: '替用户打开',
  training: '训练',
}

/** 回话（短）：体检结论几行；没体检过 / 读不到就照实说。 */
export function renderSiteHealthAnswer(data: SiteHealthQueryData | undefined, failed = ''): string {
  if (data === undefined) return `没读到体检结论：${failed || '工具没回话'}。`
  const lines = [data.message]
  const c = data.crawlers
  if (c !== undefined && c.blocked.length > 0)
    lines.push(
      `- 被挡的 AI 爬虫：${c.blocked
        .slice(0, 4)
        .map(
          (b) =>
            `${b.token}（${PURPOSE_ZH[b.purpose] ?? b.purpose}${b.state === 'partial' ? '，挡了一部分' : ''}）`,
        )
        .join('、')}`,
    )
  const jsOnly = (data.raw_html ?? []).filter((r) => r.verdict === 'js_only').length
  if (jsOnly > 0) lines.push(`- 只靠 JS 才看得到的关键事实：${String(jsOnly)} 处`)
  const p = data.products
  if (p !== undefined && p.issues.length > 0)
    lines.push(
      `- 商品信息对不上 ${String(p.issues.length + (p.more ?? 0))} 处：`,
      ...p.issues.slice(0, 3).map((i) => `  - ${i.line}`),
    )
  const tech = data.tech
  if (tech !== undefined && tech.issues.length > 0)
    lines.push(
      `- 技术体检要改 ${String(tech.issues.length + (tech.more ?? 0))} 处：`,
      ...tech.issues.slice(0, 3).map((i) => `  - ${i.line}`),
    )
  const severe = (data.drift?.findings ?? []).filter((f) => f.severity === 'critical')
  if (severe.length > 0)
    lines.push(
      `- 改版回归（${data.drift?.trigger ?? ''}）严重 ${String(severe.length)} 处：`,
      ...severe.slice(0, 3).map((f) => `  - ${f.line}`),
    )
  const t = data.ai_traffic
  if (t !== undefined)
    lines.push(
      `- 近 7 天 AI 带来 ${String(t.ai_orders)} 单 / ${t.currency} ${t.ai_revenue.toFixed(2)}（实测）`,
    )
  return lines.join('\n')
}
