/**
 * WP275（docs/95 §5 / §7 B 单，决策 222 / 236–243 / 256 / 259）：审批与安全闸按模式——**真服务进程**。
 *
 * 安全闸 =「AI 要做对外、动钱、不可逆的事之前，问这件事是谁的那个人」；审批流 =「这件事是你的，
 * 但要另一个人点头」。① 个人、② 同事互联只有安全闸，③ 公司集体两样都有（③ 的行为由
 * supervisor.test.ts / org.test.ts 里开了公司模式的那几条钉着）。
 *
 * 钉住的：
 * 1. ① 报价超授权：卡落回业务员自己、再确认一次，不写「转给了…」，不升级（到点只提醒本人）；
 * 2. ② 两个平级：岗位上设了「上级」也不转——谁的报价谁确认；
 * 3. ① 自己改职责规矩 / 额度：当场生效、不出卡；
 * 4. ② 改共用的职责：当场生效，同岗位的人收到一张「知道了 / 撤回」的通知卡，撤回就改回去；
 * 5. ① 工具箱合并：当场合；
 * 6. ① 会议里冒出来的活（待认领池）直接记到本人名下（决策 259）。
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

/** 提一张超授权的报价（1.84 万美元、毛利 18.5%），回那张卡与回执里的「谁批」。 */
async function overMandateQuote(
  who: { token?: string },
  assignment: string,
): Promise<{ card: ApprovalItem; approver?: string }> {
  const draft = await data<{ draft: { id: string } }>(
    await call('POST', '/v1/b2b/quotes/drafts', {
      ...(who.token === undefined ? {} : { token: who.token }),
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
      ...(who.token === undefined ? {} : { token: who.token }),
      assignment,
    }),
  )
  const card = await server.txn.approvals.get(staged.approval_item_id ?? '')
  if (card === undefined) throw new Error('没出卡')
  return { card, ...(staged.approver === undefined ? {} : { approver: staged.approver }) }
}

const COMPANY_WORDS = /转给|上级|老板|主管|审批|批准/

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

describe('WP275 ① 个人：没有审批流，只有安全闸', () => {
  it('报价超授权：卡落回自己、再确认一次，不写「转给了…」；到点只提醒本人', async () => {
    expect(await modeNow()).toBe('solo')
    const mine = await giveB2b(owner())
    const { card, approver } = await overMandateQuote({}, mine)
    expect(approver).toBe('role_holder')
    expect(card.routing.recipients).toHaveLength(1)
    const [r] = card.routing.recipients
    expect(r?.person).toBe(owner())
    expect(r?.reconfirm).toBe(true)
    expect(r?.reason).toBe('超金额、毛利上限')
    expect(r?.reason).not.toMatch(COMPANY_WORDS)
    expect(card.summary).not.toMatch(COMPANY_WORDS)

    // 一周以后还没人点：不升级给任何人，只多一次投递给本人
    now = Date.parse('2026-10-06T02:00:00.000Z')
    await server.txn.approvals.escalate()
    const later = (await server.txn.approvals.get(card.id)) as ApprovalItem
    expect(later.routing.recipients.map((x) => x.person)).toEqual([owner()])
    expect(later.routing.escalation.trail ?? []).toEqual([])
    expect(later.deliveries.every((d) => d.to === owner())).toBe(true)
    const types = server.kernel.eventLog.readSync({ workspace_id: ws() }).map((e) => e.type)
    expect(types).not.toContain('approval.escalated')
    expect(types).toContain('approval.reminded')
  })

  it('自己改职责规矩 / 额度：当场生效，不出卡', async () => {
    const copy = await data<{ id: string; name: string }>(
      await call('POST', '/v1/roles', { body: { from: 'dtc.support' } }),
    )
    const mineNow = async () =>
      (await server.txn.approvals.queue({ workspace_id: ws(), person_id: owner(), lane: 'mine' }))
        .length
    const before = await mineNow()
    const receipt = await data<{ status: string; approval_item_id?: string }>(
      await call('PUT', `/v1/roles/${copy.id}`, {
        body: {
          name: '售后（我的口径）',
          actions: [{ id: 'stage_refund', caps: { max_auto_refund_amount: 30 } }],
        },
      }),
    )
    expect(receipt.status).toBe('applied')
    expect(receipt.approval_item_id).toBeUndefined()
    const after = await data<{ name: string; actions: { id: string; caps: unknown }[] }>(
      await call('GET', `/v1/roles/${copy.id}`),
    )
    expect(after.name).toBe('售后（我的口径）')
    expect(await mineNow()).toBe(before)
  })

  it('工具箱合并：当场合，队列里不留卡', async () => {
    const CRON = { kind: 'cron', expr: '0 9 * * *', tz: 'Asia/Shanghai' }
    const a = await data<{ id: string }>(
      await call('POST', '/v1/schedules', { body: { title: '每天早上汇总退款单', trigger: CRON } }),
    )
    const b = await data<{ id: string }>(
      await call('POST', '/v1/schedules', {
        body: {
          title: '每天早上汇总退款单',
          trigger: CRON,
          duplicate_ack: {
            decision: 'new',
            reason: '我这条只看退货窗口内的单，口径跟他那条不一样',
            similar_to: [`schedule:${a.id}`],
          },
        },
      }),
    )
    const merged = await data<{ approval_item_id: string; applied?: boolean }>(
      await call('POST', '/v1/catalog/merge', {
        body: { keep: `schedule:${a.id}`, drop: `schedule:${b.id}` },
      }),
    )
    expect(merged.applied).toBe(true)
    const card = (await server.txn.approvals.get(merged.approval_item_id)) as ApprovalItem
    expect(card.state).toBe('approved')
    expect(card.decision?.by).toBe(owner())
    const left = await data<{ id: string }[]>(await call('GET', '/v1/catalog?kind=schedule'))
    expect(left.map((e) => e.id)).toEqual([`schedule:${a.id}`])
  })

  it('会议里冒出来的活：直接记到本人名下，不进待认领（决策 259）', async () => {
    const todo = server.work.poolTodo({ title: '把上周的退款汇总一下', source: 'meeting' })
    expect(todo.owner).toBe(owner())
    expect(server.work.pool()).toHaveLength(0)
  })
})

describe('WP275 ② 两个平级：谁也不批谁，各自确认自己的', () => {
  it('岗位上设了「上级」也不转：同事的超限报价落回同事自己', async () => {
    const mate = await colleague('he@example.com', '何佳')
    expect(await modeNow()).toBe('peers')
    const hers = await giveB2b(mate.id)
    // 发起人顺手把自己设成了 B2B 岗位的「上级」（② 的界面还是 C 单的事）——路由不认它
    expect(
      (await call('PUT', '/v1/org/positions/b2b/supervisor', { body: { person_id: owner() } }))
        .status,
    ).toBe(200)
    const { card, approver } = await overMandateQuote(mate, hers)
    expect(approver).toBe('role_holder')
    expect(card.routing.recipients.map((r) => r.person)).toEqual([mate.id])
    expect(card.routing.recipients[0]?.reconfirm).toBe(true)
    expect(card.routing.recipients[0]?.reason ?? '').not.toMatch(COMPANY_WORDS)

    // 自己的卡自己点（不是「一人既提又批」）：两下里的第二下由界面管，服务端照常收
    const token = card.deliveries.find((d) => d.to === mate.id)?.decision_token ?? ''
    const decided = await server.txn.approvals.decide(card.id, mate.id, {
      action: 'approve',
      decision_token: token,
      via: 'workstation',
    })
    expect(['approved', 'applying', 'applied']).toContain(decided.state)
  })

  it('改共用的职责：当场生效；同岗位的人收到通知卡，点「撤回」就改回去', async () => {
    const mate = await colleague('he@example.com', '何佳')
    const copy = await data<{ id: string; name: string }>(
      await call('POST', '/v1/roles', { body: { from: 'dtc.support' } }),
    )
    // 两个人都在做这条职责
    for (const person_id of [owner(), mate.id])
      expect(
        (
          await call('POST', '/v1/assignments', {
            body: { person_id, role_id: copy.id, ranges: [{ kind: 'brand', id: ws() }] },
          })
        ).status,
      ).toBe(201)
    const receipt = await data<{ status: string }>(
      await call('PUT', `/v1/roles/${copy.id}`, { body: { name: '售后（新口径）' } }),
    )
    expect(receipt.status).toBe('applied')
    expect((await data<{ name: string }>(await call('GET', `/v1/roles/${copy.id}`))).name).toBe(
      '售后（新口径）',
    )

    // 同事那边：一张「知道了 / 撤回」的卡；发起人自己那边没有
    const noticesFor = async (person_id: string) =>
      (await server.txn.approvals.queue({ workspace_id: ws(), person_id, lane: 'mine' })).filter(
        (i) => (i.payload as { form?: string }).form === 'peer_change_notice',
      )
    expect(await noticesFor(owner())).toHaveLength(0)
    const notices = await noticesFor(mate.id)
    expect(notices).toHaveLength(1)
    const notice = notices[0] as ApprovalItem
    expect(notice.routing.recipients.map((r) => r.person)).toEqual([mate.id])
    expect(`${notice.title}${notice.summary}`).not.toMatch(COMPANY_WORDS)

    // 同事选「撤回」= 维持改之前的样子
    await server.txn.approvals.decide(notice.id, mate.id, {
      action: 'approve_edited',
      edited_payload: { selected_option_id: 'before' },
      decision_token: notice.deliveries.find((d) => d.to === mate.id)?.decision_token ?? '',
      via: 'workstation',
    })
    const reverted = await data<{ name: string }>(await call('GET', `/v1/roles/${copy.id}`))
    expect(reverted.name).toBe(copy.name)
  })
})
