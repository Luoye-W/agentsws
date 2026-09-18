/**
 * 数字与时间的显示。
 *
 * 一条纪律：**微单位只在这里除**。聚合、比较、排序全在整数微元上做（65 §3），
 * 一旦某个地方提前除成浮点数，两个本来相等的毛利就会差出一个 0.000001。
 */

const COST_MICRO_UNIT = 1_000_000

/** 微元 → `¥12.34`。负数照显示（撤回与亏本都会是负的）。 */
export function cny(micros: number): string {
  const yuan = micros / COST_MICRO_UNIT
  const abs = Math.abs(yuan)
  // 小于一分钱的成本不显示成 ¥0.00——那看起来像"免费"，而它只是很便宜
  if (abs > 0 && abs < 0.01) return `${yuan < 0 ? '-' : ''}<¥0.01`
  return `${yuan < 0 ? '-' : ''}¥${abs.toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

/** 1 积分 = ¥1（49 M4），所以积分也按两位小数显示，但带的是「分」不是「¥」。 */
export function credits(value: number): string {
  return value.toLocaleString('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })
}

/** 大整数按千分位；上万之后收成 `1.2万` / `12.3k`（列宽有限）。 */
export function compact(value: number, lang: 'zh' | 'en' = 'zh'): string {
  if (!Number.isFinite(value)) return '—'
  const abs = Math.abs(value)
  if (abs < 10_000) return value.toLocaleString()
  if (lang === 'zh') {
    if (abs < 100_000_000) return `${(value / 10_000).toFixed(1)}万`
    return `${(value / 100_000_000).toFixed(2)}亿`
  }
  if (abs < 1_000_000) return `${(value / 1_000).toFixed(1)}k`
  if (abs < 1_000_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  return `${(value / 1_000_000_000).toFixed(2)}B`
}

/** ISO → `09-18 20:15`（同一年就不显示年份；跨年才显示）。 */
export function when(iso: string | null | undefined, now = new Date()): string {
  if (iso === null || iso === undefined || iso === '') return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const pad = (n: number) => String(n).padStart(2, '0')
  const sameYear = d.getFullYear() === now.getFullYear()
  const head = sameYear ? '' : `${String(d.getFullYear())}-`
  return `${head}${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 只要日期那一截。 */
export function day(iso: string | null | undefined): string {
  if (iso === null || iso === undefined || iso === '') return '—'
  return iso.slice(0, 10)
}

/** `null` / 空串 → 一个看得出"这里本来没有值"的符号，而不是空白。 */
export const orDash = (v: string | null | undefined): string =>
  v === null || v === undefined || v === '' ? '—' : v
