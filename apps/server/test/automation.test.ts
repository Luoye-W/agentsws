/**
 * WP181：官方「自动化任务」在我们的运行里真用起来（真服务进程，替身模型，不联网）。
 *
 * - 关着：工具面里没有四个工具，说「每天 9 点提醒我」只是一次普通运行；
 * - 开着（WP293 起缺省一直开——官方把「自动化任务」收进 Web，不再是可选插件）：同一句话 → 调 `schedule_create`（官方参数）→ 存进我们的调度器（`rule` 触发器、官方记录原样）；
 *   到点接着原来那件事跑一次（官方外框）；
 * - 右栏面板改「每天 / 每周几点」走 `PATCH /v1/schedules/:id { rule }`（官方校验、官方算下一次）；
 * - 会往外发的周期任务先出卡、停着；批了才开始；
 * - 关掉：到点不跑，任务留着。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ApprovalItem } from '@agentsws/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { AUTOMATION_HANDLER } from '../src/automation.js'
import { createServer, type Server } from '../src/index.js'
import { SECRETS_KEY_ENV } from '../src/secret-store.js'

const T0 = '2026-09-29T02:00:00.000Z'

let server: Server | undefined
let dir = ''

afterEach(async () => {
  await server?.close()
  server = undefined
  if (dir !== '') rmSync(dir, { recursive: true, force: true })
  dir = ''
})

/**
 * WP293：开关不再是「官方插件装没装」（官方把「自动化任务」可选包删了、收进 Web 自己挂），
 * 服务端缺省一直开；这里注入一个能翻的开关，钉「关了就停、任务留着」那几条照旧成立。
 */
async function boot(installed: boolean) {
  dir = mkdtempSync(join(tmpdir(), 'agentsws-wp181-'))
  const switchState = { on: installed }
  const automation = {
    turnOff: () => {
      switchState.on = false
    },
  }
  let t = Date.parse(T0)
  const clock = { now: () => new Date(t).toISOString() }
  server = await createServer({
    dbDir: dir,
    quiet: true,
    clock,
    scheduleIntervalMs: 0,
    tokenRefreshIntervalMs: 0,
    env: { [SECRETS_KEY_ENV]: 'c'.repeat(64) },
    automationEnabled: () => switchState.on,
  })
  const s = server
  const api = (path: string, init: { method?: string; body?: unknown } = {}) => {
    const headers = new Headers()
    headers.set('Authorization', `Bearer ${s.bootstrap.internalToken}`)
    headers.set('X-Assignment', s.bootstrap.ownerAssignment.id)
    if (init.body !== undefined) headers.set('content-type', 'application/json')
    return s.gateway.fetch(
      new Request(`http://127.0.0.1${path}`, {
        method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
        headers,
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      }),
    )
  }
  const data = async <T>(res: Response): Promise<T> => {
    const parsed = (await res.json()) as { data?: T; code?: string; message?: string }
    if (parsed.data === undefined) throw new Error(`没有 data：${parsed.code} ${parsed.message}`)
    return parsed.data
  }
  const events = (type: string) =>
    s.kernel.eventLog
      .readSync({ workspace_id: s.bootstrap.workspace.id })
      .filter((e) => e.type === type)
  const tasks = () =>
    s.schedule.scheduler
      .list({ workspace_id: s.bootstrap.workspace.id })
      .filter((x) => x.handler === AUTOMATION_HANDLER)
  const say = async (text: string) => {
    const { matter } = await data<{ matter: { id: string } }>(
      await api('/v1/matters', { body: { kind: 'conversation', title: text } }),
    )
    const out = await data<{ run_id?: string }>(
      await api(`/v1/matters/${matter.id}/messages`, { body: { text } }),
    )
    return { matter_id: matter.id, run_id: out.run_id }
  }
  const advance = (ms: number) => {
    t += ms
  }
  return { s, api, data, events, tasks, say, advance, automation, clock }
}

describe('WP181 官方「自动化任务」', () => {
  it('关着：工具面里没有四个工具，同一句话不建定时', async () => {
    const { say, tasks, events } = await boot(false)
    await say('每天早上 9 点提醒我看昨天的订单')
    expect(tasks()).toEqual([])
    expect(events('automation.requested')).toEqual([])
  })

  it('开着（缺省）：建 → 存进调度器（官方记录）→ 到点接着那件事跑 → 面板改成每周', async () => {
    const { s, api, data, events, tasks, say } = await boot(true)
    const { matter_id } = await say('每天早上 9 点提醒我看昨天的订单')
    const [task] = tasks()
    expect(task?.trigger).toMatchObject({
      kind: 'rule',
      rule: { kind: 'daily', time: '09:00:00.000' },
    })
    expect(task?.origin?.conversation_id).toBe(matter_id)
    expect(task?.created_by).toBe('agent')
    expect(task?.state).toBe('active')
    expect(task?.params?.official).toMatchObject({
      kind: 'daily',
      prompt: '每天早上 9 点提醒我看昨天的订单',
    })
    expect(events('automation.requested').map((e) => e.payload)).toEqual([
      expect.objectContaining({ tool: 'schedule_create', outcome: 'created', task_id: task?.id }),
    ])
    // 审计里不带提醒正文
    expect(JSON.stringify(events('automation.requested'))).not.toContain('昨天的订单')

    const fired = await s.schedule.scheduler.runNow(task?.id ?? '')
    expect(fired.ok).toBe(true)
    const timeline = s.work.matterView(matter_id).timeline.map((e) => e.text)
    expect(timeline.some((x) => x.startsWith('到点了：'))).toBe(true)
    expect(timeline.some((x) => x.startsWith('到点接着这件事跑了一次'))).toBe(true)
    // 到点那次运行不会又建一条（官方外框里有 `[SCHEDULE REMINDER`）
    expect(tasks()).toHaveLength(1)

    const patched = await data<{
      trigger: { rule: Record<string, unknown> }
      next_fire_at: string
    }>(
      await api(`/v1/schedules/${task?.id}`, {
        method: 'PATCH',
        body: { rule: { weekly: { time: '10:30:00', weekdays: [1, 3] } } },
      }),
    )
    expect(patched.trigger.rule).toMatchObject({
      kind: 'weekly',
      time: '10:30:00.000',
      weekdays: [1, 3],
    })
    // 2026-09-29 是周二；下一次是周三 10:30（公司时区缺省按本机，这里只看是周三）
    expect(new Date(patched.next_fire_at).getUTCDay()).toBe(3)

    const bad = await api(`/v1/schedules/${task?.id}`, {
      method: 'PATCH',
      body: { rule: { cron: { expression: '*/5 * * * *' } } },
    })
    expect(bad.status).toBe(400)
  })

  it('会往外发的周期任务：先出卡、停着；批了才开始', async () => {
    const { s, api, data, tasks, say } = await boot(true)
    await say('每周一 9 点给老客户群发邮件问好')
    const [task] = tasks()
    expect(task?.state).toBe('paused')
    expect(task?.params?.awaiting_approval).toBe(true)
    const queue = await data<{ items: ApprovalItem[] } | ApprovalItem[]>(await api('/v1/approvals'))
    const items = Array.isArray(queue) ? queue : queue.items
    const card = items.find((i) => i.kind === 'scheduled_task')
    expect(card?.payload).toMatchObject({ task_id: task?.id, effect: 'sends' })
    // 还在等批时内容又改了：总线按键改写同一张卡（不多出一张），卡上是新内容
    const req = {
      id: 'run_edit',
      workspace_id: s.bootstrap.workspace.id,
      actor: {
        person_id: task?.owner,
        assignment_id: task?.assignment_id,
        role_id: task?.role_id,
      },
      work_item: { id: task?.origin?.conversation_id },
    } as never
    await s.automation.executeTool({
      name: 'schedule_update',
      input: { id: task?.id, prompt: '每周一 9 点给老客户群发邮件问好，附上新品' },
      request: req,
    })
    const again = await data<{ items: ApprovalItem[] } | ApprovalItem[]>(await api('/v1/approvals'))
    const cardsNow = (Array.isArray(again) ? again : again.items).filter(
      (i) => i.kind === 'scheduled_task',
    )
    expect(cardsNow).toHaveLength(1)
    expect(cardsNow[0]?.payload).toMatchObject({
      prompt: '每周一 9 点给老客户群发邮件问好，附上新品',
    })
    await api(`/v1/approvals/${cardsNow[0]?.id}/decide`, { body: { action: 'approve' } })
    const after = tasks()[0]
    expect(after?.state).toBe('active')
    expect(after?.params?.approved).toBe(true)
  })

  it('关掉：到点不跑，任务留着', async () => {
    const { s, tasks, say, automation } = await boot(true)
    const { matter_id } = await say('30 分钟后提醒我回电话')
    const [task] = tasks()
    expect(task?.trigger.kind).toBe('once')
    automation.turnOff()
    const out = await s.schedule.scheduler.runNow(task?.id ?? '')
    expect(out.result).toEqual({ skipped: 'plugin_off' })
    expect(s.work.matterView(matter_id).timeline.some((e) => e.text.startsWith('到点了'))).toBe(
      false,
    )
    expect(tasks()).toHaveLength(1)
  })
})
