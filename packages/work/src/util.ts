/**
 * 小工具：id、时间、日界线。
 *
 * 纪律（35 §2）：没有一处 `Date.now()` / `Math.random()` 裸调——时间经注入的 Clock，
 * 随机经注入的 seed。`Date.parse` 只是解析已经给定的字符串，不产生时间。
 */
import type { Iso8601 } from '@agentsws/contracts'

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

export const DAY_MS = 86_400_000
export const HOUR_MS = 3_600_000
export const MINUTE_MS = 60_000

/** ULID 风格 id：时间前缀（可排序）+ 注入随机。 */
export function makeIdFactory(
  random: () => number,
  now: () => Iso8601,
): (prefix: string) => string {
  let seq = 0
  return (prefix: string): string => {
    const t = Date.parse(now())
    let time = ''
    let n = Number.isFinite(t) ? t : 0
    for (let i = 0; i < 10; i += 1) {
      time = (ALPHABET[n % 32] ?? '0') + time
      n = Math.floor(n / 32)
    }
    let rand = ''
    for (let i = 0; i < 10; i += 1) {
      rand += ALPHABET[Math.floor(random() * 32) % 32] ?? '0'
    }
    seq = (seq + 1) % 32
    return `${prefix}_${time}${rand}${ALPHABET[seq] ?? '0'}`
  }
}

export const ms = (iso: Iso8601): number => Date.parse(iso)

export const plusMs = (iso: Iso8601, delta: number): Iso8601 =>
  new Date(Date.parse(iso) + delta).toISOString()

/** 按工作区时区切当天零点（返回 UTC 毫秒）。 */
export function startOfDay(atMs: number, tzOffsetMinutes: number): number {
  const shift = tzOffsetMinutes * MINUTE_MS
  return Math.floor((atMs + shift) / DAY_MS) * DAY_MS - shift
}

/** 本地日 `YYYY-MM-DD`（按工作区 tz）。 */
export function localDay(at: Iso8601, tzOffsetMinutes: number): string {
  const local = new Date(ms(at) + tzOffsetMinutes * MINUTE_MS)
  const y = local.getUTCFullYear()
  const m = `${local.getUTCMonth() + 1}`.padStart(2, '0')
  const d = `${local.getUTCDate()}`.padStart(2, '0')
  return `${y}-${m}-${d}`
}

/**
 * 当天本地 `hour:minute` → ISO。
 * `dayStartMs` 已经是「本地零点」对应的 UTC 毫秒（见 {@link startOfDay}），所以直接加偏移即可。
 */
export function atLocalTime(dayStartMs: number, hour: number, minute = 0): Iso8601 {
  return new Date(dayStartMs + hour * HOUR_MS + minute * MINUTE_MS).toISOString()
}

/** 深拷贝；存进去与拿出来的都是副本，调用方改不动内部状态。 */
export function clone<T>(value: T): T {
  return structuredClone(value)
}

/** [aFrom, aTo) 与 [bFrom, bTo) 有没有重叠；零长度区间按「点」处理。 */
export function overlaps(aFrom: number, aTo: number, bFrom: number, bTo: number): boolean {
  if (aTo === aFrom) return aFrom >= bFrom && aFrom < bTo
  return aFrom < bTo && aTo > bFrom
}

export function round2(v: number): number {
  return Math.round(v * 100) / 100
}

/** 去重且保序。 */
export function uniq<T>(list: readonly T[]): T[] {
  return [...new Set(list)]
}

/** 稳定排序键：先按数值，再按 id 字典序（同分时结果确定）。 */
export function byKeyThenId<T extends { id: string }>(key: (v: T) => number) {
  return (a: T, b: T): number => key(a) - key(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}
