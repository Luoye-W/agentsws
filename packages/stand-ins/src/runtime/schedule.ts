/**
 * WP181：官方「自动化任务」的四个工具（`schedule_create` / `schedule_list` / `schedule_update` /
 * `schedule_delete`）在三个运行时里的共用定义。
 *
 * **名字、描述、参数一个字不改**，照抄 `@deepseek-ai/dsh-tool-schedule@0.2.1-alpha.2`（MIT，Copyright (c) 2026
 * DeepSeek）`lib/index.js` 里 `apply` 注册的那四份（WP293 之前在 `dsh-schedule` 的 `registerScheduleTools` 里）——stub / direct 用这里的 JSON Schema，
 * dsh 那一档直接用官方注册出来的定义（`dsh-adapter` 的 `official-schedule.ts`）。两份逐字相等由
 * `packages/dsh-adapter/test/official-schedule.test.ts` 钉住：上游改了描述或参数，那里先红。
 *
 * 真正干活的是服务端的执行器（`apps/server/src/automation.ts`）：谁能建 / 改 / 删、存进我们的调度器、
 * 到点跑成这个岗位的一次运行、会往外发的周期任务先出卡。**只有装了官方「自动化任务」插件**
 * （设置 → 官方插件）的运行，工具面里才有这四个名字；没装的运行字节一个不变。
 */
import type { ToolDef } from '@agentsws/contracts'

export const SCHEDULE_CREATE_TOOL = 'schedule_create'
export const SCHEDULE_LIST_TOOL = 'schedule_list'
export const SCHEDULE_UPDATE_TOOL = 'schedule_update'
export const SCHEDULE_DELETE_TOOL = 'schedule_delete'

/** 四个工具（排好序：`tools.allow` 要字节稳定）。 */
export const SCHEDULE_TOOL_NAMES: readonly string[] = [
  SCHEDULE_CREATE_TOOL,
  SCHEDULE_DELETE_TOOL,
  SCHEDULE_LIST_TOOL,
  SCHEDULE_UPDATE_TOOL,
].sort()

const bare = (name: string): string =>
  name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name

/** 名字是不是这四个之一（带不带服务前缀都认）。 */
export const isScheduleTool = (name: string): boolean => SCHEDULE_TOOL_NAMES.includes(bare(name))

const ZONE = 'UTC or IANA Area/Location, for example Asia/Shanghai.'
const EVERY =
  'Fixed-rate interval in whole seconds, at least 60, aligned to the creation time; changing it with schedule_update re-aligns it to the save time.'

/** 官方 `SELECTOR_PARAMETERS`（create 与 update 共用、顺序照官方）。 */
const SELECTOR_PROPERTIES: Record<string, unknown> = {
  every_seconds: { type: 'number', description: EVERY },
  daily: {
    type: 'object',
    description: 'Every day at a local time.',
    additionalProperties: false,
    properties: {
      time: {
        type: 'string',
        description: 'HH:mm:ss with optional 1-3 fractional digits, for example 23:00:00.',
      },
      time_zone: { type: 'string', description: ZONE },
    },
    required: ['time', 'time_zone'],
  },
  weekly: {
    type: 'object',
    description: 'On the given weekdays at a local time.',
    additionalProperties: false,
    properties: {
      time: {
        type: 'string',
        description: 'HH:mm:ss with optional 1-3 fractional digits, for example 09:00:00.',
      },
      time_zone: { type: 'string', description: ZONE },
      weekdays: {
        type: 'array',
        description: 'ISO weekdays, Monday 1 through Sunday 7, without repetitions.',
        items: { type: 'integer' },
      },
    },
    required: ['time', 'time_zone', 'weekdays'],
  },
  cron: {
    type: 'object',
    description: 'Five-field Vixie cron expression in a time zone.',
    additionalProperties: false,
    properties: {
      expression: {
        type: 'string',
        description:
          'minute hour day-of-month month day-of-week, for example "*/15 9-17 * * 1-5". When both day fields are restricted, a date matches if either one matches.',
      },
      time_zone: { type: 'string', description: ZONE },
    },
    required: ['expression', 'time_zone'],
  },
  at: {
    oneOf: [
      { type: 'string' },
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          date: { type: 'string' },
          time: { type: 'string' },
          time_zone: { type: 'string' },
        },
        required: ['date', 'time', 'time_zone'],
      },
    ],
    description:
      'Absolute target: an RFC 3339 date-time with offset, or a local date, time, and IANA time_zone.',
  },
}

const ID = { type: 'string', description: 'Schedule id returned by schedule_list.' }

/** 四份定义（官方原文）。 */
export const SCHEDULE_TOOL_DEFS: readonly ToolDef[] = [
  {
    name: SCHEDULE_CREATE_TOOL,
    description:
      'Create a reminder in the current session that delivers prompt when it becomes due. Supply exactly one timing parameter: after_seconds, at, every_seconds, daily, weekly, or cron. Local times that do not exist in the zone are skipped; repeated local times fire once, at the earlier instant. After downtime, a recurring reminder delivers only its latest missed occurrence. Delivery can repeat after a crash.',
    input_schema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Reminder content to present when the target becomes due.',
        },
        title: {
          type: 'string',
          description:
            'Task name of at most 120 characters, shown on the task card and in task lists.',
        },
        after_seconds: { type: 'number', description: 'Delay in whole seconds.' },
        ...SELECTOR_PROPERTIES,
      },
      required: ['prompt', 'title'],
    },
  },
  {
    name: SCHEDULE_LIST_TOOL,
    description: 'List the active reminders in the current session.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: SCHEDULE_DELETE_TOOL,
    description:
      'Delete a reminder in the current session, active or inactive. Deletion does not retract a reminder message that is already queued.',
    // WP293（dsh 0.2.1-alpha.2）：官方把删除这一个的 id 说明改成了 "Exact schedule id."（改那一个还是原来那句）
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Exact schedule id.' } },
      required: ['id'],
    },
  },
  {
    name: SCHEDULE_UPDATE_TOOL,
    description:
      'Change a reminder in place, keeping its id. Supply a new title, prompt, or at most one timing parameter; omitted fields keep their stored values. To change a relative delay, create a new reminder.',
    input_schema: {
      type: 'object',
      properties: {
        id: ID,
        title: { type: 'string', description: 'New task name of at most 120 characters.' },
        prompt: { type: 'string', description: 'New reminder content.' },
        ...SELECTOR_PROPERTIES,
      },
      required: ['id'],
    },
  },
]

export const SCHEDULE_TOOL_DEF_BY_NAME: ReadonlyMap<string, ToolDef> = new Map(
  SCHEDULE_TOOL_DEFS.map((d) => [d.name, d]),
)

/* ── stub 的剧本（模拟与演示用；只有工具面里有 `schedule_create` 的运行才走得到）──────────── */

const ASKS = /提醒我|每天|每周|工作日|分钟后|小时后|定时/
const WEEKDAY: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 }

/** 「下午 3 点半」「9:30」「早上 8 点」→ `HH:mm:00`；没说几点就是 09:00。 */
function clockOf(text: string): string {
  const m = /(上午|早上|中午|下午|晚上)?\s*(\d{1,2})\s*(?:[点:：时])\s*(半|\d{1,2})?/.exec(text)
  if (m === null || m[2] === undefined) return '09:00:00'
  let hour = Number.parseInt(m[2], 10)
  if ((m[1] === '下午' || m[1] === '晚上') && hour < 12) hour += 12
  const minute = m[3] === '半' ? 30 : m[3] === undefined ? 0 : Number.parseInt(m[3], 10)
  const pad = (n: number): string => String(Math.min(n, 59)).padStart(2, '0')
  return `${String(Math.min(hour, 23)).padStart(2, '0')}:${pad(minute)}:00`
}

/**
 * stub 的岔口：工具面里有 `schedule_create`、话里在要提醒 / 定时，才走这一边（回要调的入参）；
 * 到点那次运行（官方外框 `[SCHEDULE REMINDER`）一律不走——不然每天到点又建一条。
 * 时区不写：执行器按公司时区补（我们包的那一层）。
 */
export function scheduleBranch(
  allow: readonly string[],
  text: string,
): Record<string, unknown> | undefined {
  if (!allow.includes(SCHEDULE_CREATE_TOOL)) return undefined
  if (text.includes('[SCHEDULE REMINDER') || !ASKS.test(text)) return undefined
  const line = text.trim().split('\n')[0]?.trim() ?? ''
  const title = line.length > 24 ? `${line.slice(0, 24)}…` : line
  const base = { title: title === '' ? '提醒' : title, prompt: line === '' ? '提醒' : line }
  const minutes = /(\d+)\s*分钟后/.exec(text)
  if (minutes?.[1] !== undefined) return { ...base, after_seconds: Number(minutes[1]) * 60 }
  const hours = /(\d+)\s*小时后/.exec(text)
  if (hours?.[1] !== undefined) return { ...base, after_seconds: Number(hours[1]) * 3600 }
  const time = clockOf(text)
  if (/工作日/.test(text)) return { ...base, weekly: { time, weekdays: [1, 2, 3, 4, 5] } }
  const week = /每周([一二三四五六日天、,，和及]+)/.exec(text)
  if (week?.[1] !== undefined) {
    const days = [...new Set([...week[1]].map((c) => WEEKDAY[c]).filter((d) => d !== undefined))]
    if (days.length > 0) return { ...base, weekly: { time, weekdays: days.sort() } }
  }
  return { ...base, daily: { time } }
}

/** stub 回话：设成了说哪天几点，等批的说等你批，没设成照实说官方的原话。 */
export function renderScheduleAnswer(data: unknown): string {
  const o = data !== null && typeof data === 'object' ? (data as Record<string, unknown>) : {}
  if (typeof o.code === 'string') return `这条定时没设成：${String(o.message ?? o.code)}`
  const title = typeof o.title === 'string' ? o.title : '提醒'
  const at = typeof o.scheduledAt === 'string' ? o.scheduledAt : ''
  if (o.approval === 'pending') {
    return `**${title}** 到点会往外发东西，我先出了一张卡，你批了才开始。`
  }
  return `设好了：**${title}**，下一次在 ${at}。到点我会接着这件事再跑一次。`
}
