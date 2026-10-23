/**
 * 展示层格式化。
 *
 * 只做「数 → 好看的字符串」这一件事：数本身在服务端算好（29 原则 ③），
 * 前端一个加减乘除都不做。
 */
import type { RangeName, StatTile, TileFormat } from '@agentsws/deck'
import type { Lang } from './i18n.js'

const LOCALE: Record<Lang, string> = { zh: 'zh-CN', en: 'en-US' }

export function formatValue(
  value: number | undefined,
  format: TileFormat,
  lang: Lang,
  currency?: string,
  /** WP416：窄格子里用短币符（`$64` 而不是 `US$64`）。 */
  narrow = false,
): string {
  if (value === undefined) return '—'
  const locale = LOCALE[lang]
  switch (format) {
    case 'money':
      return new Intl.NumberFormat(locale, {
        style: 'currency',
        currency: currency ?? 'USD',
        maximumFractionDigits: 2,
        ...(narrow ? { currencyDisplay: 'narrowSymbol' as const } : {}),
      }).format(value)
    case 'percent':
      return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value)}%`
    case 'ratio':
      return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value)
    default:
      return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(value)
  }
}

export function formatDelta(tile: StatTile, lang: Lang): string | undefined {
  if (tile.delta_pct === undefined) return undefined
  const n = new Intl.NumberFormat(LOCALE[lang], { maximumFractionDigits: 1 }).format(
    Math.abs(tile.delta_pct),
  )
  return `${tile.delta_pct >= 0 ? '+' : '−'}${n}%`
}

export function formatDateTime(iso: string | undefined, lang: Lang): string {
  if (iso === undefined) return '—'
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return iso
  return new Intl.DateTimeFormat(LOCALE[lang], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(ms))
}

export function formatDate(iso: string | undefined, lang: Lang): string {
  if (iso === undefined) return '—'
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return iso
  return new Intl.DateTimeFormat(LOCALE[lang], { month: 'short', day: 'numeric' }).format(
    new Date(ms),
  )
}

export const RANGE_KEYS: Record<RangeName, string> = {
  yesterday: 'range.yesterday',
  last_7d: 'range.last_7d',
}

/** WP480：字节 → 「1.2 GB」（与连接页「数据后端」那一格同一种写法）。 */
export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i += 1
  }
  return `${value < 10 && i > 0 ? value.toFixed(1) : Math.round(value)} ${units[i]}`
}

/**
 * WP480：「上次备份」这类时间说人话——今天 / 昨天给钟点（「今天 11:44」），再早给「3 天前」，
 * 一个月以上给日期（「9 月 12 日」）。读不懂的串不原样上屏，回 `undefined`（调用方显示「—」）。
 */
export function formatAgo(
  iso: string | undefined,
  lang: Lang,
  t: (key: string, vars?: Record<string, string | number>) => string,
  now: Date = new Date(),
): string | undefined {
  if (iso === undefined) return undefined
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return undefined
  const when = new Date(ms)
  const time = new Intl.DateTimeFormat(LOCALE[lang], {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(when)
  const startOf = (d: Date): number =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((startOf(now) - startOf(when)) / 86_400_000)
  if (days <= 0) return t('storage.ago.today', { time })
  if (days === 1) return t('storage.ago.yesterday', { time })
  if (days < 31) return t('storage.ago.days', { n: days })
  return formatDate(iso, lang)
}
