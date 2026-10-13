/**
 * WP299（决策 386 / 387）：红人合作上的两种「花钱」——寄样与付款。
 *
 * 钉住四件事：① 谈成之前不给寄样 / 付款；② 有成本的寄样与每一笔付款都出「花钱」卡、永远人审，
 * 批了才落库（寄样进「已寄样」，付款记一笔）；③ 没成本的寄样当场记下；④ 收件地址明文只在加密库，
 * 账本、事件、卡面上一个真地址都没有；付款超过谈定预算卡上说。
 */
import type { Assignment } from '@agentsws/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'
import { kolRetro } from '../src/kol.js'

const T0 = '2026-10-13T09:00:00.000Z'
const SECRETS_KEY = 'f'.repeat(64)
const ADDRESS = 'Jonas Weber, Hauptstr. 5, 10115 Berlin, DE'

let server: Server
let t = Date.parse(T0)
let url: string
let youtube: Assignment

const api = (path: string, init: RequestInit = {}): Promise<Response> => {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${server.bootstrap.internalToken}`)
  headers.set('X-Assignment', youtube.id)
  if (init.body !== undefined) headers.set('content-type', 'application/json')
  return fetch(`${url}${path}`, { ...init, headers })
}
const post = (path: string, body: unknown): Promise<Response> =>
  api(path, { method: 'POST', body: JSON.stringify(body) })
const data = async <T>(res: Response): Promise<T> => ((await res.json()) as { data: T }).data

async function approve(id: string | undefined): Promise<void> {
  const fresh = await server.txn.approvals.get(id as string)
  const token = [...(fresh?.deliveries ?? [])]
    .reverse()
    .find((d) => d.status === 'sent')?.decision_token
  if (token === undefined) throw new Error(`这张卡没有本人的 decision_token：${fresh?.state}`)
  await server.txn.approvals.decide(id as string, server.bootstrap.person.id, {
    action: 'approve',
    decision_token: token,
    via: 'workstation',
  })
  // 15 §5「通过 ≠ 施行」：过了取消窗口（120 秒）执行器才施行
  t += 130_000
  await server.drainApprovals()
}

const kol = async () => (await server.brands.forWorkspace(server.bootstrap.workspace.id)).kol

/** 一个红人 + 一条在某个阶段的合作。 */
async function collab(stage: 'agreed' | 'negotiating', budget?: number): Promise<string> {
  const store = await kol()
  store.saveCreator({ id: 'cre_1', display_name: 'Gadget Jonas', merged_from: [] })
  store.saveCollaboration({
    id: 'col_1',
    creator_id: 'cre_1',
    channel: 'youtube',
    stage,
    currency: 'USD',
    ...(budget === undefined ? {} : { budget }),
  })
  return 'col_1'
}

beforeEach(async () => {
  t = Date.parse(T0)
  server = await createServer({
    quiet: true,
    clock: { now: () => new Date(t).toISOString() },
    scheduleIntervalMs: 0,
    startRun: false,
    env: { AGENTSWS_OWNER_EMAIL: 'luoye@example.com', AGENTSWS_SECRETS_KEY: SECRETS_KEY },
  })
  ;({ url } = await server.listen(0))
  youtube = server.roles.assignments.create({
    person_id: server.bootstrap.person.id,
    workspace_id: server.bootstrap.workspace.id,
    role_id: 'kol.youtube',
    granted_by: server.bootstrap.person.id,
    ranges: [{ kind: 'store', id: 'store_1' }],
  })
})

afterEach(async () => {
  await server.close()
})

describe('WP299 寄样（决策 386）', () => {
  it('谈成之前不给寄样，说人话', async () => {
    const id = await collab('negotiating')
    const res = await post(`/v1/kol/collaborations/${id}/sample`, { address: ADDRESS })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { message: string }).message).toContain('谈成之后才寄样')
  })

  it('有成本 → 一张「花钱」卡（人审）；批了才记下、合作进「已寄样」；地址明文只在加密库', async () => {
    const id = await collab('agreed')
    const out = await data<{ staged: boolean; approval_item_id: string; change_id: string }>(
      await post(`/v1/kol/collaborations/${id}/sample`, {
        address: ADDRESS,
        carrier: 'DHL',
        tracking_no: 'JD0123',
        cost: 45,
      }),
    )
    expect(out.staged).toBe(true)
    const item = await server.txn.approvals.get(out.approval_item_id)
    expect(item?.state).toBe('pending')
    expect(item?.title).toBe('寄样：Gadget Jonas（45 USD）')
    // 批之前一个字不落库
    expect((await kol()).collaboration(id)?.sample).toBeUndefined()

    // 账本与卡面上没有真地址，只有脱敏样子
    const change = (
      await server.txn.ledger.list({
        workspace_id: server.bootstrap.workspace.id,
        kind: 'kol_sample',
      })
    )[0]
    const ledgerText = JSON.stringify(change) + JSON.stringify(item)
    expect(ledgerText).not.toContain('Hauptstr')
    expect(ledgerText).toContain('J*** · 10115 Berlin, DE')

    await approve(out.approval_item_id)
    const row = (await kol()).collaboration(id)
    expect(row?.stage).toBe('sample_sent')
    expect(row?.sample).toMatchObject({
      address_masked: 'J*** · 10115 Berlin, DE',
      carrier: 'DHL',
      tracking_no: 'JD0123',
      cost: 45,
      currency: 'USD',
    })
    expect(row?.sample?.address_ref.startsWith('kol.sample.')).toBe(true)
  })

  it('没有成本 → 不出卡，当场记下、进「已寄样」', async () => {
    const id = await collab('agreed')
    const out = await data<{ staged: boolean; applied?: boolean; message?: string }>(
      await post(`/v1/kol/collaborations/${id}/sample`, { address: ADDRESS }),
    )
    expect(out).toMatchObject({ staged: false, applied: true })
    expect((await kol()).collaboration(id)?.stage).toBe('sample_sent')
    expect(
      await server.txn.ledger.list({
        workspace_id: server.bootstrap.workspace.id,
        kind: 'kol_sample',
      }),
    ).toHaveLength(0)
  })
})

describe('WP299 付款（决策 387）', () => {
  it('一笔付款 → 一张「花钱」卡；批了才记账；同一张卡不记两遍', async () => {
    const id = await collab('agreed', 400)
    const out = await data<{ approval_item_id: string }>(
      await post(`/v1/kol/collaborations/${id}/payments`, { amount: 200, note: '首款' }),
    )
    const item = await server.txn.approvals.get(out.approval_item_id)
    expect(item?.state).toBe('pending')
    expect(item?.title).toBe('付款：Gadget Jonas（200 USD）')
    expect((await kol()).collaboration(id)?.payments).toBeUndefined()
    await approve(out.approval_item_id)
    await server.drainApprovals()
    const payments = (await kol()).collaboration(id)?.payments ?? []
    expect(payments.map((p) => [p.amount, p.note])).toEqual([[200, '首款']])
  })

  it('加上这一笔超过谈定预算：卡上说，guardrail 记一条，不拦', async () => {
    const id = await collab('agreed', 400)
    const first = await data<{ approval_item_id: string }>(
      await post(`/v1/kol/collaborations/${id}/payments`, { amount: 300 }),
    )
    await approve(first.approval_item_id)
    const second = await data<{ staged: boolean; approval_item_id: string }>(
      await post(`/v1/kol/collaborations/${id}/payments`, { amount: 150 }),
    )
    expect(second.staged).toBe(true)
    const item = await server.txn.approvals.get(second.approval_item_id)
    expect(item?.summary).toContain('超过谈定的 400 USD')
    const change = (
      await server.txn.ledger.list({
        workspace_id: server.bootstrap.workspace.id,
        kind: 'kol_payment',
      })
    ).find((c) => (c.after as { paid_total?: number }).paid_total === 450)
    expect(change?.guardrail?.hits.map((h) => h.rule)).toContain('kol_payment_over_budget')
  })

  it('谈成之前不给付款', async () => {
    const id = await collab('negotiating')
    const res = await post(`/v1/kol/collaborations/${id}/payments`, { amount: 100 })
    expect(res.status).toBe(400)
  })
})

describe('WP299 合作复盘（决策 387）', () => {
  const base = { creator_id: 'cre_1', channel: 'youtube' as const, currency: 'USD' }
  const name = () => 'Gadget Jonas'
  const pay = (amount: number) => [{ id: 'p', amount, currency: 'USD', paid_at: T0 }]

  it('三档结论：回本了 / 还没回本 / 算不出来（没记付款、没建追踪链接）；什么都没发生的不出行', () => {
    const rows = kolRetro(
      [
        { ...base, id: 'c_worth', stage: 'delivered', payments: pay(400) },
        { ...base, id: 'c_not_yet', stage: 'delivered', payments: pay(400) },
        { ...base, id: 'c_no_pay', stage: 'delivered' },
        { ...base, id: 'c_no_link', stage: 'delivered', payments: pay(100) },
        { ...base, id: 'c_quiet', stage: 'contacted' },
      ],
      [
        { collaboration_id: 'c_worth', revenue: 645.5 },
        { collaboration_id: 'c_not_yet', revenue: 120 },
        { collaboration_id: 'c_no_pay', revenue: 90 },
      ],
      name,
    )
    expect(rows.map((r) => [r.collaboration_id, r.spent, r.revenue, r.verdict])).toEqual([
      ['c_worth', 400, 645.5, 'worth'],
      ['c_not_yet', 400, 120, 'not_yet'],
      ['c_no_pay', 0, 90, 'unknown'],
      ['c_no_link', 100, 0, 'unknown'],
    ])
  })

  it('寄样成本也算花的', () => {
    const [row] = kolRetro(
      [
        {
          ...base,
          id: 'c_1',
          stage: 'delivering',
          payments: pay(200),
          sample: {
            address_ref: 'kol.sample.x',
            address_masked: 'J***',
            cost: 45,
            currency: 'USD',
            shipped_at: T0,
          },
        },
      ],
      [{ collaboration_id: 'c_1', revenue: 300 }],
      name,
    )
    expect(row?.spent).toBe(245)
    expect(row?.verdict).toBe('worth')
  })
})
