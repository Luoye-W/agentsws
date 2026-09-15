/**
 * 52 O1–O4（WP65）端到端：组织（公司）与品牌工作区，走真装配线
 * （路由 → `OrganizationsPort` → 身份层组织面 + 职责库 + 审批总线）。
 *
 * 覆盖的验收点：
 * - 52 O1 一次性迁移：启动就有一个组织，当前工作区挂在它下面，品牌名 = 工作区名
 * - 52 O1 个人用户：一个人一个品牌 → `solo: true`（界面上不显示组织）
 * - 52 O2 两个品牌互相看不见：卡片按 `workspace_id` 切，A 的卡在 B 一张都不出
 * - 52 O2 切品牌：换一张绑新工作区的会话 token；不在那个品牌里的人切不过去
 * - 52 O3 邀请进组织一次 + 勾品牌；离职按组织一撤全撤（40 E2）
 * - 52 O4 加一个品牌 + 从某个品牌复制（只复制职责分配，范围不跟着走）
 * - 45 H2 改写：只有品牌唯一键撞上才谈得上对照合并（`brandKey` 是那把尺）
 */
import { brandKey } from '@agentsws/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'

const T0 = '2026-09-15T09:00:00.000Z'

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

const servers: Server[] = []

/** 一张待审的回信（不经运行时：这条题要验的只是"它落在哪个品牌的队列里"）。 */
function draftIn(server: Server, workspace_id: string) {
  return {
    workspace_id,
    schema_version: 1,
    kind: 'outbound_draft' as const,
    role_id: 'common.owner',
    subject: { object: { type: 'thread' as const, id: 'thr_1' } },
    dedupe_key: `${workspace_id}:outbound_draft:thr_1`,
    title: '一封回信',
    summary: '退货请求',
    payload: {
      channel: 'email',
      to: { type: 'customer', id: 'cus_1' },
      body: { subject: 'Return', text: 'Your return window started on the order date.' },
    },
    evidence: {
      run_id: 'run_1',
      source_events: [],
      provenance: {
        seen: [
          { type: 'customer' as const, id: 'cus_1' },
          { type: 'thread' as const, id: 'thr_1' },
        ],
      },
      precheck: {},
    },
    proposer: {
      kind: 'agent' as const,
      id: 'agent',
      assignment_id: server.bootstrap.ownerAssignment.id,
    },
    automation: {
      level_at_creation: 'L1' as const,
      auto_approved: false,
      mandate_check: { within: true, caps_hit: [] },
      sampling: { selected: false },
    },
    routing: {
      recipients: [{ person: server.bootstrap.person.id, via: 'role_holder' as const }],
      rule: 'role_holder' as const,
      escalation: {
        after_hours: 8,
        business_hours: true,
        chain: ['owner'],
        escalated_at: [],
      },
      separation_of_duties: false,
    },
    priority: 'queue' as const,
    context: { thread_participants: ['cus_1'], verified_contacts: ['cus_1'] },
  }
}

async function boot(): Promise<Server> {
  const server = await createServer({
    clock: makeClock(),
    random: seeded(),
    quiet: true,
    startRun: false,
    tokenRefreshIntervalMs: 0,
    env: { AGENTSWS_OWNER_EMAIL: 'wang@nordvolt.cn', AGENTSWS_WORKSPACE_NAME: '诺伏特户外' },
    mdns: () => ({ reason: '测试里不开局域网' }),
  })
  servers.push(server)
  return server
}

interface Envelope<T> {
  data?: T
  error?: { code: string; message: string }
}

async function call<T>(
  server: Server,
  method: string,
  path: string,
  init: { body?: unknown; token?: string; assignment?: string } = {},
): Promise<{ status: number; data?: T; error?: Envelope<T>['error'] }> {
  const headers = new Headers({ 'content-type': 'application/json' })
  headers.set('Authorization', `Bearer ${init.token ?? server.bootstrap.internalToken}`)
  headers.set('X-Assignment', init.assignment ?? server.bootstrap.ownerAssignment.id)
  const res = await server.gateway.fetch(
    new Request(`http://127.0.0.1${path}`, {
      method,
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    }),
  )
  const parsed = (await res.json()) as Envelope<T>
  return {
    status: res.status,
    ...(parsed.data === undefined ? {} : { data: parsed.data }),
    ...(parsed.error === undefined ? {} : { error: parsed.error }),
  }
}

interface OrgRow {
  id: string
  legal_name: string
  discoverable: boolean
  brands: number
  members: number
  solo: boolean
  role: string
}
interface BrandRow {
  workspace_id: string
  name: string
  current: boolean
  pending_approvals: number
  alerts: number
  vertical?: string
  storefront_platform?: string
}

async function orgOf(server: Server): Promise<OrgRow> {
  const res = await call<OrgRow[]>(server, 'GET', '/v1/orgs')
  expect(res.status).toBe(200)
  const first = res.data?.[0]
  if (first === undefined) throw new Error('启动之后应该至少有一个组织')
  return first
}

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
})

describe('52 O1 一次性迁移与个人用户', () => {
  it('启动就有一个组织，当前工作区挂在它下面，品牌名 = 工作区名', async () => {
    const server = await boot()
    const org = await orgOf(server)
    expect(org.brands).toBe(1)
    expect(org.members).toBe(1)
    expect(org.role).toBe('owner')
    // 还没走过向导：公司名先用工作区名占位（不留一个空公司）
    expect(org.legal_name).toBe('诺伏特户外')

    const workspace = await server.identity.getWorkspace(server.bootstrap.workspace.id)
    expect(workspace?.org_id).toBe(org.id)
    expect(workspace?.brand?.name).toBe('诺伏特户外')
  })

  it('一个人一个品牌 = solo：界面上不显示组织（52 O1）', async () => {
    const server = await boot()
    expect((await orgOf(server)).solo).toBe(true)
    const org = await orgOf(server)
    await call(server, 'POST', `/v1/orgs/${org.id}/brands`, { body: { name: '诺伏特室内' } })
    // 加了第二个品牌就不再是 solo——从这一刻起切换器与组织卡才该出现
    expect((await orgOf(server)).solo).toBe(false)
  })

  it('写公司档案 = 写组织：发现开关与全称的真源在组织上（52 O1「写时同步写组织」）', async () => {
    const server = await boot()
    const before = await orgOf(server)
    const saved = await call(server, 'PUT', '/v1/workspace/profile', {
      body: { legal_name: '深圳诺伏特科技', domain: 'NordVolt.cn', discoverable: false },
    })
    expect(saved.status).toBe(200)
    const after = await orgOf(server)
    expect(after.id).toBe(before.id)
    expect(after.legal_name).toBe('深圳诺伏特科技')
    expect(after.discoverable).toBe(false)
    // 反过来改组织，首次设置那一面读到的也是新的（读一律以组织为准）
    await call(server, 'PATCH', `/v1/orgs/${after.id}`, { body: { legal_name: '诺伏特科技' } })
    const state = await call<{ profile?: { legal_name: string; discoverable: boolean } }>(
      server,
      'GET',
      '/v1/onboarding/state',
    )
    expect(state.data?.profile?.legal_name).toBe('诺伏特科技')
    expect(state.data?.profile?.discoverable).toBe(false)
  })
})

describe('52 O2 品牌一览、隔离与切换', () => {
  it('加一个品牌：品牌级档案各存一份，新品牌里自带一条 owner 分配', async () => {
    const server = await boot()
    const org = await orgOf(server)
    await call(server, 'PUT', '/v1/workspace/profile', {
      body: { legal_name: '深圳诺伏特科技', vertical: 'goods', storefront_platform: 'shopify' },
    })
    const created = await call<BrandRow>(server, 'POST', `/v1/orgs/${org.id}/brands`, {
      body: { name: '诺伏特课程', vertical: 'digital', storefront_platform: 'other' },
    })
    expect(created.status).toBe(201)
    const brandB = created.data
    if (brandB === undefined) throw new Error('建品牌应该有回执')
    // 「你卖的是」与「网站平台」是**每个品牌各一份**的，不是公司级
    expect(brandB.vertical).toBe('digital')
    expect(brandB.storefront_platform).toBe('other')
    expect(brandB.current).toBe(false)

    const list = await call<BrandRow[]>(server, 'GET', `/v1/orgs/${org.id}/brands`)
    expect(list.data?.map((b) => b.name).sort()).toEqual(['诺伏特户外', '诺伏特课程'].sort())
    expect(list.data?.find((b) => b.current)?.workspace_id).toBe(server.bootstrap.workspace.id)
    // 新品牌里自己有一条 owner 分配——不然建完连自己都进不去
    const owner = server.roles.assignments
      .listByPerson(server.bootstrap.person.id, { workspace_id: brandB.workspace_id })
      .filter((a) => a.revoked_at === undefined)
    expect(owner.map((a) => a.role_id)).toEqual(['common.owner'])
  })

  it('同一家公司下不许有两个同名品牌', async () => {
    const server = await boot()
    const org = await orgOf(server)
    const first = await call(server, 'POST', `/v1/orgs/${org.id}/brands`, {
      body: { name: '诺伏特课程' },
    })
    expect(first.status).toBe(201)
    const dup = await call(server, 'POST', `/v1/orgs/${org.id}/brands`, {
      body: { name: '诺伏特课程' },
    })
    expect(dup.status).toBe(409)
  })

  it('两个品牌互相看不见：A 的卡在 B 的队列里一张都不出（52 O2）', async () => {
    const server = await boot()
    const org = await orgOf(server)
    const brandB = (
      await call<BrandRow>(server, 'POST', `/v1/orgs/${org.id}/brands`, {
        body: { name: '诺伏特课程' },
      })
    ).data
    if (brandB === undefined) throw new Error('建品牌应该有回执')

    // 在品牌甲里造一张真卡（走同一条审批总线）
    await server.txn.approvals.create(draftIn(server, server.bootstrap.workspace.id))
    const mine = await server.txn.approvals.queue({
      workspace_id: server.bootstrap.workspace.id,
      person_id: server.bootstrap.person.id,
      lane: 'scope',
      state: ['pending'],
    })
    expect(mine.length).toBeGreaterThan(0)
    // 同一个人、同一条总线、换一个 `workspace_id` —— 一张都看不到
    const theirs = await server.txn.approvals.queue({
      workspace_id: brandB.workspace_id,
      person_id: server.bootstrap.person.id,
      lane: 'scope',
      state: ['pending'],
    })
    expect(theirs).toHaveLength(0)

    // 品牌一览上的数也是各算各的
    const rows = await call<BrandRow[]>(server, 'GET', `/v1/orgs/${org.id}/brands`)
    const a = rows.data?.find((b) => b.workspace_id === server.bootstrap.workspace.id)
    const b = rows.data?.find((b) => b.workspace_id === brandB.workspace_id)
    expect(a?.pending_approvals).toBeGreaterThan(0)
    expect(b?.pending_approvals).toBe(0)
  })

  it('知识也按品牌切：甲的事实卡在乙查不到', async () => {
    const server = await boot()
    const org = await orgOf(server)
    const brandB = (
      await call<BrandRow>(server, 'POST', `/v1/orgs/${org.id}/brands`, {
        body: { name: '诺伏特课程' },
      })
    ).data
    if (brandB === undefined) throw new Error('建品牌应该有回执')
    const card = await server.knowledge.store.propose({
      schema_version: 1,
      workspace_id: server.bootstrap.workspace.id,
      layer: 'fact',
      domain: 'knowledge',
      scope: [{ kind: 'store', id: 'store_main' }],
      sensitivity: 'internal',
      subject: { type: 'fact_card', key: 'policy.return_window' },
      statement: '甲品牌退货期 30 天',
      provenance: [{ source: 'document', ref: 'policy.md', locator: 'p1', at: T0 }],
      confidence: { value: 0.9, state: 'probable' },
      valid: {},
      owner: server.bootstrap.person.id,
      created_by: { kind: 'person', id: server.bootstrap.person.id },
    })
    await server.knowledge.store.activate(card.id, server.bootstrap.person.id)
    const actorIn = (workspace_id: string) => ({
      person_id: server.bootstrap.person.id,
      assignment_id: server.bootstrap.ownerAssignment.id,
      role_id: 'common.owner',
      workspace_id,
      grants: [
        {
          domain: 'knowledge',
          ops: ['read' as const],
          range: 'workspace' as const,
          max_sensitivity: 'restricted' as const,
        },
      ],
      ranges: [{ kind: 'store' as const, id: 'store_main' }],
    })
    const inA = await server.knowledge.store.list(
      { workspace_id: server.bootstrap.workspace.id },
      actorIn(server.bootstrap.workspace.id),
    )
    expect(inA.length).toBeGreaterThan(0)
    // 同一个库、同一个人、换一个 `workspace_id` —— 一张都查不到
    const inB = await server.knowledge.store.list(
      { workspace_id: brandB.workspace_id },
      actorIn(brandB.workspace_id),
    )
    expect(inB).toHaveLength(0)
  })

  it('切品牌：换一张绑新工作区的会话 token；不在那个品牌里的人切不过去', async () => {
    const server = await boot()
    const org = await orgOf(server)
    const brandB = (
      await call<BrandRow>(server, 'POST', `/v1/orgs/${org.id}/brands`, {
        body: { name: '诺伏特课程' },
      })
    ).data
    if (brandB === undefined) throw new Error('建品牌应该有回执')

    const switched = await call<{ workspace_id: string; name: string; session_token?: string }>(
      server,
      'POST',
      `/v1/orgs/${org.id}/brands/${brandB.workspace_id}/switch`,
    )
    expect(switched.status).toBe(200)
    expect(switched.data?.name).toBe('诺伏特课程')
    const token = switched.data?.session_token
    if (token === undefined) throw new Error('本地档应该把新会话 token 回给前端')
    const who = await server.identity.authenticate(token)
    expect(who?.workspace_id).toBe(brandB.workspace_id)
    expect(who?.person_id).toBe(server.bootstrap.person.id)

    // 换一个只在公司里、还没进任何品牌的人：切不过去（52 O2「看得见 ≠ 进得去」）
    const li = await server.identity.createPerson({ email: 'li@nordvolt.cn', name: '李默' })
    await server.identity.addOrganizationMember({ org_id: org.id, person_id: li.id })
    await server.identity.addMember({
      workspace_id: server.bootstrap.workspace.id,
      person_id: li.id,
      role: 'member',
      ranges: [],
    })
    const liAssignment = server.roles.assignments.create({
      person_id: li.id,
      workspace_id: server.bootstrap.workspace.id,
      role_id: 'common.owner',
      granted_by: server.bootstrap.person.id,
      ranges: [],
    })
    const liToken = server.identity.issue('session', li.id, server.bootstrap.workspace.id).token
    const denied = await call(
      server,
      'POST',
      `/v1/orgs/${org.id}/brands/${brandB.workspace_id}/switch`,
      { token: liToken, assignment: liAssignment.id },
    )
    expect(denied.status).toBe(403)
    // 他的下拉里也根本不该出现那个品牌
    const visible = await call<BrandRow[]>(server, 'GET', `/v1/orgs/${org.id}/brands`, {
      token: liToken,
      assignment: liAssignment.id,
    })
    expect(visible.data?.map((b) => b.workspace_id)).toEqual([server.bootstrap.workspace.id])
  })
})

describe('52 O3 人：邀请进组织一次，离职一撤全撤', () => {
  it('邀请进公司 + 勾两个品牌：各发一张一次性链接；人先进公司再进品牌', async () => {
    const server = await boot()
    const org = await orgOf(server)
    const brandB = (
      await call<BrandRow>(server, 'POST', `/v1/orgs/${org.id}/brands`, {
        body: { name: '诺伏特课程' },
      })
    ).data
    if (brandB === undefined) throw new Error('建品牌应该有回执')

    const invited = await call<{
      email: string
      brands: string[]
      tokens: { workspace_id: string; token: string }[]
    }>(server, 'POST', `/v1/orgs/${org.id}/members`, {
      body: {
        email: 'Li@nordvolt.cn',
        name: '李默',
        role: 'member',
        brands: [server.bootstrap.workspace.id, brandB.workspace_id],
      },
    })
    expect(invited.status).toBe(201)
    expect(invited.data?.tokens).toHaveLength(2)

    const members = await call<{ person_id: string; role: string; brands: string[] }[]>(
      server,
      'GET',
      `/v1/orgs/${org.id}/members`,
    )
    const li = members.data?.find((m) => m.role === 'member')
    expect(li).toBeDefined()
    // 还没点链接：人在公司名单上，品牌一个都没进（52 O3 的中间态）
    expect(li?.brands).toEqual([])

    for (const t of invited.data?.tokens ?? []) await server.identity.acceptInvitation(t.token)
    const after = await call<{ person_id: string; brands: string[] }[]>(
      server,
      'GET',
      `/v1/orgs/${org.id}/members`,
    )
    expect(after.data?.find((m) => m.person_id === li?.person_id)?.brands.sort()).toEqual(
      [server.bootstrap.workspace.id, brandB.workspace_id].sort(),
    )
  })

  it('离职：一次撤两个品牌的成员关系与分配，名单上留痕（40 E2）', async () => {
    const server = await boot()
    const org = await orgOf(server)
    const brandB = (
      await call<BrandRow>(server, 'POST', `/v1/orgs/${org.id}/brands`, {
        body: { name: '诺伏特课程' },
      })
    ).data
    if (brandB === undefined) throw new Error('建品牌应该有回执')
    const li = await server.identity.createPerson({ email: 'li@nordvolt.cn', name: '李默' })
    await server.identity.addOrganizationMember({ org_id: org.id, person_id: li.id })
    for (const ws of [server.bootstrap.workspace.id, brandB.workspace_id]) {
      await server.identity.addMember({
        workspace_id: ws,
        person_id: li.id,
        role: 'member',
        ranges: [],
      })
      server.roles.assignments.create({
        person_id: li.id,
        workspace_id: ws,
        role_id: 'common.owner',
        granted_by: server.bootstrap.person.id,
        ranges: [],
      })
    }

    const removed = await call<{ brands: string[]; revoked_assignments: number }>(
      server,
      'DELETE',
      `/v1/orgs/${org.id}/members/${li.id}`,
    )
    expect(removed.status).toBe(200)
    expect(removed.data?.brands).toHaveLength(2)
    expect(removed.data?.revoked_assignments).toBe(2)
    for (const ws of [server.bootstrap.workspace.id, brandB.workspace_id])
      expect(
        server.roles.assignments
          .listByPerson(li.id, { workspace_id: ws })
          .filter((a) => a.revoked_at === undefined),
      ).toHaveLength(0)
    // 不删行：名单上那一条还在，标了什么时候走的
    const members = await call<{ person_id: string; left_at?: string }[]>(
      server,
      'GET',
      `/v1/orgs/${org.id}/members`,
    )
    expect(members.data?.find((m) => m.person_id === li.id)?.left_at).toBeDefined()
  })
})

describe('52 O4 加品牌与"从某个品牌复制"', () => {
  it('复制只搬职责分配，范围留在原地；连接与知识一个字节都不复制', async () => {
    const server = await boot()
    const org = await orgOf(server)
    const li = await server.identity.createPerson({ email: 'li@nordvolt.cn', name: '李默' })
    await server.identity.addOrganizationMember({ org_id: org.id, person_id: li.id })
    await server.identity.addMember({
      workspace_id: server.bootstrap.workspace.id,
      person_id: li.id,
      role: 'member',
      ranges: [],
    })
    server.roles.assignments.create({
      person_id: li.id,
      workspace_id: server.bootstrap.workspace.id,
      role_id: 'common.owner',
      granted_by: server.bootstrap.person.id,
      // 范围是**源品牌的店**：复制过去只会指向一个新品牌里根本不存在的东西
      ranges: [{ kind: 'store', id: 'store_main' }],
    })

    const created = await call<BrandRow>(server, 'POST', `/v1/orgs/${org.id}/brands`, {
      body: { name: '诺伏特课程', copy_from: server.bootstrap.workspace.id },
    })
    expect(created.status).toBe(201)
    const brandB = created.data
    if (brandB === undefined) throw new Error('建品牌应该有回执')

    const copied = server.roles.assignments
      .listByWorkspace(brandB.workspace_id)
      .filter((a) => a.revoked_at === undefined)
    // owner 自己那条（建品牌时就有）+ 李默那条
    expect(copied.map((a) => a.person_id).sort()).toEqual(
      [server.bootstrap.person.id, li.id].sort(),
    )
    // 范围一律空着，等这个品牌连上自己的店再挂
    expect(copied.flatMap((a) => a.ranges)).toHaveLength(0)

    // 再复制一次是幂等的：同一个人同一条职责不会出现第二份
    const again = await call<{
      copied_assignments: number
      models_shared: boolean
      copied_model_providers?: number
    }>(server, 'POST', `/v1/orgs/${org.id}/brands/${brandB.workspace_id}/copy-from`, {
      body: { from: server.bootstrap.workspace.id },
    })
    expect(again.status).toBe(201)
    expect(again.data?.copied_assignments).toBe(0)
    // WP66：模型设置按品牌各一份了（不再是"本来就共用"）；源品牌一条都没配，
    // 所以这一次也没什么可搬的
    expect(again.data?.models_shared).toBe(false)
    expect(again.data?.copied_model_providers).toBe(0)
  })

  it('不能从自己复制到自己；也不能复制别家公司的品牌', async () => {
    const server = await boot()
    const org = await orgOf(server)
    const same = await call(
      server,
      'POST',
      `/v1/orgs/${org.id}/brands/${server.bootstrap.workspace.id}/copy-from`,
      { body: { from: server.bootstrap.workspace.id } },
    )
    expect(same.status).toBe(400)
    const alien = await call(
      server,
      'POST',
      `/v1/orgs/${org.id}/brands/${server.bootstrap.workspace.id}/copy-from`,
      { body: { from: 'ws_someone_else' } },
    )
    expect(alien.status).toBe(404)
  })
})

describe('45 H2 改写：只有品牌唯一键撞上才谈得上对照合并', () => {
  it('品牌名归一化 + 店铺域名是那把尺', async () => {
    // 同一个品牌（写法不同）→ 同一把钥匙 → 走 45 的对照合并
    expect(brandKey('诺伏特 户外', 'Nordvolt.cn')).toBe(brandKey('诺伏特户外', 'www.nordvolt.cn'))
    // 同一家公司下的两个品牌 → 两把钥匙 → 各自挂到组织下，谁也不并进谁
    expect(brandKey('诺伏特户外', 'nordvolt.cn')).not.toBe(brandKey('诺伏特课程', 'nordvolt.cn'))
  })
})
