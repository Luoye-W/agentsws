/**
 * WP155：服务商无关的那一半——把「一段回答 + 一串引用」判成 `AiAnswerResult`，
 * 以及几个归一化小工具（域名、节选、输入校验）。
 *
 * 纯函数、不联网。三家适配器与官方 / 自带两条路都用这一份，所以同一段回答
 * 不管从哪条路来，「提没提到我们」判出来都一样。
 */
import type {
  AiAnswerProbe,
  AiAnswerResult,
  AiCitation,
  AiCitationWhere,
  AiPlatform,
  CitedSiteKind,
  SearchDataErrorCode,
  SerpQuery,
} from '@agentsws/contracts'
import { AI_ANSWER_EXCERPT_MAX, AI_PLATFORMS, SEARCH_ENGINES } from '@agentsws/contracts'
import type { ProviderCitation } from './provider.js'
import { builtinSiteKind } from './site-kinds.js'

/** 适配器与路由抛的错：`code` 是契约那张码表，`message` 是一句人话（**从不含 key**）。 */
export class SearchDataError extends Error {
  readonly code: SearchDataErrorCode
  constructor(code: SearchDataErrorCode, message: string) {
    super(message)
    this.name = 'SearchDataError'
    this.code = code
  }
}

/** 网址 → 不带 `www.` 的小写主机名；不是网址回空串。 */
export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./u, '')
  } catch {
    return ''
  }
}

/** `a.com` 认 `a.com`、`shop.a.com`；不认 `nota.com`。 */
export function domainMatches(host: string, domain: string): boolean {
  const d = domain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//u, '')
    .replace(/^www\./u, '')
    .replace(/\/.*$/u, '')
  if (d === '' || host === '') return false
  return host === d || host.endsWith(`.${d}`)
}

/** 节选：压空白、截到上限（按字符，不切半个汉字）。 */
export function excerptOf(text: string, max = AI_ANSWER_EXCERPT_MAX): string {
  const flat = text.replace(/\s+/gu, ' ').trim()
  const chars = Array.from(flat)
  return chars.length <= max ? flat : `${chars.slice(0, max - 1).join('')}…`
}

/** 去重并保序；只留 http(s) 网址。 */
export function uniqueUrls(urls: readonly (string | undefined | null)[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const u of urls) {
    if (typeof u !== 'string' || !/^https?:\/\//iu.test(u) || seen.has(u)) continue
    seen.add(u)
    out.push(u)
  }
  return out
}

const LATIN = /^[\p{Script=Latin}\p{N}\s.&'’-]+$/u

/**
 * 一段话里提没提到这个名字。拉丁字母的名字按「词」找（`Anker` 不命中 `Ankerite`），
 * 其余（中文等没有词边界的）按子串找。大小写不敏感。
 */
export function mentions(text: string, name: string): boolean {
  return firstMention(text, name) >= 0
}

/**
 * WP310：这个名字在这段话里**第一次**出现在第几个字符（没出现回 -1）。规则同 {@link mentions}：
 * 拉丁字母按词、其余按子串、大小写不敏感。
 */
export function firstMention(text: string, name: string): number {
  const n = name.trim()
  if (n === '' || text === '') return -1
  if (!LATIN.test(n)) return text.toLowerCase().indexOf(n.toLowerCase())
  const escaped = n.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const m = new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, 'iu').exec(text)
  return m === null ? -1 : m.index + (m[1]?.length ?? 0)
}

/**
 * 一段回答 + 引用 → 契约那一行。
 *
 * WP310：提没提到按 {@link analyzeAnswer} 判（名字 + **别名** + 域名，先删引用标记、屏蔽网址）；
 * 适配器给了全文 / 结构化引用 / 模型 / 取数方式就原样带上（`answer_markdown`、`citations`、
 * `model`、`via`）；只给了 `text + cited_urls` 的老适配器出来的形状与以前一样。
 */
export function judgeAnswer(
  probe: Pick<AiAnswerProbe, 'brand' | 'competitors'>,
  platform: AiPlatform,
  raw: {
    text: string
    cited_urls: readonly string[]
    markdown?: string | undefined
    citations?: readonly ProviderCitation[] | undefined
    model?: string | undefined
    via?: AiAnswerResult['via'] | undefined
  },
  meta: { fetched_at: string; source: string },
): AiAnswerResult {
  const cited = uniqueUrls(raw.cited_urls)
  const hosts = cited.map(domainOf)
  const hitsDomain = (domains: readonly string[]): boolean =>
    domains.some((d) => hosts.some((h) => domainMatches(h, d)))
  const textHasDomain = (domains: readonly string[]): boolean =>
    domains.some((d) => d.trim() !== '' && raw.text.toLowerCase().includes(d.trim().toLowerCase()))
  const structured = raw.citations !== undefined || raw.markdown !== undefined
  const citations = structured ? citationsOf({ citations: raw.citations, cited_urls: cited }) : []
  const found = matchEntities(raw.text, citations, watchEntities(probe))
  const competitors = (probe.competitors ?? [])
    .filter(
      (c, i) =>
        found[i + 1]?.mentioned === true ||
        hitsDomain(c.domains ?? []) ||
        textHasDomain(c.domains ?? []),
    )
    .map((c) => c.name)
  return {
    platform,
    answer_excerpt: excerptOf(raw.text),
    brand_mentioned: found[0]?.mentioned === true || textHasDomain(probe.brand.domains),
    our_domain_cited: hitsDomain(probe.brand.domains),
    cited_urls: cited,
    competitors_mentioned: [...new Set(competitors)],
    fetched_at: meta.fetched_at,
    source: meta.source,
    ...(structured ? { answer_markdown: raw.markdown ?? raw.text, citations } : {}),
    ...(raw.model === undefined ? {} : { model: raw.model }),
    ...(raw.via === undefined ? {} : { via: raw.via }),
  }
}

/** 国家两位字母、语言两到三位字母（`zh-cn` 这类也认，只取前段给服务商）。 */
const COUNTRY = /^[a-z]{2}$/u
const LANGUAGE = /^[a-z]{2,3}(-[a-z0-9]{2,8})?$/u

/** 校验并归一一次 SERP 查询（小写、去空白）；不对就抛 `invalid_input` 人话。 */
export function normalizeSerpQuery(input: unknown): SerpQuery {
  const q = (input ?? {}) as Partial<Record<keyof SerpQuery, unknown>>
  const query = typeof q.query === 'string' ? q.query.trim() : ''
  if (query === '' || query.length > 400)
    throw new SearchDataError('invalid_input', '要查的词是空的或太长了（最多 400 个字）。')
  const engine = typeof q.engine === 'string' ? q.engine.trim().toLowerCase() : ''
  if (!(SEARCH_ENGINES as readonly string[]).includes(engine))
    throw new SearchDataError('invalid_input', `搜索引擎只认 ${SEARCH_ENGINES.join(' / ')}。`)
  const country = typeof q.country === 'string' ? q.country.trim().toLowerCase() : ''
  if (!COUNTRY.test(country))
    throw new SearchDataError('invalid_input', '国家要写两位字母代码，比如 us、gb、de。')
  const language = typeof q.language === 'string' ? q.language.trim().toLowerCase() : ''
  if (!LANGUAGE.test(language))
    throw new SearchDataError('invalid_input', '语言要写语言代码，比如 en、de、zh。')
  const device = q.device === 'mobile' ? 'mobile' : q.device === 'desktop' ? 'desktop' : undefined
  return {
    query,
    engine: engine as SerpQuery['engine'],
    country,
    language,
    ...(device === undefined ? {} : { device }),
  }
}

/** 校验并归一一次 AI 问答探测；平台去重保序。 */
export function normalizeProbe(input: unknown): AiAnswerProbe {
  const p = (input ?? {}) as Partial<Record<keyof AiAnswerProbe, unknown>>
  const question = typeof p.question === 'string' ? p.question.trim() : ''
  if (question === '' || question.length > 1000)
    throw new SearchDataError('invalid_input', '要问的问题是空的或太长了（最多 1000 个字）。')
  const raw = Array.isArray(p.platforms) ? p.platforms : []
  const platforms = [
    ...new Set(
      raw.filter((x): x is AiPlatform => (AI_PLATFORMS as readonly unknown[]).includes(x)),
    ),
  ]
  if (platforms.length === 0)
    throw new SearchDataError('invalid_input', `至少选一个平台：${AI_PLATFORMS.join(' / ')}。`)
  const { country, language } = normalizeSerpQuery({
    query: question,
    engine: 'google',
    country: p.country,
    language: p.language,
  })
  const brand = (p.brand ?? {}) as { name?: unknown; domains?: unknown; aliases?: unknown }
  const name = typeof brand.name === 'string' ? brand.name.trim() : ''
  if (name === '')
    throw new SearchDataError('invalid_input', '要写品牌名（用来判断回答里有没有提到你）。')
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : []
  // WP310：别名只在给了的时候带（老调用方的形状不变）
  const aliasesOf = (v: unknown): { aliases?: string[] } => {
    const a = strings(v).map((x) => x.trim())
    return a.length === 0 ? {} : { aliases: [...new Set(a)] }
  }
  const competitors = Array.isArray(p.competitors)
    ? p.competitors
        .map((c) => c as { name?: unknown; domains?: unknown; aliases?: unknown })
        .filter((c) => typeof c.name === 'string' && c.name.trim() !== '')
        .map((c) => ({
          name: (c.name as string).trim(),
          domains: strings(c.domains),
          ...aliasesOf(c.aliases),
        }))
    : undefined
  return {
    question,
    platforms,
    country,
    language,
    brand: { name, domains: strings(brand.domains), ...aliasesOf(brand.aliases) },
    ...(competitors === undefined ? {} : { competitors }),
  }
}

/** 从一段文字里抹掉 key（服务商偶尔把请求参数回显进错误信息——防一手）。 */
export function redact(text: string, key: string | undefined): string {
  if (key === undefined || key.length < 4) return text
  return text.split(key).join('***')
}

/* ------------------------------------------------------------------ */
/* WP310（docs/99 §5.3 / §5.5）：别名、首次出现位置、网址归一、引用归类   */
/* ------------------------------------------------------------------ */

/**
 * 匹配规则的版本：存进每一条 `geo_mentions`。规则改了（加别名、改边界）就加一，
 * 历史原文可以按新规则重算，旧判定一眼认得出是哪一版算的。
 */
export const GEO_RULES_VERSION = 1

/** 跟踪参数：去掉之后才算「同一页」。 */
const TRACKING_PARAM =
  /^(utm_[a-z0-9_]+|gclid|gclsrc|dclid|gbraid|wbraid|fbclid|msclkid|yclid|twclid|ttclid|mc_cid|mc_eid|igshid|srsltid|_ga|_gl|_hsenc|_hsmi|ref|ref_src|spm|si)$/iu

/**
 * 网址归一（`url_norm`）：去跟踪参数（utm / gclid / fbclid…）、去 `www.`、去尾斜杠、去 `#…`，
 * 主机名小写、协议统一成 https、剩下的参数按名字排序。不是 http(s) 网址原样回。
 */
export function normalizeUrl(url: string): string {
  const raw = url.trim()
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return raw
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return raw
  const host = u.hostname.toLowerCase().replace(/^www\./u, '')
  const params = [...u.searchParams.entries()]
    .filter(([k]) => !TRACKING_PARAM.test(k))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const query = params.length === 0 ? '' : `?${new URLSearchParams(params).toString()}`
  const port = u.port === '' ? '' : `:${u.port}`
  return `https://${host}${port}${u.pathname.replace(/\/+$/u, '')}${query}`
}

const WHERE_RANK: Record<AiCitationWhere, number> = { inline: 0, listed: 1, searched: 2 }

/**
 * 适配器给的引用 → 契约的 `citations[]`：只留 http(s)、按归一后的网址去重（同一页记第一次出现的
 * 位置；出现在正文里的算 `inline`，比「只列在来源里」「只在搜索结果里」都强）、1 起编号。
 * 适配器没给结构化引用时，拿 `cited_urls` 当「列在来源里」。
 */
export function citationsOf(raw: {
  citations?: readonly ProviderCitation[] | undefined
  cited_urls: readonly string[]
}): AiCitation[] {
  const src: readonly ProviderCitation[] =
    raw.citations ?? raw.cited_urls.map((url) => ({ url, where: 'listed' as const }))
  const out: AiCitation[] = []
  const byNorm = new Map<string, AiCitation>()
  for (const c of src) {
    const url = c.url.trim()
    if (!/^https?:\/\//iu.test(url)) continue
    const key = normalizeUrl(url)
    const seen = byNorm.get(key)
    if (seen !== undefined) {
      if (WHERE_RANK[c.where] < WHERE_RANK[seen.where]) seen.where = c.where
      if (seen.title === undefined && c.title !== undefined && c.title.trim() !== '')
        seen.title = c.title.trim()
      if (seen.snippet === undefined && c.snippet !== undefined && c.snippet.trim() !== '')
        seen.snippet = c.snippet.trim()
      continue
    }
    const title = c.title?.trim()
    const snippet = c.snippet?.trim()
    const cit: AiCitation = {
      position: out.length + 1,
      url,
      domain: domainOf(url),
      ...(title === undefined || title === '' ? {} : { title }),
      ...(snippet === undefined || snippet === '' ? {} : { snippet }),
      where: c.where,
    }
    out.push(cit)
    byNorm.set(key, cit)
  }
  return out
}

/**
 * 判「提没提到」之前先整理正文：删引用标记（`[1]`、`[1, 2]`、`[^3]`、`【1】`），再把网址与邮箱
 * **换成等长空格**（网址里出现品牌名不算「提到」——那是引用；等长是为了位置不乱）。
 */
export function prepareAnswerText(text: string): string {
  return text
    .replace(/\[\^?\d+(?:\s*[,，]\s*\^?\d+)*\]|【\d+(?:\s*[,，]\s*\d+)*】/gu, '')
    .replace(/https?:\/\/[^\s)\]>"'<]+|[\w.+-]+@[\w-]+(?:\.[\w-]+)+/giu, (m) =>
      ' '.repeat(m.length),
    )
}

/** 正文里第一次出现这个域名（含子域名，不认 `notvoltbrick.com`）的位置；没有回 -1。 */
export function firstDomainMention(text: string, domain: string): number {
  const d = domain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//u, '')
    .replace(/^www\./u, '')
    .replace(/\/.*$/u, '')
  if (d === '' || !d.includes('.')) return -1
  const escaped = d.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const m = new RegExp(`(^|[^\\p{L}\\p{N}-])${escaped}(?=$|[^\\p{L}\\p{N}-])`, 'iu').exec(text)
  return m === null ? -1 : m.index + (m[1]?.length ?? 0)
}

/** 一个要在回答里找的品牌（我们 = `ours`，竞品 = 它的 id）。 */
export interface WatchEntity {
  entity: string
  name: string
  aliases?: readonly string[] | undefined
  domains?: readonly string[] | undefined
}

/** 一个品牌在一条回答里的判定（`GeoMentionRecord` 去掉 `answer_id` / 情感那几格）。 */
export interface EntityMatch {
  entity: string
  name_snapshot: string
  alias_hit?: string
  mentioned: boolean
  cited: boolean
  first_offset?: number
  rank?: number
}

/** 关注设置 / 探测参数 → 要找的品牌（我们排第一个；竞品没 id 时按顺序编 `c1`、`c2`…）。 */
export function watchEntities(watch: {
  brand: { name: string; domains: readonly string[]; aliases?: readonly string[] | undefined }
  competitors?:
    | readonly {
        id?: string | undefined
        name: string
        domains?: readonly string[] | undefined
        aliases?: readonly string[] | undefined
      }[]
    | undefined
}): WatchEntity[] {
  return [
    {
      entity: 'ours',
      name: watch.brand.name,
      aliases: watch.brand.aliases,
      domains: watch.brand.domains,
    },
    ...(watch.competitors ?? []).map((c, i) => ({
      entity: c.id ?? `c${i + 1}`,
      name: c.name,
      aliases: c.aliases,
      domains: c.domains,
    })),
  ]
}

/**
 * 每个品牌：提没提到（名字 / 别名 / 域名，取最早的那一处）、被没被引用（`inline` / `listed` 的引用里
 * 有它的域名；只在搜索结果里的不算）、第一次出现在哪；提到了的按先后排名次（只在已知品牌里排，
 * 借 open-seo）。数不经模型手。
 */
export function matchEntities(
  text: string,
  citations: readonly AiCitation[],
  entities: readonly WatchEntity[],
): EntityMatch[] {
  const body = prepareAnswerText(text)
  const used = citations.filter((c) => c.where !== 'searched')
  const rows: EntityMatch[] = entities.map((e) => {
    let best = -1
    let hit: string | undefined
    const take = (offset: number, what: string): void => {
      if (offset >= 0 && (best < 0 || offset < best)) {
        best = offset
        hit = what
      }
    }
    for (const n of [e.name, ...(e.aliases ?? [])]) take(firstMention(body, n), n.trim())
    for (const d of e.domains ?? []) take(firstDomainMention(body, d), d.trim())
    const cited = (e.domains ?? []).some((d) => used.some((c) => domainMatches(c.domain, d)))
    return {
      entity: e.entity,
      name_snapshot: e.name,
      ...(hit === undefined ? {} : { alias_hit: hit }),
      mentioned: best >= 0,
      cited,
      ...(best < 0 ? {} : { first_offset: best }),
    }
  })
  const order = rows
    .map((r, i) => ({ r, i }))
    .filter((x) => x.r.first_offset !== undefined)
    .sort((a, b) => (a.r.first_offset ?? 0) - (b.r.first_offset ?? 0) || a.i - b.i)
  order.forEach((x, n) => {
    x.r.rank = n + 1
  })
  return rows
}

/**
 * 被引用的站是哪类：我们的域名 → `ours`；竞品的 → `competitor`；人改过 / 模型判过的缓存
 * （`known`，O2 的 `domain_kinds`）；内置表；都认不出 → `other`。
 */
export function siteKindOf(
  host: string,
  ctx: {
    ours: readonly string[]
    competitors?: readonly string[] | undefined
    known?: ((host: string) => CitedSiteKind | undefined) | undefined
  },
): CitedSiteKind {
  if (ctx.ours.some((d) => domainMatches(host, d))) return 'ours'
  if ((ctx.competitors ?? []).some((d) => domainMatches(host, d))) return 'competitor'
  return ctx.known?.(host) ?? builtinSiteKind(host) ?? 'other'
}

/** 一条引用 + 归一网址 + 站的类型（`GeoCitationRecord` 去掉 `answer_id`）。 */
export type ClassifiedCitation = AiCitation & { url_norm: string; site_kind: CitedSiteKind }

/** {@link analyzeAnswer} 的结果：存进历史表的那几格都在这里。 */
export interface AnswerAnalysis {
  citations: ClassifiedCitation[]
  /** 第一个是我们，其后是竞品（与关注设置里的顺序一致）。 */
  mentions: EntityMatch[]
  rules_version: number
}

/**
 * 一条回答全文 + 引用 → 引用归类与每个品牌的判定（docs/99 §5.3 的规则判那几格）。
 * 纯函数：历史原文可以随时按新的关注设置重算。
 */
export function analyzeAnswer(
  watch: Parameters<typeof watchEntities>[0],
  answer: {
    text: string
    citations?: readonly ProviderCitation[] | readonly AiCitation[] | undefined
    cited_urls?: readonly string[] | undefined
  },
  known?: (host: string) => CitedSiteKind | undefined,
): AnswerAnalysis {
  const base = citationsOf({ citations: answer.citations, cited_urls: answer.cited_urls ?? [] })
  const competitorDomains = (watch.competitors ?? []).flatMap((c) => c.domains ?? [])
  const citations = base.map((c) => ({
    ...c,
    url_norm: normalizeUrl(c.url),
    site_kind: siteKindOf(c.domain, {
      ours: watch.brand.domains,
      competitors: competitorDomains,
      known,
    }),
  }))
  return {
    citations,
    mentions: matchEntities(answer.text, base, watchEntities(watch)),
    rules_version: GEO_RULES_VERSION,
  }
}
