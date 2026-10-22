/**
 * WP448（docs/109 §4.4、§5.1 #1）：技术体检的**判断**——没收录、规范网址、跳转与死链、站点地图、hreflang、结构化数据、页面速度。
 *
 * 只判「命中了规则表里哪一条」：严重度、交给谁、文案全在 `tech-rules.ts`（数据）。读数（抓页面、跟跳转、站点地图、
 * Search Console 网址检查、页面速度）都由服务端读好递进来；这里不打一跳网络、不经模型。**只列有问题的**。
 *
 * 结构化数据按 Google 富媒体结果现行要求校验，用 Adobe 的开源校验库 `@adobe/structured-data-validator`
 * （Apache-2.0，零依赖；只用它的 Google 规则，不加载 schema.org 全表、不联网）。
 *
 * 检查项思路借 claude-seo（MIT）@ 4b99de2：`skills/seo-technical`（跳转不超过 1 跳、canonical 自指、noindex 冲突）、
 * `seo-sitemap`（站点地图只留 200 且可收录的最终地址、robots.txt 里声明）、`seo-hreflang`（自指、互指、ISO 码、
 * 和规范网址一致、x-default）、`seo-schema`、`seo-google`（CrUX 真实用户数据优先、PageSpeed 实验室数兜底）。
 */
import type { SitePage, TechAuditIssue, TechAuditOwner, TechAuditResult } from '@agentsws/contracts'
import { isNoindex, type PageSeoFacts, schemaTypes, urlKey } from './page-seo.js'
import { CWV_THRESHOLDS, TECH_AUDIT_RULES, type TechAuditRuleId } from './tech-rules.js'

/* ── 跳转跟踪 ─────────────────────────────────────────────────────────── */

/** 不自动跟跳转地抓一次：状态码 + `Location`（+ `X-Robots-Tag`）。服务端注入真请求，测试注入替身。 */
export type RedirectProbe = (
  url: string,
) => Promise<{ status: number; location?: string; x_robots?: string }>

export interface RedirectTrace {
  url: string
  /** 每一跳（不含最终那一页）：哪个地址、回的几号。 */
  hops: { url: string; status: number }[]
  final: { url: string; status: number }
  loop?: boolean
  /** 跳出了自己的站（不再往下跟）。 */
  offsite?: boolean
}

/** 最多跟几跳（再多就当跳转链问题报，不再追）。 */
export const MAX_REDIRECT_HOPS = 5

/** 从一个地址起跟跳转，只在自己站内跟（跳到别的主机就停）。抓不到 = 最终状态 0。 */
export async function traceRedirects(
  url: string,
  probe: RedirectProbe,
  ownHosts: readonly string[],
): Promise<RedirectTrace> {
  const hops: { url: string; status: number }[] = []
  const seen = new Set<string>()
  let at = url
  for (let i = 0; i <= MAX_REDIRECT_HOPS; i += 1) {
    if (seen.has(urlKey(at))) return { url, hops, final: { url: at, status: 0 }, loop: true }
    seen.add(urlKey(at))
    let r: { status: number; location?: string }
    try {
      r = await probe(at)
    } catch {
      return { url, hops, final: { url: at, status: 0 } }
    }
    if (r.status < 300 || r.status >= 400 || r.location === undefined)
      return { url, hops, final: { url: at, status: r.status } }
    hops.push({ url: at, status: r.status })
    let next: URL
    try {
      next = new URL(r.location, at)
    } catch {
      return { url, hops, final: { url: at, status: r.status } }
    }
    if (!ownHosts.includes(next.host.toLowerCase()))
      return { url, hops, final: { url: next.toString(), status: 0 }, offsite: true }
    at = next.toString()
  }
  return { url, hops, final: { url: at, status: 0 } }
}

/* ── 站点地图 ─────────────────────────────────────────────────────────── */

/** robots.txt 里声明的站点地图。 */
export function sitemapsInRobots(robots: string | undefined): string[] {
  if (robots === undefined) return []
  return [...robots.matchAll(/^\s*sitemap\s*:\s*(\S+)\s*$/gim)]
    .map((m) => m[1] ?? '')
    .filter((u) => /^https?:\/\//i.test(u))
}

/** 一份站点地图：索引（指向子地图）/ 网址清单 / 读不出。 */
export function parseSitemap(xml: string | undefined): {
  kind: 'index' | 'urlset' | 'invalid'
  locs: string[]
} {
  if (xml === undefined) return { kind: 'invalid', locs: [] }
  const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) =>
    (m[1] ?? '').replace(/&amp;/g, '&'),
  )
  if (/<sitemapindex\b/i.test(xml)) return { kind: 'index', locs }
  if (/<urlset\b/i.test(xml)) return { kind: 'urlset', locs }
  return { kind: 'invalid', locs: [] }
}

/** 服务端读到的站点地图（读到了哪些网址、读全了没有）。 */
export interface SitemapRead {
  state: 'found' | 'missing' | 'unreadable' | 'unknown'
  declared_in_robots: boolean
  /** 站点地图里所有页面地址（读到的那部分）。 */
  urls: string[]
  /** 子地图太多没读完（这时不判「在卖的页不在站点地图里」）。 */
  truncated?: boolean
  /** 站点地图的地址。 */
  at?: string
}

/* ── 页面速度 ─────────────────────────────────────────────────────────── */

/** 一页的速度：真实用户（CrUX，p75）优先，没有就实验室（Lighthouse）。 */
export interface SpeedReading {
  url: string
  source: 'field' | 'lab'
  lcp_ms?: number
  inp_ms?: number
  cls?: number
  tbt_ms?: number
  /** 真实用户数据是这一页自己的，还是整站的（页面数据不够时 CrUX 退到整站）。 */
  scope?: 'page' | 'origin'
}

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined
const rec = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}

/**
 * PageSpeed Insights v5 的回包 → 一份读数。`loadingExperience`（这一页的 CrUX）有数就用它，
 * 没有退 `originLoadingExperience`（整站），再没有用 Lighthouse 实验室数并标「实验室」。读不出回 `undefined`。
 */
export function speedReadingOf(url: string, psi: unknown): SpeedReading | undefined {
  const field = (exp: unknown, scope: 'page' | 'origin'): SpeedReading | undefined => {
    const m = rec(rec(exp).metrics)
    const p = (k: string): number | undefined => num(rec(m[k]).percentile)
    const lcp = p('LARGEST_CONTENTFUL_PAINT_MS')
    const inp = p('INTERACTION_TO_NEXT_PAINT')
    const clsRaw = p('CUMULATIVE_LAYOUT_SHIFT_SCORE')
    if (lcp === undefined && inp === undefined && clsRaw === undefined) return undefined
    return {
      url,
      source: 'field',
      scope,
      ...(lcp === undefined ? {} : { lcp_ms: lcp }),
      ...(inp === undefined ? {} : { inp_ms: inp }),
      // CrUX 的 CLS 百分位是乘了 100 的整数
      ...(clsRaw === undefined ? {} : { cls: clsRaw / 100 }),
    }
  }
  const body = rec(psi)
  const own = field(body.loadingExperience, 'page')
  if (own !== undefined) return own
  const origin = field(body.originLoadingExperience, 'origin')
  if (origin !== undefined) return origin
  const audits = rec(rec(body.lighthouseResult).audits)
  const a = (k: string): number | undefined => num(rec(audits[k]).numericValue)
  const lcp = a('largest-contentful-paint')
  const cls = a('cumulative-layout-shift')
  const tbt = a('total-blocking-time')
  if (lcp === undefined && cls === undefined && tbt === undefined) return undefined
  return {
    url,
    source: 'lab',
    ...(lcp === undefined ? {} : { lcp_ms: Math.round(lcp) }),
    ...(cls === undefined ? {} : { cls: Math.round(cls * 1000) / 1000 }),
    ...(tbt === undefined ? {} : { tbt_ms: Math.round(tbt) }),
  }
}

/* ── 结构化数据（Google 富媒体结果要求） ─────────────────────────────── */

interface SdvIssue {
  issueMessage?: string
  severity?: string
  rootType?: string
  fieldNames?: string[]
}

type SdvValidator = { validate(data: unknown): Promise<SdvIssue[]> }
let validatorPromise: Promise<SdvValidator | undefined> | undefined

/** 校验库按需载入（载不进来就不校验结构化数据的字段，只报 JSON 写坏与缺 Product）。 */
function validator(): Promise<SdvValidator | undefined> {
  validatorPromise ??= import('@adobe/structured-data-validator')
    // 包的入口只有默认导出（`export default Validator`）
    .then((m: { default: new (schema?: unknown) => SdvValidator }) => new m.default())
    .catch(() => undefined)
  return validatorPromise
}

/** 文章类的几种写法（Shopify 博客默认是 BlogPosting / Article）。 */
const ARTICLE_TYPE = /^(Article|BlogPosting|NewsArticle)$/

/** 我们在乎的四类（Google 现行支持里中小店用得上的）。 */
const CHECKED_TYPES = new Set(['Product', 'ProductGroup', 'Offer', 'BreadcrumbList', 'Article'])

/** JSON-LD 块 → 校验库要的「按根类型分组」那份（`@graph` 摊开）。 */
function waeOf(blocks: readonly unknown[]): { jsonld: Record<string, unknown[]> } {
  const jsonld: Record<string, unknown[]> = {}
  const add = (v: unknown, depth: number): void => {
    if (depth > 4) return
    if (Array.isArray(v)) {
      for (const x of v) add(x, depth + 1)
      return
    }
    const o = rec(v)
    if (o['@graph'] !== undefined) add(o['@graph'], depth + 1)
    const t = o['@type']
    const type = Array.isArray(t) ? t.find((x) => typeof x === 'string') : t
    if (typeof type !== 'string' || !CHECKED_TYPES.has(type)) return
    // 校验库会删 `@location`，给它一份拷贝
    const list = jsonld[type] ?? []
    list.push(structuredClone(o))
    jsonld[type] = list
  }
  add(blocks, 0)
  return { jsonld }
}

/** 一页的结构化数据：Google 要求的字段缺了哪几格（只取 ERROR；WARNING 是推荐项，不列）。 */
export async function schemaErrors(
  blocks: readonly unknown[],
): Promise<{ type: string; fields: string[] }[]> {
  const wae = waeOf(blocks)
  if (Object.keys(wae.jsonld).length === 0) return []
  const v = await validator()
  if (v === undefined) return []
  let issues: SdvIssue[]
  try {
    issues = await v.validate(wae)
  } catch {
    return []
  }
  const by = new Map<string, Set<string>>()
  for (const i of issues) {
    if (i.severity !== 'ERROR') continue
    const type = i.rootType ?? '?'
    const set = by.get(type) ?? new Set<string>()
    for (const f of i.fieldNames ?? []) set.add(f)
    if ((i.fieldNames ?? []).length === 0 && i.issueMessage !== undefined)
      set.add(i.issueMessage.slice(0, 60))
    by.set(type, set)
  }
  return [...by.entries()].map(([type, f]) => ({ type, fields: [...f].sort() }))
}

/* ── hreflang ─────────────────────────────────────────────────────────── */

/** 不是国家码的常见错写（UK 应写 GB；EU / LA 不是国家）。 */
const BAD_REGIONS = new Set(['UK', 'EU', 'LA', 'UN', 'AP'])

/** hreflang 码合不合规：ISO 639-1 语言（两个字母）+ 可选四字母书写体 + 可选 ISO 3166-1 地区；或 `x-default`。 */
export function validHreflang(code: string): boolean {
  if (code.toLowerCase() === 'x-default') return true
  const m = /^([a-z]{2})(?:-([A-Za-z]{4}))?(?:-([A-Za-z]{2}|\d{3}))?$/i.exec(code)
  if (m === null) return false
  const region = m[3]?.toUpperCase()
  return region === undefined || !BAD_REGIONS.has(region)
}

/* ── 主函数 ───────────────────────────────────────────────────────────── */

export type AuditPageKind = 'home' | 'product' | 'collection' | 'article' | 'page'

export interface TechAuditInput {
  origin: string
  checked_at: string
  /** 抓到的页（首页、抽查的商品、合集、文章…）。 */
  pages: { kind: AuditPageKind; facts: PageSeoFacts }[]
  /** Search Console 网址检查读到的页；`undefined` = 没连。 */
  index: readonly SitePage[] | undefined
  sitemap: SitemapRead
  /** 跟过跳转的地址（站内链接、站点地图抽查、规范网址目标）：地址 → 结果。 */
  traces: ReadonlyMap<string, RedirectTrace>
  /** 站内链接是从哪一页链过来的（死链说明要写）。 */
  link_from: ReadonlyMap<string, string>
  /** 站点地图里抽查了哪几条（`traces` 里的键）。 */
  sitemap_sample: readonly string[]
  /** 目标市场几个（≥ 2 才查 hreflang）。 */
  markets: number
  /** 速度读数；`undefined` = 这次没量（没开 / 读不到）。 */
  speed: readonly SpeedReading[] | undefined
  /** 速度那一项开没开（关掉 = `off`）。 */
  speed_enabled: boolean
}

const pathOf = (u: string): string => {
  try {
    const x = new URL(u)
    return `${x.pathname}${x.search}`
  } catch {
    return u
  }
}

/** Shopify 合集里的商品地址（/collections/x/products/y）规范网址指 /products/y 是对的，不算「指走了」。 */
const shopifyCollectionProduct = (page: string, canonical: string): boolean => {
  const m = /\/collections\/[^/]+\/products\/([^/?#]+)/.exec(pathOf(page))
  return m !== null && pathOf(canonical).replace(/\/+$/, '') === `/products/${m[1]}`
}

export async function runTechAudit(input: TechAuditInput): Promise<TechAuditResult> {
  const issues: TechAuditIssue[] = []
  const seen = new Set<string>()
  const push = (
    rule: TechAuditRuleId,
    detail: string,
    extra: Partial<Pick<TechAuditIssue, 'url' | 'redirect' | 'measured' | 'severity'>> = {},
  ): void => {
    const key = `${rule}|${extra.url ?? ''}`
    if (seen.has(key)) return
    seen.add(key)
    const r = TECH_AUDIT_RULES[rule]
    issues.push({
      rule,
      area: r.area,
      severity: extra.severity ?? r.severity,
      owner: r.owner,
      detail,
      ...(extra.url === undefined ? {} : { url: extra.url }),
      ...(extra.redirect === undefined ? {} : { redirect: extra.redirect }),
      ...(extra.measured === undefined ? {} : { measured: extra.measured }),
    })
  }
  let ownHost = ''
  try {
    ownHost = new URL(input.origin).host.toLowerCase()
  } catch {
    // 起点地址不对：照样判页面本身
  }
  const sameSite = (u: string): boolean => {
    try {
      return new URL(u).host.toLowerCase().replace(/^www\./, '') === ownHost.replace(/^www\./, '')
    } catch {
      return false
    }
  }

  // ① 没收录（Search Console 网址检查）
  let indexing: TechAuditResult['indexing'] = 'not_connected'
  if (input.index !== undefined) {
    const known = input.index.filter((p) => p.index_status !== undefined)
    indexing = known.length === 0 ? 'no_data' : 'checked'
    for (const p of known) {
      if (p.index_status === 'not_indexed')
        push('indexing.not_indexed', `${pathOf(p.url)}：Search Console 说没收录`, { url: p.url })
      if (p.index_status === 'redirect')
        push('indexing.redirect', `${pathOf(p.url)}：排名落在会跳走的地址上`, { url: p.url })
      if (p.index_status === 'canonical_mismatch')
        push(
          'indexing.canonical_mismatch',
          `${pathOf(p.url)}：Google 认的规范网址和页面写的不一样`,
          {
            url: p.url,
          },
        )
    }
  }

  // ② 规范网址
  for (const { facts } of input.pages) {
    if (facts.status !== 200) continue
    const at = pathOf(facts.url)
    if (facts.canonicals.length === 0) {
      push('canonical.missing', `${at}：<head> 里没有 canonical`, { url: facts.url })
      continue
    }
    if (facts.canonicals.length > 1)
      push(
        'canonical.multiple',
        `${at}：写了 ${String(facts.canonicals.length)} 个（${facts.canonicals.map(pathOf).join('、')}）`,
        { url: facts.url },
      )
    const canonical = facts.canonicals[0] ?? facts.url
    const self = urlKey(canonical) === urlKey(facts.url)
    if (!self && !shopifyCollectionProduct(facts.url, canonical)) {
      push('canonical.points_elsewhere', `${at} 的规范网址是 ${pathOf(canonical)}`, {
        url: facts.url,
      })
      if (isNoindex(facts.robots))
        push(
          'canonical.noindex_conflict',
          `${at}：noindex，同时规范网址指向 ${pathOf(canonical)}`,
          {
            url: facts.url,
          },
        )
      const t = input.traces.get(canonical)
      if (t !== undefined && (t.hops.length > 0 || t.final.status !== 200))
        push(
          'canonical.target_broken',
          `${at} 指向的 ${pathOf(canonical)} ${t.hops.length > 0 ? `会跳到 ${pathOf(t.final.url)}` : `打开是 ${String(t.final.status || '打不开')}`}`,
          { url: facts.url },
        )
    }
  }

  // ③ 跳转与死链
  for (const t of input.traces.values()) {
    const at = pathOf(t.url)
    const from = input.link_from.get(t.url)
    const via = from === undefined ? '' : `（从 ${pathOf(from)} 链过来）`
    if (t.loop === true) {
      push(
        'redirect.loop',
        `${at} 跳了一圈又回来：${[...t.hops.map((h) => pathOf(h.url)), at].join(' → ')}`,
        {
          url: t.url,
        },
      )
      continue
    }
    const temp = t.hops.find((h) => h.status === 302 || h.status === 307)
    if (temp !== undefined)
      push('redirect.temporary', `${pathOf(temp.url)} 用的是临时跳转（${String(temp.status)}）`, {
        url: temp.url,
      })
    if (t.hops.length >= 2) {
      const finalOk = t.final.status === 200 && sameSite(t.final.url)
      push(
        'redirect.chain',
        `${String(t.hops.length)} 跳：${[...t.hops.map((h) => pathOf(h.url)), pathOf(t.final.url)].join(' → ')}`,
        {
          url: t.url,
          ...(finalOk ? { redirect: { path: pathOf(t.url), target: pathOf(t.final.url) } } : {}),
        },
      )
    }
    const s = t.final.status
    // 死链只说站内链接（站点地图抽查的那几条归下面站点地图那一块）
    if (from === undefined) continue
    if (s === 404 || s === 410)
      push('link.dead_internal', `${at} 打开是 ${String(s)}${via}`, { url: t.url })
    else if (s >= 500) push('link.server_error', `${at} 打开是 ${String(s)}${via}`, { url: t.url })
  }

  // ④ 站点地图
  const sm = input.sitemap
  if (sm.state === 'missing')
    push('sitemap.missing', '/sitemap.xml 打不开，robots.txt 里也没写别的地址')
  else if (sm.state === 'unreadable')
    push(
      'sitemap.unreadable',
      `${sm.at === undefined ? '站点地图' : pathOf(sm.at)} 不是站点地图格式`,
    )
  else if (sm.state === 'found') {
    if (!sm.declared_in_robots) push('sitemap.not_in_robots', 'robots.txt 里没有 Sitemap: 那一行')
    const inMap = new Set(sm.urls.map(urlKey))
    for (const u of input.sitemap_sample) {
      const t = input.traces.get(u)
      if (t === undefined) continue
      if (t.hops.length > 0)
        push('sitemap.bad_url', `站点地图里的 ${pathOf(u)} 会跳到 ${pathOf(t.final.url)}`, {
          url: u,
        })
      else if (t.final.status !== 200 && t.final.status !== 0)
        push('sitemap.bad_url', `站点地图里的 ${pathOf(u)} 打开是 ${String(t.final.status)}`, {
          url: u,
        })
    }
    for (const { kind, facts } of input.pages) {
      const listed = inMap.has(urlKey(facts.url))
      if (listed && isNoindex(facts.robots))
        push('sitemap.bad_url', `站点地图里的 ${pathOf(facts.url)} 设了 noindex`, {
          url: facts.url,
        })
      const indexable =
        facts.status === 200 &&
        !isNoindex(facts.robots) &&
        (facts.canonicals[0] === undefined || urlKey(facts.canonicals[0]) === urlKey(facts.url))
      if (
        sm.truncated !== true &&
        (kind === 'product' || kind === 'collection') &&
        indexable &&
        !listed
      )
        push('sitemap.missing_page', `${pathOf(facts.url)} 能打开、能收录，但不在站点地图里`, {
          url: facts.url,
        })
    }
  }

  // ⑤ hreflang（多个市场时）
  const hreflang: TechAuditResult['hreflang'] = input.markets >= 2 ? 'checked' : 'single_market'
  if (hreflang === 'checked') {
    const byKey = new Map(input.pages.map((p) => [urlKey(p.facts.url), p.facts]))
    const withTags = input.pages.filter((p) => p.facts.hreflang.length > 0)
    const home = input.pages.find((p) => p.kind === 'home')
    if (withTags.length === 0 && home !== undefined && home.facts.status === 200)
      push('hreflang.missing', `${String(input.markets)} 个目标市场，首页一条 hreflang 都没写`, {
        url: home.facts.url,
      })
    let anyXDefault = false
    for (const { facts } of withTags) {
      const at = pathOf(facts.url)
      const bad = facts.hreflang.filter((h) => !validHreflang(h.lang)).map((h) => h.lang)
      if (bad.length > 0)
        push('hreflang.invalid_code', `${at}：${[...new Set(bad)].join('、')}`, { url: facts.url })
      if (facts.hreflang.some((h) => h.lang.toLowerCase() === 'x-default')) anyXDefault = true
      const canonical = facts.canonicals[0] ?? facts.url
      const selfEntry = facts.hreflang.find(
        (h) => urlKey(h.href) === urlKey(facts.url) || urlKey(h.href) === urlKey(canonical),
      )
      if (selfEntry === undefined)
        push('hreflang.no_self', `${at}：没有指向自己的那一条`, { url: facts.url })
      else if (selfEntry.href !== canonical)
        push(
          'hreflang.canonical_mismatch',
          `${at}：hreflang 写 ${selfEntry.href}，规范网址是 ${canonical}`,
          { url: facts.url },
        )
      for (const alt of facts.hreflang) {
        if (alt.lang.toLowerCase() === 'x-default') continue
        if (urlKey(alt.href) === urlKey(facts.url)) continue
        const other = byKey.get(urlKey(alt.href))
        if (other === undefined || other.status !== 200) continue
        const back = other.hreflang.some(
          (h) => urlKey(h.href) === urlKey(facts.url) || urlKey(h.href) === urlKey(canonical),
        )
        if (!back)
          push('hreflang.no_return', `${pathOf(alt.href)}（${alt.lang}）没指回 ${at}`, {
            url: alt.href,
          })
      }
    }
    if (withTags.length > 0 && !anyXDefault)
      push('hreflang.no_x_default', '一组 hreflang 里都没有 x-default')
  }

  // ⑥ 结构化数据
  for (const { kind, facts } of input.pages) {
    if (facts.status !== 200) continue
    const at = pathOf(facts.url)
    if (facts.jsonld.broken > 0)
      push('schema.broken_json', `${at}：${String(facts.jsonld.broken)} 块 JSON-LD 读不出`, {
        url: facts.url,
      })
    const types = schemaTypes(facts.jsonld.blocks)
    if (kind === 'product' && !types.some((t) => t === 'Product' || t === 'ProductGroup'))
      push('schema.product_missing', `${at}：结构化数据里只有 ${types.join('、') || '（没有）'}`, {
        url: facts.url,
      })
    for (const e of await schemaErrors(facts.jsonld.blocks))
      push('schema.invalid', `${at}：${e.type} 缺 ${e.fields.join('、')}`, { url: facts.url })
    if (kind === 'article' && types.some((t) => ARTICLE_TYPE.test(t))) {
      const article = facts.jsonld.blocks
        .flatMap((b) => (Array.isArray(b) ? b : [b]))
        .map(rec)
        .flatMap((o) => (Array.isArray(o['@graph']) ? (o['@graph'] as unknown[]).map(rec) : [o]))
        .find((o) => typeof o['@type'] === 'string' && ARTICLE_TYPE.test(o['@type'] as string))
      const missing = ['headline', 'image', 'datePublished'].filter(
        (k) => article !== undefined && (article[k] === undefined || article[k] === ''),
      )
      if (missing.length > 0)
        push('schema.article_recommended', `${at}：Article 没写 ${missing.join('、')}`, {
          url: facts.url,
        })
    }
  }

  // ⑦ 页面速度（真实用户优先；实验室数标「实验室」、降一级）
  let speed: TechAuditResult['speed'] = input.speed_enabled ? 'unavailable' : 'off'
  if (input.speed !== undefined && input.speed.length > 0) {
    const sources = new Set(input.speed.map((s) => s.source))
    speed = sources.size === 2 ? 'mixed' : sources.has('field') ? 'field' : 'lab'
    const lower = (s: 'high' | 'medium' | 'low'): 'high' | 'medium' | 'low' =>
      s === 'high' ? 'medium' : 'low'
    for (const r of input.speed) {
      const at = pathOf(r.url)
      const tag =
        r.source === 'lab'
          ? '（实验室）'
          : r.scope === 'origin'
            ? '（整站真实用户）'
            : '（真实用户）'
      const check = (
        rule: 'speed.lcp' | 'speed.inp' | 'speed.cls' | 'speed.tbt',
        v: number | undefined,
        line: { good: number; poor: number },
        text: (v: number) => string,
      ): void => {
        if (v === undefined || v <= line.good) return
        const base = v > line.poor ? 'high' : TECH_AUDIT_RULES[rule].severity
        push(rule, `${at}：${text(v)}${tag}`, {
          url: r.url,
          measured: r.source,
          severity: r.source === 'lab' ? lower(base) : base,
        })
      }
      check('speed.lcp', r.lcp_ms, CWV_THRESHOLDS.lcp_ms, (v) => `LCP ${(v / 1000).toFixed(1)} 秒`)
      check(
        'speed.inp',
        r.inp_ms,
        CWV_THRESHOLDS.inp_ms,
        (v) => `INP ${String(Math.round(v))} 毫秒`,
      )
      check(
        'speed.cls',
        r.cls,
        CWV_THRESHOLDS.cls,
        (v) => `CLS ${String(Math.round(v * 100) / 100)}`,
      )
      if (r.source === 'lab')
        check(
          'speed.tbt',
          r.tbt_ms,
          CWV_THRESHOLDS.tbt_ms,
          (v) => `TBT ${String(Math.round(v))} 毫秒`,
        )
    }
  }

  const order = { high: 0, medium: 1, low: 2 } as const
  issues.sort((a, b) => order[a.severity] - order[b.severity] || a.rule.localeCompare(b.rule))
  return {
    checked_at: input.checked_at,
    pages: input.pages.length,
    indexing,
    sitemap: sm.state,
    hreflang,
    speed,
    issues,
  }
}

/** 一条技术问题 → 事项里的一行人话。 */
export function techIssueLine(i: TechAuditIssue): string {
  const r = TECH_AUDIT_RULES[i.rule as TechAuditRuleId]
  return `${r?.title.zh ?? i.rule}：${i.detail}${r === undefined ? '' : `。${r.fix.zh}`}`
}

/**
 * 交给建站的那件事的正文（按担哪一条分开）。跳转类单独列一段「可以直接出改跳转卡的清单」（`path → target`）。
 * 只交中 / 高的；低的只留在报表里。
 */
export function techHandoffText(
  issues: readonly TechAuditIssue[],
  owner: TechAuditOwner,
): { text: string; count: number } | undefined {
  const mine = issues.filter((i) => i.owner === owner && i.severity !== 'low')
  if (mine.length === 0) return undefined
  const lines = mine.slice(0, 30).map((i, n) => `${String(n + 1)}. ${techIssueLine(i)}`)
  const redirects = mine.filter((i) => i.redirect !== undefined).slice(0, 20)
  const text = [
    `网站技术体检发现 ${String(mine.length)} 处要改（SEO 与 GEO 技术体检转来，体检只看不改）。请逐条核对后用你的工具出改动卡：`,
    ...lines,
    ...(redirects.length === 0
      ? []
      : [
          '',
          '可以直接出「改跳转」卡的清单（旧路径 → 新路径）：',
          ...redirects.map((i) => `${i.redirect?.path ?? ''} → ${i.redirect?.target ?? ''}`),
        ]),
  ].join('\n')
  return { text, count: mine.length }
}
