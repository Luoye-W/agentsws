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
): string {
  if (value === undefined) return '—'
  const locale = LOCALE[lang]
  switch (format) {
    case 'money':
      return new Intl.NumberFormat(locale, {
        style: 'currency',
        currency: currency ?? 'USD',
        maximumFractionDigits: 2,
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
