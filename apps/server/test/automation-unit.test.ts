/**
 * WP181：`automation.ts` 包的那一层——谁能动、上限、出卡、改了内容旧卡不算数、每天次数上限、审计不带正文。
 * 调度器是真的（内存档 + 官方的时间算法），审批总线与事项是替身。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ApprovalItem, DecideInput, EventEnvelope, RunRequest } from '@agentsws/contracts'
import { officialRuleResolver } from '@agentsws/dsh-adapter/official-schedule'
import { createScheduler } from '@agentsws/schedule'
import { describe, expect, it } from 'vitest'
import {
  AUTOMATION_HANDLER,
  type AutomationFireCounter,
  createAutomation,
  effectOf,
  localDay,
  sqliteFireCounter,
} from '../src/automation.js'

const T0 = '2026-09-29T02:00:00.000Z'

function setup(
  opts: { limits?: Record<string, number>; enabled?: boolean; fires?: AutomationFireCounter } = {},
) {
  let t = Date.parse(T0)
  const clock = { now: () => new Date(t).toISOString() }
  const scheduler = createScheduler({ clock, rules: officialRuleResolver })
  const events: Omit<EventEnvelope, 'id' | 'at'>[] = []
  const cards: ApprovalItem[] = []
  const approvals = {
    async create(input: unknown) {
      const item = {
        ...(input as object),
        id: `apv_${cards.length + 1}`,
        state: 'pending',
      } as ApprovalItem
      cards.push(item)
      return item
    },
  }
  const bus = {
    async decide(id: string, _by: never, input: DecideInput): Promise<ApprovalItem> {
      const item = cards.find((c) => c.id === id) as ApprovalItem
      return {
        ...item,
        state: input.action === 'approve' ? 'approved' : 'rejected',
      } as ApprovalItem
    },
  }
  const runs: string[] = []
  let on = opts.enabled ?? true
  const automation = createAutomation({
    scheduler: () => scheduler,
    clock,
    appendEvent: (e) => {
      events.push(e)
    },
    approvals: () => approvals as never,
    enabled: () => on,
    companyZone: () => '+08:00',
    runner: () => ({
      work: {
        getMatter: (id: string) => ({ id, title: 'm' }),
        appendEvent: () => undefined,
      } as never,
      startRun: async (input) => {
        runs.push(input.brief)
        return { run_id: `run_${runs.length}` }
      },
    }),
    ...(opts.limits === undefined ? {} : { limits: opts.limits }),
    ...(opts.fires === undefined ? {} : { fires: opts.fires }),
    random: () => 0.5,
  })
  automation.register()
  const req = (matter = 'mat_1', assignment = 'asg_1'): RunRequest =>
    ({
      id: `run_${Math.random()}`,
      workspace_id: 'ws_1',
      actor: { person_id: 'p_1', assignment_id: assignment, role_id: 'dtc.support' },
      work_item: { id: matter, conversation_id: matter, role_id: 'dtc.support' },
    }) as unknown as RunRequest
  const call = (name: string, input: Record<string, unknown>, r = req()) =>
    automation.executeTool({ name, input, request: r })
  return {
    scheduler,
    automation,
    bus: automation.wrap(bus),
    events,
    cards,
    runs,
    call,
    req,
    advance: (ms: number) => {
      t += ms
    },
    setOn: (v: boolean) => {
      on = v
    },
  }
}

describe('包的那一层', () => {
  it('没装插件：四个工具一律拒（blocked）', async () => {
    const { call } = setup({ enabled: false })
    const out = await call('schedule_list', {})
    expect(out.status).toBe('blocked')
  })

  it('固定偏移的公司时区换成 Etc/GMT-8；没写时区补上', async () => {
    const { call, scheduler } = setup()
    const out = await call('schedule_create', {
      title: '看报表',
      prompt: '看昨天的报表',
      daily: { time: '09:00:00' },
    })
    expect(out.data).toMatchObject({ kind: 'daily', timeZone: 'Etc/GMT-8', deliveryMode: 'host' })
    const [task] = scheduler.list({ workspace_id: 'ws_1' })
    expect(task?.next_fire_at).toBe('2026-09-30T01:00:00.000Z')
  })

  it('只动这件事里自己建的：别的事项里删不掉、看不见', async () => {
    const { call, req } = setup()
    const made = (await call('schedule_create', { title: 'x', prompt: 'x', after_seconds: 600 }))
      .data as { id: string }
    const other = req('mat_2')
    expect((await call('schedule_list', {}, other)).data).toEqual([])
    expect((await call('schedule_delete', { id: made.id }, other)).data).toEqual({
      id: made.id,
      deleted: false,
      code: 'schedule_not_found',
    })
    expect((await call('schedule_delete', { id: made.id })).data).toEqual({
      id: made.id,
      deleted: true,
    })
  })

  it('上限：条数、两次之间至少 15 分钟（官方的码）', async () => {
    const { call } = setup({ limits: { per_assignment: 1 } })
    await call('schedule_create', { title: 'a', prompt: 'a', after_seconds: 600 })
    expect(
      (await call('schedule_create', { title: 'b', prompt: 'b', after_seconds: 600 })).data,
    ).toMatchObject({
      code: 'limit_reached',
    })
    const { call: call2 } = setup()
    expect(
      (await call2('schedule_create', { title: 'c', prompt: 'c', every_seconds: 300 })).data,
    ).toMatchObject({
      code: 'frequency_too_high',
    })
    // 官方自己的报错原样回（多个时间写法）
    expect(
      (
        await call2('schedule_create', {
          title: 'd',
          prompt: 'd',
          after_seconds: 60,
          every_seconds: 3600,
        })
      ).data,
    ).toMatchObject({ code: 'invalid_selector' })
  })

  it('会往外发的周期任务出卡；内容改了出新卡，旧卡批了不算数；新卡批了才开始', async () => {
    const { call, scheduler, cards, bus } = setup()
    const made = (
      await call('schedule_create', {
        title: '周报',
        prompt: '每周一把周报发邮件给老板',
        weekly: { time: '09:00:00', weekdays: [1] },
      })
    ).data as { id: string; approval?: string }
    expect(made.approval).toBe('pending')
    expect(scheduler.get(made.id)?.state).toBe('paused')
    await call('schedule_update', { id: made.id, prompt: '每周一把周报发邮件给老板和财务' })
    expect(cards).toHaveLength(2)
    await bus.decide(cards[0]?.id ?? '', undefined as never, { action: 'approve' } as DecideInput)
    expect(scheduler.get(made.id)?.state).toBe('paused')
    await bus.decide(cards[1]?.id ?? '', undefined as never, { action: 'approve' } as DecideInput)
    expect(scheduler.get(made.id)?.state).toBe('active')
    // 一次性的提醒不出卡（到点那次运行里的对外动作照样出卡）
    await call('schedule_create', { title: '寄样', prompt: '提醒我寄样品', after_seconds: 600 })
    expect(cards).toHaveLength(2)
  })

  it('每天到点自动跑有上限；到了记 automation.capped、不跑', async () => {
    const { call, scheduler, runs, events } = setup({ limits: { fires_per_day: 1 } })
    const made = (
      await call('schedule_create', {
        title: '看库存',
        prompt: '看一眼库存',
        daily: { time: '09:00:00' },
      })
    ).data as { id: string }
    await scheduler.runNow(made.id)
    const second = await scheduler.runNow(made.id)
    expect(runs).toHaveLength(1)
    expect(runs[0]).toContain('[SCHEDULE REMINDER BATCH]')
    expect(second.result).toEqual({ skipped: 'daily_cap' })
    expect(events.map((e) => e.type)).toContain('automation.capped')
    expect(scheduler.get(made.id)?.handler).toBe(AUTOMATION_HANDLER)
  })

  it('每天的次数落盘：按岗位按自然日（公司时区）计，重启不清零，第二天重新算', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentsws-wp181-fires-'))
    try {
      const path = join(dir, 'automation.sqlite')
      const first = setup({ limits: { fires_per_day: 1 }, fires: sqliteFireCounter(path) })
      const made = (
        await first.call('schedule_create', {
          title: '看库存',
          prompt: '看一眼库存',
          daily: { time: '09:00:00' },
        })
      ).data as { id: string }
      await first.scheduler.runNow(made.id)
      expect(first.runs).toHaveLength(1)
      // 「重启」：新进程、新调度器，同一份库
      const again = setup({ limits: { fires_per_day: 1 }, fires: sqliteFireCounter(path) })
      const made2 = (
        await again.call('schedule_create', {
          title: '看库存',
          prompt: '看一眼库存',
          daily: { time: '09:00:00' },
        })
      ).data as { id: string }
      expect((await again.scheduler.runNow(made2.id)).result).toEqual({ skipped: 'daily_cap' })
      expect(again.runs).toEqual([])
      // 公司时区（东八区）的第二天：重新算
      again.advance(24 * 3_600_000)
      await again.scheduler.runNow(made2.id)
      expect(again.runs).toHaveLength(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('自然日按公司时区切（UTC 16:30 在东八区已经是第二天）', () => {
    expect(localDay('2026-09-29T16:30:00.000Z', 'Etc/GMT-8')).toBe('2026-09-30')
    expect(localDay('2026-09-29T16:30:00.000Z', '+08:00')).toBe('2026-09-30')
    expect(localDay('2026-09-29T16:30:00.000Z', 'UTC')).toBe('2026-09-29')
  })

  it('审计：每次调用一条 automation.requested，不带提醒正文', async () => {
    const { call, events } = setup()
    await call('schedule_create', { title: '秘密标题', prompt: '秘密正文', after_seconds: 600 })
    const text = JSON.stringify(events)
    expect(events.map((e) => e.type)).toEqual(['automation.requested'])
    expect(text).not.toContain('秘密正文')
    expect(text).not.toContain('秘密标题')
  })

  it('执行器自己判会不会往外发', () => {
    expect(effectOf('每天把日报发邮件给老板')).toBe('sends')
    expect(effectOf('每周一 send the report')).toBe('sends')
    expect(effectOf('每天看一眼昨天的订单')).toBe('read_only')
  })
})
