/**
 * WP438：报表里数的写法（与 deck 的 `formatReportValue` 同一个口径：$48.2k、2.41%、排名 11.2）。
 * 前端只负责「怎么写」，一个数都不在这里算。
 */
import type { ReportFormat, ReportMetricValue } from '@agentsws/deck'

const SIGN: Record<string, string> = { USD: '$', EUR: '€', GBP: '£', CNY: '¥', JPY: '¥' }

const round = (v: number, d: number): number => {
  const k = 10 ** d
  return Math.round(v * k) / k
}

/** 大数缩写（12,340 → 12.3k）；`full` 时写全（$48,210）。 */
export function fmtNumber(v: number, opts: { full?: boolean } = {}): string {
  const a = Math.abs(v)
  if (opts.full === true || a < 10_000)
    return a < 100 && !Number.isInteger(v)
      ? String(round(v, 1))
      : Math.round(v).toLocaleString('en-US')
  if (a >= 1_000_000) return `${round(v / 1_000_000, 1)}m`
  return `${round(v / 1000, 1)}k`
}

export function fmtValue(
  v: number | undefined,
  format: ReportFormat | undefined,
  currency = 'USD',
  opts: { full?: boolean } = {},
): string {
  if (v === undefined || !Number.isFinite(v)) return '—'
  switch (format) {
    case 'currency': {
      const s = SIGN[currency]
      const body = fmtNumber(v, opts)
      return s === undefined ? `${body} ${currency}` : `${s}${body}`
    }
    case 'percent':
      return `${round(v, 2)}%`
    case 'hours':
      return `${round(v, 1)}h`
    case 'position':
    case 'decimal':
      return String(round(v, format === 'position' ? 1 : 2))
    default:
      return fmtNumber(v, opts)
  }
}

export type DeltaTone = 'up' | 'down' | 'flat'

/** 涨跌那一小截：「↑18.4%」「↓0.18pt」。`good` = 对人来说是好事（越小越好的反过来）。 */
export function deltaOf(
  m: Pick<ReportMetricValue, 'delta' | 'delta_unit' | 'invert'>,
): { text: string; tone: DeltaTone; good: boolean } | undefined {
  if (m.delta === undefined) return undefined
  const unit = m.delta_unit === 'pt' ? 'pt' : '%'
  const abs = Math.abs(m.delta)
  const n = unit === '%' ? round(abs, 1) : round(abs, 2)
  if (m.delta === 0) return { text: `0${unit}`, tone: 'flat', good: true }
  const up = m.delta > 0
  return {
    text: `${up ? '↑' : '↓'}${n}${unit}`,
    tone: up ? 'up' : 'down',
    good: m.invert === true ? !up : up,
  }
}

/** 表里「比前 30 天」那一列的百分比（+31% / -4%）。 */
export function pctText(v: number | null | undefined): { text: string; good?: boolean } {
  if (v === null || v === undefined) return { text: '—' }
  if (v === 0) return { text: '0%' }
  return { text: `${v > 0 ? '↑' : '↓'}${round(Math.abs(v), 1)}%`, good: v > 0 }
}

/** `2026-10-20` → `10-20`。 */
export const shortDay = (d: string): string => (d.length >= 10 ? d.slice(5, 10) : d)

/** `**粗体**` → 片段（结论卡那三句）。 */
export function boldParts(text: string): { text: string; bold: boolean }[] {
  const out: { text: string; bold: boolean }[] = []
  const re = /\*\*([^*]+)\*\*/g
  let last = 0
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), bold: false })
    out.push({ text: m[1] ?? '', bold: true })
    last = m.index + m[0].length
  }
  if (last < text.length) out.push({ text: text.slice(last), bold: false })
  return out
}
