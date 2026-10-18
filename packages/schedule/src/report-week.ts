/**
 * WP388（docs/103 R9 / S2 / S3 / T2，Luoye 10-17）：周报类定时的**默认值**与**取数窗口**。
 *
 * - 默认每周一 16:30（工作区时区）出**上一周**的：美国那边上一周刚结束，Google Analytics 这类数据也有延迟；
 *   17:00 偏晚，很多公司 18:00 下班。**只是默认**——用户跟 AI 说一声就能改，不写死成规矩。
 * - 日界线按品牌**目标市场**的时区算；没设目标市场就用工作区时区（决策 1092）。
 * - 取的是**到出报告前一天为止最近完整的 7 天**（决策 1091）：周一出 = 上周一到周日；用户改到周五出
 *   （例如甲方要周五交）= 上周五到本周四。不为哪一种周报、哪一个甲方写分支；某一份要别的范围在对话里另说。
 */
import { DAY_MS, MINUTE_MS, tzOffsetMinutes, wallClock } from './cron.js'

/** 周报类定时的默认：每周一 16:30（工作区时区）。 */
export const WEEKLY_REPORT_CRON = '30 16 * * 1'
/** 同上，设置页那一行的样子（`weekday` 0 = 周日）。 */
export const WEEKLY_REPORT_DEFAULT = { weekday: 1, time: '16:30' } as const
/** 为什么默认周一（卡上 / 设置页问号里那一句；AI 建议周报时间时也带上）。 */
export const WEEKLY_REPORT_WHY = '美国那边上一周刚结束、数据也到齐了；想换时间跟我说一声。'

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
  /** 第一天 00:00（取数时区）那一刻。 */
  start: string
  /** 不含：出报告那天 00:00（取数时区）。 */
  end: string
  /** 第一天、最后一天的本地日期（`YYYY-MM-DD`）。 */
  from_date: string
  to_date: string
  /** 正好是周一到周日（默认周一出的那种）= 「上周」。 */
  mon_to_sun: boolean
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

/**
 * 这一刻出一份周报，取哪 7 天（决策 1091，Luoye 10-18）：**到出报告前一天为止最近完整的 7 天**
 * （取数时区的日界线）。周一出 = 上周一到周日；周五出 = 上周五到本周四。不按星期几分段。
 */
export function reportWeek(now: string, tz: string): ReportWeek {
  const w = wallClock(Date.parse(now), tz)
  const today = Date.UTC(w.year, w.month - 1, w.day)
  const first = today - 7 * DAY_MS
  const start = localMidnight(first, tz)
  const end = localMidnight(today, tz)
  return {
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
    from_date: ymd(first),
    to_date: ymd(today - DAY_MS),
    mon_to_sun: new Date(first).getUTCDay() === 1,
    offset_minutes: tzOffsetMinutes(tz, end - 1),
    tz,
  }
}
