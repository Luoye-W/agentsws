/**
 * 制度面端到端（WP28）：真装配线（路由 → OrgPort → roles / identity / txn），不打桩。
 *
 * 走的就是派工书里那条路：owner 邀请一位同事 → 同事接受 → owner 把「独立站售后客服」
 * 分给他 → 同事用自己的邮箱登录 → 他名下就有这个岗位 → owner 撤销 → 他立刻 403。
 *
 * 另外四条一致性用例各有一个 it：
 * - 不并集（31 §3.1）：一人两岗位，各自请求各自的权限，拿 A 的岗位去要 B 的权限 → 403
 * - 空范围拒（31 §3.1）：范围为空的分配，`assigned` 查询一律拒
 * - 撤销即失效（05 §3）：撤销那一刻起，这条分配不能再当凭据用
 * - 改模板必经审批（14 §1 policy_change）：PUT 只建卡不改人，批了才生效
 */
import type { ApprovalItem } from '@agentsws/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'

const T0 = '2026-09-07T09:00:00.000Z'

function makeClock(start = T0) {
  let t = Date.parse(start)
  return {
    now: () => new Date(t).toISOString(),
    advance: (ms: number) => {
      t += ms
    },
  }
}

function seeded(seed = 5): () => number {
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

interface AssignmentView {
  assignment_id: string
  role_id: string
  role_name: string
  ranges: { kind: string; id: string }[]
  unassigned_range: boolean
}

interface MemberView {
  person_id: string
  name: string
  email: string
  positions: { id: string; name: string }[]
  assignments: AssignmentView[]
}

const ws = (): string => server.bootstrap.workspace.id

/** 邀请 + 接受 + 用邮箱登录，返回这位同事的会话 token 与 person_id。 */
async function inviteColleague(
  email: string,
  input: { position_id?: string; name?: string } = {},
): Promise<{ token: string; person_id: string }> {
  const invitation = await data<{ url: string; id: string }>(
    await call('POST', `/v1/workspaces/${ws()}/invitations`, {
      body: {
        email,
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.position_id === undefined ? {} : { position_id: input.position_id }),
      },
    }),
  )
  const token = invitation.url.slice(invitation.url.lastIndexOf('/') + 1)
  const accepted = await data<{ person_id: string }>(
    await server.gateway.fetch(
      new Request(`http://127.0.0.1/v1/invitations/${token}/accept`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }),
    ),
  )
  const login = await data<{ token: string }>(
    await server.gateway.fetch(
      new Request('http://127.0.0.1/v1/auth/magic-link', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      }),
    ),
  )
  const session = await data<{ session_token: string }>(
    await server.gateway.fetch(
      new Request('http://127.0.0.1/v1/auth/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: login.token }),
      }),
    ),
  )
  return { token: session.session_token, person_id: accepted.person_id }
}

const assignmentsOf = async (person_id: string): Promise<AssignmentView[]> => {
  const members = await data<MemberView[]>(await call('GET', `/v1/workspaces/${ws()}/members`))
  return members.find((m) => m.person_id === person_id)?.assignments ?? []
}

beforeEach(async () => {
  clock = makeClock()
  server = await createServer({
    clock,
    random: seeded(),
    quiet: true,
    startRun: false,
    tokenRefreshIntervalMs: 0,
  })
})

afterEach(async () => {
  await server.close()
})

describe('制度面：职责与岗位', () => {
  it('职责清单带积木 / 动作 / 自动化摘要，内置模板不可改', async () => {
    const roles = await data<
      {
        id: string
        source: string
        editable: boolean
        actions: unknown[]
        home_blocks: unknown[]
      }[]
    >(await call('GET', '/v1/roles'))
    const aftersales = roles.find((r) => r.id === 'dtc.aftersales')
    expect(aftersales?.source).toBe('bundled')
    expect(aftersales?.editable).toBe(false)
    expect(aftersales?.actions.length).toBeGreaterThan(0)
    expect(aftersales?.home_blocks.length).toBeGreaterThan(0)
  })

  it('首批岗位里有「独立站售后客服」，岗位 = 职责的默认包', async () => {
    const positions = await data<{ id: string; name: string; roles: { role_id: string }[] }[]>(
      await call('GET', '/v1/org/positions'),
    )
    const support = positions.find((p) => p.id === 'dtc-support')
    expect(support?.name).toBe('独立站售后客服')
    expect(support?.roles.map((r) => r.role_id)).toContain('dtc.aftersales')
  })

  it('新建岗位 → 分配 → 删岗位被拦（还有人在做）→ 撤销后能删', async () => {
    const created = await data<{ id: string }>(
      await call('POST', '/v1/org/positions', {
        body: { name: '客服（夜班）', roles: [{ role_id: 'dtc.aftersales', default: true }] },
      }),
    )
    const mate = await inviteColleague('night@example.com')
    const granted = await data<AssignmentView[]>(
      await call('POST', '/v1/assignments', {
        body: {
          person_id: mate.person_id,
          position_id: created.id,
          ranges: [{ kind: 'store', id: 'store_main' }],
        },
      }),
    )
    expect(granted.map((a) => a.role_id)).toEqual(['dtc.aftersales'])
    const blocked = await call('DELETE', `/v1/org/positions/${created.id}`)
    expect(blocked.status).toBe(409)
    expect((await call('DELETE', `/v1/assignments/${granted[0]?.assignment_id}`)).status).toBe(200)
    expect((await call('DELETE', `/v1/org/positions/${created.id}`)).status).toBe(200)
  })
})

describe('把「独立站售后客服」分给一个同事（派工书的验收路径）', () => {
  it('邀请 → 接受 → 分配 → 同事自己登录后左栏就有这个岗位；owner 撤销后他 403', async () => {
    const mate = await inviteColleague('li@example.com', { name: '李默' })

    // 接受邀请只给"工作区成员"，还没有售后岗位
    const before = await data<{ positions: { role_id: string }[] }>(
      await call('GET', '/v1/positions', { token: mate.token, assignment: '' }),
    ).catch(() => ({ positions: [] }))
    expect(before.positions.some((p) => p.role_id === 'dtc.aftersales')).toBe(false)

    const granted = await data<AssignmentView[]>(
      await call('POST', '/v1/assignments', {
        body: {
          person_id: mate.person_id,
          position_id: 'dtc-support',
          ranges: [{ kind: 'store', id: 'store_main' }],
        },
      }),
    )
    const support = granted.find((a) => a.role_id === 'dtc.aftersales')
    expect(support).toBeDefined()
    expect(support?.role_name).toBe('独立站售后客服')

    // 同事以自己的身份看：左栏（/v1/positions）里就是这个岗位
    const mine = await data<{ positions: { position_id: string; role_id: string }[] }>(
      await call('GET', '/v1/positions', {
        token: mate.token,
        assignment: support?.assignment_id ?? '',
      }),
    )
    expect(mine.positions.map((p) => p.role_id)).toContain('dtc.aftersales')

    // 首页的数据条与卡片只按这一个岗位算（一次请求一个 Assignment）
    const home = await call('GET', '/v1/home?range=yesterday', {
      token: mate.token,
      assignment: support?.assignment_id ?? '',
    })
    expect(home.status).toBe(200)

    // owner 撤销 → 这条分配立刻不能再当凭据用
    expect((await call('DELETE', `/v1/assignments/${support?.assignment_id}`)).status).toBe(200)
    const after = await call('GET', '/v1/home?range=yesterday', {
      token: mate.token,
      assignment: support?.assignment_id ?? '',
    })
    expect(after.status).toBe(403)
  })
})

describe('一致性用例', () => {
  it('不并集：一人两岗位，拿 A 岗位的凭据要 B 岗位的权限 → 403', async () => {
    // owner 同时持有 common.owner 与 common.member；后者没有 policy 域
    const member = await data<AssignmentView[]>(
      await call('POST', '/v1/assignments', {
        body: {
          person_id: server.bootstrap.person.id,
          position_id: 'member',
          ranges: [],
        },
      }),
    )
    const memberAssignment = member[0]?.assignment_id ?? ''
    // 用 owner 那条：过
    expect((await call('GET', '/v1/roles')).status).toBe(200)
    // 用 member 那条：403——**即使同一个人也持有 owner 岗位**，权限不并集
    expect((await call('GET', '/v1/roles', { assignment: memberAssignment })).status).toBe(403)
  })

  it('空范围拒：范围为空的分配标 unassigned_range，assigned 范围的查询拿不到东西', async () => {
    const mate = await inviteColleague('empty@example.com')
    const granted = await data<AssignmentView[]>(
      await call('POST', '/v1/assignments', {
        body: { person_id: mate.person_id, position_id: 'dtc-support', ranges: [] },
      }),
    )
    const support = granted.find((a) => a.role_id === 'dtc.aftersales')
    expect(support?.unassigned_range).toBe(true)
    const effective = await data<{ unassigned_range: boolean }>(
      await call('GET', `/v1/assignments/${support?.assignment_id}/effective`, {
        token: mate.token,
        assignment: support?.assignment_id ?? '',
      }),
    )
    expect(effective.unassigned_range).toBe(true)
    expect(
      server.roles.can(support?.assignment_id ?? '', 'order', 'read', {
        range: 'assigned',
        sensitivity: 'internal',
      }),
    ).toBe(false)
  })

  it('撤销即失效：撤销后成员清单里没有它，X-Assignment 也不认了', async () => {
    const mate = await inviteColleague('gone@example.com')
    const granted = await data<AssignmentView[]>(
      await call('POST', '/v1/assignments', {
        body: {
          person_id: mate.person_id,
          position_id: 'dtc-support',
          ranges: [{ kind: 'store', id: 'store_main' }],
        },
      }),
    )
    const id = granted[0]?.assignment_id ?? ''
    await call('DELETE', `/v1/assignments/${id}`)
    expect((await assignmentsOf(mate.person_id)).some((a) => a.assignment_id === id)).toBe(false)
    // 撤销那一刻起，这条分配不能再当凭据用（`/v1/me` 不绑 Assignment，所以拿要绑的那条路验）
    expect(
      (await call('GET', '/v1/home?range=yesterday', { token: mate.token, assignment: id })).status,
    ).toBe(403)
  })

  it('移出成员：全部分配一次撤掉，他的 token 立刻失效（20 §4）', async () => {
    const mate = await inviteColleague('bye@example.com')
    await call('POST', '/v1/assignments', {
      body: {
        person_id: mate.person_id,
        position_id: 'dtc-support',
        ranges: [{ kind: 'store', id: 'store_main' }],
      },
    })
    const removed = await data<{ revoked_assignments: number }>(
      await call('DELETE', `/v1/workspaces/${ws()}/members/${mate.person_id}`),
    )
    expect(removed.revoked_assignments).toBeGreaterThanOrEqual(2)
    const res = await call('GET', '/v1/me', { token: mate.token, assignment: '' })
    expect(res.status).toBe(401)
  })

  it('非 owner 403：售后岗位打制度面一律拒', async () => {
    const mate = await inviteColleague('nope@example.com')
    const granted = await data<AssignmentView[]>(
      await call('POST', '/v1/assignments', {
        body: {
          person_id: mate.person_id,
          position_id: 'dtc-support',
          ranges: [{ kind: 'store', id: 'store_main' }],
        },
      }),
    )
    const support = granted.find((a) => a.role_id === 'dtc.aftersales')?.assignment_id ?? ''
    for (const [method, path] of [
      ['GET', '/v1/roles'],
      ['GET', '/v1/org/positions'],
      ['POST', '/v1/assignments'],
      ['GET', `/v1/workspaces/${ws()}/members`],
      ['POST', `/v1/workspaces/${ws()}/invitations`],
    ] as const) {
      const res = await call(method, path, {
        token: mate.token,
        assignment: support,
        ...(method === 'POST' ? { body: {} } : {}),
      })
      expect([403], `${method} ${path}`).toContain(res.status)
    }
  })

  it('改模板必经审批：PUT 只建卡；批准之后才生效', async () => {
    const copy = await data<{ id: string; name: string; version: string }>(
      await call('POST', '/v1/roles', { body: { from: 'dtc.aftersales' } }),
    )
    expect(copy.id).toBe('dtc.aftersales-custom')

    const receipt = await data<{ status: string; approval_item_id: string }>(
      await call('PUT', `/v1/roles/${copy.id}`, {
        body: {
          name: '售后（本公司口径）',
          actions: [{ id: 'stage_refund', caps: { max_auto_refund_amount: 30 } }],
        },
      }),
    )
    expect(receipt.status).toBe('pending_approval')

    // 还没批：职责定义一个字都没改
    const stillOld = await data<{ name: string }>(await call('GET', `/v1/roles/${copy.id}`))
    expect(stillOld.name).toBe(copy.name)

    // owner 批准那张卡
    const item = (await server.txn.approvals.get(receipt.approval_item_id)) as ApprovalItem
    expect(item.kind).toBe('policy_change')
    // 36 §2.2：policy_change 是选择题卡，批准必须说清选哪一个（after = 按提议改）
    const decided = await call('POST', `/v1/approvals/${item.id}/decide`, {
      body: { action: 'approve', selected_option_id: 'after' },
    })
    expect(decided.status).toBe(200)

    const applied = await data<{ name: string; version: string }>(
      await call('GET', `/v1/roles/${copy.id}`),
    )
    expect(applied.name).toBe('售后（本公司口径）')
    expect(applied.version).toBe('1.0.1')
  })

  it('选「维持现状」= 不改：卡结了，职责定义还是原来那份', async () => {
    const copy = await data<{ id: string; name: string }>(
      await call('POST', '/v1/roles', { body: { from: 'dtc.aftersales' } }),
    )
    const receipt = await data<{ approval_item_id: string }>(
      await call('PUT', `/v1/roles/${copy.id}`, { body: { name: '不该生效的名字' } }),
    )
    await call('POST', `/v1/approvals/${receipt.approval_item_id}/decide`, {
      body: { action: 'approve', selected_option_id: 'before' },
    })
    const after = await data<{ name: string }>(await call('GET', `/v1/roles/${copy.id}`))
    expect(after.name).toBe(copy.name)
  })

  it('内置职责不给直接改：先复制一份（409）', async () => {
    const res = await call('PUT', '/v1/roles/dtc.aftersales', { body: { name: '改个名' } })
    expect(res.status).toBe(409)
  })

  it('策略层：改额度也走 policy_change，批了才落到工作区', async () => {
    const receipt = await data<{ status: string; approval_item_id: string }>(
      await call('PUT', `/v1/workspaces/${ws()}/policy`, {
        body: { global_caps: { max_daily_refund_total: 400 } },
      }),
    )
    expect(receipt.status).toBe('pending_approval')
    const before = await data<{ global_caps: Record<string, number> }>(
      await call('GET', `/v1/workspaces/${ws()}/policy`),
    )
    expect(before.global_caps.max_daily_refund_total).toBeUndefined()
    await call('POST', `/v1/approvals/${receipt.approval_item_id}/decide`, {
      body: { action: 'approve', selected_option_id: 'after' },
    })
    const after = await data<{ global_caps: Record<string, number> }>(
      await call('GET', `/v1/workspaces/${ws()}/policy`),
    )
    expect(after.global_caps.max_daily_refund_total).toBe(400)
  })

  it('额度覆盖只能更紧：想放宽 → 400', async () => {
    const mate = await inviteColleague('tight@example.com')
    const granted = await data<AssignmentView[]>(
      await call('POST', '/v1/assignments', {
        body: {
          person_id: mate.person_id,
          position_id: 'dtc-support',
          ranges: [{ kind: 'store', id: 'store_main' }],
        },
      }),
    )
    const id = granted.find((a) => a.role_id === 'dtc.aftersales')?.assignment_id ?? ''
    const tighter = await call('PUT', `/v1/assignments/${id}`, {
      body: { mandate_overrides: { stage_refund: { caps: { max_auto_refund_amount: 20 } } } },
    })
    expect(tighter.status).toBe(200)
    const looser = await call('PUT', `/v1/assignments/${id}`, {
      body: { mandate_overrides: { stage_refund: { caps: { max_auto_refund_amount: 5000 } } } },
    })
    expect(looser.status).toBe(400)
  })

  it('邀请是一次性的：同一个链接接受两次 → 404', async () => {
    const invitation = await data<{ url: string }>(
      await call('POST', `/v1/workspaces/${ws()}/invitations`, {
        body: { email: 'twice@example.com' },
      }),
    )
    const token = invitation.url.slice(invitation.url.lastIndexOf('/') + 1)
    const accept = (): Promise<Response> =>
      server.gateway.fetch(
        new Request(`http://127.0.0.1/v1/invitations/${token}/accept`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        }),
      )
    expect((await accept()).status).toBe(200)
    expect((await accept()).status).toBe(404)
  })

  it('邀请过了 24 小时就不认了', async () => {
    const invitation = await data<{ url: string; expires_at: string }>(
      await call('POST', `/v1/workspaces/${ws()}/invitations`, {
        body: { email: 'late@example.com' },
      }),
    )
    const token = invitation.url.slice(invitation.url.lastIndexOf('/') + 1)
    clock.advance(25 * 60 * 60 * 1000)
    const res = await server.gateway.fetch(
      new Request(`http://127.0.0.1/v1/invitations/${token}/accept`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
    )
    expect(res.status).toBe(404)
  })

  it('邀请的 token 不进事件日志', async () => {
    const invitation = await data<{ url: string }>(
      await call('POST', `/v1/workspaces/${ws()}/invitations`, {
        body: { email: 'secret@example.com' },
      }),
    )
    const token = invitation.url.slice(invitation.url.lastIndexOf('/') + 1)
    const events: string[] = []
    for await (const e of server.kernel.eventLog.read({ workspace_id: ws() }))
      events.push(JSON.stringify(e))
    expect(events.join('\n')).not.toContain(token)
    expect(events.some((e) => e.includes('invitation.created'))).toBe(true)
  })
})

/**
 * WP47 / 44：品牌（范围组）与产品线走完整条路由 → OrgPort → roles 的真装配线。
 */
describe('44 品牌与产品线', () => {
  interface RangeGroupView {
    id: string
    name: string
    members: { kind: string; id: string }[]
    holders: number
  }
  interface ProductLineView {
    id: string
    name: string
    parent: { kind: string; id: string }
    rule: { platform: string; tags?: string[] }
    holders: number
    pushdown: boolean
  }

  const brand = (body: unknown) => call('POST', '/v1/org/range-groups', { body })
  const lineOf = (body: unknown) => call('POST', '/v1/org/product-lines', { body })

  it('G1：建一个品牌，把它分给同事 → 岗位拿到的是展开后的范围', async () => {
    const created = await data<RangeGroupView>(
      await brand({
        name: '品牌乙',
        members: [
          { kind: 'store', id: 'store_b1' },
          { kind: 'store', id: 'store_b2' },
        ],
      }),
    )
    expect(created.holders).toBe(0)
    const li = await inviteColleague('li@example.com', { name: '李默' })
    await data(
      await call('POST', '/v1/assignments', {
        body: {
          person_id: li.person_id,
          position_id: 'dtc-support',
          ranges: [],
          range_groups: [created.id],
        },
      }),
    )
    const mine = (await assignmentsOf(li.person_id)).find((a) => a.role_id === 'dtc.aftersales')
    expect(mine?.ranges.map((r) => r.id).sort()).toEqual(['store_b1', 'store_b2'])
    expect(mine?.unassigned_range).toBe(false)
    const groups = await data<RangeGroupView[]>(await call('GET', '/v1/org/range-groups'))
    expect(groups[0]?.holders).toBe(1)
  })

  it('G5：品牌新开一家店 → 挂它的岗位自动多这家店，留一条事件 + 一张给 owner 的 L3 卡', async () => {
    const created = await data<RangeGroupView>(
      await brand({ name: '品牌乙', members: [{ kind: 'store', id: 'store_b1' }] }),
    )
    const li = await inviteColleague('li2@example.com', { name: '李默' })
    await data(
      await call('POST', '/v1/assignments', {
        body: {
          person_id: li.person_id,
          position_id: 'dtc-support',
          ranges: [],
          range_groups: [created.id],
        },
      }),
    )
    await data(
      await call('PUT', `/v1/org/range-groups/${created.id}`, {
        body: {
          name: '品牌乙',
          members: [
            { kind: 'store', id: 'store_b1' },
            { kind: 'store', id: 'store_b3' },
          ],
        },
      }),
    )
    const mine = (await assignmentsOf(li.person_id)).find((a) => a.role_id === 'dtc.aftersales')
    expect(mine?.ranges.map((r) => r.id).sort()).toEqual(['store_b1', 'store_b3'])

    const types: string[] = []
    for await (const e of server.kernel.eventLog.read({ workspace_id: ws() })) types.push(e.type)
    expect(types).toContain('range_group.created')
    expect(types).toContain('range_group.updated')
    expect(types).toContain('assignment.range_expanded')

    // owner 手上有一张说明这件事的卡（L3：默认放行，只通知）
    const cards = await server.txn.approvals.queue({
      workspace_id: ws(),
      person_id: server.bootstrap.workspace.owner_id,
      lane: 'mine',
      state: ['pending', 'auto_approved', 'approved', 'in_review'],
    })
    const card = cards.find((c) => c.title.includes('品牌乙'))
    expect(card).toBeDefined()
    expect(card?.automation.level_at_creation).toBe('L3')
  })

  it('还有岗位挂着的品牌删不掉（409）', async () => {
    const created = await data<RangeGroupView>(
      await brand({ name: '品牌甲', members: [{ kind: 'store', id: 'store_a' }] }),
    )
    const chen = await inviteColleague('chen@example.com', { name: '陈晓' })
    await data(
      await call('POST', '/v1/assignments', {
        body: {
          person_id: chen.person_id,
          position_id: 'dtc-support',
          ranges: [],
          range_groups: [created.id],
        },
      }),
    )
    const res = await call('DELETE', `/v1/org/range-groups/${created.id}`)
    expect(res.status).toBe(409)
    // 摘掉之后就删得了
    const mine = (await assignmentsOf(chen.person_id)).find((a) => a.role_id === 'dtc.aftersales')
    await data(
      await call('PUT', `/v1/assignments/${mine?.assignment_id}`, {
        body: { ranges: [], range_groups: [] },
      }),
    )
    expect((await call('DELETE', `/v1/org/range-groups/${created.id}`)).status).toBe(200)
  })

  it('G2：产品线 CRUD；能下推的判据标 pushdown，产品线也进"选范围"的候选', async () => {
    const created = await data<ProductLineView>(
      await lineOf({
        name: '厨房线',
        parent: { kind: 'store', id: 'store_main' },
        rule: { platform: 'shopify', tags: ['kitchen'] },
      }),
    )
    expect(created.pushdown).toBe(true)
    const options = await data<{ kind: string; id: string; label: string }[]>(
      await call('GET', '/v1/org/ranges'),
    )
    expect(options).toContainEqual({ kind: 'product_line', id: created.id, label: '厨房线' })

    const renamed = await data<ProductLineView>(
      await call('PUT', `/v1/org/product-lines/${created.id}`, {
        body: {
          name: '厨房线（北美）',
          parent: { kind: 'market', id: 'amz_na:US' },
          rule: { platform: 'amazon', asins: ['B0KITCHEN'] },
        },
      }),
    )
    expect(renamed.name).toBe('厨房线（北美）')
    expect(renamed.pushdown).toBe(false)
    expect((await call('DELETE', `/v1/org/product-lines/${created.id}`)).status).toBe(200)
    expect(await data<ProductLineView[]>(await call('GET', '/v1/org/product-lines'))).toEqual([])
  })

  it('G3：一个岗位同时挂店铺 + 品牌 + 产品线，取并集', async () => {
    const group = await data<RangeGroupView>(
      await brand({ name: '品牌乙', members: [{ kind: 'store', id: 'store_b1' }] }),
    )
    const line = await data<ProductLineView>(
      await lineOf({
        name: '厨房线',
        parent: { kind: 'store', id: 'store_main' },
        rule: { platform: 'manual', product_ids: ['prod_1'] },
      }),
    )
    const sun = await inviteColleague('sun@example.com', { name: '孙洋' })
    await data(
      await call('POST', '/v1/assignments', {
        body: {
          person_id: sun.person_id,
          position_id: 'dtc-support',
          ranges: [
            { kind: 'store', id: 'store_main' },
            { kind: 'product_line', id: line.id },
          ],
          range_groups: [group.id],
        },
      }),
    )
    const mine = (await assignmentsOf(sun.person_id)).find((a) => a.role_id === 'dtc.aftersales')
    expect(mine?.ranges.map((r) => `${r.kind}:${r.id}`).sort()).toEqual(
      [`product_line:${line.id}`, 'store:store_b1', 'store:store_main'].sort(),
    )
  })

  it('产品线只能切在店铺 / 账号 / 市场里面（400）；挂不存在的品牌 404', async () => {
    const bad = await lineOf({
      name: '不合法',
      parent: { kind: 'department', id: 'dep_1' },
      rule: { platform: 'manual', product_ids: [] },
    })
    expect(bad.status).toBe(400)
    const chu = await inviteColleague('chu@example.com', { name: '褚黎' })
    const res = await call('POST', '/v1/assignments', {
      body: {
        person_id: chu.person_id,
        position_id: 'dtc-support',
        ranges: [],
        range_groups: ['rg_nope'],
      },
    })
    expect(res.status).toBe(404)
  })

  it('普通成员碰不到这两组路由（403）', async () => {
    const wei = await inviteColleague('wei@example.com', { name: '卫青' })
    const mine = (await assignmentsOf(wei.person_id))[0]
    const res = await call('GET', '/v1/org/range-groups', {
      token: wei.token,
      assignment: mine?.assignment_id ?? '',
    })
    expect(res.status).toBe(403)
  })
})
