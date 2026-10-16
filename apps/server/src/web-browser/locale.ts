/**
 * WP353（Luoye 10-16「搜索语言」）：**工坊这一层定规矩**——搜什么语言、哪个市场，按品牌档案定，
 * 不靠模型记住。
 *
 * - 品牌主市场 = 档案 `markets` 的第一个（多市场品牌默认用主市场）；语言按 `marketLanguage`
 *   （档案里按市场覆盖的优先，其次各国第一语言，WP169 那张表）。
 * - Google 带 `gl` / `hl`，Bing 带 `cc` / `setlang`：美国 `gl=us&hl=en`、德国 `gl=de&hl=de`、日本 `gl=jp&hl=ja`。
 * - 查询串本身是中文（例如搜国内竞品）：`hl=zh-CN`、**不带市场**（不把中文查询钉到美国结果上），查询不改写。
 * - 档案里没有市场：`hl=en`、不带市场（交给搜索引擎按出口 IP 定）。
 */
import { marketLanguage } from '@agentsws/contracts'

export interface SearchLocale {
  /** 国家码（大写，`US`）；没有 = 不带市场参数。 */
  market?: string
  /** 搜索界面语言（Google 的 `hl` 写法：`en` / `de` / `ja` / `zh-CN` / `zh-TW`）。 */
  language: string
}

/** 品牌档案里与搜索语言有关的那两格（`WorkspaceProfile` 的子集）。 */
export interface LocaleProfile {
  markets?: readonly string[] | undefined
  market_languages?: Readonly<Record<string, string>> | undefined
}

const HAN = /[㐀-䶿一-鿿]/u

/** 语言码 → Google `hl` 写法（`zh-tw` → `zh-TW`、`pt-br` → `pt-BR`）。 */
function hlOf(lang: string): string {
  const [base, region] = lang.split('-')
  return region === undefined ? (base ?? 'en') : `${base}-${region.toUpperCase()}`
}

export function searchLocaleOf(profile: LocaleProfile | undefined, query: string): SearchLocale {
  if (HAN.test(query)) return { language: 'zh-CN' }
  const market = profile?.markets
    ?.find((m) => /^[A-Za-z]{2}$/.test(m.trim()))
    ?.trim()
    .toUpperCase()
  if (market === undefined) return { language: 'en' }
  const lang = marketLanguage(market, profile?.market_languages) ?? 'en'
  return { market: market === 'UK' ? 'GB' : market, language: hlOf(lang) }
}

/** 给模型的那一行上下文（只说主市场与语言，不塞整份档案）。没有市场回 `undefined`。 */
export function searchLocaleLine(profile: LocaleProfile | undefined): string | undefined {
  const markets = (profile?.markets ?? [])
    .map((m) => m.trim().toUpperCase())
    .filter((m) => /^[A-Z]{2}$/.test(m))
  if (markets.length === 0) return undefined
  const langs = markets.map((m) => `${m}=${marketLanguage(m, profile?.market_languages) ?? 'en'}`)
  return `品牌主市场：${markets[0]}；各市场语言：${langs.join('，')}`
}

export function googleSearchUrl(query: string, locale: SearchLocale): string {
  const p = new URLSearchParams({ q: query, hl: locale.language, num: '10' })
  if (locale.market !== undefined) p.set('gl', locale.market.toLowerCase())
  return `https://www.google.com/search?${p}`
}

export function bingSearchUrl(query: string, locale: SearchLocale): string {
  const p = new URLSearchParams({ q: query, setlang: locale.language, count: '10' })
  if (locale.market !== undefined) p.set('cc', locale.market)
  return `https://www.bing.com/search?${p}`
}
