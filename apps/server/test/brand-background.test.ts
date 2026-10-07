/**
 * WP215（52 §4 收口）：**每个品牌的后台活同时跑，与眼前切在哪个品牌无关；每条任务只用自己品牌的东西。**
 *
 * 覆盖的验收点（派工单第 5 条「服务端」）：
 * - 两个品牌各建定时任务，视图停在 A 时 B 的任务准点触发，结果只进 B 的卡片流 / 事件；
 * - 新建品牌时它那一套系统任务**立刻**建好（不用重启），B 的收信照常、只收 B 的邮箱；
 * - B 品牌急停只停 B：B 的任务到点不跑、B 的对外发送与模型被拦，A 照常；放开之后补跑；
 * - 品牌一览 / 设置页那一格：在跑几条、最近一次、停没停；全进程并发上限写进设置。
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BackgroundSettingsView, BrandBackgroundView, BrandView } from '@agentsws/api'
import { afterEach, describe, expect, it } from 'vitest'
import { BACKGROUND_FILE } from '../src/brand-background.js'
import { createServer, type Server } from '../src/index.js'
import { HANDLERS } from '../src/schedule.js'
import { SECRETS_KEY_ENV } from '../src/secret-store.js'

const T0 = '2026-10-05T02:00:00.000Z'
const SECRETS_KEY = 'b'.repeat(64)

function makeClock(start = T0) {
  let t = Date.parse(start)
  return {
    now: () => new Date(t).toISOString(),
    advance: (ms: number) => {
      t += ms
    },
  }
}

function seeded(seed = 11): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const servers: Server[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
})

async function boot(
  clock = makeClock(),
  extra: { dbDir?: string } = {},
): Promise<{ server: Server; clock: ReturnType<typeof makeClock> }> {
  const server = await createServer({
    clock,
    random: seeded(),
    quiet: true,
    startRun: false,
    tokenRefreshIntervalMs: 0,
    scheduleIntervalMs: 0,
    liveDataIntervalMs: 0,
    env: {
      AGENTSWS_OWNER_EMAIL: 'wang@nordvolt.cn',
      AGENTSWS_WORKSPACE_NAME: 'INMO 代运营',
      [SECRETS_KEY_ENV]: SECRETS_KEY,
    },
    mdns: () => ({ reason: '测试里不开局域网' }),
    ...(extra.dbDir === undefined ? {} : { dbDir: extra.dbDir }),
  })
  servers.push(server)
  return { server, clock }
}

interface Who {
  workspace_id: string
  token: string
  assignment: string
}

async function call<T>(
  server: Server,
  who: Who,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data?: T; code?: string }> {
  const headers = new Headers({ 'content-type': 'application/json' })
  headers.set('Authorization', `Bearer ${who.token}`)
  headers.set('X-Assignment', who.assignment)
  const res = await server.gateway.fetch(
    new Request(`http://127.0.0.1${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )
  const parsed = (await res.json()) as { data?: T; code?: string }
  return {
    status: res.status,
    ...(parsed.data === undefined ? {} : { data: parsed.data }),
    ...(parsed.code === undefined ? {} : { code: parsed.code }),
  }
}

const bootstrapWho = (server: Server): Who => ({
  workspace_id: server.bootstrap.workspace.id,
  token: server.bootstrap.internalToken,
  assignment: server.bootstrap.ownerAssignment.id,
})

async function orgOf(server: Server): Promise<string> {
  const orgs = await call<{ id: string }[]>(server, bootstrapWho(server), 'GET', '/v1/orgs')
  const id = orgs.data?.[0]?.id
  if (id === undefined) throw new Error('启动之后应该有一个组织')
  return id
}

/** 建第二个品牌，拿到"以它的身份"发请求的句柄（切品牌 = 换一张会话 token）。 */
async function addBrand(server: Server, name: string): Promise<Who> {
  const me = bootstrapWho(server)
  const org = await orgOf(server)
  const created = await call<{ workspace_id: string }>(
    server,
    me,
    'POST',
    `/v1/orgs/${org}/brands`,
    {
      name,
    },
  )
  expect(created.status).toBe(201)
  const workspace_id = created.data?.workspace_id as string
  const switched = await call<{ session_token?: string }>(
    server,
    me,
    'POST',
    `/v1/orgs/${org}/brands/${workspace_id}/switch`,
  )
  const token = switched.data?.session_token as string
  const assignment = server.roles.assignments
    .listByPerson(server.bootstrap.person.id, { workspace_id })
    .find((a) => a.revoked_at === undefined)
  if (assignment === undefined) throw new Error('新品牌里应该自带一条 owner 分配')
  return { workspace_id, token, assignment: assignment.id }
}

/** 一条一分钟后的「拟今天的安排」——两个品牌里各建一条（走 `/v1/schedules`，与人在界面上建的同一条路）。 */
async function planTask(server: Server, who: Who, title: string, at: string): Promise<string> {
  // WP244：0 条建议不出卡——先在这个品牌的待办箱里放一条，计划才有东西可建议
  const todo = await call(server, who, 'POST', '/v1/todos', { title: `${title}：要跟进的一件事` })
  expect(todo.status, JSON.stringify(todo)).toBe(201)
  const res = await call<{ id: string }>(server, who, 'POST', '/v1/schedules', {
    title,
    trigger: { kind: 'once', at },
    handler: HANDLERS.dailyPlan,
    effect: 'read_only',
    duplicate_ack: { decision: 'new', reason: `${title}：这一条只给这个品牌拟早上的安排` },
  })
  expect(res.status, JSON.stringify(res)).toBe(201)
  return res.data?.id as string
}

const plansIn = (server: Server, ws: string) =>
  server.txn.runtime.store
    .listApprovals({})
    .filter((i) => i.kind === 'daily_plan' && i.workspace_id === ws)

describe('WP215 每个品牌的后台都在跑，与眼前品牌无关', () => {
  it('新品牌一建好，它那一套系统任务就在（不用重启），挂在它自己的工作区与负责人名下', async () => {
    const { server } = await boot()
    const b = await addBrand(server, '变形金刚耳机独立站')
    const tasks = server.schedule.scheduler.list({ workspace_id: b.workspace_id })
    const ids = tasks.map((t) => t.id)
    expect(ids).toContain(`sched_mail_poll__${b.workspace_id}`)
    expect(ids).toContain(`sched_learning_daily__${b.workspace_id}`)
    expect(ids).toContain(`sched_reconcile_deliveries__${b.workspace_id}`)
    expect(ids).toContain(`sched_daily_plan_${b.assignment}__${b.workspace_id}`)
    // 进程级的家务只在第一个品牌名下一份
    expect(ids.some((id) => id.startsWith('sched_approval_housekeeping'))).toBe(false)
    expect(ids.some((id) => id.startsWith('sched_raw_prune'))).toBe(false)
    for (const t of tasks) expect(t.workspace_id).toBe(b.workspace_id)
    // 第一个品牌的老任务 id 一条不动
    const a = server.bootstrap.workspace.id
    expect(server.schedule.scheduler.get('sched_mail_poll')?.workspace_id).toBe(a)
    expect(server.schedule.scheduler.get('sched_approval_housekeeping')?.workspace_id).toBe(a)
  })

  it('视图停在 A：B 的定时任务准点触发，计划卡只进 B 的队列、事件只记在 B 名下', async () => {
    const { server, clock } = await boot()
    const a = bootstrapWho(server)
    const b = await addBrand(server, '变形金刚耳机独立站')
    const at = new Date(Date.parse(T0) + 60_000).toISOString()
    const taskA = await planTask(server, a, 'A 品牌的早报', at)
    const taskB = await planTask(server, b, 'B 品牌的早报', at)
    // 之后只用 A 的令牌发请求（眼前切在 A），B 一个请求都不收
    clock.advance(2 * 60_000)
    const fired = await server.schedule.scheduler.runDue(clock.now())
    const byId = new Map(fired.map((o) => [o.task.id, o]))
    expect(byId.get(taskA)?.ok).toBe(true)
    expect(byId.get(taskB)?.ok, JSON.stringify(byId.get(taskB)?.error)).toBe(true)

    const cardsA = plansIn(server, a.workspace_id)
    const cardsB = plansIn(server, b.workspace_id)
    expect(cardsA.length).toBeGreaterThan(0)
    expect(cardsB.length).toBeGreaterThan(0)
    // B 的卡：去重键、岗位、收件人都是 B 那边的
    for (const card of cardsB) {
      expect(card.dedupe_key.startsWith(`${b.workspace_id}:`)).toBe(true)
      expect(card.dedupe_key).toContain(b.assignment)
    }
    for (const card of cardsA) expect(card.dedupe_key).not.toContain(b.assignment)

    // 站在 A 看：A 的队列里一张 B 的卡都没有
    const queueA = await server.txn.approvals.queue({
      workspace_id: a.workspace_id,
      person_id: server.bootstrap.person.id,
      lane: 'mine',
      state: ['pending'],
    })
    expect(queueA.some((i) => i.workspace_id === b.workspace_id)).toBe(false)

    // 事件：B 那条任务的触发记在 B 名下
    const firedB = server.kernel.eventLog
      .readSync({ workspace_id: b.workspace_id })
      .filter((e) => e.type === 'schedule.fired')
      .filter((e) => (e.payload as { task_id?: string }).task_id === taskB)
    expect(firedB.length).toBe(1)
  })

  it('B 的收信照常：B 那条收信任务只拉 B 的邮箱，A 那条只拉 A 的', async () => {
    const { server } = await boot()
    const a = bootstrapWho(server)
    const b = await addBrand(server, '变形金刚耳机独立站')
    const connect = async (who: Who, email: string) => {
      const res = await call(server, who, 'POST', '/v1/connections/imap_smtp/submit', {
        alias: email,
        fields: {
          email,
          password: `pw-${email}`,
          imap_host: '127.0.0.1',
          imap_port: '1',
          smtp_host: '127.0.0.1',
          smtp_port: '2',
        },
      })
      expect([200, 201]).toContain(res.status)
    }
    await connect(a, 'ops@inmo.example')
    await connect(b, 'hello@tws.example')
    const outB = await server.schedule.scheduler.runNow(`sched_mail_poll__${b.workspace_id}`)
    const outA = await server.schedule.scheduler.runNow('sched_mail_poll')
    const reportB = outB.result as { accounts: number; failed: string[] }
    const reportA = outA.result as { accounts: number; failed: string[] }
    expect(reportB.accounts).toBe(1)
    expect(reportA.accounts).toBe(1)
    expect(reportB.failed.join()).toContain('hello@tws.example')
    expect(reportB.failed.join()).not.toContain('ops@inmo.example')
    expect(reportA.failed.join()).toContain('ops@inmo.example')
    expect(reportA.failed.join()).not.toContain('hello@tws.example')
  })

  it('B 品牌急停只停 B：B 到点不跑、对外与模型被拦；A 照常；放开之后补跑', async () => {
    const { server, clock } = await boot()
    const a = bootstrapWho(server)
    const b = await addBrand(server, '变形金刚耳机独立站')
    // 视图停在 A，从 A 这边按下 B 的急停
    const halted = await call<BrandBackgroundView>(
      server,
      a,
      'PUT',
      `/v1/settings/background/brands/${b.workspace_id}`,
      { halted: true, reason: '先停一下 B 的推广' },
    )
    expect(halted.status).toBe(200)
    expect(halted.data?.state).toBe('halted')

    const at = new Date(Date.parse(T0) + 60_000).toISOString()
    const taskA = await planTask(server, a, 'A 品牌的早报', at)
    const taskB = await planTask(server, b, 'B 品牌的早报', at)
    clock.advance(2 * 60_000)
    const fired = (await server.schedule.scheduler.runDue(clock.now())).map((o) => o.task.id)
    expect(fired).toContain(taskA)
    expect(fired).not.toContain(taskB)
    expect(server.schedule.scheduler.get(taskB)?.fire_count).toBe(0)
    await expect(server.schedule.scheduler.runNow(taskB)).rejects.toThrow()

    // 对外发送 / 模型：B 的急停视图全停，A 的不受影响；全局急停没动
    expect(server.background.haltOf(b.workspace_id).isHalted('outbound')).toBe(true)
    expect(server.background.haltOf(b.workspace_id).isHalted('model')).toBe(true)
    expect(server.background.haltOf(a.workspace_id).isHalted('outbound')).toBe(false)
    expect(server.kernel.halt.isHalted('outbound')).toBe(false)
    // B 默认跟随公司默认（借的是 A 那个网关）：借来的那一份也按 B 的急停拦，A 自己那一份照常
    const gatewayB = await server.brands.gateway(b.workspace_id)
    const gatewayA = await server.brands.gateway(a.workspace_id)
    expect(() => gatewayB.complete({} as never)).toThrow('halted')
    expect(gatewayB.providers().length).toBeGreaterThan(0)
    await expect(Promise.resolve().then(() => gatewayA.providers())).resolves.toBeDefined()

    // 审计：记在 B 名下
    const changed = server.kernel.eventLog
      .readSync({ workspace_id: b.workspace_id })
      .filter((e) => e.type === 'halt.changed')
    expect(changed.length).toBe(1)
    expect(changed[0]?.payload).toMatchObject({ on: true, brand: b.workspace_id })

    // 放开：停着那段时间到点的那一条按 misfire 规矩补一次
    const released = await call<BrandBackgroundView>(
      server,
      a,
      'PUT',
      `/v1/settings/background/brands/${b.workspace_id}`,
      { halted: false },
    )
    expect(released.data?.state).toBe('running')
    clock.advance(60_000)
    const after = (await server.schedule.scheduler.runDue(clock.now())).map((o) => o.task.id)
    expect(after).toContain(taskB)
    expect(plansIn(server, b.workspace_id).length).toBeGreaterThan(0)
  })

  it('品牌一览每行带后台那一格；设置页「同时最多跑几件」写进设置并落盘', async () => {
    const dbDir = mkdtempSync(join(tmpdir(), 'agentsws-wp215-'))
    const { server, clock } = await boot(makeClock(), { dbDir })
    const a = bootstrapWho(server)
    const b = await addBrand(server, '变形金刚耳机独立站')
    clock.advance(2 * 60_000)
    await server.schedule.scheduler.runNow(`sched_mail_poll__${b.workspace_id}`)

    const org = await orgOf(server)
    const brands = await call<BrandView[]>(server, a, 'GET', `/v1/orgs/${org}/brands`)
    const rowB = brands.data?.find((r) => r.workspace_id === b.workspace_id)
    const rowA = brands.data?.find((r) => r.workspace_id === a.workspace_id)
    expect(rowB?.background?.state).toBe('running')
    expect(rowB?.background?.scheduled).toBeGreaterThan(0)
    expect(rowB?.background?.last_run_at).toBe(clock.now())
    expect(rowA?.background?.state).toBe('running')
    // 进程级家务不算进 A 的数：两个品牌的数一样多（同一套品牌级任务）
    expect(rowA?.background?.scheduled).toBe(rowB?.background?.scheduled)

    const before = await call<BackgroundSettingsView>(server, a, 'GET', '/v1/settings/background')
    expect(before.data?.max_concurrent).toBe(2)
    expect(before.data?.runs_on).toBe('this_device')
    expect(before.data?.brands.map((r) => r.workspace_id).sort()).toEqual(
      [a.workspace_id, b.workspace_id].sort(),
    )
    const set = await call<BackgroundSettingsView>(server, a, 'PUT', '/v1/settings/background', {
      max_concurrent: 3,
    })
    expect(set.data?.max_concurrent).toBe(3)
    expect(server.background.maxConcurrent()).toBe(3)
    const tooMany = await call(server, a, 'PUT', '/v1/settings/background', { max_concurrent: 9 })
    expect(tooMany.status).toBe(400)
    const saved = JSON.parse(readFileSync(join(dbDir, BACKGROUND_FILE), 'utf8')) as {
      max_concurrent: number
    }
    expect(saved.max_concurrent).toBe(3)
  })

  it('学习回路不串品牌：B 里批的口径卡写进 B 的知识库，A 一条都看不到', async () => {
    const { server } = await boot()
    const a = bootstrapWho(server)
    const b = await addBrand(server, '变形金刚耳机独立站')
    const gap = await call<{ id: string }>(server, b, 'POST', '/v1/knowledge/gaps', {
      question: '耳机保修几个月？',
      subject: { type: 'policy', key: 'tws_warranty' },
    })
    expect(gap.status).toBe(201)
    const answered = await call<{ approval_item_id: string }>(
      server,
      b,
      'POST',
      `/v1/knowledge/gaps/${gap.data?.id}/answer`,
      { answer: '整机保修 12 个月。', layer: 'policy' },
    )
    const cardId = answered.data?.approval_item_id as string
    const card = await server.txn.approvals.get(cardId)
    expect(card?.workspace_id).toBe(b.workspace_id)
    const decided = await call(server, b, 'POST', `/v1/approvals/${cardId}/decide`, {
      action: 'approve',
    })
    expect(decided.status, JSON.stringify(decided)).toBe(200)
    const healthB = await call<{ total: number }>(server, b, 'GET', '/v1/knowledge/health')
    const healthA = await call<{ total: number }>(server, a, 'GET', '/v1/knowledge/health')
    expect(healthB.data?.total).toBe(1)
    expect(healthA.data?.total).toBe(0)
  })

  it('公司管理员（不是 B 的负责人、也不在 B 里）也能停 B；普通成员不行（Fable 10-05）', async () => {
    const { server } = await boot()
    const b = await addBrand(server, '变形金刚耳机独立站')
    const org = await orgOf(server)
    const a = server.bootstrap.workspace.id
    const join = async (email: string, role: 'admin' | 'member'): Promise<Who> => {
      const p = await server.identity.createPerson({ email, name: email })
      await server.identity.addOrganizationMember({ org_id: org, person_id: p.id, role })
      await server.identity.addMember({
        workspace_id: a,
        person_id: p.id,
        role: 'member',
        ranges: [],
      })
      const asg = server.roles.assignments.create({
        person_id: p.id,
        workspace_id: a,
        role_id: 'common.member',
        granted_by: server.bootstrap.person.id,
        ranges: [],
      })
      return {
        workspace_id: a,
        token: server.identity.issue('session', p.id, a).token,
        assignment: asg.id,
      }
    }
    const admin = await join('ops-admin@example.com', 'admin')
    const member = await join('ops-member@example.com', 'member')
    const path = `/v1/settings/background/brands/${b.workspace_id}`
    const denied = await call(server, member, 'PUT', path, { halted: true })
    expect(denied.status).toBe(403)
    expect(server.background.brandHalted(b.workspace_id)).toBe(false)
    const ok = await call<BrandBackgroundView>(server, admin, 'PUT', path, { halted: true })
    expect(ok.status).toBe(200)
    expect(ok.data?.state).toBe('halted')
    expect(server.background.brandHalted(a)).toBe(false)
  })

  it('先建品牌、再分配 Reddit 职责：监控任务立即出现并按时触发；撤销后停，再分配又放开（不用重启）', async () => {
    const { server, clock } = await boot()
    const b = await addBrand(server, 'INMO Reddit 代运营')
    const id = `sched_pr_monitor__${b.workspace_id}`
    // 还没人担公关职责：没有这一条
    expect(server.schedule.scheduler.get(id)).toBeUndefined()

    const asg = server.roles.assignments.create({
      person_id: server.bootstrap.person.id,
      workspace_id: b.workspace_id,
      role_id: 'pr.reddit',
      granted_by: server.bootstrap.person.id,
      ranges: [],
    })
    await server.background.settled()
    const task = server.schedule.scheduler.get(id)
    expect(task?.state).toBe('active')
    expect(task?.workspace_id).toBe(b.workspace_id)
    // 视图在第一个品牌，B 的监控照样按时跑（15 分钟一轮）
    clock.advance(16 * 60_000)
    const fired = await server.schedule.scheduler.runDue(clock.now())
    const mine = fired.find((o) => o.task.id === id)
    expect(mine?.ok, JSON.stringify(mine?.error)).toBe(true)
    // 第一个品牌没人担这条职责，也就没有它的监控
    expect(server.schedule.scheduler.get('sched_pr_monitor')).toBeUndefined()

    // 撤销：停下（暂停，带记号），到点不再跑
    server.roles.assignments.revoke(asg.id)
    await server.background.settled()
    expect(server.schedule.scheduler.get(id)?.state).toBe('paused')
    clock.advance(16 * 60_000)
    const after = await server.schedule.scheduler.runDue(clock.now())
    expect(after.some((o) => o.task.id === id)).toBe(false)

    // 人自己按的暂停不碰：再分配只放开带记号的那几条
    server.roles.assignments.create({
      person_id: server.bootstrap.person.id,
      workspace_id: b.workspace_id,
      role_id: 'pr.reddit',
      granted_by: server.bootstrap.person.id,
      ranges: [],
    })
    await server.background.settled()
    expect(server.schedule.scheduler.get(id)?.state).toBe('active')
    expect(server.schedule.scheduler.get(id)?.params?.auto_stopped).toBeUndefined()
    await server.schedule.scheduler.pause(id)
    server.roles.assignments.create({
      person_id: server.bootstrap.person.id,
      workspace_id: b.workspace_id,
      role_id: 'pr.monitoring',
      granted_by: server.bootstrap.person.id,
      ranges: [],
    })
    await server.background.settled()
    expect(server.schedule.scheduler.get(id)?.state).toBe('paused')
  })

  it('分配一条新岗位：这个人在 B 的每日计划 / 复盘立即建上；撤了就停', async () => {
    const { server } = await boot()
    const b = await addBrand(server, '变形金刚耳机独立站')
    const asg = server.roles.assignments.create({
      person_id: server.bootstrap.person.id,
      workspace_id: b.workspace_id,
      role_id: 'dtc.support',
      granted_by: server.bootstrap.person.id,
      ranges: [],
    })
    await server.background.settled()
    const plan = `sched_daily_plan_${asg.id}__${b.workspace_id}`
    expect(server.schedule.scheduler.get(plan)?.state).toBe('active')
    server.roles.assignments.revoke(asg.id)
    await server.background.settled()
    expect(server.schedule.scheduler.get(plan)?.state).toBe('paused')
  })

  it('不是这个品牌负责人的人停不了它；不认识的工作区回 404', async () => {
    const { server } = await boot()
    const a = bootstrapWho(server)
    const missing = await call(server, a, 'PUT', '/v1/settings/background/brands/ws_nope', {
      halted: true,
    })
    expect(missing.status).toBe(404)
  })
})
