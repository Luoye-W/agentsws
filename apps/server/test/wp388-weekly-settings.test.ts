/**
 * WP388（docs/103 S3）：跟 AI 说「周复盘改到周五下午 5 点」→ `request_setup` 的「改设置」卡（WP334 / 决策 841）
 * → 人确认 → 那条定时改成周五 17:00（时区照旧）。不确认不动。
 */
import type { ApprovalBus, ApprovalItem, SetupRequestPayload } from '@agentsws/contracts'
import { createScheduler } from '@agentsws/schedule'
import { describe, expect, it } from 'vitest'
import { ensureSystemTasks } from '../src/schedule.js'
import { createSetupCards } from '../src/setup-cards.js'
import { createSetupRequestTool } from '../src/setup-request-tool.js'
import {
  formatWeekly,
  parseWeekly,
  WEEKLY_REPORTS_TARGET,
  weeklyReportsSetupTarget,
} from '../src/weekly-report-settings.js'

const actor = { person_id: 'p_1', assignment_id: 'asg_1', role_id: 'common.owner' } as never

function fakeBus(): ApprovalBus & { items: Map<string, ApprovalItem> } {
  const items = new Map<string, ApprovalItem>()
  let n = 0
  return {
    items,
    async create(raw: Partial<ApprovalItem>) {
      n += 1
      const item = { ...raw, id: `apr_${n}`, state: 'pending', revision: 1 } as ApprovalItem
      items.set(item.id, item)
      return item
    },
    async get(id: string) {
      return items.get(id)
    },
    async withdraw(id: string) {
      const it = items.get(id) as ApprovalItem
      it.state = 'withdrawn'
      return it
    },
  } as never
}

const decide = (bus: ReturnType<typeof fakeBus>, id: string, action: string) => {
  const it = bus.items.get(id) as ApprovalItem
  it.state = action === 'reject' ? 'rejected' : 'approved'
  it.decision = { action } as never
  return it
}

async function setup() {
  const scheduler = createScheduler({ clock: { now: () => '2026-10-18T00:00:00.000Z' } })
  await ensureSystemTasks(scheduler, {
    workspace_id: 'ws_1',
    owner: 'p_1',
    role_id: 'common.owner',
    assignment_id: 'asg_1',
    tz: 'Asia/Shanghai',
    positions: [{ assignment_id: 'asg_1', person_id: 'p_1', role_id: 'common.owner' }],
    has: { work: true, weeklyReview: true },
  })
  const bus = fakeBus()
  const cards = createSetupCards({
    workspace_id: 'ws_1',
    clock: { now: () => '2026-10-18T00:00:00.000Z' },
    approvals: () => bus,
    isConnected: async () => true,
    resume: async () => undefined,
  })
  cards.registerTarget(
    weeklyReportsSetupTarget({ scheduler: () => scheduler, workspace_id: 'ws_1' }),
  )
  return { scheduler, bus, cards }
}

describe('WP388 周报几点出：写法', () => {
  it('认「周五 17:00」「星期五下午5点」「周三 9点半」「Fri 5pm」；认不出回 undefined', () => {
    expect(parseWeekly('周五 17:00')).toEqual({ weekday: 5, hour: 17, minute: 0 })
    expect(parseWeekly('星期五下午5点')).toEqual({ weekday: 5, hour: 17, minute: 0 })
    expect(parseWeekly('周三 9点半')).toEqual({ weekday: 3, hour: 9, minute: 30 })
    expect(parseWeekly('周日 20：15')).toEqual({ weekday: 0, hour: 20, minute: 15 })
    expect(parseWeekly('Fri 5pm')).toEqual({ weekday: 5, hour: 17, minute: 0 })
    expect(parseWeekly('17:00')).toBeUndefined()
    expect(parseWeekly('周五')).toBeUndefined()
    expect(
      formatWeekly({ trigger: { kind: 'cron', expr: '30 16 * * 1', tz: 'UTC' } } as never),
    ).toBe('周一 16:30')
  })
})

describe('WP388 改设置卡改周复盘的时间', () => {
  it('方案卡上每份一格、默认那格带理由；AI 给「周五 17:00」→ 现值 → 新值；确认才改、时区照旧', async () => {
    const { scheduler, bus, cards } = await setup()

    // AI：request_setup（已设好 + 带新值 = 提议改）
    const tool = createSetupRequestTool({
      directory: async () => [],
      isConnected: async () => undefined,
      target: async (id) => cards.target(id),
      targetIds: async () => cards.targetIds(),
    })
    const r = await tool(
      {
        name: 'request_setup',
        input: {
          setting: WEEKLY_REPORTS_TARGET,
          why: '你说周复盘改到周五下午 5 点',
          suggestions: [{ key: 'review_week', value: '周五 17:00', why: '你说的' }],
        },
      } as never,
      {} as never,
    )
    expect(r.data).toMatchObject({ needs_setup: WEEKLY_REPORTS_TARGET, change: true })

    const out = await cards.askSetup({
      target: WEEKLY_REPORTS_TARGET,
      actor,
      change: true,
      suggestions: { review_week: '周五 17:00' },
      reasons: { review_week: '你说的' },
    })
    const p = out?.item.payload as SetupRequestPayload
    expect(p.mode).toBe('change')
    expect(p.fields.find((f) => f.key === 'review_week')).toMatchObject({
      current: '周一 16:30',
      suggested: '周五 17:00',
    })
    expect(p.fields.find((f) => f.key === 'weekly_review')).toMatchObject({
      current: '周一 16:30',
      suggested: '周一 16:30',
    })

    // 不确认：不动
    await cards.onDecided(decide(bus, out?.item.id as string, 'reject'))
    expect(scheduler.get('sched_review_week_asg_1')?.trigger).toMatchObject({ expr: '30 16 * * 1' })

    // 再提、确认：周复盘改成周五 17:00（时区照旧），一页纸不动
    const two = await cards.askSetup({
      target: WEEKLY_REPORTS_TARGET,
      actor,
      change: true,
      suggestions: { review_week: '周五 17:00' },
    })
    await cards.onDecided(decide(bus, two?.item.id as string, 'approve'))
    expect(scheduler.get('sched_review_week_asg_1')?.trigger).toEqual({
      kind: 'cron',
      expr: '0 17 * * 5',
      tz: 'Asia/Shanghai',
    })
    expect(scheduler.get('sched_weekly_review')?.trigger).toMatchObject({ expr: '30 16 * * 1' })
    // 再重启一次（ensure）：用户改过的不被新默认覆盖
    await ensureSystemTasks(scheduler, {
      workspace_id: 'ws_1',
      owner: 'p_1',
      role_id: 'common.owner',
      assignment_id: 'asg_1',
      tz: 'Asia/Shanghai',
      positions: [{ assignment_id: 'asg_1', person_id: 'p_1', role_id: 'common.owner' }],
      has: { work: true, weeklyReview: true },
    })
    expect(scheduler.get('sched_review_week_asg_1')?.trigger).toMatchObject({ expr: '0 17 * * 5' })
  })

  it('已经设好 = 不缺什么（不带新值不出卡）；格子里默认那格的问号是「为什么默认周一」', async () => {
    const { cards, scheduler } = await setup()
    expect(await cards.askSetup({ target: WEEKLY_REPORTS_TARGET, actor })).toBeUndefined()
    const fields = await weeklyReportsSetupTarget({
      scheduler: () => scheduler,
      workspace_id: 'ws_1',
    }).fields()
    // 这个品牌没有 SEO 周报那条（没人担内容与搜索）：只有两格
    expect(fields.map((f) => f.key)).toEqual(['review_week', 'weekly_review'])
    const f = fields.find((x) => x.key === 'review_week')
    expect(f?.suggested).toBe('周一 16:30')
    expect(f?.suggested_why ?? '').toContain('美国那边上一周刚结束')
  })
})
