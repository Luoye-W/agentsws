/**
 * WP277（docs/95 §3.4–§3.6，决策 239 / 240 / 241）：③ 开启公司模式——真服务进程。
 *
 * 钉住的：
 * 1. 向导：只有发起人能开（同事 403）；公司全称必填；开完 `mode = company`，品牌里的同事进组织名单、
 *    选的管理员是 admin；
 * 2. 同事收卡（239）：「知道了 / 我要退出」；退出按 ② 的退出走；
 * 3. 开了以后 ③ 全套：超授权的报价转老板；
 * 4. 降回 ②（240）：只有老板能降；等老板的卡退回本人；上级、管理员收起不删，再开原样回来；
 *    离职交接没做完不让降；没点的「知道了 / 我要退出」收掉；
 * 5. 老板可以不是发起人：组织与品牌的所有者一起换、他有负责人那条、超授权转他；
 * 6. 上级派活（241）：③ 里上级 → 下属直接生效、不出卡，下属首页一行通知；平级 / ② 照旧要对方接下。
 */
import type { ApprovalItem } from '@agentsws/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'

const T0 = '2026-10-08T02:00:00.000Z'

function seeded(seed = 17): () => number {
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
const modeNow = () => server.organizations.modeOf(ws())
const orgId = (): string => {
  const org = server.organizations.organizationOf(ws())
  if (org === undefined) throw new Error('没有组织')
  return org.id
}

async function colleague(email: string, name: string): Promise<{ token: string; id: string }> {
  const invitation = await data<{ url: string }>(
    await call('POST', `/v1/workspaces/${ws()}/invitations`, { body: { email, name } }),
  )
  const token = invitation.url.slice(invitation.url.lastIndexOf('/') + 1)
  const accepted = await data<{ person_id: string }>(
    await post(`/v1/invitations/${token}/accept`, {}),
  )
  const login = await data<{ token: string }>(await post('/v1/auth/magic-link', { email }))
  const session = await data<{ session_token: string }>(
    await post('/v1/auth/verify', { token: login.token }),
  )
  return { token: session.session_token, id: accepted.person_id }
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

/** 一张超授权的报价（1.84 万美元、毛利 18.5%）。 */
async function overMandateQuote(
  who: { token?: string },
  assignment: string,
): Promise<ApprovalItem> {
  const auth = who.token === undefined ? {} : { token: who.token }
  const draft = await data<{ draft: { id: string } }>(
    await call('POST', '/v1/b2b/quotes/drafts', {
      ...auth,
      assignment,
      body: {
        record: { account_id: 'acc_volthaus' },
        quote_version: {
          lines: [{ sku: 'GAN65', description: '65W GaN', qty: 1000, unit_price_usd: 18.4 }],
          margin_pct: 18.5,
          discount_pct: 0,
          payment_terms_days: 30,
          incoterm: 'FOB',
          valid_until: '2026-10-28',
        },
      },
    }),
  )
  const staged = await data<{ approval_item_id?: string }>(
    await call('POST', `/v1/b2b/quotes/drafts/${draft.draft.id}/submit`, { ...auth, assignment }),
  )
  const card = await server.txn.approvals.get(staged.approval_item_id ?? '')
  if (card === undefined) throw new Error('没出卡')
  return card
}

const queueOf = async (person_id: string): Promise<ApprovalItem[]> =>
  (await server.txn.approvals.queue({
    workspace_id: ws(),
    person_id,
    lane: 'mine',
    state: ['pending', 'in_review'],
  })) as ApprovalItem[]

const noticeOf = async (person_id: string): Promise<ApprovalItem | undefined> =>
  (await queueOf(person_id)).find((i) => (i.payload as { form?: string }).form === 'company_notice')

const setMode = (
  body: { mode: 'company' | 'peers'; legal_name?: string; boss?: string; admins?: string[] },
  as: { token?: string; assignment?: string } = {},
) => call('PUT', `/v1/orgs/${orgId()}/mode`, { body, ...as })

let lin: { token: string; id: string }
let he: { token: string; id: string }
let linB2b = ''
let heB2b = ''

beforeEach(async () => {
  now = Date.parse(T0)
  server = await createServer({
    clock: { now: () => new Date(now++).toISOString() },
    random: seeded(),
    quiet: true,
    startRun: false,
    tokenRefreshIntervalMs: 0,
  })
  lin = await colleague('lin@example.com', '林峰')
  he = await colleague('he@example.com', '何佳')
  linB2b = await giveB2b(lin.id)
  heB2b = await giveB2b(he.id)
  expect(await modeNow()).toBe('peers')
})

afterEach(async () => {
  await server.close()
})

describe('WP277 开公司模式向导', () => {
  it('只有发起人能开：同事 403；全称必填；开完是 ③、同事进组织名单、管理员是 admin', async () => {
    const theirs = await data<{ can_open: boolean; can_close: boolean }>(
      await call('GET', `/v1/orgs/${orgId()}/mode`, { token: lin.token, assignment: linB2b }),
    )
    expect(theirs).toMatchObject({ can_open: false, can_close: false })
    const denied = await setMode(
      { mode: 'company', legal_name: '深圳伏特豪斯' },
      { token: lin.token, assignment: linB2b },
    )
    expect(denied.status).toBe(403)

    const mine = await data<{
      can_open: boolean
      legal_name: string
      people: { person_id: string; name: string }[]
    }>(await call('GET', `/v1/orgs/${orgId()}/mode`))
    expect(mine.can_open).toBe(true)
    expect(mine.people.map((p) => p.name).sort()).toEqual(
      [server.bootstrap.person.name, '何佳', '林峰'].sort(),
    )
    expect((await setMode({ mode: 'company', legal_name: '  ' })).status).toBe(400)
    expect(await modeNow()).toBe('peers')

    const opened = await data<{ mode: string; legal_name: string }>(
      await setMode({ mode: 'company', legal_name: '深圳伏特豪斯科技有限公司', admins: [he.id] }),
    )
    expect(opened).toMatchObject({ mode: 'company', legal_name: '深圳伏特豪斯科技有限公司' })
    expect(await modeNow()).toBe('company')
    const org = server.identity.getOrganization(orgId())
    const roleOf = (p: string) => org?.members.find((m) => m.person_id === p)?.role
    expect(roleOf(lin.id)).toBe('member')
    expect(roleOf(he.id)).toBe('admin')
    expect(org?.mode_changed_by).toBe(owner())
    const event = server.kernel.eventLog
      .readSync({ workspace_id: ws(), types: ['organization.mode_changed'] })
      .at(-1)
    expect(event?.payload).toMatchObject({ mode: 'company', from: 'peers', admins: 1, notified: 2 })
    expect(JSON.stringify(event?.payload)).not.toContain('伏特豪斯')
    // 再开一次：已经是 ③
    expect((await setMode({ mode: 'company', legal_name: 'X' })).status).toBe(409)
  })

  it('开了以后 ③ 全套：同事的超授权报价转给老板（卡上写转给了谁）', async () => {
    await setMode({ mode: 'company', legal_name: '深圳伏特豪斯' })
    const card = await overMandateQuote(lin, linB2b)
    expect(card.routing.recipients.map((r) => r.person)).toEqual([owner()])
    expect(card.routing.recipients[0]?.reason).toContain('转给了老板')
  })
})

describe('WP277 同事收卡（决策 239）', () => {
  it('每位同事一张「知道了 / 我要退出」；选退出 = ② 的退出（人走、东西留下），选知道了什么都不变', async () => {
    await setMode({ mode: 'company', legal_name: '深圳伏特豪斯' })
    const linCard = await noticeOf(lin.id)
    const heCard = await noticeOf(he.id)
    expect(await noticeOf(owner())).toBeUndefined()
    expect(linCard?.title).toContain('把这里改成了公司模式')
    expect(linCard?.title).not.toContain(owner())
    expect(
      (linCard?.payload as { options: { label: string }[] } | undefined)?.options.map(
        (o) => o.label,
      ),
    ).toEqual(['知道了', '我要退出'])

    const ack = await call('POST', `/v1/approvals/${heCard?.id}/decide`, {
      token: he.token,
      assignment: heB2b,
      body: { action: 'approve', selected_option_id: 'ack' },
    })
    expect(ack.status).toBe(200)
    expect((await server.identity.members(ws())).find((m) => m.person_id === he.id)?.left_at).toBe(
      undefined,
    )

    const leave = await call('POST', `/v1/approvals/${linCard?.id}/decide`, {
      token: lin.token,
      assignment: linB2b,
      body: { action: 'approve', selected_option_id: 'leave' },
    })
    expect(leave.status).toBe(200)
    const left = (await server.identity.members(ws())).find((m) => m.person_id === lin.id)
    expect(left?.left_at).toBeDefined()
    expect(
      server.roles.assignments
        .listByPerson(lin.id, { workspace_id: ws() })
        .every((a) => a.revoked_at !== undefined),
    ).toBe(true)
    const org = server.identity.getOrganization(orgId())
    expect(org?.members.find((m) => m.person_id === lin.id)?.left_at).toBeDefined()
    // 按 ② 的退出走（记 member.left），不是 ③ 的离职交接
    const types = server.kernel.eventLog.readSync({ workspace_id: ws() }).map((e) => e.type)
    expect(types).toContain('member.left')
  })
})

describe('WP277 降回同事互联（决策 240）', () => {
  it('只有老板能降；等老板的卡退回本人；上级、管理员收起不删，再开原样回来', async () => {
    await setMode({ mode: 'company', legal_name: '深圳伏特豪斯', admins: [he.id] })
    expect(
      (await call('PUT', '/v1/org/positions/b2b/supervisor', { body: { person_id: he.id } }))
        .status,
    ).toBe(200)
    // 何佳是 B2B 的上级：林峰的超授权报价转何佳
    const card = await overMandateQuote(lin, linB2b)
    expect(card.routing.recipients.map((r) => r.person)).toEqual([he.id])

    const denied = await setMode({ mode: 'peers' }, { token: he.token, assignment: heB2b })
    expect(denied.status).toBe(403)
    const down = await data<{ mode: string }>(await setMode({ mode: 'peers' }))
    expect(down.mode).toBe('peers')

    const back = (await server.txn.approvals.get(card.id)) as ApprovalItem
    expect(back.state).toBe('pending')
    expect(back.routing.recipients.map((r) => r.person)).toEqual([lin.id])
    expect(back.routing.recipients[0]?.reason).toBe('改回同事互联，退回给你')
    // 没点的「知道了 / 我要退出」收掉了
    expect(await noticeOf(lin.id)).toBeUndefined()
    // 收起不删：上级还在、管理员还在
    const positions = server.org.positions()
    expect(positions.find((p) => p.id === 'b2b')?.supervisor_person_id).toBe(he.id)
    const org = server.identity.getOrganization(orgId())
    expect(org?.members.find((m) => m.person_id === he.id)?.role).toBe('admin')
    // 同事那一行通知要的「谁改的」
    const view = (
      await data<{ mode: string; mode_changed_by_name?: string }[]>(
        await call('GET', '/v1/orgs', { token: lin.token, assignment: linB2b }),
      )
    )[0]
    expect(view?.mode).toBe('peers')
    expect(view?.mode_changed_by_name).toBe(server.bootstrap.person.name)

    // ② 里林峰自己点得了（没有职责分离）
    const decided = await call('POST', `/v1/approvals/${card.id}/decide`, {
      token: lin.token,
      assignment: linB2b,
      body: { action: 'approve' },
    })
    expect(decided.status).toBe(200)

    // 再开：向导带出以前的管理员，上级原样在，超授权又转何佳
    const setup = await data<{ people: { person_id: string; role: string }[] }>(
      await call('GET', `/v1/orgs/${orgId()}/mode`),
    )
    expect(setup.people.find((p) => p.person_id === he.id)?.role).toBe('admin')
    await setMode({ mode: 'company', legal_name: '深圳伏特豪斯', admins: [he.id] })
    const again = await overMandateQuote(lin, linB2b)
    expect(again.routing.recipients.map((r) => r.person)).toEqual([he.id])
  })

  it('离职交接没做完不让降', async () => {
    await setMode({ mode: 'company', legal_name: '深圳伏特豪斯' })
    await server.txn.approvals.create({
      workspace_id: ws(),
      schema_version: 1,
      kind: 'policy_change',
      role_id: 'common.owner',
      subject: { object: { type: 'policy', id: 'offboard:x' } },
      dedupe_key: `${ws()}:offboard:x`,
      title: '离职：迁移记忆',
      summary: '离职：迁移记忆',
      payload: { target: 'offboard' },
      evidence: {
        source_events: [],
        diff: { before: null, after: {}, summary: 'x' },
        provenance: { seen: [] },
        precheck: { permission_diff: 'ok', semantic_diff: 'ok' },
      },
      proposer: { kind: 'person', id: owner() },
      automation: { level_at_creation: 'L1' },
      routing: {
        recipients: [{ person: owner(), via: 'owner' }],
        rule: 'owner',
        escalation: { after_hours: 48, business_hours: true, chain: [], escalated_at: [] },
        separation_of_duties: false,
      },
      priority: 'queue',
    } as never)
    const setup = await data<{ can_close: boolean; close_blocked?: string }>(
      await call('GET', `/v1/orgs/${orgId()}/mode`),
    )
    expect(setup.can_close).toBe(false)
    expect(setup.close_blocked).toContain('离职交接')
    expect((await setMode({ mode: 'peers' })).status).toBe(409)
    expect(await modeNow()).toBe('company')
  })
})

describe('WP277 老板可以不是发起人', () => {
  it('选林峰当老板：组织与品牌的所有者换成他、他有负责人那条；超授权转他；只有他能降', async () => {
    await setMode({ mode: 'company', legal_name: '深圳伏特豪斯', boss: lin.id })
    const org = server.identity.getOrganization(orgId())
    expect(org?.owner_id).toBe(lin.id)
    expect(org?.members.find((m) => m.person_id === owner())?.role).toBe('admin')
    expect((await server.identity.getWorkspace(ws()))?.owner_id).toBe(lin.id)
    expect(
      server.roles.assignments
        .listByPerson(lin.id, { workspace_id: ws(), role_id: 'common.owner' })
        .some((a) => a.revoked_at === undefined),
    ).toBe(true)
    // 老板那张只有「知道了」
    const card = await noticeOf(lin.id)
    expect(
      (card?.payload as { options: { id: string }[] } | undefined)?.options.map((o) => o.id),
    ).toEqual(['ack'])
    const quote = await overMandateQuote(he, heB2b)
    expect(quote.routing.recipients.map((r) => r.person)).toEqual([lin.id])
    // 发起人已经不是老板：降不了
    expect((await setMode({ mode: 'peers' })).status).toBe(403)
  })
})

describe('WP277 上级派活（决策 241）', () => {
  async function openMatter(assignment: string, token?: string): Promise<string> {
    const made = await data<{ matter: { id: string } }>(
      await call('POST', '/v1/matters', {
        assignment,
        ...(token === undefined ? {} : { token }),
        body: { kind: 'project', title: 'Volthaus 的报价跟进' },
      }),
    )
    return made.matter.id
  }
  const handoffCards = async (person: string) =>
    (await queueOf(person)).filter((i) => (i.payload as { form?: string }).form === 'handoff')

  it('③ 里上级 → 下属直接生效（不出卡），下属首页一行通知；平级照旧要对方接下', async () => {
    await setMode({ mode: 'company', legal_name: '深圳伏特豪斯' })
    await call('PUT', '/v1/org/positions/b2b/supervisor', { body: { person_id: he.id } })
    // 何佳是 B2B 的上级，林峰在做 B2B：派过去直接生效
    const id = await openMatter(heB2b, he.token)
    const sent = await data<{ handoff: { handoff: { state: string; dispatched?: boolean } } }>(
      await call('POST', `/v1/handoffs/matter/${id}`, {
        token: he.token,
        assignment: heB2b,
        body: { to: lin.id, note: '这周你跟' },
      }),
    )
    expect(sent.handoff.handoff).toMatchObject({ state: 'accepted', dispatched: true })
    expect(await handoffCards(lin.id)).toHaveLength(0)
    const matter = await data<{ matter: { position_id?: string } }>(
      await call('GET', `/v1/matters/${id}`, { token: lin.token, assignment: linB2b }),
    )
    expect(matter.matter.position_id).toBe(linB2b)
    const lists = await data<{ dispatched?: { id: string; from_label: string }[] }>(
      await call('GET', '/v1/handoffs', { token: lin.token, assignment: linB2b }),
    )
    expect(lists.dispatched?.map((d) => d.id)).toEqual([id])
    expect(lists.dispatched?.[0]?.from_label).toBe('何佳')
    await call('POST', `/v1/handoffs/matter/${id}/seen`, { token: lin.token, assignment: linB2b })
    const after = await data<{ dispatched?: unknown[] }>(
      await call('GET', '/v1/handoffs', { token: lin.token, assignment: linB2b }),
    )
    expect(after.dispatched ?? []).toHaveLength(0)

    // 林峰不是何佳的上级：交给何佳要她接下
    const mine = await openMatter(linB2b, lin.token)
    const offered = await data<{ handoff: { handoff: { state: string } } }>(
      await call('POST', `/v1/handoffs/matter/${mine}`, {
        token: lin.token,
        assignment: linB2b,
        body: { to: he.id },
      }),
    )
    expect(offered.handoff.handoff.state).toBe('offered')
    expect(await handoffCards(he.id)).toHaveLength(1)
  })

  it('② 里设了上级也照旧要对方接下（没有上下级）', async () => {
    await call('PUT', '/v1/org/positions/b2b/supervisor', { body: { person_id: he.id } })
    const id = await openMatter(heB2b, he.token)
    const offered = await data<{ handoff: { handoff: { state: string } } }>(
      await call('POST', `/v1/handoffs/matter/${id}`, {
        token: he.token,
        assignment: heB2b,
        body: { to: lin.id },
      }),
    )
    expect(offered.handoff.handoff.state).toBe('offered')
  })
})
