/**
 * WP166：从官网推「这个品牌卖到哪些国家」（Luoye 09-27：初始化时我们自己判断，设好、让用户知道，
 * 用户可以增删改）。
 *
 * 看的是站上**自己写明**的那几样，一样一条出处：
 *
 * | 信号 | 在哪 | 出处 `locator` |
 * |---|---|---|
 * | Shopify Markets 的国家 / 地区切换 | 首页的 `/localization` 表单、`name="country_code"` 的下拉 | `shopify:localization` |
 * | 语言版本 | `<link hreflang="en-gb">`、同站的 `/en-gb/` 子目录 | `hreflang` / `path:locale` |
 * | 国家顶级域名 | `.co.uk` / `.de` / `.com.au`… | `tld` |
 * | 配送政策 | `/policies/shipping-policy` 里写 ship / deliver 的那几句提到的国家 | `policy:shipping` |
 * | 「Ships to …」 | 首页 / 商品页上的那一句 | `text:ships-to` |
 * | 结账币种 | 商品价的币种（只认一国一币的：GBP → 英国；EUR 认不出是哪国，不猜） | `currency` |
 *
 * 纪律：**推不出就空着**（界面说「没看出来，请选一下」）；币种最弱，只在别的信号一个都没有时才用，
 * 而且把握度是 `low`（界面标「请确认」）。国家切换一口气列了几十上百个国家的（「卖全世界」），
 * 那一条不算——那不是目标市场，是没设限。
 */
import type { BrandIntakeEvidence, BrandIntakeField } from '@agentsws/contracts'
import { MARKET_COUNTRY_CODES, normalizeMarkets } from '@agentsws/contracts'
import { MAX_QUOTE_CHARS } from './field.js'
import { absolute, hrefs, visibleText } from './html.js'

/** 国家切换里列出的国家超过这个数，就当"卖全世界"，这一条不算目标市场。 */
export const MARKET_SELECTOR_MAX = 25

/** 一国一币（币种 → 国家）。欧元、美元以外的多国货币不在表里：认不出是哪国，不猜。 */
const SINGLE_COUNTRY_CURRENCY: Readonly<Record<string, string>> = {
  USD: 'US',
  GBP: 'GB',
  CAD: 'CA',
  AUD: 'AU',
  JPY: 'JP',
  CNY: 'CN',
  NZD: 'NZ',
  SGD: 'SG',
  HKD: 'HK',
  CHF: 'CH',
  SEK: 'SE',
  NOK: 'NO',
  DKK: 'DK',
  KRW: 'KR',
  MXN: 'MX',
  BRL: 'BR',
  INR: 'IN',
  PLN: 'PL',
  AED: 'AE',
  SAR: 'SA',
  TWD: 'TW',
}

/**
 * 国家顶级域名里被当通用域名用的那些（`.io` / `.co` / `.ai`…）——它们说明不了卖到哪。
 * `.eu` 不是一个国家，也不算。
 */
const GENERIC_CCTLDS = new Set([
  'io',
  'co',
  'ai',
  'me',
  'tv',
  'cc',
  'ly',
  'fm',
  'am',
  'gg',
  'so',
  'to',
  'sh',
  'ws',
  'la',
  'vc',
  'sc',
  'st',
  'is',
  'it', // 常被拿来拼词（get.it）；真在意大利卖的站多半还有 hreflang / 配送政策
  'us', // .us 很少见，而且美国站几乎都用 .com；留给别的信号
])

/** 英文里的别称（国名本身由 `Intl.DisplayNames` 现取）。大小写敏感的缩写单独列。 */
const ALIASES: readonly [RegExp, string][] = [
  [/\b(?:U\.S\.A?\.?|USA|US)(?![A-Za-z])/, 'US'],
  [/\bUnited States(?: of America)?\b/i, 'US'],
  [/\b(?:U\.K\.|UK)(?![A-Za-z])/, 'GB'],
  [/\b(?:Great Britain|Britain|England|Scotland|Wales|Northern Ireland)\b/i, 'GB'],
  [/\bSouth Korea\b/i, 'KR'],
  [/\bUAE\b/, 'AE'],
  [/\bHolland\b/i, 'NL'],
  // 中文里的简称（`Intl` 给的是「中国香港特别行政区」这种全称）；「国内 / 全国 / 大陆」在中文站上就是中国
  [/香港/, 'HK'],
  [/澳门/, 'MO'],
  [/国内|全国|中国大陆|内地/, 'CN'],
]

/** 国名 → 国家码（英文与简体中文两套，第一次用时现算）。 */
let NAME_TABLE: { re: RegExp; code: string }[] | undefined
function nameTable(): { re: RegExp; code: string }[] {
  if (NAME_TABLE !== undefined) return NAME_TABLE
  const out: { re: RegExp; code: string }[] = []
  const names = (locale: string) => {
    try {
      return new Intl.DisplayNames([locale], { type: 'region' })
    } catch {
      return undefined
    }
  }
  const en = names('en')
  const zh = names('zh-CN')
  for (const code of MARKET_COUNTRY_CODES) {
    const e = en?.of(code)
    // 太短或带括号的（"Congo (DRC)"）照样能匹配主干；两个字以下的英文名不认（误伤太多）
    if (e !== undefined && e !== code && e.length > 3) {
      const stem = e.replace(/\s*\(.*\)$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      out.push({ re: new RegExp(`\\b${stem}\\b`, 'i'), code })
    }
    const z = zh?.of(code)
    if (z !== undefined && z !== code && z.length >= 2)
      out.push({ re: new RegExp(z.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), code })
  }
  NAME_TABLE = out
  return out
}

/** 一段文字里提到了哪些国家（按国名、别称），按在文字里出现的先后排。 */
export function countriesIn(text: string): string[] {
  const at = new Map<string, number>()
  const note = (re: RegExp, code: string): void => {
    const i = text.search(re)
    if (i >= 0 && (at.get(code) ?? Number.POSITIVE_INFINITY) > i) at.set(code, i)
  }
  for (const [re, code] of ALIASES) note(re, code)
  for (const { re, code } of nameTable()) note(re, code)
  return [...at.entries()].sort((a, b) => a[1] - b[1]).map(([code]) => code)
}

/** 把一段话切成句子（中文句号 / 分号后面不带空格，英文句号后面带空格；换行也算）。 */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[。！？；])|(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s !== '')
}

const SHIP_WORDS =
  /\b(ship|ships|shipping|deliver|delivers|delivery)\b|配送|发货|寄送|送达|发往|只发|发到|寄往|寄到|送往|邮寄|快递|顺丰|包邮/i
/** 否定句（"We do not ship to …"）里的国家不是市场。 */
const NOT_SHIP =
  /\b(do not|don't|does not|doesn't|cannot|can't|no longer|unable to)\b|不(?:配送|发货|寄|发)|暂不|无法/i

/** 配送政策 / 「Ships to …」那几句里提到的国家（否定句里的不算）。 */
export function shippingCountries(text: string): { codes: string[]; quote?: string } {
  const codes: string[] = []
  let quote: string | undefined
  for (const s of sentences(text)) {
    if (!SHIP_WORDS.test(s) || NOT_SHIP.test(s)) continue
    const found = countriesIn(s)
    if (found.length === 0) continue
    for (const c of found) if (!codes.includes(c)) codes.push(c)
    quote ??= s
  }
  return quote === undefined ? { codes } : { codes, quote }
}

/** Shopify Markets 的国家切换（`/localization` 表单或 `name="country_code"` 的下拉）。 */
export function localizationCountries(html: string): string[] {
  const blocks: string[] = []
  const form = /<form[^>]*action=["'][^"']*\/localization["'][^>]*>([\s\S]*?)<\/form>/gi
  for (const m of html.matchAll(form)) blocks.push(m[1] ?? '')
  const select = /<select[^>]*name=["']country_code["'][^>]*>([\s\S]*?)<\/select>/gi
  for (const m of html.matchAll(select)) blocks.push(m[1] ?? '')
  const codes: string[] = []
  for (const b of blocks) {
    for (const m of b.matchAll(/(?:data-value|value)=["']([A-Za-z]{2})["']/g)) {
      const cc = normalizeMarkets([m[1] ?? ''])[0]
      if (cc !== undefined && !codes.includes(cc)) codes.push(cc)
    }
  }
  return codes
}

/** `<link rel="alternate" hreflang="en-gb">` 与同站 `/en-gb/` 子目录里的国家（只认带地区的）。 */
export function hreflangCountries(
  html: string,
  base: string,
): { codes: string[]; locator: string; quote?: string } {
  const codes: string[] = []
  let quote: string | undefined
  let locator = 'hreflang'
  for (const m of html.matchAll(/<link\b[^>]*hreflang=["']([^"']+)["'][^>]*>/gi)) {
    const tag = m[1] ?? ''
    const region = /^[a-z]{2,3}[-_]([a-z]{2})$/i.exec(tag)?.[1]
    const cc = region === undefined ? undefined : normalizeMarkets([region])[0]
    if (cc === undefined) continue
    if (!codes.includes(cc)) codes.push(cc)
    quote ??= m[0]
  }
  if (codes.length > 0) return quote === undefined ? { codes, locator } : { codes, locator, quote }
  let origin: string
  try {
    origin = new URL(base).origin
  } catch {
    return { codes, locator }
  }
  for (const href of hrefs(html)) {
    const abs = absolute(href, base)
    if (abs === undefined) continue
    const u = new URL(abs)
    if (u.origin !== origin) continue
    const region = /^\/[a-z]{2}-([a-z]{2})(?:\/|$)/i.exec(u.pathname)?.[1]
    const cc = region === undefined ? undefined : normalizeMarkets([region])[0]
    if (cc === undefined) continue
    if (!codes.includes(cc)) codes.push(cc)
    quote ??= u.pathname
    locator = 'path:locale'
  }
  return quote === undefined ? { codes, locator } : { codes, locator, quote }
}

/** 国家顶级域名（`.co.uk` → 英国；通用的 `.io` / `.co` 之类不算）。 */
export function tldCountry(url: string): string | undefined {
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return undefined
  }
  const tld = host.split('.').pop() ?? ''
  if (tld.length !== 2 || GENERIC_CCTLDS.has(tld)) return undefined
  return normalizeMarkets([tld])[0]
}

export interface MarketInputs {
  /** 官网入口（国家域名看它）。 */
  entryUrl: string
  /** 首页 HTML（国家切换、hreflang、「Ships to …」看它）。 */
  home?: string
  /** 配送政策正文（去过标签的）与它的网址。 */
  shipping?: { url: string; text: string }
  /** 商品页的正文（「Ships to …」）。 */
  products?: { url: string; html: string }[]
  /** 结账币种（商品价上的）与出处网址。 */
  currency?: { code: string; url: string }
}

const clip = (s: string): string => s.replace(/\s+/g, ' ').trim().slice(0, MAX_QUOTE_CHARS)

/**
 * 推一份目标市场。推不出回 `undefined`（格子不出现，界面说「没看出来，请选一下」）。
 *
 * 排序：被越多条信号提到的越靠前，一样多的按先看到的；每条信号一条出处。
 */
export function inferMarkets(input: MarketInputs): BrandIntakeField<string[]> | undefined {
  const votes = new Map<string, number>()
  const evidence: BrandIntakeEvidence[] = []
  const add = (codes: readonly string[], ev: BrandIntakeEvidence): void => {
    if (codes.length === 0) return
    for (const c of codes) votes.set(c, (votes.get(c) ?? 0) + 1)
    evidence.push(ev)
  }
  const home = input.home ?? ''
  const entry = input.entryUrl

  const selector = localizationCountries(home)
  if (selector.length > 0 && selector.length <= MARKET_SELECTOR_MAX)
    add(selector, { url: entry, locator: 'shopify:localization', quote: selector.join(' ') })

  const lang = hreflangCountries(home, entry)
  add(lang.codes, {
    url: entry,
    locator: lang.locator,
    ...(lang.quote === undefined ? {} : { quote: clip(lang.quote) }),
  })

  const tld = tldCountry(entry)
  if (tld !== undefined) add([tld], { url: entry, locator: 'tld', quote: new URL(entry).hostname })

  if (input.shipping !== undefined) {
    const s = shippingCountries(input.shipping.text)
    add(s.codes, {
      url: input.shipping.url,
      locator: 'policy:shipping',
      ...(s.quote === undefined ? {} : { quote: clip(s.quote) }),
    })
  }

  for (const page of [{ url: entry, html: home }, ...(input.products ?? [])]) {
    const text = visibleText(page.html, 20_000)
    const m =
      /\b(?:ships?|delivers?|shipping|delivery) (?:to|within|across) ([^.!?\n]{2,160})/i.exec(text)
    if (m === null) continue
    const codes = countriesIn(m[1] ?? '')
    if (codes.length === 0) continue
    add(codes, { url: page.url, locator: 'text:ships-to', quote: clip(m[0]) })
    break
  }

  let confidence: BrandIntakeField<string[]>['confidence'] = 'medium'
  if (votes.size === 0 && input.currency !== undefined) {
    const cc = SINGLE_COUNTRY_CURRENCY[input.currency.code.toUpperCase()]
    if (cc !== undefined) {
      add([cc], { url: input.currency.url, locator: 'currency', quote: input.currency.code })
      // 只有币种这一条：最弱，要人确认
      confidence = 'low'
    }
  }
  if (votes.size === 0) return undefined
  const order = [...votes.keys()]
  const value = [...order].sort(
    (a, b) => (votes.get(b) ?? 0) - (votes.get(a) ?? 0) || order.indexOf(a) - order.indexOf(b),
  )
  return { value, confidence, evidence }
}
