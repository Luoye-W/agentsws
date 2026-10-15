/**
 * WP340：巡查条目的**本地**词匹配——告警词（命中标「优先」）、标签词（命中打标签）。
 *
 * 全在本机比对，不调任何外部接口、不额外计费。通用写法，不认哪个品牌：
 * - 拉丁字母按整词认，词里的空格 / 连字符可有可无（`Air 3` = `Air3` = `air-3`）；
 * - 告警词再放过英语常见词尾（`refund` 认 `refunded`、`overheat` 认 `overheating`）；
 * - 中文等按包含认。
 */
import type { RedditWatchEntry, RedditWatchSettings } from '@agentsws/contracts'

const LATIN = /^[\p{Script=Latin}\d\s._+-]+$/u
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')

/** 一个词 → 正则（认不出 / 空词回 `undefined`）。 */
export function termPattern(term: string, inflect: boolean): RegExp | undefined {
  const k = term.trim().toLowerCase()
  if (k === '') return undefined
  if (!LATIN.test(k)) return new RegExp(esc(k), 'u')
  // 按「字母段 / 数字段 / 分隔」切开，段与段之间的空格、连字符、下划线可有可无
  const chunks = k.match(/\p{L}+|\d+|[._+]/gu) ?? []
  if (chunks.length === 0) return undefined
  const body = chunks.map(esc).join('[\\s\\-_]?')
  const tail = inflect ? '(?:s|es|ed|d|ing)?' : ''
  return new RegExp(`(^|[^\\p{L}\\p{N}])${body}${tail}($|[^\\p{L}\\p{N}])`, 'u')
}

/** 这段话里命中了哪些词（按设置里的原样回，去重）。 */
export function termHits(text: string, terms: readonly string[], inflect: boolean): string[] {
  const t = text.toLowerCase()
  const out: string[] = []
  for (const term of terms) {
    const re = termPattern(term, inflect)
    if (re !== undefined && re.test(t) && !out.includes(term)) out.push(term)
  }
  return out
}

const textOf = (e: Pick<RedditWatchEntry, 'title' | 'text' | 'post_title'>): string =>
  [e.title ?? '', e.text].join('\n')

/** 一条按当前设置算出的告警词 / 标签（只看它自己的标题与正文）。 */
export function localMarks(
  e: Pick<RedditWatchEntry, 'title' | 'text' | 'post_title'>,
  s: Pick<RedditWatchSettings, 'alert_words' | 'tag_words'>,
): { alerts: string[]; tags: string[] } {
  const text = textOf(e)
  return {
    alerts: termHits(text, s.alert_words ?? [], true),
    tags: termHits(text, s.tag_words ?? [], false),
  }
}

/** 入库前给条目标上（我们自己发的、被删的不标优先）。 */
export function applyLocalMarks(
  e: RedditWatchEntry,
  s: Pick<RedditWatchSettings, 'alert_words' | 'tag_words'>,
): RedditWatchEntry {
  const m = localMarks(e, s)
  if (m.tags.length > 0) e.tags = m.tags
  if (m.alerts.length > 0 && e.ours !== true && e.deleted !== true) {
    e.priority = true
    e.alert_hits = m.alerts
  }
  return e
}
