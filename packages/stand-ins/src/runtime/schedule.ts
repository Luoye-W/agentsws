/**
 * WP181：官方「自动化任务」的四个工具（`schedule_create` / `schedule_list` / `schedule_update` /
 * `schedule_delete`）在三个运行时里的共用定义。
 *
 * **名字、描述、参数一个字不改**，照抄 `@deepseek-ai/dsh-schedule@0.2.0-rc.1`（MIT，Copyright (c) 2026
 * DeepSeek）`lib/index.js` 里 `registerScheduleTools` 注册的那四份——stub / direct 用这里的 JSON Schema，
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
    input_schema: { type: 'object', properties: { id: ID }, required: ['id'] },
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
