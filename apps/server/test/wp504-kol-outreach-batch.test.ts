/**
 * WP504（决策 1777 A）：红人库多选「发开发信」——只出一张批量确认卡；批了才逐个提（不再出第二张卡），
 * 没批名单上的「等你确认」收掉。起真进程打 HTTP，走包了钩子的那条决定路。
 */
import type { Assignment } from '@agentsws/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'

const T0 = '2026-09-15T09:00:00.000Z'
const SECRETS_KEY = 'e'.repeat(64)

let t = Date.parse(T0)
let server: Server
let url: string
let youtube: Assignment

const api = async (path: string, init: RequestInit = {}): Promise<Response> => {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${server.bootstrap.internalToken}`)
  headers.set('X-Assignment', youtube.id)
  if (init.body !== undefined) headers.set('content-type', 'application/json')
  return fetch(`${url}${path}`, { ...init, headers })
}
const post = (path: string, body: unknown): Promise<Response> =>
  api(path, { method: 'POST', body: JSON.stringify(body) })
const data = async <T>(res: Response): Promise<T> => ((await res.json()) as { data: T }).data

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

async function creator(name: string, email = true): Promise<string> {
  const detail = await data<{ creator: { id: string } }>(
    await post('/v1/kol/creators', {
      display_name: name,
      channel: 'youtube',
      handle: name.toLowerCase().replace(/\s/g, ''),
      followers: 48_000,
      engagement_rate: 0.06,
      category: '数码',
    }),
  )
  if (email)
    await post(`/v1/kol/creators/${detail.creator.id}/contacts`, {
      kind: 'email',
      value: `${name.toLowerCase().replace(/\s/g, '')}@example.com`,
    })
  return detail.creator.id
}

interface BatchView {
  ok: boolean
  approval_item_id?: string
  sending: { creator_id: string }[]
  skipped: { creator_id: string; reason: string }[]
  message?: string
}

const BODY = { product: '65W 氮化镓充电器', brand_pitch: '我们做桌面周边的充电与理线。' }

async function decide(id: string, action: 'approve' | 'reject'): Promise<void> {
  const res = await post(`/v1/approvals/${id}/decide`, {
    action,
    ...(action === 'reject' ? { reason: '不要' } : {}),
  })
  expect(res.status).toBe(200)
}

const outreachChanges = () =>
  server.txn.ledger.list({ workspace_id: server.bootstrap.workspace.id, kind: 'kol_outreach' })

describe('WP504 批量开发信确认卡', () => {
  it('出一张卡：名单、跳过谁和原因、样信；不提任何一封', async () => {
    const a = await creator('Gadget Jonas')
    const b = await creator('Desk Rosa')
    const c = await creator('Cable Kevin', false)
    const out = await data<BatchView>(
      await post('/v1/kol/outreach/batch', { channel: 'youtube', creator_ids: [a, b, c], ...BODY }),
    )
    expect(out.ok).toBe(true)
    expect(out.sending.map((s) => s.creator_id)).toEqual([a, b])
    expect(out.skipped).toEqual([{ creator_id: c, display_name: 'Cable Kevin', reason: '没邮箱' }])
    const item = await server.txn.approvals.get(out.approval_item_id as string)
    expect(item?.kind).toBe('kol_outreach_batch')
    expect(item?.state).toBe('pending')
    expect(item?.title).toBe('给 3 位红人发首封开发信？')
    const payload = item?.payload as {
      form: string
      count: number
      sample: { creator_name: string; subject: string; body: string }
      creators: { initial: string }[]
    }
    expect(payload.form).toBe('kol_outreach_batch')
    expect(payload.count).toBe(2)
    expect(payload.sample.creator_name).toBe('Gadget Jonas')
    expect(payload.sample.body).toContain('Gadget Jonas')
    expect(payload.creators.map((x) => x.initial)).toEqual(['G', 'D'])
    // 卡上不带一个真地址
    expect(JSON.stringify(item?.payload)).not.toContain('@example.com')
    expect(await outreachChanges()).toHaveLength(0)
    // 名单上的人标「等你确认」，没进名单的不标
    const rows = await data<{ rows: { creator_id: string; awaiting_confirm?: boolean }[] }>(
      await api('/v1/kol/creators?channel=youtube'),
    )
    const mark = new Map(rows.rows.map((r) => [r.creator_id, r.awaiting_confirm === true]))
    expect(mark.get(a)).toBe(true)
    expect(mark.get(b)).toBe(true)
    expect(mark.get(c)).toBe(false)
    // 同一个人再进一批：跳过（在另一张没定的卡上）
    const again = await data<BatchView>(
      await post('/v1/kol/outreach/batch', { channel: 'youtube', creator_ids: [a], ...BODY }),
    )
    expect(again.ok).toBe(false)
    expect(again.skipped[0]?.reason).toBe('在另一张没定的卡上')
  })

  it('缺「想聊的产品」、或一个能发的都没有：不出卡，说一句', async () => {
    const a = await creator('Gadget Jonas')
    const none = await data<BatchView>(
      await post('/v1/kol/outreach/batch', { channel: 'youtube', creator_ids: [a] }),
    )
    expect(none.ok).toBe(false)
    expect(none.approval_item_id).toBeUndefined()
    expect(none.message).toContain('想聊的产品')
    const c = await creator('Cable Kevin', false)
    const empty = await data<BatchView>(
      await post('/v1/kol/outreach/batch', { channel: 'youtube', creator_ids: [c], ...BODY }),
    )
    expect(empty.ok).toBe(false)
    expect(empty.message).toContain('没邮箱 1')
  })

  it('批了：演练红人按名单逐个提、自动批（不再出第二张要人点的卡）；30 天内联系过的下一批跳过', async () => {
    expect((await post('/v1/kol/sandbox', { channel: 'youtube' })).status).toBeLessThan(300)
    const pool = await data<{
      rows: { creator_id: string; has_contact: boolean; collab?: { stage: string } }[]
    }>(await api('/v1/kol/creators?channel=youtube'))
    const ids = pool.rows
      .filter((r) => r.has_contact && (r.collab === undefined || r.collab.stage === 'sourced'))
      .slice(0, 2)
      .map((r) => r.creator_id)
    expect(ids).toHaveLength(2)
    const out = await data<BatchView>(
      await post('/v1/kol/outreach/batch', { channel: 'youtube', creator_ids: ids, ...BODY }),
    )
    expect(out.ok).toBe(true)
    await decide(out.approval_item_id as string, 'approve')
    const changes = await outreachChanges()
    expect(changes).toHaveLength(2)
    // 人已经在批量卡上点过「发出」：每封都自动批（不再等第二次点头）
    for (const ch of changes) expect(ch.status).not.toBe('staged')
    const rows = await data<{ rows: { awaiting_confirm?: boolean }[] }>(
      await api('/v1/kol/creators?channel=youtube'),
    )
    expect(rows.rows.some((r) => r.awaiting_confirm === true)).toBe(false)
    const next = await data<BatchView>(
      await post('/v1/kol/outreach/batch', {
        channel: 'youtube',
        creator_ids: [ids[0] as string],
        ...BODY,
      }),
    )
    expect(next.ok).toBe(false)
    expect(next.skipped[0]?.reason).toBe('30 天内联系过')
  })

  it('批了但没连发信邮箱：真红人那几封照旧等人（批了也发不出去，卡上照实说）', async () => {
    const a = await creator('Gadget Jonas')
    const out = await data<BatchView>(
      await post('/v1/kol/outreach/batch', { channel: 'youtube', creator_ids: [a], ...BODY }),
    )
    const card = await server.txn.approvals.get(out.approval_item_id as string)
    expect((card?.payload as { heads_up?: string[] } | undefined)?.heads_up?.join('\n')).toContain(
      '还没连发信邮箱',
    )
    await decide(out.approval_item_id as string, 'approve')
    const changes = await outreachChanges()
    expect(changes).toHaveLength(1)
    expect(changes[0]?.status).toBe('staged')
  })

  it('不发：一封都不提，名单上的「等你确认」收掉', async () => {
    const a = await creator('Gadget Jonas')
    const out = await data<BatchView>(
      await post('/v1/kol/outreach/batch', { channel: 'youtube', creator_ids: [a], ...BODY }),
    )
    await decide(out.approval_item_id as string, 'reject')
    expect(await outreachChanges()).toHaveLength(0)
    const rows = await data<{ rows: { awaiting_confirm?: boolean }[] }>(
      await api('/v1/kol/creators?channel=youtube'),
    )
    expect(rows.rows[0]?.awaiting_confirm).toBeUndefined()
  })
})
