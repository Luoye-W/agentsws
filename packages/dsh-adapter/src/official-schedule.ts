/**
 * WP181：官方「自动化任务」（`@deepseek-ai/dsh-schedule` + WP293 起单独成包的 `@deepseek-ai/dsh-tool-schedule`）
 * 在我们运行里**真用起来**的那一层。WP293（dsh 0.2.1-alpha.2）：官方删了「自动化任务」可选插件包，改成 Web 组合
 * 自己挂、默认 preset 就带四个工具——我们跟着改成内置、一直开（`apps/server/src/server.ts`），不再看插件装没装。
 *
 * 官方的 Host 服务（`ScheduleService`：存储、定时器、到点把消息投回原来那次对话）挂不进我们的两档运行时——
 * 它要 Web 会话控制器、会话持久化与 `Date.now()`（官方 README：「headless 挂不上」）。所以分工是：
 *
 * | 官方的（照用，一个字不改） | 我们包的一层 |
 * |---|---|
 * | 四个工具的名字、参数形状、描述 | 谁能建 / 改 / 删（只动这件事里自己建的） |
 * | 六种时间写法的校验与报错码（`create*ScheduleRecord`） | 存进我们的调度器（落盘、重启续跑、不重入、审计事件） |
 * | 每天 / 每周几 / cron / 固定间隔的下一次怎么算（夏令时跳过、重叠取早） | 到点跑成这个岗位的一次运行（对外动作照样出卡） |
 * | 工具回给模型的那份 JSON（`scheduleView`） | 会往外发 / 写的周期任务先出卡、次数与频率上限 |
 * | 到点给模型的那段话（`renderReminderFraming`，防注入的外框） | 固定偏移时区（`+08:00`）换成官方认的 `Etc/GMT-8` |
 *
 * 子路径 `@agentsws/dsh-adapter/official-schedule`；主入口不 re-export（不把官方模块拖进别的装配）。
 */
import {
  createAfterScheduleRecord,
  createAtScheduleRecord,
  createCronScheduleRecord,
  createDailyScheduleRecord,
  createEveryScheduleRecord,
  createWeeklyScheduleRecord,
  MAX_TITLE_LENGTH,
  renderRecurringReminderBatchFraming,
  renderReminderFraming,
  resolveEveryOccurrence,
  type ScheduleCreateRequest,
  ScheduleId,
  ScheduleInputError,
  type ScheduleRecord,
  type ScheduleView,
  scheduleView,
} from '@deepseek-ai/dsh-schedule'
// WP293（dsh 0.2.1-alpha.2）：四个工具的注册从 `dsh-schedule` 的 `registerScheduleTools` 挪进了单独的插件包
// `dsh-tool-schedule`（`apply` 里 `inject(['schedule'])` 再注册）；定义本身照旧是官方的
import { apply as applyOfficialScheduleTools } from '@deepseek-ai/dsh-tool-schedule'

export type { ScheduleRecord as OfficialScheduleRecord, ScheduleView as OfficialScheduleView }

/** 六种时间写法（官方 `schedule_create` 的参数，除 `prompt` / `title` 外那几个）。 */
export type OfficialSelector = Pick<
  ScheduleCreateRequest,
  'after_seconds' | 'at' | 'every_seconds' | 'daily' | 'weekly' | 'cron'
>

const SELECTOR_KEYS = ['after_seconds', 'at', 'every_seconds', 'daily', 'weekly', 'cron'] as const

/** 官方的报错码（工具回给模型的 `code`）加我们这一层的两个。 */
export type OfficialScheduleCode =
  | ScheduleInputError['code']
  | 'schedule_not_found'
  | 'schedule_ended'
  | 'limit_reached'
  | 'internal_error'

export class OfficialScheduleError extends Error {
  constructor(
    readonly code: OfficialScheduleCode,
    message: string,
  ) {
    super(message)
    this.name = 'OfficialScheduleError'
  }
}

/** 模型 / 界面给的参数里挑出时间写法（官方参数名原样）。 */
export function selectorOf(input: Record<string, unknown>): OfficialSelector {
  const out: Record<string, unknown> = {}
  for (const k of SELECTOR_KEYS) if (input[k] !== undefined) out[k] = input[k]
  return out as OfficialSelector
}

export function selectorCount(selector: OfficialSelector): number {
  return SELECTOR_KEYS.filter((k) => selector[k] !== undefined).length
}

const FIXED_OFFSET = /^(?:UTC|GMT)?([+-])(\d{1,2})(?::?(\d{2}))?$/i

/**
 * 时区换成官方认的写法。我们的公司时区常常是固定偏移（`+08:00`，工作区档案按分钟偏移存），
 * 官方只认 `UTC` 或 IANA 名字——整小时的偏移有一一对应的 `Etc/GMT∓N`（注意符号相反，IANA 的规矩）；
 * 不是整小时的（`+05:30`）没有对应，原样交给官方去拒（报错说人话）。
 */
export function officialZone(zone: string): string {
  const z = zone.trim()
  if (z === 'Z' || z.toUpperCase() === 'UTC' || z.toUpperCase() === 'GMT') return 'UTC'
  const m = FIXED_OFFSET.exec(z)
  if (m === null || m[1] === undefined || m[2] === undefined) return z
  const hours = Number.parseInt(m[2], 10)
  const minutes = Number.parseInt(m[3] ?? '0', 10)
  if (minutes !== 0 || hours > 14) return z
  if (hours === 0) return 'UTC'
  return `Etc/GMT${m[1] === '+' ? '-' : '+'}${hours}`
}

type Zoned = { time_zone?: unknown }

/** 没写时区的补公司时区；写了固定偏移的换成官方认的写法。其余原样交给官方校验。 */
export function withZone(selector: OfficialSelector, companyZone: string): OfficialSelector {
  const fill = <T extends object>(v: T | undefined): T | undefined => {
    if (v === undefined || v === null || typeof v !== 'object') return v
    const tz = (v as Zoned).time_zone
    return {
      ...v,
      time_zone:
        typeof tz === 'string' && tz.trim() !== '' ? officialZone(tz) : officialZone(companyZone),
    }
  }
  const at = selector.at
  return {
    ...selector,
    ...(selector.daily === undefined ? {} : { daily: fill(selector.daily) }),
    ...(selector.weekly === undefined ? {} : { weekly: fill(selector.weekly) }),
    ...(selector.cron === undefined ? {} : { cron: fill(selector.cron) }),
    ...(at !== undefined && typeof at === 'object' ? { at: fill(at) } : {}),
  } as OfficialSelector
}

/**
 * 参数 → 官方校验过的一条记录（官方 `create*ScheduleRecord`；错了抛 {@link OfficialScheduleError}，码与原文照官方）。
 * `nowMs` 是注入的时钟（模拟 / 回放管得住），不读墙钟。
 */
export function officialRecord(input: {
  id: string
  title: string
  prompt: string
  selector: OfficialSelector
  nowMs: number
}): ScheduleRecord {
  const { selector, nowMs } = input
  if (selectorCount(selector) !== 1) {
    throw new OfficialScheduleError(
      'invalid_selector',
      'schedule_create requires exactly one of after_seconds, at, every_seconds, daily, weekly, or cron.',
    )
  }
  const id = ScheduleId(input.id)
  try {
    if (selector.after_seconds !== undefined)
      return createAfterScheduleRecord(id, input.prompt, selector.after_seconds, nowMs, input.title)
    if (selector.at !== undefined)
      return createAtScheduleRecord(id, input.prompt, selector.at, nowMs, input.title)
    if (selector.every_seconds !== undefined)
      return createEveryScheduleRecord(id, input.prompt, selector.every_seconds, nowMs, input.title)
    if (selector.daily !== undefined)
      return createDailyScheduleRecord(id, input.prompt, selector.daily, nowMs, input.title)
    if (selector.weekly !== undefined)
      return createWeeklyScheduleRecord(id, input.prompt, selector.weekly, nowMs, input.title)
    return createCronScheduleRecord(
      id,
      input.prompt,
      selector.cron as NonNullable<OfficialSelector['cron']>,
      nowMs,
      input.title,
    )
  } catch (e) {
    if (e instanceof ScheduleInputError) throw new OfficialScheduleError(e.code, e.message)
    throw new OfficialScheduleError('internal_error', 'The schedule operation failed.')
  }
}

export const isRecurring = (record: { kind: string }): boolean =>
  record.kind === 'every' ||
  record.kind === 'daily' ||
  record.kind === 'weekly' ||
  record.kind === 'cron'

/** 我们调度器的触发器：一次性的就是 `once`；周期的是 `rule`（原样存官方那份，时间交给 {@link officialRuleResolver}）。 */
export function triggerOf(
  record: ScheduleRecord,
): { kind: 'once'; at: string } | { kind: 'rule'; rule: Record<string, unknown> } {
  if (!isRecurring(record)) return { kind: 'once', at: record.scheduledAt }
  const { id: _id, title: _title, prompt: _prompt, ...rule } = record
  return { kind: 'rule', rule: rule as Record<string, unknown> }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const PROBE_ID = ScheduleId('probe')

/** 严格晚于 `afterMs` 的下一次（官方算法）。认不出的规则回 `undefined`（任务就此结束，不猜）。 */
function nextOfRule(rule: Record<string, unknown>, afterMs: number): string | undefined {
  try {
    switch (rule.kind) {
      case 'daily':
        return createDailyScheduleRecord(
          PROBE_ID,
          'probe',
          { time: str(rule.time), time_zone: str(rule.timeZone) },
          afterMs,
          'probe',
        ).scheduledAt
      case 'weekly':
        return createWeeklyScheduleRecord(
          PROBE_ID,
          'probe',
          {
            time: str(rule.time),
            time_zone: str(rule.timeZone),
            weekdays: Array.isArray(rule.weekdays) ? (rule.weekdays as number[]) : [],
          },
          afterMs,
          'probe',
        ).scheduledAt
      case 'cron':
        return createCronScheduleRecord(
          PROBE_ID,
          'probe',
          { expression: str(rule.expression), time_zone: str(rule.timeZone) },
          afterMs,
          'probe',
        ).scheduledAt
      case 'every': {
        const anchor = str(rule.scheduledAt)
        if (Date.parse(anchor) > afterMs) return anchor
        return resolveEveryOccurrence(
          { everySeconds: Number(rule.everySeconds), scheduledAt: anchor },
          afterMs,
        ).nextScheduledAt
      }
      default:
        return undefined
    }
  } catch {
    return undefined
  }
}

/**
 * 注入 `@agentsws/schedule` 的 `RuleResolver`：第一次 = 建的时候官方算好的那一刻（还没过就用它），
 * 之后每一次都照官方的算法往后找。
 */
export const officialRuleResolver = {
  first(rule: Record<string, unknown>, nowMs: number): string | undefined {
    const at = str(rule.scheduledAt)
    return Date.parse(at) > nowMs ? at : nextOfRule(rule, nowMs)
  },
  next: nextOfRule,
}

/** 两次之间最短隔多久（秒）：往后看三次取最小。算不出回 `undefined`。 */
export function shortestGapSeconds(record: ScheduleRecord): number | undefined {
  if (!isRecurring(record)) return undefined
  const rule = triggerOf(record)
  if (rule.kind !== 'rule') return undefined
  let at = Date.parse(record.scheduledAt)
  let min: number | undefined
  for (let i = 0; i < 3; i += 1) {
    const next = nextOfRule(rule.rule, at)
    if (next === undefined) break
    const gap = (Date.parse(next) - at) / 1000
    min = min === undefined ? gap : Math.min(min, gap)
    at = Date.parse(next)
  }
  return min
}

/** 工具回给模型的那份（官方 `scheduleView`，id 就是我们调度器里的任务 id）。 */
export function officialView(record: ScheduleRecord, nowMs: number): ScheduleView {
  return scheduleView(record, nowMs)
}

/** 到点给模型的那段话（官方的防注入外框；周期任务按官方「一批」的写法，一批只有这一条）。 */
export function reminderBrief(record: ScheduleRecord, occurrenceAt: string): string {
  if (!isRecurring(record))
    return renderReminderFraming({ ...record, scheduledAt: occurrenceAt } as never)
  return renderRecurringReminderBatchFraming([{ record: record as never, occurrenceAt }])
}

export { MAX_TITLE_LENGTH }

/** 官方注册出来的一份工具定义里我们用得上的那三样（名字、描述、参数的 JSON Schema）。 */
export interface OfficialScheduleToolShape {
  name: string
  description: string
  parameters: Record<string, unknown>
}

let officialTools: readonly OfficialScheduleToolShape[] | undefined

/**
 * 官方 `dsh-tool-schedule` 注册的四份定义（拿一个只记录的假 `tools.register` 接住；它的 `apply`
 * 先 `inject(['schedule'])`，假 ctx 当场把自己递回去；注册那一刻官方不碰 Host 服务，`execute` 才碰——
 * 我们不用它的 `execute`）。
 * dsh 那一档的工具面**直接用这四份**，stub / direct 用 `@agentsws/stand-ins` 抄的那份（测试钉逐字相等）。
 */
export function officialScheduleTools(): readonly OfficialScheduleToolShape[] {
  if (officialTools !== undefined) return officialTools
  const got: OfficialScheduleToolShape[] = []
  const toolCtx = {
    tools: {
      register(def: OfficialScheduleToolShape) {
        got.push({ name: def.name, description: def.description, parameters: def.parameters })
        return () => undefined
      },
    },
    inject(_deps: readonly string[], cb: (ctx: unknown) => void) {
      cb(toolCtx)
    },
  }
  applyOfficialScheduleTools(toolCtx as never)
  officialTools = got
  return got
}
