/**
 * WP181：官方「自动化任务」在我们运行里用起来的那一层（`src/official-schedule.ts`）。
 *
 * 1. 三个运行时看到的四个工具**与官方注册的逐字相等**（stub / direct 用 stand-ins 抄的那份）；
 * 2. 时间写法的校验、报错码、下一次怎么算——全是官方的函数，这里钉住我们接得对；
 * 3. 我们包的两处：固定偏移时区换成官方认的写法、没写时区补公司时区。
 */
import { SCHEDULE_TOOL_DEFS, SCHEDULE_TOOL_NAMES } from '@agentsws/stand-ins'
import { renderReminderFraming, ScheduleId } from '@deepseek-ai/dsh-schedule'
import { describe, expect, it } from 'vitest'
import {
  OfficialScheduleError,
  officialRecord,
  officialRuleResolver,
  officialScheduleTools,
  officialZone,
  reminderBrief,
  selectorOf,
  shortestGapSeconds,
  triggerOf,
  withZone,
} from '../src/official-schedule.js'

const NOW = Date.parse('2026-09-29T10:00:00.000Z')

describe('四个工具：官方原文', () => {
  it('stand-ins 抄的那份与官方注册的逐字相等（名字、描述、参数）', () => {
    const official = officialScheduleTools()
    expect(official.map((t) => t.name).sort()).toEqual([...SCHEDULE_TOOL_NAMES])
    for (const def of SCHEDULE_TOOL_DEFS) {
      const o = official.find((t) => t.name === def.name)
      expect(o, def.name).toBeDefined()
      expect(def.description).toBe(o?.description)
      expect(JSON.stringify(def.input_schema)).toBe(JSON.stringify(o?.parameters))
    }
  })
})

describe('时区：固定偏移换成官方认的写法', () => {
  it('整小时 → Etc/GMT∓N（符号相反）；UTC 系列 → UTC；IANA 与半小时原样', () => {
    expect(officialZone('+08:00')).toBe('Etc/GMT-8')
    expect(officialZone('-05:00')).toBe('Etc/GMT+5')
    expect(officialZone('UTC+8')).toBe('Etc/GMT-8')
    expect(officialZone('+00:00')).toBe('UTC')
    expect(officialZone('Z')).toBe('UTC')
    expect(officialZone('Asia/Shanghai')).toBe('Asia/Shanghai')
    expect(officialZone('+05:30')).toBe('+05:30')
  })

  it('没写时区补公司时区；写了固定偏移的换掉', () => {
    const s = withZone(
      selectorOf({ daily: { time: '09:00:00' }, title: 'x', prompt: 'y' }),
      '+08:00',
    )
    expect(s).toEqual({ daily: { time: '09:00:00', time_zone: 'Etc/GMT-8' } })
    expect(
      withZone({ weekly: { time: '09:00:00', time_zone: '+09:00', weekdays: [1] } }, 'UTC'),
    ).toEqual({ weekly: { time: '09:00:00', time_zone: 'Etc/GMT-9', weekdays: [1] } })
  })
})

describe('建一条：官方校验', () => {
  const base = { id: 'sched_1', title: '看报表', prompt: '提醒我看昨天的报表', nowMs: NOW }

  it('每天 9 点（公司时区东八区）→ 明早 01:00Z，触发器是 rule', () => {
    const r = officialRecord({
      ...base,
      selector: { daily: { time: '09:00:00', time_zone: 'Asia/Shanghai' } },
    })
    expect(r.scheduledAt).toBe('2026-09-30T01:00:00.000Z')
    const t = triggerOf(r)
    expect(t.kind).toBe('rule')
    expect(t.kind === 'rule' ? t.rule : {}).toEqual({
      kind: 'daily',
      time: '09:00:00.000',
      timeZone: 'Asia/Shanghai',
      scheduledAt: '2026-09-30T01:00:00.000Z',
    })
  })

  it('一次性的（after / at）是 once', () => {
    const r = officialRecord({ ...base, selector: { after_seconds: 600 } })
    expect(triggerOf(r)).toEqual({ kind: 'once', at: '2026-09-29T10:10:00.000Z' })
  })

  it('报错码与原文照官方：多个时间写法 / 过去的时刻 / 太频繁 / 时区认不出', () => {
    const code = (selector: Record<string, unknown>): string => {
      try {
        officialRecord({ ...base, selector })
        return 'ok'
      } catch (e) {
        return e instanceof OfficialScheduleError ? e.code : 'other'
      }
    }
    expect(code({ after_seconds: 60, every_seconds: 120 })).toBe('invalid_selector')
    expect(code({})).toBe('invalid_selector')
    expect(code({ at: '2020-01-01T00:00:00Z' })).toBe('not_future')
    expect(code({ every_seconds: 30 })).toBe('frequency_too_high')
    expect(code({ daily: { time: '09:00:00', time_zone: '+08:00' } })).toBe('invalid_time_zone')
    expect(code({ daily: { time: '9:00', time_zone: 'Asia/Shanghai' } })).toBe('invalid_rule')
  })
})

describe('下一次怎么算：官方算法', () => {
  it('每周一、三 9 点：周三之后是下周一', () => {
    const r = officialRecord({
      id: 's',
      title: 't',
      prompt: 'p',
      nowMs: NOW,
      selector: { weekly: { time: '09:00:00', time_zone: 'Asia/Shanghai', weekdays: [3, 1] } },
    })
    const t = triggerOf(r)
    if (t.kind !== 'rule') throw new Error('want rule')
    expect(officialRuleResolver.first(t.rule, NOW)).toBe('2026-09-30T01:00:00.000Z')
    expect(officialRuleResolver.next(t.rule, Date.parse('2026-09-30T01:00:00.000Z'))).toBe(
      '2026-10-05T01:00:00.000Z',
    )
  })

  it('夏令时那天不存在的 02:30 跳过（纽约 2027-03-14）', () => {
    const rule = { kind: 'daily', time: '02:30:00.000', timeZone: 'America/New_York' }
    const before = Date.parse('2027-03-13T12:00:00.000Z')
    const first = officialRuleResolver.next(rule, before)
    expect(first).toBe('2027-03-15T06:30:00.000Z')
  })

  it('固定间隔：对齐建的那一刻，错过几次也只排下一次', () => {
    const r = officialRecord({
      id: 's',
      title: 't',
      prompt: 'p',
      nowMs: NOW,
      selector: { every_seconds: 3600 },
    })
    const t = triggerOf(r)
    if (t.kind !== 'rule') throw new Error('want rule')
    expect(officialRuleResolver.first(t.rule, NOW)).toBe('2026-09-29T11:00:00.000Z')
    expect(officialRuleResolver.next(t.rule, Date.parse('2026-09-29T13:30:00.000Z'))).toBe(
      '2026-09-29T14:00:00.000Z',
    )
  })

  it('最短间隔：cron 每 5 分钟 = 300 秒；一次性的没有', () => {
    const cron = officialRecord({
      id: 's',
      title: 't',
      prompt: 'p',
      nowMs: NOW,
      selector: { cron: { expression: '*/5 * * * *', time_zone: 'UTC' } },
    })
    expect(shortestGapSeconds(cron)).toBe(300)
    const once = officialRecord({
      id: 's',
      title: 't',
      prompt: 'p',
      nowMs: NOW,
      selector: { after_seconds: 60 },
    })
    expect(shortestGapSeconds(once)).toBeUndefined()
  })
})

describe('到点给模型的那段话', () => {
  it('一次性的就是官方外框（occurrence_at 是这一次）', () => {
    const r = officialRecord({
      id: 'sched_9',
      title: '看报表',
      prompt: '看报表',
      nowMs: NOW,
      selector: { after_seconds: 60 },
    })
    expect(reminderBrief(r, r.scheduledAt)).toBe(
      renderReminderFraming({ ...r, id: ScheduleId('sched_9') }),
    )
  })

  it('周期的用官方「一批」的写法', () => {
    const r = officialRecord({
      id: 'sched_2',
      title: '日报',
      prompt: '汇总昨天的订单',
      nowMs: NOW,
      selector: { daily: { time: '09:00:00', time_zone: 'UTC' } },
    })
    const text = reminderBrief(r, '2026-09-30T09:00:00.000Z')
    expect(text.split('\n')[0]).toBe('[SCHEDULE REMINDER BATCH]')
    expect(text).toContain('"reminder_prompt":"汇总昨天的订单"')
  })
})

describe('dsh 那一档的工具面', () => {
  it('四个工具用官方注册的描述与参数；执行照旧走注入的出口', async () => {
    const { buildToolDefinitions } = await import('../src/tools.js')
    const { makeRequest } = await import('./helpers.js')
    const calls: { name: string; input: Record<string, unknown> }[] = []
    const defs = buildToolDefinitions(
      makeRequest({ allow: ['get_order', ...SCHEDULE_TOOL_NAMES] }),
      {
        run: async (name, input) => {
          calls.push({ name, input })
          return { status: 'ok' as const, data: { id: 'sched_1' } }
        },
        note: () => undefined,
        provenance: () => undefined,
      },
      { stage: async () => undefined, draft: async () => ({ status: 'failed' }) as never },
    )
    for (const o of officialScheduleTools()) {
      const d = defs.find((x) => x.name === o.name)
      expect(d?.description).toBe(o.description)
      expect(d?.parameters).toEqual(o.parameters)
    }
    const create = defs.find((x) => x.name === 'schedule_create')
    await create?.execute(
      { title: 't', prompt: 'p', daily: { time: '09:00:00', time_zone: 'UTC' } } as never,
      { callId: 'c1' } as never,
    )
    expect(calls).toEqual([
      {
        name: 'schedule_create',
        input: { title: 't', prompt: 'p', daily: { time: '09:00:00', time_zone: 'UTC' } },
      },
    ])
  })
})
