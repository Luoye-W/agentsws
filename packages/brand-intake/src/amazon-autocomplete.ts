/**
 * WP398（docs/106 §5.6 / §13 A8）：Amazon 前台**搜索框联想词**——地址怎么拼、回来的东西怎么读。
 *
 * 就是用户在 Amazon 搜索框里打字时浏览器去要的那份联想（公开、不登录）。真正去读的是工坊内置浏览器
 * （请求带 `Agent/AgentsWorkshop`，docs/106 §2.1）；这里只有两条纯规则，测试拿录好的响应直接钉。
 *
 * - 一期**没有搜索量**：联想只给「有人这么搜」，不给多少人搜，也排不了先后（不估）；
 * - 被拦（验证页）照实认出来，交给调用方停下：不绕、不重试。
 *
 * 地址写法参考了公开的联想词研究做法（思路：种子词 + a–z 扩展），没有拷任何代码。
 */
import { isBlocked } from './amazon.js'

/**
 * 站点国家码 → 联想服务的域名与站点 id（`mid`）、语言。
 * 美国站是常见公开写法；其余站点按同一服务的区域域名写，**验收时实测**，读不到照实说。
 */
const MARKETS: Readonly<Record<string, { host: string; mid: string; lop: string }>> = {
  US: { host: 'completion.amazon.com', mid: 'ATVPDKIKX0DER', lop: 'en_US' },
  CA: { host: 'completion.amazon.com', mid: 'A2EUQ1WTGCTBG2', lop: 'en_CA' },
  MX: { host: 'completion.amazon.com', mid: 'A1AM78C64UM0Y8', lop: 'es_MX' },
  BR: { host: 'completion.amazon.com', mid: 'A2Q3Y263D00KWC', lop: 'pt_BR' },
  GB: { host: 'completion.amazon.co.uk', mid: 'A1F83G8C2ARO7P', lop: 'en_GB' },
  DE: { host: 'completion.amazon.co.uk', mid: 'A1PA6795UKMFR9', lop: 'de_DE' },
  FR: { host: 'completion.amazon.co.uk', mid: 'A13V1IB3VIYZZH', lop: 'fr_FR' },
  IT: { host: 'completion.amazon.co.uk', mid: 'APJ6JRA9NG5V4', lop: 'it_IT' },
  ES: { host: 'completion.amazon.co.uk', mid: 'A1RKKUPIHCS9HS', lop: 'es_ES' },
  NL: { host: 'completion.amazon.co.uk', mid: 'A1805IZSGTT6HS', lop: 'nl_NL' },
  SE: { host: 'completion.amazon.co.uk', mid: 'A2NODRKZP88ZB9', lop: 'sv_SE' },
  PL: { host: 'completion.amazon.co.uk', mid: 'A1C3SOZRARQ6R3', lop: 'pl_PL' },
  JP: { host: 'completion.amazon.co.jp', mid: 'A1VC38T7YXB528', lop: 'ja_JP' },
  AU: { host: 'completion.amazon.com.au', mid: 'A39IBJ37TRP1C6', lop: 'en_AU' },
  IN: { host: 'completion.amazon.in', mid: 'A21TJRUUN4KGV', lop: 'en_IN' },
}

const norm = (marketplace: string): string => {
  const m = marketplace.trim().toUpperCase()
  return m === 'UK' ? 'GB' : m
}

/** 这个站点读得了联想词没有。 */
export function amazonAutocompleteSupported(marketplace: string): boolean {
  return MARKETS[norm(marketplace)] !== undefined
}

/** 一个前缀的联想词地址（站点认不出回 `undefined`）。 */
export function amazonAutocompleteUrl(marketplace: string, prefix: string): string | undefined {
  const m = MARKETS[norm(marketplace)]
  if (m === undefined) return undefined
  const q = new URLSearchParams({
    limit: '11',
    prefix: prefix.trim(),
    'suggestion-type': 'KEYWORD',
    'page-type': 'Gateway',
    alias: 'aps',
    'site-variant': 'desktop',
    version: '3',
    lop: m.lop,
    mid: m.mid,
  })
  return `https://${m.host}/api/2017/suggestions?${q.toString()}`
}

/** 一批前缀：种子词本身 + 后面接 a–z（共 27 个）。 */
export function amazonAutocompletePrefixes(seed: string): string[] {
  const s = seed.trim().replace(/\s+/g, ' ').toLowerCase()
  if (s === '') return []
  return [s, ...'abcdefghijklmnopqrstuvwxyz'.split('').map((c) => `${s} ${c}`)]
}

export type AmazonSuggestionParse =
  | { status: 'ok'; suggestions: string[] }
  | { status: 'blocked' }
  | { status: 'unreadable'; message: string }

/**
 * 读回来的那一页（可能是 JSON 原文，也可能是浏览器把 JSON 画成页面后的正文）→ 联想词。
 * 只收 `type = KEYWORD` 的（不收「在某个类目里搜」那种）；去重、去空、小写。
 */
export function parseAmazonSuggestions(text: string): AmazonSuggestionParse {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) {
    if (isBlocked(text) || /not a robot|verify you are human/i.test(text))
      return { status: 'blocked' }
    return { status: 'unreadable', message: '回来的不是联想词（不是 JSON）' }
  }
  let raw: unknown
  try {
    raw = JSON.parse(text.slice(start, end + 1))
  } catch {
    if (isBlocked(text)) return { status: 'blocked' }
    return { status: 'unreadable', message: '联想词读不懂（JSON 坏了或被截断）' }
  }
  const list = (raw as { suggestions?: unknown }).suggestions
  if (!Array.isArray(list)) return { status: 'unreadable', message: '回来的 JSON 里没有联想词' }
  const out: string[] = []
  for (const s of list) {
    if (typeof s !== 'object' || s === null) continue
    const o = s as { value?: unknown; type?: unknown }
    if (o.type !== undefined && o.type !== 'KEYWORD') continue
    if (typeof o.value !== 'string') continue
    const v = o.value.replace(/\s+/g, ' ').trim().toLowerCase()
    if (v !== '' && v.length <= 200 && !out.includes(v)) out.push(v)
  }
  return { status: 'ok', suggestions: out }
}
