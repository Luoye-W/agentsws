/**
 * WP276（docs/95 §1 / §3.3 / §3.6 / §6.2，决策 237 / 243 / 274）：② 同事互联——真服务进程。
 *
 * 钉住的：
 * 1. ① → ②：贴邀请码申请的是「一起用」（卡上不说加入公司 / 成为成员），同意后不出空的并进来对照卡；
 * 2. ② 新人申请发给每一位同事，谁先点算谁的，团队页上记着是谁同意的；
 * 3. ② 平级同事进得了团队页（岗位、同事、邀请码、申请）与连接页；请人离开、删岗位仍只有发起人；
 * 4. ② 同事能改共用职责的规矩（当场生效，WP275 那张通知卡给同岗位的人）；
 * 5. ② 角色定位谁都能改，同岗位的人收一张「知道了 / 撤回」，撤回就改回去；
 * 6. ② 没主人的卡（AI / 系统提的，老规矩发给所有者）改发给做那条职责的人；
 * 7. ② 自己退出：手上别人交给他的事交还原来那个人（要对方接下），发起人不能直接退；导出自己的副本；
 * 8. ③ 不变：同一个人进不了公司页、退不了。
 */
import type { ApprovalItem } from '@agentsws/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'

const T0 = '2026-10-08T02:00:00.000Z'

function seeded(seed = 13): () => number {
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
let now = Date.parse(T0)

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

const post = (path: string, body: unknown) =>
  server.gateway.fetch(
    new Request(`http://127.0.0.1${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )

const ws = (): string => server.bootstrap.workspace.id
const owner = (): string => server.bootstrap.person.id

async function login(email: string): Promise<string> {
  const link = await data<{ token: string }>(await post('/v1/auth/magic-link', { email }))
  const session = await data<{ session_token: string }>(
    await post('/v1/auth/verify', { token: link.token }),
  )
  return session.session_token
}

async function giveB2b(person_id: string): Promise<string> {
  const granted = await data<{ assignment_id: string; role_id: string }[]>(
    await call('POST', '/v1/assignments', {
      body: { person_id, position_id: 'b2b', ranges: [{ kind: 'brand', id: ws() }] },
    }),
  )
  const sales = granted.find((a) => a.role_id === 'b2b.sales')
  if (sales === undefined) throw new Error('没分到 b2b.sales')
  return sales.assignment_id
}

const queueOf = async (person_id: string): Promise<ApprovalItem[]> =>
  (await server.txn.approvals.queue({
    workspace_id: ws(),
    person_id,
    lane: 'mine',
  })) as ApprovalItem[]

/** 贴码申请 → 发起人在卡上同意（这一步把 ① 变成 ②）。回新人的 person_id。 */
async function joinWithCode(name: string, email: string): Promise<string> {
  const invite = await data<{ code: string }>(await call('POST', '/v1/invites'))
  const request = await data<{ id: string }>(
    await post('/v1/memberships/requests', { code: invite.code, name, email }),
  )
  const card = (await queueOf(owner())).find(
    (i) =>
      i.kind === 'membership' && (i.payload as { request_id?: string }).request_id === request.id,
  )
  if (card === undefined) throw new Error('没有申请卡')
  const res = await call('POST', `/v1/approvals/${card.id}/decide`, { body: { action: 'approve' } })
  expect(res.status).toBe(200)
  const person = server.identity.personByEmail(email)
  if (person === undefined) throw new Error('没建人')
  return person.id
}

const COMPANY = /加入一家公司|成为成员|合并向导|并进来|主管|老板|上级/

beforeEach(async () => {
  now = Date.parse(T0)
  server = await createServer({
    clock: { now: () => new Date(now++).toISOString() },
    random: seeded(),
    quiet: true,
    startRun: false,
    tokenRefreshIntervalMs: 0,
  })
})

afterEach(async () => {
  await server.close()
})

describe('WP276 ② 同事互联（真服务进程）', () => {
  it('① → ②：申请的是「一起用」，卡上不说公司那一套；同意后不出空的并进来对照卡、谁同意的记着', async () => {
    expect(await server.organizations.modeOf(ws())).toBe('solo')
    const invite = await data<{ code: string }>(await call('POST', '/v1/invites'))
    const request = await data<{ id: string }>(
      await post('/v1/memberships/requests', {
        code: invite.code,
        name: '林峰',
        email: 'lin@ex.com',
      }),
    )
    const card = (await queueOf(owner())).find((i) => i.kind === 'membership')
    expect(card?.title).toBe('林峰 想和你们一起用')
    expect(`${card?.title}${card?.summary}`).not.toMatch(COMPANY)
    await call('POST', `/v1/approvals/${card?.id}/decide`, { body: { action: 'approve' } })
    expect(await server.organizations.modeOf(ws())).toBe('peers')
    expect((await queueOf(owner())).some((i) => i.kind === 'join_mapping')).toBe(false)
    const requests = await data<{ id: string; status: string; decided_by?: string }[]>(
      await call('GET', '/v1/memberships/requests'),
    )
    expect(requests.find((r) => r.id === request.id)).toMatchObject({
      status: 'approved',
      decided_by: owner(),
    })
  })

  it('② 新人申请发给每一位同事，谁先点算谁的；平级同事进得了团队页 / 连接页，家务只有发起人', async () => {
    const lin = await joinWithCode('林峰', 'lin@ex.com')
    const linToken = await login('lin@ex.com')
    const linB2b = await giveB2b(lin)
    const as = { token: linToken, assignment: linB2b }
    // 团队页那几样
    expect((await call('GET', '/v1/org/positions', as)).status).toBe(200)
    expect((await call('GET', `/v1/workspaces/${ws()}/members`, as)).status).toBe(200)
    expect((await call('GET', '/v1/roles', as)).status).toBe(200)
    expect((await call('GET', '/v1/memberships/requests', as)).status).toBe(200)
    expect((await call('GET', '/v1/connections', as)).status).not.toBe(403)
    // 林峰也能发邀请码；第三个人来申请——卡同时在两人手上
    const invite = await data<{ code: string }>(await call('POST', '/v1/invites', as))
    const request = await data<{ id: string }>(
      await post('/v1/memberships/requests', {
        code: invite.code,
        name: '陈一',
        email: 'chen@ex.com',
      }),
    )
    const card = (await queueOf(lin)).find((i) => i.kind === 'membership')
    expect(card?.routing.recipients.map((r) => r.person).sort()).toEqual([lin, owner()].sort())
    const res = await call('POST', `/v1/approvals/${card?.id}/decide`, {
      ...as,
      body: { action: 'approve' },
    })
    expect(res.status).toBe(200)
    const requests = await data<{ id: string; status: string; decided_by?: string }[]>(
      await call('GET', '/v1/memberships/requests', as),
    )
    expect(requests.find((r) => r.id === request.id)).toMatchObject({
      status: 'approved',
      decided_by: lin,
    })
    expect((await queueOf(owner())).some((i) => i.id === card?.id)).toBe(false)
    // 家务：请人离开、删岗位只有发起人
    const chen = server.identity.personByEmail('chen@ex.com')?.id ?? ''
    expect((await call('DELETE', `/v1/workspaces/${ws()}/members/${chen}`, as)).status).toBe(403)
    expect((await call('DELETE', '/v1/org/positions/b2b', as)).status).toBe(403)
    // 连接：谁接的谁管——不是他接的（这一版之前接的、没记过是谁）断不了
    const conn = await call('DELETE', '/v1/connections/conn_from_before', as)
    expect(conn.status).toBe(403)
    expect(((await conn.json()) as { message?: string }).message).toContain('谁接的谁管')
    expect((await call('DELETE', `/v1/workspaces/${ws()}/members/${chen}`)).status).toBe(200)
  })

  it('② 同事能改共用职责的规矩（当场生效）；角色定位谁都能改，同岗位的人可撤回', async () => {
    const lin = await joinWithCode('林峰', 'lin@ex.com')
    const linToken = await login('lin@ex.com')
    const linB2b = await giveB2b(lin)
    await giveB2b(owner())
    const as = { token: linToken, assignment: linB2b }
    const copy = await data<{ id: string }>(
      await call('POST', '/v1/roles', { ...as, body: { from: 'b2b.sales' } }),
    )
    const receipt = await data<{ status: string }>(
      await call('PUT', `/v1/roles/${copy.id}`, { ...as, body: { name: '外贸业务（林峰改）' } }),
    )
    expect(receipt.status).toBe('applied')

    const before = await data<{ effective: { zh: string } | string; overridden: boolean }>(
      await call('GET', '/v1/personas?kind=role&id=b2b.sales', as),
    )
    expect(before.overridden).toBe(false)
    const set = await call('PUT', '/v1/personas', {
      ...as,
      body: { kind: 'role', id: 'b2b.sales', zh: '你是这家店的外贸业务员，口气稳，报价先看毛利。' },
    })
    expect(set.status).toBe(200)
    // 发起人（也在做 B2B）收一张「知道了 / 撤回」
    await new Promise((r) => setTimeout(r, 10))
    const notice = (await queueOf(owner())).find(
      (i) => (i.payload as { form?: string; target?: string }).target === 'persona',
    )
    expect(notice?.title).toContain('林峰改了')
    expect((await queueOf(lin)).some((i) => i.id === notice?.id)).toBe(false)
    await call('POST', `/v1/approvals/${notice?.id}/decide`, {
      body: { action: 'approve', selected_option_id: 'before' },
    })
    const after = await data<{ overridden: boolean }>(
      await call('GET', '/v1/personas?kind=role&id=b2b.sales', as),
    )
    expect(after.overridden).toBe(false)
  })

  it('② 没主人的卡改发给做那条职责的人（谁先点算谁的）；③ 照旧给所有者', async () => {
    const lin = await joinWithCode('林峰', 'lin@ex.com')
    await giveB2b(lin)
    await giveB2b(owner())
    const input = {
      workspace_id: ws(),
      schema_version: 1 as const,
      kind: 'skill_promotion' as const,
      role_id: 'b2b.sales',
      subject: { object: { type: 'skill', id: 'b2b-quote' } },
      title: '把报价技能提到岗位层',
      summary: '三个人都这么改过',
      payload: { form: 'skill_promotion' },
      evidence: { source_events: [], provenance: { seen: [] }, precheck: {} },
      proposer: { kind: 'agent' as const, id: 'learning' },
      automation: { level_at_creation: 'L1' as const },
      routing: {
        recipients: [{ person: owner(), via: 'owner' as const }],
        rule: 'owner' as const,
        escalation: {
          after_hours: 48,
          business_hours: true,
          chain: ['owner' as const],
          escalated_at: [],
        },
        separation_of_duties: false,
      },
      priority: 'digest' as const,
    }
    const routed = await server.approvals.create({ ...input, dedupe_key: `${ws()}:sp:a` })
    expect(routed.routing.recipients.map((r) => r.person).sort()).toEqual([lin, owner()].sort())
    expect(routed.routing.escalation.chain).toEqual([])
    // ③ 照旧给所有者
    for (const org of server.identity.listOrganizations())
      await server.identity.updateOrganization(org.id, { mode: 'company' })
    const kept = await server.approvals.create({ ...input, dedupe_key: `${ws()}:sp:b` })
    expect(kept.routing.recipients.map((r) => r.person)).toEqual([owner()])
  })

  it('② 自己退出：别人交给他的事交还原来那个人；发起人不能直接退；能导出自己的副本', async () => {
    const lin = await joinWithCode('林峰', 'lin@ex.com')
    const linToken = await login('lin@ex.com')
    const linB2b = await giveB2b(lin)
    const mine = await giveB2b(owner())
    const as = { token: linToken, assignment: linB2b }
    const made = await data<{ matter: { id: string } }>(
      await call('POST', '/v1/matters', {
        assignment: mine,
        body: { kind: 'project', title: 'Acme 报价' },
      }),
    )
    await call('POST', `/v1/handoffs/matter/${made.matter.id}`, {
      assignment: mine,
      body: { to: lin },
    })
    await call('POST', `/v1/handoffs/matter/${made.matter.id}/accept`, as)
    const exported = await data<{ matters: { matter: { id: string } }[] }>(
      await call('GET', '/v1/work/mine/export', as),
    )
    expect(exported.matters.map((m) => m.matter.id)).toContain(made.matter.id)

    expect((await call('POST', `/v1/workspaces/${ws()}/leave`)).status).toBe(409)
    const left = await data<{ returned: number }>(
      await call('POST', `/v1/workspaces/${ws()}/leave`, as),
    )
    expect(left.returned).toBe(1)
    const view = await data<{ matter: { handoff: { state: string; from: string; to: string } } }>(
      await call('GET', `/v1/matters/${made.matter.id}`, { assignment: mine }),
    )
    expect(view.matter.handoff).toMatchObject({ state: 'offered', from: lin, to: owner() })
    expect(await server.organizations.modeOf(ws())).toBe('solo')
  })

  it('② 提到岗位层、工具箱合并：当场生效，同岗位的人 / 两条的主人收「知道了 / 撤回」，撤回就改回去', async () => {
    const lin = await joinWithCode('林峰', 'lin@ex.com')
    const linToken = await login('lin@ex.com')
    const linB2b = await giveB2b(lin)
    await giveB2b(owner())
    const as = { token: linToken, assignment: linB2b }
    // 提层：林峰把自己的一句话提到 B2B 岗位层
    const section_id = server.skills.registry.listSections('customer-care')[0]?.id ?? ''
    await server.skills.registry.setOverlay({
      skill: 'customer-care',
      tier: 'personal',
      owner: lin,
      ops: [{ op: 'replace', section_id, body: '岗位里都这么回' }],
      base_version: '1.0.0',
      version: 0,
    })
    const promoted = await data<{ applied?: boolean }>(
      await call('POST', '/v1/skills/customer-care/promote', {
        ...as,
        body: { section_ids: [section_id], to_tier: 'position', scope_id: 'b2b' },
      }),
    )
    expect(promoted.applied).toBe(true)
    expect(
      JSON.stringify(server.skills.registry.getOverlay('customer-care', 'position', 'b2b')?.ops),
    ).toContain('岗位里都这么回')
    await new Promise((r) => setTimeout(r, 10))
    const layerNotice = (await queueOf(owner())).find(
      (i) => (i.payload as { target?: string }).target === 'skill_overlay',
    )
    expect(layerNotice?.title).toContain('林峰改了')
    await call('POST', `/v1/approvals/${layerNotice?.id}/decide`, {
      body: { action: 'approve', selected_option_id: 'before' },
    })
    expect(server.skills.registry.getOverlay('customer-care', 'position', 'b2b')?.ops).toEqual([])

    // 合并：发起人建了一条、林峰建了一条一样的；林峰把发起人那条并进自己的 → 发起人收通知，撤回就拆开
    const CRON = { kind: 'cron', expr: '0 9 * * *', tz: 'Asia/Shanghai' }
    const a = await data<{ id: string }>(
      await call('POST', '/v1/schedules', { body: { title: '每天早上汇总询盘', trigger: CRON } }),
    )
    const b = await data<{ id: string }>(
      await call('POST', '/v1/schedules', {
        ...as,
        body: {
          title: '每天早上汇总询盘',
          trigger: CRON,
          duplicate_ack: {
            decision: 'new',
            reason: '我这条只看外贸询盘，口径不一样的',
            similar_to: [`schedule:${a.id}`],
          },
        },
      }),
    )
    const merged = await data<{ applied?: boolean }>(
      await call('POST', '/v1/catalog/merge', {
        ...as,
        body: { keep: `schedule:${b.id}`, drop: `schedule:${a.id}` },
      }),
    )
    expect(merged.applied).toBe(true)
    await new Promise((r) => setTimeout(r, 10))
    const mergeNotice = (await queueOf(owner())).find(
      (i) => (i.payload as { target?: string }).target === 'catalog_merge',
    )
    expect(mergeNotice).toBeDefined()
    await call('POST', `/v1/approvals/${mergeNotice?.id}/decide`, {
      body: { action: 'approve', selected_option_id: 'before' },
    })
    const left = await data<{ id: string }[]>(await call('GET', '/v1/catalog?kind=schedule'))
    expect(left.map((e) => e.id).sort()).toEqual([`schedule:${a.id}`, `schedule:${b.id}`].sort())
  })

  it('③ 不变：同一个同事进不了公司页、不能自己退', async () => {
    const lin = await joinWithCode('林峰', 'lin@ex.com')
    const linToken = await login('lin@ex.com')
    const linB2b = await giveB2b(lin)
    for (const org of server.identity.listOrganizations())
      await server.identity.updateOrganization(org.id, { mode: 'company' })
    const as = { token: linToken, assignment: linB2b }
    expect((await call('GET', '/v1/org/positions', as)).status).toBe(403)
    expect((await call('GET', `/v1/workspaces/${ws()}/members`, as)).status).toBe(403)
    expect((await call('POST', '/v1/invites', as)).status).toBe(403)
    expect((await call('POST', `/v1/workspaces/${ws()}/leave`, as)).status).toBe(409)
  })
})
