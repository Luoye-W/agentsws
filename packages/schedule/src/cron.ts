/**
 * 最小 cron（25 §4「精度分钟；tz 按任务」）。
 *
 * 五段：`分 时 日 月 周`，每段支持 `*` / `a` / `a,b` / `a-b` / `*\/n` / `a-b/n`。
 * 不支持 `L` `W` `#` `?` 这些方言——公司里的定时任务是「每天 8 点」「每周一 6 点」
 * 「每 15 分钟」，用不到，支持了反而要解释。
 *
 * 时区：任务自带 `tz`。既认固定偏移（`+08:00` / `UTC+8` / `Z`），也认 IANA 名字
 * （`Asia/Shanghai`）——后者用 `Intl` 按**那一刻**算偏移，所以夏令时会跟着变。
 * 全程不碰 `Date.now()`：算的永远是「从给定的那个毫秒往后」。
 */
import { invalid } from './errors.js'

export const MINUTE_MS = 60_000
export const HOUR_MS = 60 * MINUTE_MS
export const DAY_MS = 24 * HOUR_MS

export interface CronExpr {
  minute: ReadonlySet<number>
  hour: ReadonlySet<number>
  /** 日（1–31） */
  day: ReadonlySet<number>
  /** 月（1–12） */
  month: ReadonlySet<number>
  /** 周（0–6，0 = 周日） */
  dow: ReadonlySet<number>
  /** 日与周都被限制过时按 OR 取并（标准 cron 语义） */
  dayRestricted: boolean
  dowRestricted: boolean
}

interface FieldSpec {
  name: string
  min: number
  max: number
}

const FIELDS: readonly FieldSpec[] = [
  { name: '分', min: 0, max: 59 },
  { name: '时', min: 0, max: 23 },
  { name: '日', min: 1, max: 31 },
  { name: '月', min: 1, max: 12 },
  { name: '周', min: 0, max: 6 },
]

const RANGE_RE = /^(\d{1,2})(?:-(\d{1,2}))?$/

function parseField(raw: string, spec: FieldSpec): { values: Set<number>; restricted: boolean } {
  const values = new Set<number>()
  let restricted = false
  for (const part of raw.split(',')) {
    const piece = part.trim()
    if (piece === '') throw invalid(`cron ${spec.name} 段有空项：${raw}`)
    const [head, stepRaw, ...rest] = piece.split('/')
    if (rest.length > 0 || head === undefined) throw invalid(`cron ${spec.name} 段不合法：${piece}`)
    let step = 1
    if (stepRaw !== undefined) {
      if (!/^\d{1,2}$/.test(stepRaw)) throw invalid(`cron ${spec.name} 段的步长不合法：${piece}`)
      step = Number.parseInt(stepRaw, 10)
      if (step < 1) throw invalid(`cron ${spec.name} 段的步长必须 ≥ 1：${piece}`)
    }
    let from: number
    let to: number
    if (head === '*') {
      from = spec.min
      to = spec.max
      if (stepRaw !== undefined) restricted = true
    } else {
      const m = RANGE_RE.exec(head)
      if (m === null || m[1] === undefined) throw invalid(`cron ${spec.name} 段不合法：${piece}`)
      from = Number.parseInt(m[1], 10)
      to = m[2] === undefined ? from : Number.parseInt(m[2], 10)
      restricted = true
    }
    if (from < spec.min || to > spec.max || from > to) {
      throw invalid(`cron ${spec.name} 段越界（${spec.min}–${spec.max}）：${piece}`)
    }
    for (let v = from; v <= to; v += step) values.add(v)
  }
  if (values.size === 0) throw invalid(`cron ${spec.name} 段没有取值：${raw}`)
  return { values, restricted }
}

/** 解析 `分 时 日 月 周`。多余空白无所谓。 */
export function parseCron(expr: string): CronExpr {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) {
    throw invalid(`cron 必须是「分 时 日 月 周」五段：${expr}`, { expr })
  }
  // 按 FIELDS 的顺序取，长度上面已经校过；`?? ''` 只是让类型收敛，走到就是空段报错
  const [minute, hour, day, month, dow] = FIELDS.map((spec, i) =>
    parseField(parts[i] ?? '', spec),
  ) as [
    ReturnType<typeof parseField>,
    ReturnType<typeof parseField>,
    ReturnType<typeof parseField>,
    ReturnType<typeof parseField>,
    ReturnType<typeof parseField>,
  ]
  return {
    minute: minute.values,
    hour: hour.values,
    day: day.values,
    month: month.values,
    dow: dow.values,
    dayRestricted: day.restricted,
    dowRestricted: dow.restricted,
  }
}

const OFFSET_RE = /^([+-])(\d{1,2}):?(\d{2})?$/
const UTC_OFFSET_RE = /^(?:UTC|GMT)([+-]\d{1,2})(?::?(\d{2}))?$/i
const GMT_RE = /GMT([+-]\d{2}):(\d{2})/

/**
 * 某个时区在**某一刻**相对 UTC 的分钟偏移（东八区 = +480）。
 *
 * 固定偏移直接算；IANA 名字交给 `Intl`（`longOffset` → `GMT+08:00`）。
 * 解析不出来就报 `invalid_input`——宁可让装配的人改对，也不默默按 UTC 跑。
 */
export function tzOffsetMinutes(tz: string, atMs: number): number {
  const name = tz.trim()
  if (name === '' || name === 'Z' || name.toUpperCase() === 'UTC' || name.toUpperCase() === 'GMT') {
    return 0
  }
  const fixed = OFFSET_RE.exec(name)
  if (fixed?.[1] !== undefined && fixed[2] !== undefined) {
    const sign = fixed[1] === '-' ? -1 : 1
    return sign * (Number.parseInt(fixed[2], 10) * 60 + Number.parseInt(fixed[3] ?? '0', 10))
  }
  const utc = UTC_OFFSET_RE.exec(name)
  if (utc?.[1] !== undefined) {
    const hours = Number.parseInt(utc[1], 10)
    const minutes = Number.parseInt(utc[2] ?? '0', 10)
    return hours * 60 + Math.sign(hours || 1) * minutes
  }
  let text: string
  try {
    text = new Intl.DateTimeFormat('en-US', {
      timeZone: name,
      timeZoneName: 'longOffset',
    }).format(new Date(atMs))
  } catch {
    throw invalid(`认不出这个时区：${tz}`, { tz })
  }
  const m = GMT_RE.exec(text)
  if (m?.[1] === undefined || m[2] === undefined) return 0
  const hours = Number.parseInt(m[1], 10)
  const minutes = Number.parseInt(m[2], 10)
  return hours * 60 + Math.sign(hours || 1) * minutes
}

export interface WallClock {
  year: number
  /** 1–12 */
  month: number
  /** 1–31 */
  day: number
  hour: number
  minute: number
  /** 0 = 周日 */
  dow: number
  /** 这一刻的时区偏移（分钟） */
  offset: number
}

/** 某一刻在某时区下的「墙上时间」。 */
export function wallClock(atMs: number, tz: string): WallClock {
  const offset = tzOffsetMinutes(tz, atMs)
  const d = new Date(atMs + offset * MINUTE_MS)
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    dow: d.getUTCDay(),
    offset,
  }
}

function matchesDay(cron: CronExpr, w: WallClock): boolean {
  const byDay = cron.day.has(w.day)
  const byDow = cron.dow.has(w.dow)
  // 标准 cron：两段都限制过就取并集；只限制一段就只看那一段
  if (cron.dayRestricted && cron.dowRestricted) return byDay || byDow
  if (cron.dayRestricted) return byDay
  if (cron.dowRestricted) return byDow
  return true
}

/** 往后找四年还找不到就是表达式本身不可能命中（`0 0 30 2 *`）。 */
const HORIZON_MS = 4 * 366 * DAY_MS

/**
 * 严格晚于 `fromMs` 的下一次触发（毫秒）。
 *
 * 按分钟对齐；月 / 日 / 时不命中时整段跳过，所以最坏也就几千次循环。
 */
export function nextCronAfter(expr: string | CronExpr, fromMs: number, tz: string): number {
  const cron = typeof expr === 'string' ? parseCron(expr) : expr
  const limit = fromMs + HORIZON_MS
  let t = Math.floor(fromMs / MINUTE_MS) * MINUTE_MS + MINUTE_MS
  while (t <= limit) {
    const w = wallClock(t, tz)
    if (!cron.month.has(w.month)) {
      // 跳到下个月 1 号 00:00（本地）
      const nextMonth = w.month === 12 ? 1 : w.month + 1
      const nextYear = w.month === 12 ? w.year + 1 : w.year
      // 偏移可能在这中间变（夏令时）；只保证不倒退，不多跳，宁可下一圈再判一次
      t = Math.max(Date.UTC(nextYear, nextMonth - 1, 1) - w.offset * MINUTE_MS, t + MINUTE_MS)
      continue
    }
    if (!matchesDay(cron, w)) {
      t += (24 - w.hour) * HOUR_MS - w.minute * MINUTE_MS
      continue
    }
    if (!cron.hour.has(w.hour)) {
      t += HOUR_MS - w.minute * MINUTE_MS
      continue
    }
    if (!cron.minute.has(w.minute)) {
      t += MINUTE_MS
      continue
    }
    return t
  }
  throw invalid(`这个 cron 四年内不会触发：${typeof expr === 'string' ? expr : '(已解析)'}`)
}
