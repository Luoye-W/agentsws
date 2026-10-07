/**
 * WP248：决策 79 / 80 / 83 的服务端那一半（82 是看板交互，规则在契约、界面在工作台）。
 *
 * 1. **79**：「今天 N 个待办」把已过期没做完的算进来——岗位页 `counts.todos_today / todos_overdue`
 *    与每条的 `overdue`；首页 `today.due` 里补上 `horizon` 不是 today 的过期待办，并点出 `overdue_ids`。
 * 2. **80**：系统例行定时（每日计划、复盘、巡检）不进岗位「工作」，只在定时任务列表里——走真装配线钉住
 *    （过滤在 `server.ts` 按处理器名做，纯函数那一层按 `created_by` 的已由 WP241 测试钉住）。
 * 3. **83**：品牌档案三格（一句话介绍、客服邮箱、币种，默认 USD）——设置页写得进读得出、旧档案缺省兼容；
 *    第 ② 步手填确认后写进**这个品牌**的档案；AI 运行取品牌上下文时按品牌带上。
 */
import type { PositionWorkView, Todo } from '@agentsws/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'
import { buildPositionWork } from '../src/position-work.js'

const NOW = '2026-10-07T12:00:00.000Z'

const servers: Server[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
})

async function boot(): Promise<Server> {
  const server = await createServer({
    clock: { now: () => NOW },
    quiet: true,
    startRun: false,
    tokenRefreshIntervalMs: 0,
    scheduleIntervalMs: 0,
    liveDataIntervalMs: 0,
    env: { AGENTSWS_OWNER_EMAIL: 'luoye@example.com', AGENTSWS_WORKSPACE_NAME: 'INMO' },
    mdns: () => ({ reason: '测试里不开局域网' }),
    brandIntakeFetch: async () => ({ ok: false, status: 429, text: async () => '' }),
  })
  servers.push(server)
  return server
}

interface Who {
  token: string
  assignment: string
  workspace_id: string
}

const ownerOf = (server: Server): Who => ({
  token: server.bootstrap.internalToken,
  assignment: server.bootstrap.ownerAssignment.id,
  workspace_id: server.bootstrap.workspace.id,
})

async function call<T>(
  server: Server,
  who: Who,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data?: T; message?: string }> {
  const headers = new Headers({
    Authorization: `Bearer ${who.token}`,
    'X-Assignment': who.assignment,
    'content-type': 'application/json',
  })
  const res = await server.gateway.fetch(
    new Request(`http://127.0.0.1${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )
  const parsed = (await res.json()) as { data?: T; message?: string }
  return {
    status: res.status,
    ...(parsed.data === undefined ? {} : { data: parsed.data }),
    ...(parsed.message === undefined ? {} : { message: parsed.message }),
  }
}

const todo = (over: Partial<Todo>): Todo => ({
  id: 't_1',
  schema_version: 1,
  workspace_id: 'ws_1',
  title: '待办',
  owner: 'p_1',
  horizon: 'today',
  source: 'manual',
  status: 'open',
  cards: [],
  runs: [],
  created_at: NOW,
  updated_at: NOW,
  ...over,
})

describe('79：今天 N 个待办（M 个已过期）', () => {
  it('岗位页：过期没做完的算进今天、标 overdue；做完的、以后的不算', () => {
    const view = buildPositionWork({
      position_id: 'pos-x',
      now: NOW,
      today: { from: '2026-10-07T00:00:00.000Z', to: '2026-10-08T00:00:00.000Z' },
      duties: [{ role_id: 'pr.reddit', role_name: 'Reddit 营销', assignment_id: 'asg_pr' }],
      matters: [],
      todos: [
        todo({ id: 't_late', position_id: 'asg_pr', due: '2026-10-05T09:00:00.000Z' }),
        todo({
          id: 't_late_doing',
          position_id: 'asg_pr',
          status: 'doing',
          due: '2026-10-06T09:00:00.000Z',
        }),
        todo({ id: 't_today', position_id: 'asg_pr', due: '2026-10-07T18:00:00.000Z' }),
        todo({ id: 't_later', position_id: 'asg_pr', due: '2026-10-09T09:00:00.000Z' }),
        todo({
          id: 't_done_late',
          position_id: 'asg_pr',
          status: 'done',
          due: '2026-10-05T09:00:00.000Z',
          closed_at: NOW,
        }),
      ],
      schedules: [],
      posts: [],
      cards: [],
      roleName: (id) => id,
      roleOfAssignment: () => 'pr.reddit',
    })
    expect(view.counts.todos_today).toBe(3)
    expect(view.counts.todos_overdue).toBe(2)
    const overdue = view.items.filter((i) => i.overdue === true).map((i) => i.ref_id)
    expect(overdue.sort()).toEqual(['t_late', 't_late_doing'])
    expect(view.items.find((i) => i.ref_id === 't_done_late')?.overdue).toBeUndefined()
  })

  it('首页：上周记的「本周」待办今天过期了也进今天的到期清单，排最前、点名是过期的', async () => {
    const server = await boot()
    const me = ownerOf(server)
    const created = server.work.createTodo({
      owner: server.bootstrap.person.id,
      title: '回 r/INMO 版主的私信',
      source: 'manual',
      due: '2026-10-03T09:00:00.000Z',
      horizon: 'week',
    })
    server.work.createTodo({
      owner: server.bootstrap.person.id,
      title: '今天发周报',
      source: 'manual',
      due: '2026-10-07T15:00:00.000Z',
    })
    const home = await call<{ today?: { due: { todos: Todo[]; overdue_ids?: string[] } } }>(
      server,
      me,
      'GET',
      '/v1/home',
    )
    expect(home.status, home.message).toBe(200)
    const due = home.data?.today?.due
    expect(due?.todos.map((t) => t.title)).toEqual(['回 r/INMO 版主的私信', '今天发周报'])
    expect(due?.overdue_ids).toEqual([created.id])
  })
})

describe('80：系统例行定时不进岗位「工作」', () => {
  it('每日计划 / 复盘挂在本人分配上：定时任务列表里有，工作里没有；人建的照样在', async () => {
    const server = await boot()
    const me = ownerOf(server)
    const a = server.roles.assignments.create({
      person_id: server.bootstrap.person.id,
      workspace_id: server.bootstrap.workspace.id,
      role_id: 'pr.reddit',
      granted_by: server.bootstrap.person.id,
      ranges: [],
    })
    const base = {
      workspace_id: server.bootstrap.workspace.id,
      owner: server.bootstrap.person.id,
      role_id: 'pr.reddit',
      assignment_id: a.id,
      created_by: 'user' as const,
      misfire_policy: 'skip' as const,
    }
    await server.schedule.scheduler.schedule({
      ...base,
      title: '每天早上出计划卡',
      handler: 'work.daily_plan',
      trigger: { kind: 'cron', expr: '0 8 * * *', tz: 'UTC' },
    })
    await server.schedule.scheduler.schedule({
      ...base,
      title: '晚上做一次复盘',
      handler: 'work.review',
      trigger: { kind: 'cron', expr: '0 21 * * *', tz: 'UTC' },
    })
    const asPr = { ...me, assignment: a.id }
    expect(
      (
        await call(server, asPr, 'POST', '/v1/schedules', {
          title: '扫一遍 Reddit 提及',
          trigger: { kind: 'interval', every_ms: 7_200_000 },
        })
      ).status,
    ).toBe(201)

    const listed = await call<{ title?: string }[]>(server, asPr, 'GET', '/v1/schedules')
    const listedTitles = (listed.data ?? []).map((r) => r.title)
    expect(listedTitles).toEqual(
      expect.arrayContaining(['每天早上出计划卡', '晚上做一次复盘', '扫一遍 Reddit 提及']),
    )

    const work = await call<PositionWorkView>(
      server,
      asPr,
      'GET',
      `/v1/positions/${encodeURIComponent(a.id)}/work`,
    )
    expect(work.status, work.message).toBe(200)
    const titles = (work.data?.items ?? []).filter((i) => i.kind === 'schedule').map((i) => i.title)
    expect(titles).toEqual(['扫一遍 Reddit 提及'])
  })
})

interface ProfileView {
  one_liner?: string
  support_email?: string
  currency?: string
}

describe('83：品牌档案三格', () => {
  it('旧档案缺省兼容（币种读成 USD）；设置页写得进、读得出、空串清空；邮箱不像邮箱 400', async () => {
    const server = await boot()
    const me = ownerOf(server)
    const first = await call<ProfileView>(server, me, 'PUT', '/v1/workspace/profile', {
      legal_name: 'INMO',
    })
    expect(first.status, first.message).toBe(200)
    expect(first.data?.currency).toBe('USD')
    expect(first.data?.one_liner).toBeUndefined()

    const set = await call<ProfileView>(server, me, 'PUT', '/v1/workspace/profile', {
      legal_name: 'INMO',
      one_liner: '  给近视的人做的   AR 眼镜 ',
      support_email: 'support@inmo.example',
      currency: 'eur',
    })
    expect(set.data).toMatchObject({
      one_liner: '给近视的人做的 AR 眼镜',
      support_email: 'support@inmo.example',
      currency: 'EUR',
    })
    // 不给 = 不改（只改公司名的那次保存不清掉三格）
    const kept = await call<ProfileView>(server, me, 'PUT', '/v1/workspace/profile', {
      legal_name: 'INMO Tech',
    })
    expect(kept.data?.one_liner).toBe('给近视的人做的 AR 眼镜')
    // 空串 = 清空；币种清空回到 USD
    const cleared = await call<ProfileView>(server, me, 'PUT', '/v1/workspace/profile', {
      legal_name: 'INMO Tech',
      support_email: '',
      currency: '',
    })
    expect(cleared.data?.support_email).toBeUndefined()
    expect(cleared.data?.currency).toBe('USD')
    expect(
      (
        await call(server, me, 'PUT', '/v1/workspace/profile', {
          legal_name: 'INMO Tech',
          support_email: 'not-an-email',
        })
      ).status,
    ).toBe(400)
  })

  it('第 ② 步手填确认后写进这个品牌的档案（不再只活在那一轮分析的内存里）', async () => {
    const server = await boot()
    const me = ownerOf(server)
    await call(server, me, 'PUT', '/v1/workspace/profile', { legal_name: 'INMO' })
    const out = await call(server, me, 'POST', '/v1/brand-intake/manual', {
      edits: {
        one_liner: '户外滑板与配件',
        support_email: 'help@inmo.example',
        currency: 'cad',
      },
    })
    expect(out.status, out.message).toBe(201)
    expect(server.onboarding.brandProfile(server.bootstrap.workspace.id)).toMatchObject({
      one_liner: '户外滑板与配件',
      support_email: 'help@inmo.example',
      currency: 'CAD',
    })
  })

  it('AI 运行取品牌上下文时带上三格（按这次运行所在的品牌取）', async () => {
    const server = await boot()
    const me = ownerOf(server)
    await call(server, me, 'PUT', '/v1/workspace/profile', {
      legal_name: 'INMO',
      one_liner: '给近视的人做的 AR 眼镜',
      support_email: 'support@inmo.example',
      currency: 'USD',
    })
    const brand = server.personas
      .sections({ role_id: 'dtc.support', workspace_id: server.bootstrap.workspace.id })
      .find((s) => s.id === 'brand')
    expect(brand?.text).toContain('一句话定位：给近视的人做的 AR 眼镜')
    expect(brand?.text).toContain('客服邮箱：support@inmo.example')
    expect(brand?.text).toContain('币种：USD')
    // 另一个品牌（没写过三格）：一行都不带，不拿 INMO 的顶上
    const other = server.personas
      .sections({ role_id: 'dtc.support', workspace_id: 'ws_other' })
      .find((s) => s.id === 'brand')
    expect(other?.text ?? '').not.toContain('support@inmo.example')
  })
})
