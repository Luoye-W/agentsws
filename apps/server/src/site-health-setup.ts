/**
 * WP385（决策 1076 → 690）：网站体检的设置**在对话里完成**——配置卡的设置目标 `site.health`。
 *
 * 用户在网站运营 / 内容与搜索的对话里说一句（「我们的 Google 商品 feed 是 …」「Amazon 上架页是 …」
 * 「别查 GPTBot 了」），AI 调通用的 `request_setup`（`setting: site.health` + 建议值）→ 一张「我打算改成这样」的卡
 * （只列要改的几格）→ 人点头 → 这里存好、**接着在后台体检一次**，原来那件事按原话接着做。
 *
 * 这个目标没有「缺」：feed、上架页、清单加减都是可选的，所以 `satisfied()` 恒为真——卡只在 AI 带了新值时出，
 * 而且只出真会变的那几格（{@link SetupTarget.pending} 去掉已经生效的）。
 *
 * 格子都是「一行一条」的人话写法，多条用 `;` 隔开（卡上的输入框是单行），一条里的几栏用 `|` 隔开。
 */
import type { AiCrawler, AiReferrer, SetupField, SiteHealthSettings } from '@agentsws/contracts'
import { DEFAULT_AI_REFERRERS, effectiveReferrers } from '@agentsws/seo-core'
import { DEFAULT_AI_CRAWLERS, effectiveCrawlers } from '@agentsws/site-core'
import { SITE_HEALTH_SETUP_TARGET } from '@agentsws/stand-ins'
import { SetupCardError, type SetupTarget } from './setup-cards.js'
import type { SiteHealthService } from './site-health.js'

export { SITE_HEALTH_SETUP_TARGET }

export interface SiteHealthSetupOptions {
  service(): SiteHealthService
  /** 存好之后重新体检一次（后台跑，不等）。 */
  rerun?(): void
}

/** 卡上那几格的键（与 `query_site_health` 描述里给模型的一致）。 */
export const SITE_HEALTH_FIELD_KEYS = [
  'feed_url',
  'listings_add',
  'listings_remove',
  'crawlers_add',
  'crawlers_remove',
  'referrers_add',
  'referrers_remove',
] as const

const MAX_LISTINGS = 50
const MAX_LIST = 50
/** 说「不要了」的几种写法（清掉 feed 地址）。 */
const CLEAR = /^(?:无|没有|不要了?|清空|删掉|none|-|—)$/i
const HANDLE = /^[a-z0-9][a-z0-9-]{0,199}$/
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{1,79}$/
const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/

const entries = (v: string | undefined): string[] =>
  (v ?? '')
    .split(/[\n;；]+/u)
    .map((x) => x.trim())
    .filter((x) => x !== '')
const names = (v: string | undefined): string[] =>
  (v ?? '')
    .split(/[\n;；,，、]+/u)
    .map((x) => x.trim())
    .filter((x) => x !== '')
const cols = (line: string): string[] => line.split(/\s*[|｜]\s*/u).map((x) => x.trim())

function httpUrl(v: string): string | undefined {
  try {
    const u = new URL(v.trim())
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : undefined
  } catch {
    return undefined
  }
}
const sameUrl = (a: string, b: string): boolean =>
  (httpUrl(a) ?? a).replace(/\/+$/, '').toLowerCase() ===
  (httpUrl(b) ?? b).replace(/\/+$/, '').toLowerCase()

/** 「Amazon | power-bank-20000 | https://…」→ 一条上架页；写不全回一句人话。 */
export function parseListing(line: string): SiteHealthListing | string {
  const parts = cols(line)
  const urlAt = parts.findIndex((p) => httpUrl(p) !== undefined && !/\/products\//i.test(p))
  const at = urlAt >= 0 ? urlAt : parts.findIndex((p) => httpUrl(p) !== undefined)
  const url = at >= 0 ? httpUrl(parts[at] ?? '') : undefined
  if (url === undefined) return `「${line}」里没有上架页网址。`
  const rest = parts.filter((_, i) => i !== at)
  const platform = rest[0]?.trim() ?? ''
  if (platform === '' || platform.length > 60) return `「${line}」要写是哪个平台（如 Amazon）。`
  const raw = rest[1]?.trim() ?? ''
  const handle = (/\/products\/([a-z0-9-]+)/i.exec(raw)?.[1] ?? raw).toLowerCase()
  if (!HANDLE.test(handle)) return `「${line}」要写是哪件商品：店里商品网址 /products/ 后面那一段。`
  return { platform, handle, url }
}

type SiteHealthListing = NonNullable<SiteHealthSettings['listings']>[number]

const PURPOSES: readonly [RegExp, AiCrawler['purpose']][] = [
  [/^(?:search|搜索|ai\s*搜索)$/i, 'search'],
  [/^(?:user|替用户打开|打开|用户)$/i, 'user'],
  [/^(?:training|train|训练)$/i, 'training'],
]

/** 「Bytespider | training」→ 一个爬虫（用途不写按 AI 搜索；哪家不写就用 UA 名）。 */
export function parseCrawler(line: string): AiCrawler | string {
  const [token = '', purposeRaw = '', vendorRaw = ''] = cols(line)
  if (!TOKEN.test(token)) return `「${line}」开头要是爬虫的 UA 名（如 PerplexityBot）。`
  const purpose =
    purposeRaw === '' ? 'search' : PURPOSES.find(([re]) => re.test(purposeRaw.trim()))?.[1]
  if (purpose === undefined) return `「${line}」的用途写 search、user 或 training。`
  const vendor = vendorRaw === '' ? token : vendorRaw.slice(0, 80)
  return { token, vendor, purpose }
}

/** 「Kimi | kimi.com, kimi.moonshot.cn」→ 一个 AI 来源。 */
export function parseReferrer(line: string): AiReferrer | string {
  const [platform = '', hostsRaw = ''] = cols(line)
  if (platform === '' || platform.length > 80) return `「${line}」要写是哪个 AI（如 Kimi）。`
  const hosts = names(hostsRaw.replace(/\s+/g, ','))
    .map((h) => {
      try {
        return new URL(/^[a-z]+:\/\//i.test(h) ? h : `https://${h}`).hostname.toLowerCase()
      } catch {
        return ''
      }
    })
    .filter((h) => HOST.test(h))
  if (hosts.length === 0) return `「${line}」要写来源域名（如 kimi.com）。`
  return { platform, hosts: [...new Set(hosts)].slice(0, 10) }
}

const lower = (s: string): string => s.trim().toLowerCase()

export function siteHealthSetupTarget(options: SiteHealthSetupOptions): SetupTarget {
  const settings = (): SiteHealthSettings => options.service().settings()

  /** 一条建议里还没生效的那几行（已经是这样的去掉；写不对的留着，存的时候说哪里不对）。 */
  const pendingOf = (key: string, value: string, now: SiteHealthSettings): string => {
    const listings = now.listings ?? []
    const crawlers = effectiveCrawlers(now).map((c) => lower(c.token))
    const referrers = effectiveReferrers(now).map((r) => lower(r.platform))
    switch (key) {
      case 'feed_url': {
        const v = value.trim()
        if (CLEAR.test(v)) return now.feed_url === undefined ? '' : v
        return now.feed_url !== undefined && sameUrl(v, now.feed_url) ? '' : v
      }
      case 'listings_add':
        return entries(value)
          .filter((line) => {
            const l = parseListing(line)
            return (
              typeof l === 'string' ||
              !listings.some((x) => sameUrl(x.url, l.url) && x.handle === l.handle)
            )
          })
          .join('; ')
      case 'listings_remove':
        return entries(value)
          .filter((v) => listings.some((x) => sameUrl(x.url, v) || lower(x.platform) === lower(v)))
          .join('; ')
      case 'crawlers_add':
        return entries(value)
          .filter((line) => {
            const c = parseCrawler(line)
            return typeof c === 'string' || !crawlers.includes(lower(c.token))
          })
          .join('; ')
      case 'crawlers_remove':
        return names(value)
          .filter((t) => crawlers.includes(lower(t)))
          .join(', ')
      case 'referrers_add':
        return entries(value)
          .filter((line) => {
            const r = parseReferrer(line)
            if (typeof r === 'string') return true
            const have = effectiveReferrers(now).find(
              (x) => lower(x.platform) === lower(r.platform),
            )
            return have === undefined || r.hosts.some((h) => !have.hosts.includes(h))
          })
          .join('; ')
      case 'referrers_remove':
        return names(value)
          .filter((p) => referrers.includes(lower(p)))
          .join(', ')
      default:
        return ''
    }
  }

  return {
    id: SITE_HEALTH_SETUP_TARGET,
    name: '网站体检设置',
    why: '体检照这些去比：商品 feed、其他平台上架页、AI 爬虫与 AI 来源清单。',
    async fields(): Promise<SetupField[]> {
      const now = settings()
      const text = (key: string, label: string, placeholder: string): SetupField => ({
        key,
        label,
        kind: 'text',
        placeholder,
        required: false,
      })
      return [
        {
          key: 'feed_url',
          label: '商品 feed',
          kind: 'url',
          placeholder: 'https://…/feed.xml',
          ...(now.feed_url === undefined ? {} : { suggested: now.feed_url }),
          required: false,
        },
        text('listings_add', '加上架页', '平台 | 商品 handle | 网址'),
        text('listings_remove', '去掉上架页', '网址或平台'),
        text('crawlers_add', '加 AI 爬虫', 'UA 名 | search / user / training'),
        text('crawlers_remove', '不查的爬虫', 'UA 名'),
        text('referrers_add', '加 AI 来源', '平台 | 来源域名'),
        text('referrers_remove', '不算的来源', '平台名'),
      ]
    },
    // 都是可选的：没有「缺」。卡只在 AI 带了新值时出（「我打算改成这样」）
    satisfied: async () => true,
    async pending(suggestions) {
      const now = settings()
      const out: Record<string, string> = {}
      for (const [k, v] of Object.entries(suggestions)) {
        const left = pendingOf(k, v, now)
        if (left !== '') out[k] = left
      }
      return out
    },
    async apply(values): Promise<void> {
      const now = settings()
      const next: SiteHealthSettings = {
        ...now,
        listings: [...(now.listings ?? [])],
        crawlers_add: [...(now.crawlers_add ?? [])],
        crawlers_remove: [...(now.crawlers_remove ?? [])],
        referrers_add: [...(now.referrers_add ?? [])],
        referrers_remove: [...(now.referrers_remove ?? [])],
      }
      const fail = (why: string): never => {
        throw new SetupCardError('invalid_input', why)
      }
      // 商品 feed：一个网址；说「不要了」就清掉
      const feed = values.feed_url?.trim()
      if (feed !== undefined && feed !== '') {
        if (CLEAR.test(feed)) delete next.feed_url
        else next.feed_url = httpUrl(feed) ?? fail('商品 feed 要是 http / https 网址。')
      }
      // 上架页：同一个网址只留一条（后写的为准）
      for (const line of entries(values.listings_add)) {
        const l = parseListing(line)
        if (typeof l === 'string') return fail(l)
        next.listings = [...(next.listings ?? []).filter((x) => !sameUrl(x.url, l.url)), l]
      }
      for (const v of entries(values.listings_remove))
        next.listings = (next.listings ?? []).filter(
          (x) => !sameUrl(x.url, v) && lower(x.platform) !== lower(v),
        )
      if ((next.listings ?? []).length > MAX_LISTINGS)
        fail(`上架页最多 ${String(MAX_LISTINGS)} 条。`)
      // AI 爬虫：默认清单里有的，「加」= 不再减掉；没有的才记进加的那张
      for (const line of entries(values.crawlers_add)) {
        const c = parseCrawler(line)
        if (typeof c === 'string') return fail(c)
        next.crawlers_remove = (next.crawlers_remove ?? []).filter(
          (t) => lower(t) !== lower(c.token),
        )
        if (!DEFAULT_AI_CRAWLERS.some((d) => lower(d.token) === lower(c.token)))
          next.crawlers_add = [
            ...(next.crawlers_add ?? []).filter((x) => lower(x.token) !== lower(c.token)),
            c,
          ]
      }
      for (const t of names(values.crawlers_remove)) {
        next.crawlers_add = (next.crawlers_add ?? []).filter((x) => lower(x.token) !== lower(t))
        if (
          DEFAULT_AI_CRAWLERS.some((d) => lower(d.token) === lower(t)) &&
          !(next.crawlers_remove ?? []).some((x) => lower(x) === lower(t))
        )
          next.crawlers_remove = [...(next.crawlers_remove ?? []), t]
      }
      // AI 来源：同上
      for (const line of entries(values.referrers_add)) {
        const r = parseReferrer(line)
        if (typeof r === 'string') return fail(r)
        next.referrers_remove = (next.referrers_remove ?? []).filter(
          (p) => lower(p) !== lower(r.platform),
        )
        const base = DEFAULT_AI_REFERRERS.find((d) => lower(d.platform) === lower(r.platform))
        const merged =
          base === undefined
            ? r
            : { ...base, hosts: [...new Set([...base.hosts, ...r.hosts])].slice(0, 10) }
        if (base === undefined || merged.hosts.length > base.hosts.length)
          next.referrers_add = [
            ...(next.referrers_add ?? []).filter((x) => lower(x.platform) !== lower(r.platform)),
            merged,
          ]
      }
      for (const p of names(values.referrers_remove)) {
        next.referrers_add = (next.referrers_add ?? []).filter(
          (x) => lower(x.platform) !== lower(p),
        )
        if (
          DEFAULT_AI_REFERRERS.some((d) => lower(d.platform) === lower(p)) &&
          !(next.referrers_remove ?? []).some((x) => lower(x) === lower(p))
        )
          next.referrers_remove = [...(next.referrers_remove ?? []), p]
      }
      for (const k of [
        'crawlers_add',
        'crawlers_remove',
        'referrers_add',
        'referrers_remove',
      ] as const)
        if ((next[k] ?? []).length > MAX_LIST) fail('清单加减太多了，一次少改几条。')
      // 空的那几张不落（契约是 exactOptional）
      const clean: SiteHealthSettings = { ...next }
      for (const k of [
        'listings',
        'crawlers_add',
        'crawlers_remove',
        'referrers_add',
        'referrers_remove',
      ] as const)
        if ((clean[k] ?? []).length === 0) delete clean[k]
      options.service().saveSettings(clean)
      try {
        options.rerun?.()
      } catch {
        // 体检没排上：设置已经存好，下周一照样按新的跑
      }
    },
  }
}
