/**
 * WP174（docs/84 §11.1 第 3 条）：岗位上级在**真服务进程**里的样子。
 *
 * 真装配线（路由 → OrgPort → B2B 服务 → 变更账本 → 审批总线），不打桩：
 * 1. 没设上级：业务员提一张超授权的报价 → 卡落老板，卡上一句「没设上级，转给了老板」；
 * 2. 公司页给「B2B」岗位设上级林峰 → 同样的报价落林峰，卡上一句「转给了上级林峰」；
 * 3. 上级就是提的人自己 → 落老板；
 * 4. 林峰被移出工作区 → 岗位上级清空、他手上那张卡改派给老板（写原因）、老板收到一张提醒。
 */
import type { ApprovalItem } from '@agentsws/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'

const T0 = '2026-09-28T02:00:00.000Z'

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

const post = (path: string, body: unknown, token?: string) =>
  server.gateway.fetch(
    new Request(`http://127.0.0.1${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify(body),
    }),
  )

const ws = (): string => server.bootstrap.workspace.id
const owner = (): string => server.bootstrap.person.id

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

/** 把 B2B 岗位分给他，回他 `b2b.sales` 那条分配。 */
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

/** 提一张超授权的报价（1.84 万美元、毛利 18.5%），回那张卡。 */
async function overMandateQuote(who: { token: string }, assignment: string): Promise<ApprovalItem> {
  const draft = await data<{ draft: { id: string } }>(
    await call('POST', '/v1/b2b/quotes/drafts', {
      token: who.token,
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
  const staged = await data<{ approval_item_id?: string; approver?: string }>(
    await call('POST', `/v1/b2b/quotes/drafts/${draft.draft.id}/submit`, {
      token: who.token,
      assignment,
    }),
  )
  const card = await server.txn.approvals.get(staged.approval_item_id ?? '')
  if (card === undefined) throw new Error('没出卡')
  return card
}

const supervise = (person_id: string | null) =>
  call('PUT', '/v1/org/positions/b2b/supervisor', { body: { person_id } })

beforeEach(async () => {
  let t = Date.parse(T0)
  server = await createServer({
    // 每读一次走一毫秒：卡与事件的先后看得出来
    clock: { now: () => new Date(t++).toISOString() },
    random: seeded(),
    quiet: true,
    startRun: false,
    tokenRefreshIntervalMs: 0,
  })
})

afterEach(async () => {
  await server.close()
})

describe('WP174 岗位上级：scope_manager 真的落到上级，没有才落老板', () => {
  it('没设上级 → 老板；设了 → 上级；上级是本人 → 老板', async () => {
    const lin = await colleague('lin@example.com', '林峰')
    const he = await colleague('he@example.com', '何佳')
    const heSales = await giveB2b(he.id)

    const first = await overMandateQuote(he, heSales)
    expect(first.routing.recipients).toEqual([
      { person: owner(), via: 'owner', reason: expect.stringContaining('「B2B」岗位没设上级') },
    ])

    const set = await supervise(lin.id)
    expect(set.status).toBe(200)
    const view = await data<{ supervisor?: { person_id: string; name: string } }>(set)
    expect(view.supervisor).toEqual({ person_id: lin.id, name: '林峰' })

    const second = await overMandateQuote(he, heSales)
    expect(second.routing.recipients).toEqual([
      { person: lin.id, via: 'scope_manager', reason: '转给了「B2B」岗位的上级林峰' },
    ])
    // Fable 终审：卡面说人话，不露 amount / margin 这种字段名
    expect(second.summary).toBe('超了授权（金额、毛利），转上级批')
    expect(second.summary).not.toMatch(/[a-z_]{3,}/)

    // 上级就是提的人自己 → 老板
    const linSales = await giveB2b(lin.id)
    const self = await overMandateQuote(lin, linSales)
    expect(self.routing.recipients[0]).toMatchObject({ person: owner(), via: 'owner' })
    expect(self.routing.recipients[0]?.reason).toContain('上级就是提的人自己')

    // 不是工作区里的人不能当上级
    expect((await supervise('p_nobody')).status).toBe(400)
  })

  it('上级被移出工作区 → 岗位上级清空、他手上的卡改派给老板、老板收到提醒', async () => {
    const lin = await colleague('lin@example.com', '林峰')
    const he = await colleague('he@example.com', '何佳')
    const heSales = await giveB2b(he.id)
    await supervise(lin.id)
    const card = await overMandateQuote(he, heSales)
    expect(card.routing.recipients[0]?.person).toBe(lin.id)

    expect((await call('DELETE', `/v1/workspaces/${ws()}/members/${lin.id}`)).status).toBe(200)

    const positions = await data<{ id: string; supervisor?: unknown }[]>(
      await call('GET', '/v1/org/positions'),
    )
    expect(positions.find((p) => p.id === 'b2b')?.supervisor).toBeUndefined()
    const moved = await server.txn.approvals.get(card.id)
    expect(moved?.state).toBe('pending')
    expect(moved?.routing.recipients).toEqual([
      { person: owner(), via: 'owner', reason: expect.stringContaining('上级林峰已经离开工作区') },
    ])
    const queue = await server.txn.approvals.queue({
      workspace_id: ws(),
      person_id: owner(),
      lane: 'mine',
      state: ['pending', 'in_review', 'approved', 'auto_approved', 'applied'],
    })
    const notice = queue.find((i) => i.title.includes('岗位的上级空了'))
    expect(notice?.summary).toContain('林峰离开了工作区')
    expect(notice?.summary).toContain('1 张卡已经改派给你')
    const types: string[] = []
    for await (const e of server.kernel.eventLog.read({ workspace_id: ws() })) types.push(e.type)
    expect(types).toContain('position.supervisor_set')
    expect(types).toContain('position.supervisor_cleared')
    expect(types).toContain('approval.rerouted')

    // 之后新提的卡直接落老板
    const next = await overMandateQuote(he, heSales)
    expect(next.routing.recipients[0]).toMatchObject({ person: owner(), via: 'owner' })
  })

  it('离职编排（offboard）那条路也一样：上级走了，岗位落回老板，卡改派', async () => {
    const lin = await colleague('lin@example.com', '林峰')
    const he = await colleague('he@example.com', '何佳')
    const heSales = await giveB2b(he.id)
    await supervise(lin.id)
    const card = await overMandateQuote(he, heSales)
    const res = await call('POST', `/v1/workspaces/${ws()}/members/${lin.id}/offboard`, {
      body: {},
    })
    expect(res.status).toBe(200)
    const moved = await server.txn.approvals.get(card.id)
    expect(moved?.routing.recipients[0]).toMatchObject({ person: owner(), via: 'owner' })
    const positions = await data<{ id: string; supervisor?: unknown }[]>(
      await call('GET', '/v1/org/positions'),
    )
    expect(positions.find((p) => p.id === 'b2b')?.supervisor).toBeUndefined()
  })

  it('POST /v1/approvals 给了 rule: scope_manager 没给收件人 → 同一个解析口', async () => {
    const lin = await colleague('lin@example.com', '林峰')
    // 老板自己那条 `common.owner` 在「店主 / 负责人」岗位里；给那个岗位设个上级
    expect(
      (await call('PUT', '/v1/org/positions/owner/supervisor', { body: { person_id: lin.id } }))
        .status,
    ).toBe(200)
    const created = await data<ApprovalItem>(
      await call('POST', '/v1/approvals', {
        body: {
          kind: 'claim',
          subject: { object: { type: 'b2b_account', id: 'acc_volthaus' } },
          dedupe_key: 'wp174-claim',
          title: '这家客户要不要放宽账期',
          summary: '客户要 60 天账期',
          routing: { rule: 'scope_manager' },
        },
      }),
    )
    expect(created.routing.recipients).toEqual([
      { person: lin.id, via: 'scope_manager', reason: '转给了「店主 / 负责人」岗位的上级林峰' },
    ])
  })
})
