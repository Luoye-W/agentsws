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
  AiPlatform,
  SearchDataErrorCode,
  SerpQuery,
} from '@agentsws/contracts'
import { AI_ANSWER_EXCERPT_MAX, AI_PLATFORMS, SEARCH_ENGINES } from '@agentsws/contracts'

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
  const n = name.trim()
  if (n === '') return false
  const hay = text.toLowerCase()
  const needle = n.toLowerCase()
  if (!LATIN.test(n)) return hay.includes(needle)
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, 'u').test(hay)
}

/** 一段回答 + 引用 → 契约那一行。 */
export function judgeAnswer(
  probe: Pick<AiAnswerProbe, 'brand' | 'competitors'>,
  platform: AiPlatform,
  raw: { text: string; cited_urls: readonly string[] },
  meta: { fetched_at: string; source: string },
): AiAnswerResult {
  const cited = uniqueUrls(raw.cited_urls)
  const hosts = cited.map(domainOf)
  const hitsDomain = (domains: readonly string[]): boolean =>
    domains.some((d) => hosts.some((h) => domainMatches(h, d)))
  const textHasDomain = (domains: readonly string[]): boolean =>
    domains.some((d) => d.trim() !== '' && raw.text.toLowerCase().includes(d.trim().toLowerCase()))
  const competitors = (probe.competitors ?? [])
    .filter(
      (c) =>
        mentions(raw.text, c.name) || hitsDomain(c.domains ?? []) || textHasDomain(c.domains ?? []),
    )
    .map((c) => c.name)
  return {
    platform,
    answer_excerpt: excerptOf(raw.text),
    brand_mentioned: mentions(raw.text, probe.brand.name) || textHasDomain(probe.brand.domains),
    our_domain_cited: hitsDomain(probe.brand.domains),
    cited_urls: cited,
    competitors_mentioned: [...new Set(competitors)],
    fetched_at: meta.fetched_at,
    source: meta.source,
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
  const brand = (p.brand ?? {}) as { name?: unknown; domains?: unknown }
  const name = typeof brand.name === 'string' ? brand.name.trim() : ''
  if (name === '')
    throw new SearchDataError('invalid_input', '要写品牌名（用来判断回答里有没有提到你）。')
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : []
  const competitors = Array.isArray(p.competitors)
    ? p.competitors
        .map((c) => c as { name?: unknown; domains?: unknown })
        .filter((c) => typeof c.name === 'string' && c.name.trim() !== '')
        .map((c) => ({ name: (c.name as string).trim(), domains: strings(c.domains) }))
    : undefined
  return {
    question,
    platforms,
    country,
    language,
    brand: { name, domains: strings(brand.domains) },
    ...(competitors === undefined ? {} : { competitors }),
  }
}

/** 从一段文字里抹掉 key（服务商偶尔把请求参数回显进错误信息——防一手）。 */
export function redact(text: string, key: string | undefined): string {
  if (key === undefined || key.length < 4) return text
  return text.split(key).join('***')
}
