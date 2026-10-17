/**
 * WP388（docs/103 R9 / S2 / S3 / T2，Luoye 10-17）：周报类定时的**默认值**与**取数窗口**。
 *
 * - 默认每周一 16:30（工作区时区）出**上一周**的：美国那边上一周刚结束，Google Analytics 这类数据也有延迟；
 *   17:00 偏晚，很多公司 18:00 下班。**只是默认**——用户跟 AI 说一声就能改，不写死成规矩。
 * - 「上一周」按品牌**目标市场**的时区算（周一 00:00 到周日 24:00）；没设目标市场就用工作区时区。
 * - 用户把时间改到周四以后（例如甲方要周五交），那一份就是**这一周到现在**——窗口跟着出报告的那一天走，
 *   不为哪一种周报、哪一个甲方写分支。
 */
import { DAY_MS, MINUTE_MS, tzOffsetMinutes, wallClock } from './cron.js'

/** 周报类定时的默认：每周一 16:30（工作区时区）。 */
export const WEEKLY_REPORT_CRON = '30 16 * * 1'
/** 同上，设置页那一行的样子（`weekday` 0 = 周日）。 */
export const WEEKLY_REPORT_DEFAULT = { weekday: 1, time: '16:30' } as const
/** 为什么默认周一（卡上 / 设置页问号里那一句；AI 建议周报时间时也带上）。 */
export const WEEKLY_REPORT_WHY = '美国那边上一周刚结束、数据也到齐了；想换时间跟我说一声。'

/**
 * 出报告那一天在周几之前（不含；0 = 周一）算「上一周」：周一到周三出的是上一周整周，
 * 周四到周日出的是这一周到现在。
 */
export const LAST_WEEK_BEFORE_DOW = 3

/**
 * 跨好几个时区的市场取哪一个：**一周最晚结束的那个主要时区**（美国按美西）——
 * 到了这个点，这个市场里各处的上一周都过完了。只列常见的几个；一个时区的国家照 `Intl` 现取。
 */
const MARKET_ZONE: Readonly<Record<string, string>> = {
  US: 'America/Los_Angeles',
  CA: 'America/Vancouver',
  MX: 'America/Tijuana',
  BR: 'America/Manaus',
  AU: 'Australia/Perth',
  NZ: 'Pacific/Auckland',
  RU: 'Europe/Kaliningrad',
  ID: 'Asia/Jakarta',
  CN: 'Asia/Shanghai',
  DE: 'Europe/Berlin',
  ES: 'Europe/Madrid',
  PT: 'Europe/Lisbon',
  GB: 'Europe/London',
  UK: 'Europe/London',
  CL: 'America/Santiago',
  AR: 'America/Argentina/Buenos_Aires',
  EC: 'America/Guayaquil',
  MY: 'Asia/Kuala_Lumpur',
  UA: 'Europe/Kyiv',
  KZ: 'Asia/Almaty',
}

type LocaleWithZones = Intl.Locale & { getTimeZones?(): string[]; timeZones?: string[] }

/** 一个国家码 → 一个 IANA 时区（认不出回 `undefined`）。 */
export function marketTimeZone(country: string | undefined): string | undefined {
  const cc = country?.trim().toUpperCase()
  if (cc === undefined || !/^[A-Z]{2}$/.test(cc)) return undefined
  const known = MARKET_ZONE[cc]
  if (known !== undefined) return known
  try {
    const locale = new Intl.Locale(`und-${cc}`) as LocaleWithZones
    const zones = locale.getTimeZones?.() ?? locale.timeZones
    return zones?.[0]
  } catch {
    return undefined
  }
}

/** 品牌的取数时区：目标市场的第一个（主市场）认得出就用它，否则用工作区时区。 */
export function reportTimeZone(
  markets: readonly string[] | undefined,
  workspaceTz: string,
): string {
  for (const m of markets ?? []) {
    const zone = marketTimeZone(m)
    if (zone !== undefined) return zone
  }
  return workspaceTz
}

export interface ReportWeek {
  /** `last_week` = 上一周整周；`this_week` = 这一周到现在。 */
  kind: 'last_week' | 'this_week'
  /** 周一 00:00（取数时区）那一刻。 */
  start: string
  /** 不含：上一周 = 下一个周一 00:00；这一周 = 现在。 */
  end: string
  /** 周一、周日的本地日期（`YYYY-MM-DD`）。 */
  monday: string
  sunday: string
  /** 窗口最后一刻的时区偏移（分钟；面板查询用的固定偏移）。 */
  offset_minutes: number
  tz: string
}

const ymd = (wallUtcMs: number): string => new Date(wallUtcMs).toISOString().slice(0, 10)

/** 本地某天 00:00（墙上日期按 UTC 午夜给）→ 那一刻（两次逼近，夏令时那天也对）。 */
function localMidnight(wallUtcMs: number, tz: string): number {
  const first = wallUtcMs - tzOffsetMinutes(tz, wallUtcMs) * MINUTE_MS
  return wallUtcMs - tzOffsetMinutes(tz, first) * MINUTE_MS
}

/** 这一刻出一份周报，该取哪一周（见文件头）。 */
export function reportWeek(now: string, tz: string): ReportWeek {
  const nowMs = Date.parse(now)
  const w = wallClock(nowMs, tz)
  const dow = (w.dow + 6) % 7
  const thisMonday = Date.UTC(w.year, w.month - 1, w.day) - dow * DAY_MS
  const last = dow < LAST_WEEK_BEFORE_DOW
  const monday = last ? thisMonday - 7 * DAY_MS : thisMonday
  const start = localMidnight(monday, tz)
  const end = last ? localMidnight(monday + 7 * DAY_MS, tz) : nowMs
  return {
    kind: last ? 'last_week' : 'this_week',
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
    monday: ymd(monday),
    sunday: ymd(monday + 6 * DAY_MS),
    offset_minutes: tzOffsetMinutes(tz, end - 1),
    tz,
  }
}
