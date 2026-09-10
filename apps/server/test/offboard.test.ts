/**
 * 离职端到端（WP36 交付 1 / 2）：真装配线（路由 → OffboardPort → roles / work / skills /
 * knowledge / learning），不打桩。
 *
 * 走的就是 40 §1.2 那条路：owner 邀请一位同事 → 他接受 → 拿到岗位 → 手上有在办的事项、
 * 未完的待办、个人层技能改动、个人记忆 → owner 点「离职」→ 权限没了、活转给接手人、
 * 个人层归档成只读、工作记忆等审批、其余当场擦掉 → 出一份报告。
 *
 * 另外几条一致性用例：
 * - **可重跑**：同一个请求发第二次，转 0 件、归档 0 条，不重复建卡
 * - **管理员没有「读」**：离职响应、归档区清单、事件日志里都找不到个人数据的正文
 * - **兜底接手人**：不给 `handover_to` 就按 05 §3 的 fallback 落到 owner
 * - **采纳进部门层**：一键 = 一张 `policy_change` 卡；批了才落，落之前部门层什么都没有
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ArchivedSkillView, OffboardReportView } from '../../../packages/api/src/routes/org.js'
import { createServer, type Server } from '../src/index.js'

const T0 = '2026-09-10T09:00:00.000Z'

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

let server: Server
let clock: ReturnType<typeof makeClock>

const call = async (
  method: string,
  path: string,
  options: { body?: unknown; token?: string; assignment?: string } = {},
): Promise<Response> => {
  const headers = new Headers()
  headers.set('Authorization', `Bearer ${options.token ?? server.bootstrap.internalToken}`)
  const assignment = options.assignment ?? server.bootstrap.ownerAssignment.id
  if (assignment !== '') headers.set('X-Assignment', assignment)
  if (options.body !== undefined) headers.set('content-type', 'application/json')
  return server.gateway.fetch(
    new Request(`http://127.0.0.1${path}`, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }),
  )
}

const data = async <T>(res: Response): Promise<T> => {
  const parsed = (await res.json()) as { data?: T; code?: string; message?: string }
  if (parsed.data === undefined) throw new Error(`没有 data：${parsed.code} ${parsed.message}`)
  return parsed.data
}

/** 邀请一位同事并让他接受，回他的 person_id。 */
const hire = async (email: string, name: string): Promise<string> => {
  const ws = server.bootstrap.workspace.id
  const invite = await data<{ url?: string }>(
    await call('POST', `/v1/workspaces/${ws}/invitations`, {
      body: { email, name, position_id: 'dtc-support' },
    }),
  )
  const token = (invite.url ?? '').split('/invite/')[1] ?? ''
  const accepted = await data<{ person_id: string }>(
    await call('POST', `/v1/invitations/${token}/accept`, { body: { name } }),
  )
  return accepted.person_id
}

const memoryFact = (workspace_id: string, person: string, key: string, value: string) => ({
  key,
  value,
  category: 'preference' as const,
  subject: { type: 'person', id: person },
  source_run_hash: 'abcdef012345',
  expires_at: '2027-01-01T00:00:00.000Z',
  workspace_id,
})

beforeEach(async () => {
  clock = makeClock()
  server = await createServer({
    quiet: true,
    clock: { now: () => clock.now() },
    random: seeded(),
    scheduleIntervalMs: 0,
    env: { AGENTSWS_OWNER_EMAIL: 'luoye@example.com' },
  })
})

afterEach(async () => {
  await server.close()
})

describe('40 §1.2 离职是一个正式动作', () => {
  it('撤权限 → 在办事项 / 未完待办真转接手人 → 个人层归档 → 个人记忆按策略处置 → 出报告', async () => {
    const ws = server.bootstrap.workspace.id
    const leaver = await hire('limo@example.com', '李默')
    const successor = await hire('wanglan@example.com', '王岚')

    // 他手上：一件在办的事项、两条未完的待办、一条已完成的待办（历史不该被动）
    const matter = server.work.createMatter({
      kind: 'conversation',
      title: '退款单核对',
      participants: [leaver],
    })
    const open = server.work.createTodo({
      title: '核对昨天的退款单',
      owner: leaver,
      matter_id: matter.id,
    })
    server.work.createTodo({ title: '给客户回信', owner: leaver })
    const done = server.work.createTodo({ title: '已经做完的', owner: leaver })
    server.work.complete(done.id)

    // 他的个人层技能改动
    await server.skills.registry.setOverlay({
      skill: 'aftersales-basics',
      tier: 'personal',
      owner: leaver,
      ops: [{ op: 'append', section_id: 'sec-1', body: '遇到破损件先要照片', origin: 'authored' }],
      base_version: '1.0',
      version: 0,
    })

    // 他的个人记忆：一条工作相关（带本工作区域引用）、一条纯个人的
    const written = await server.knowledge.memory.write([
      memoryFact(ws, leaver, '客户A偏好', '只收邮件不接电话'),
      memoryFact('', leaver, '我的习惯', '早上先看队列'),
    ])
    expect(written.accepted).toHaveLength(2)

    const before = server.roles.assignments
      .listByPerson(leaver, { workspace_id: ws })
      .filter((a) => a.revoked_at === undefined)
    expect(before.length).toBeGreaterThan(0)

    const report = await data<OffboardReportView>(
      await call('POST', `/v1/workspaces/${ws}/members/${leaver}/offboard`, {
        body: { handover_to: successor, personal_layer: 'archive', memory: 'migrate_work' },
      }),
    )

    // ① 权限：一条不剩，token 立刻失效
    expect(
      server.roles.assignments
        .listByPerson(leaver, { workspace_id: ws })
        .filter((a) => a.revoked_at === undefined),
    ).toHaveLength(0)
    expect(report.steps.find((s) => s.step === 'revoke')?.counts?.assignments).toBe(before.length)

    // ② 真转：事项参与者换人、未完待办换主人、已完成的不动
    expect(server.work.requireMatter(matter.id).context.participants).toEqual([successor])
    expect(server.work.requireTodo(open.id).owner).toBe(successor)
    expect(server.work.requireTodo(done.id).owner).toBe(leaver)
    expect(report.steps.find((s) => s.step === 'handover')?.counts).toMatchObject({
      matters: 1,
      todos: 2,
    })
    // 时间线上留了痕
    const timeline = server.work.matterView(matter.id).timeline
    expect(timeline.some((e) => e.text.includes('交接：') && e.text.includes('李默离职'))).toBe(
      true,
    )

    // ③ 个人层：搬进只读归档，叠加时不再生效
    expect(
      server.skills.registry.getOverlay('aftersales-basics', 'personal', leaver),
    ).toBeUndefined()
    expect(server.skills.registry.listArchivedOverlays({ owner: leaver })).toHaveLength(1)
    expect(report.steps.find((s) => s.step === 'skills')?.counts?.archived).toBe(1)

    // ④ 个人记忆：工作相关的等审批，其余当场擦掉
    const memoryStep = report.steps.find((s) => s.step === 'memory')
    expect(memoryStep?.status).toBe('pending_approval')
    expect(memoryStep?.counts).toMatchObject({ to_migrate: 1, erased: 1 })
    expect(
      server.knowledge.memory.countSubject({ type: 'person', id: leaver }, { workspace_id: ws }),
    ).toMatchObject({ work: 1, personal: 0 })

    // ⑤ 报告：一句人话 + 还需人工的 + 落在接手人的一个事项上
    expect(report.status).toBe('pending_approval')
    expect(report.summary).toContain('王岚')
    expect(report.manual.length).toBeGreaterThan(0)
    expect(report.matter_id).toBeDefined()

    // ⑥ 事件：member.offboarded，payload 只有数字与处置方式
    const events = server.kernel.eventLog.readSync({
      workspace_id: ws,
      types: ['member.offboarded'],
    })
    expect(events).toHaveLength(1)
    expect(JSON.stringify(events[0]?.payload)).not.toContain('只收邮件不接电话')
    expect(
      server.kernel.eventLog.readSync({ workspace_id: ws, types: ['matter.handover'] }),
    ).toHaveLength(1)
  })

  it('可重跑：任一步失败整体 partial，同一个请求再发一次只补没做成的那几步', async () => {
    const ws = server.bootstrap.workspace.id
    const leaver = await hire('limo@example.com', '李默')
    const successor = await hire('wanglan@example.com', '王岚')
    server.work.createTodo({ title: '还没做完的', owner: leaver })

    const first = await data<OffboardReportView>(
      await call('POST', `/v1/workspaces/${ws}/members/${leaver}/offboard`, {
        body: { handover_to: successor },
      }),
    )
    expect(first.steps.find((s) => s.step === 'handover')?.counts?.todos).toBe(1)

    const second = await data<OffboardReportView>(
      await call('POST', `/v1/workspaces/${ws}/members/${leaver}/offboard`, {
        body: { handover_to: successor },
      }),
    )
    expect(second.steps.find((s) => s.step === 'revoke')?.counts?.assignments).toBe(0)
    expect(second.steps.find((s) => s.step === 'handover')?.counts).toMatchObject({
      matters: 0,
      todos: 0,
    })
    expect(second.steps.find((s) => s.step === 'skills')?.counts?.archived).toBe(0)
  })

  it('不给接手人 → 按 05 §3 的 fallback 兜底落到 owner', async () => {
    const ws = server.bootstrap.workspace.id
    const leaver = await hire('limo@example.com', '李默')
    server.work.createTodo({ title: '没人接的活', owner: leaver })

    const report = await data<OffboardReportView>(
      await call('POST', `/v1/workspaces/${ws}/members/${leaver}/offboard`, { body: {} }),
    )
    expect(report.fallback_used).toBe(true)
    expect(report.handover_to).toBe(server.bootstrap.person.id)
  })

  it('memory: erase → 他名下的记忆一条不剩，报告里也只有条数', async () => {
    const ws = server.bootstrap.workspace.id
    const leaver = await hire('limo@example.com', '李默')
    await server.knowledge.memory.write([
      memoryFact(ws, leaver, '客户A偏好', '只收邮件不接电话'),
      memoryFact('', leaver, '我的习惯', '早上先看队列'),
    ])

    const report = await data<OffboardReportView>(
      await call('POST', `/v1/workspaces/${ws}/members/${leaver}/offboard`, {
        body: { personal_layer: 'erase', memory: 'erase' },
      }),
    )
    expect(report.steps.find((s) => s.step === 'memory')?.counts?.erased).toBe(2)
    expect(server.knowledge.memory.countSubject({ type: 'person', id: leaver }).total).toBe(0)
    expect(JSON.stringify(report)).not.toContain('只收邮件不接电话')
  })

  it('工作区所有者不能离职', async () => {
    const ws = server.bootstrap.workspace.id
    const res = await call(
      'POST',
      `/v1/workspaces/${ws}/members/${server.bootstrap.person.id}/offboard`,
      { body: {} },
    )
    expect(res.ok).toBe(false)
  })
})

describe('40 E1 管理员对个人数据只有迁移 / 归档 / 销毁，没有读', () => {
  it('前员工层清单只给段数，不给正文；采纳进部门层要走一张 policy_change 卡', async () => {
    const ws = server.bootstrap.workspace.id
    const leaver = await hire('limo@example.com', '李默')
    await server.skills.registry.setOverlay({
      skill: 'aftersales-basics',
      tier: 'personal',
      owner: leaver,
      ops: [
        { op: 'append', section_id: 'sec-1', body: '遇到破损件先要照片', origin: 'authored' },
        { op: 'append', section_id: 'sec-2', body: '超过 30 天先问店主', origin: 'authored' },
      ],
      base_version: '1.0',
      version: 0,
    })
    await call('POST', `/v1/workspaces/${ws}/members/${leaver}/offboard`, { body: {} })

    const list = await data<ArchivedSkillView[]>(
      await call('GET', `/v1/workspaces/${ws}/archived-skills`),
    )
    expect(list).toHaveLength(1)
    expect(list[0]?.sections).toBe(2)
    // 正文一个字都不在响应里
    expect(JSON.stringify(list)).not.toContain('遇到破损件先要照片')

    // 采纳：只建卡，部门层这会儿还是空的
    const receipt = await data<{ status: string; approval_item_id: string }>(
      await call('POST', `/v1/workspaces/${ws}/archived-skills/adopt`, {
        body: { skill: 'aftersales-basics', owner: leaver, to_tier: 'department' },
      }),
    )
    expect(receipt.status).toBe('pending_approval')
    expect(server.skills.registry.getOverlay('aftersales-basics', 'department', ws)).toBeUndefined()

    // 批了之后，下一次读时落地
    await call('POST', `/v1/approvals/${receipt.approval_item_id}/decide`, {
      body: { action: 'approve', selected_option_id: 'after' },
    })
    await server.offboard.reconcile()
    const adopted = server.skills.registry.getOverlay('aftersales-basics', 'department', ws)
    expect(adopted?.ops).toHaveLength(2)
  })

  it('工作记忆的迁移要批准；批了之后条目换主人，owner 全程读不到正文', async () => {
    const ws = server.bootstrap.workspace.id
    const leaver = await hire('limo@example.com', '李默')
    const successor = await hire('wanglan@example.com', '王岚')
    await server.knowledge.memory.write([memoryFact(ws, leaver, '客户A偏好', '只收邮件不接电话')])

    const report = await data<OffboardReportView>(
      await call('POST', `/v1/workspaces/${ws}/members/${leaver}/offboard`, {
        body: { handover_to: successor },
      }),
    )
    const card = report.steps.find((s) => s.step === 'memory')?.approval_item_id
    expect(card).toBeDefined()

    await call('POST', `/v1/approvals/${card as string}/decide`, {
      body: { action: 'approve', selected_option_id: 'after' },
    })
    await server.offboard.reconcile()

    expect(server.knowledge.memory.countSubject({ type: 'person', id: leaver }).total).toBe(0)
    const moved = await server.knowledge.memory.recall(
      { type: 'person', id: successor },
      { workspace_id: ws },
    )
    expect(moved.map((f) => f.key)).toContain('客户A偏好')
  })
})

describe('40 E1 owner 拿不到别人的个人数据正文，但三个动作都能做', () => {
  it('技能页只端本人的个人层；别人的个人层正文在任何一条路由上都取不到', async () => {
    const ws = server.bootstrap.workspace.id
    const colleague = await hire('limo@example.com', '李默')
    await server.skills.registry.setOverlay({
      skill: 'customer-care',
      tier: 'personal',
      owner: colleague,
      ops: [{ op: 'append', section_id: 'sec-1', body: '这是李默自己的写法', origin: 'authored' }],
      base_version: '1.0',
      version: 0,
    })
    await server.skills.registry.setOverlay({
      skill: 'customer-care',
      tier: 'company',
      owner: ws,
      ops: [{ op: 'append', section_id: 'sec-1', body: '这是公司层的写法', origin: 'authored' }],
      base_version: '1.0',
      version: 0,
    })

    // owner 身份把技能页、解析、教训、成员、事件都翻一遍
    const probes = [
      '/v1/skills',
      '/v1/skills/customer-care/resolved',
      '/v1/lessons',
      `/v1/workspaces/${ws}/members`,
      `/v1/workspaces/${ws}/archived-skills`,
      '/v1/events?limit=500',
    ]
    for (const path of probes) {
      const res = await call('GET', path)
      const text = await res.text()
      expect(text, path).not.toContain('这是李默自己的写法')
    }
    // 公司层是公共的，照样看得见——不是把整页都挡掉
    const skillsPage = await (await call('GET', '/v1/skills')).text()
    expect(skillsPage).toContain('这是公司层的写法')

    // 个人记忆一样：owner 没有任何一条能读出正文的路由
    await server.knowledge.memory.write([
      memoryFact(ws, colleague, '客户A偏好', '只收邮件不接电话'),
    ])
    for (const path of probes) {
      const text = await (await call('GET', path)).text()
      expect(text, path).not.toContain('只收邮件不接电话')
    }

    // 但三个动作都在：归档（离职）→ 迁移（批准）→ 销毁
    const report = await data<OffboardReportView>(
      await call('POST', `/v1/workspaces/${ws}/members/${colleague}/offboard`, { body: {} }),
    )
    expect(report.steps.find((s) => s.step === 'skills')?.counts?.archived).toBe(1)
    const card = report.steps.find((s) => s.step === 'memory')?.approval_item_id
    expect(card).toBeDefined()
    await call('POST', `/v1/approvals/${card as string}/decide`, {
      body: { action: 'approve', selected_option_id: 'after' },
    })
    await server.offboard.reconcile()
    expect(server.knowledge.memory.countSubject({ type: 'person', id: colleague }).total).toBe(0)
  })
})
