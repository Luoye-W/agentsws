/**
 * WP181：右栏「定时任务」面板用的纯函数——官方「自动化任务」的时间规则 ↔ 一句人话 ↔ 面板上那几格。
 *
 * 规则的形状照官方（`@deepseek-ai/dsh-schedule` 的记录：`daily` / `weekly` / `cron` / `every`，
 * 一次性的在我们调度器里是 `once`）。借官方任务页的「Run time」卡：重复（每天 / 工作日 / 每周 / 一次）
 * + 时间 + 周几；改完一次保存，提交的是官方工具的参数形状（`daily` / `weekly` / `at`），校验在服务端官方那一层。
 */
import type { Lang } from '@/lib/i18n'

export type RuleKind = 'daily' | 'weekly' | 'cron' | 'every' | 'once'

export interface ScheduleRule {
  kind: RuleKind
  time?: string
  timeZone?: string
  weekdays?: number[]
  expression?: string
  everySeconds?: number
  /** 一次性的那一刻（ISO） */
  at?: string
}

/** 调度器的触发器 → 官方规则（认不出回 `undefined`：面板只读显示原样）。 */
export function ruleOfTrigger(
  trigger: { kind: string } & Record<string, unknown>,
): ScheduleRule | undefined {
  if (trigger.kind === 'once' && typeof trigger.at === 'string')
    return { kind: 'once', at: trigger.at }
  if (trigger.kind !== 'rule') return undefined
  const r = (trigger.rule ?? {}) as Record<string, unknown>
  const kind = r.kind
  if (kind !== 'daily' && kind !== 'weekly' && kind !== 'cron' && kind !== 'every') return undefined
  return {
    kind,
    ...(typeof r.time === 'string' ? { time: r.time } : {}),
    ...(typeof r.timeZone === 'string' ? { timeZone: r.timeZone } : {}),
    ...(Array.isArray(r.weekdays) ? { weekdays: r.weekdays as number[] } : {}),
    ...(typeof r.expression === 'string' ? { expression: r.expression } : {}),
    ...(typeof r.everySeconds === 'number' ? { everySeconds: r.everySeconds } : {}),
  }
}

const WEEK_ZH = ['', '一', '二', '三', '四', '五', '六', '日']
const WEEK_EN = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

/** `09:00:00.000` → `09:00`。 */
export const hhmm = (time: string | undefined): string => (time ?? '09:00').slice(0, 5)

export function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/** `Etc/GMT-8` → `UTC+8`（IANA 的 Etc 符号是反的）；别的原样。 */
export function zoneLabel(zone: string): string {
  const m = /^Etc\/GMT([+-])(\d{1,2})$/.exec(zone)
  if (m === null) return zone
  return `UTC${m[1] === '-' ? '+' : '-'}${m[2]}`
}

const isWorkdays = (days: readonly number[] | undefined): boolean =>
  days !== undefined && days.length === 5 && [1, 2, 3, 4, 5].every((d) => days.includes(d))

/** 一句人话：「每天 09:00」「工作日 09:00」「每周一、三 10:30」「每 2 小时」「一次 · 9月30日 10:00」。 */
export function frequencyText(rule: ScheduleRule, lang: Lang, zone = browserZone()): string {
  const zh = lang === 'zh'
  const tz =
    rule.timeZone === undefined || rule.timeZone === zone ? '' : ` (${zoneLabel(rule.timeZone)})`
  switch (rule.kind) {
    case 'daily':
      return `${zh ? '每天' : 'Daily'} ${hhmm(rule.time)}${tz}`
    case 'weekly': {
      if (isWorkdays(rule.weekdays)) return `${zh ? '工作日' : 'Weekdays'} ${hhmm(rule.time)}${tz}`
      const days = (rule.weekdays ?? []).map((d) => (zh ? WEEK_ZH[d] : WEEK_EN[d]) ?? '')
      return zh
        ? `每周${days.join('、')} ${hhmm(rule.time)}${tz}`
        : `Every ${days.join(', ')} ${hhmm(rule.time)}${tz}`
    }
    case 'every': {
      const s = rule.everySeconds ?? 0
      if (s % 3600 === 0) return zh ? `每 ${s / 3600} 小时` : `Every ${s / 3600} h`
      return zh ? `每 ${Math.round(s / 60)} 分钟` : `Every ${Math.round(s / 60)} min`
    }
    case 'cron':
      return `cron ${rule.expression ?? ''}${tz}`
    default: {
      const at = rule.at === undefined ? undefined : new Date(rule.at)
      const when =
        at === undefined
          ? ''
          : new Intl.DateTimeFormat(zh ? 'zh-CN' : 'en-US', {
              month: 'short',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
              hourCycle: 'h23',
            }).format(at)
      return `${zh ? '一次' : 'Once'} · ${when}`
    }
  }
}

/* ── 面板上那几格（官方「Run time」卡借形）─────────────────────────────────── */

export type Repeat = 'daily' | 'workdays' | 'weekly' | 'once'

export interface RuleDraft {
  repeat: Repeat
  /** `HH:mm` */
  time: string
  /** 每周那几天（ISO：周一 1 … 周日 7） */
  weekdays: number[]
  /** 一次性的日期 `YYYY-MM-DD`（按这台电脑的时区） */
  date: string
}

const pad = (n: number): string => String(n).padStart(2, '0')

function localParts(iso: string): { date: string; time: string; weekday: number } {
  const d = new Date(iso)
  const weekday = d.getDay() === 0 ? 7 : d.getDay()
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
    weekday,
  }
}

/** 存着的规则 → 面板上的那几格（cron / 固定间隔没有对应的格子：按下一次那一刻给「每天」起个头）。 */
export function draftOf(rule: ScheduleRule, nextAt: string | undefined): RuleDraft {
  const next = localParts(nextAt ?? rule.at ?? new Date().toISOString())
  if (rule.kind === 'once')
    return { repeat: 'once', time: next.time, weekdays: [next.weekday], date: next.date }
  if (rule.kind === 'weekly') {
    const days = [...(rule.weekdays ?? [])]
    return {
      repeat: isWorkdays(days) ? 'workdays' : 'weekly',
      time: hhmm(rule.time),
      weekdays: days,
      date: next.date,
    }
  }
  if (rule.kind === 'daily')
    return { repeat: 'daily', time: hhmm(rule.time), weekdays: [next.weekday], date: next.date }
  return { repeat: 'daily', time: next.time, weekdays: [next.weekday], date: next.date }
}

export const sameDraft = (a: RuleDraft, b: RuleDraft): boolean =>
  a.repeat === b.repeat &&
  a.time === b.time &&
  (a.repeat !== 'weekly' || [...a.weekdays].sort().join() === [...b.weekdays].sort().join()) &&
  (a.repeat !== 'once' || a.date === b.date)

/**
 * 面板那几格 → 官方工具的参数形状（`PATCH /v1/schedules/:id { rule }`）。
 * 时区：规则原来存的那个照旧（官方：改时间不换时区）；一次性的按这台电脑的时区；都没有就不写（服务端补公司时区）。
 */
export function selectorOfDraft(draft: RuleDraft, rule: ScheduleRule): Record<string, unknown> {
  const time = `${draft.time}:00`
  const zone = rule.kind === 'once' || rule.timeZone === undefined ? undefined : rule.timeZone
  const tz = zone === undefined ? {} : { time_zone: zone }
  if (draft.repeat === 'daily') return { daily: { time, ...tz } }
  if (draft.repeat === 'workdays') return { weekly: { time, weekdays: [1, 2, 3, 4, 5], ...tz } }
  if (draft.repeat === 'weekly') {
    return { weekly: { time, weekdays: [...new Set(draft.weekdays)].sort(), ...tz } }
  }
  return { at: { date: draft.date, time, time_zone: browserZone() } }
}
