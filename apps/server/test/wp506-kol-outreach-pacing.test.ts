/**
 * WP506（决策 1788 B）：批量开发信批了之后**分时发**——每小时最多 N 封（卡上能改）、仍受每天额度，
 * 按队列一封一封发；进度看得见、库里卡上「排队中 / 已发」；能暂停 / 继续、取消剩下的（已发的不撤）；
 * 重启后接着发、不重发。只给人点（AI 运行的令牌 403）。
 *
 * 一封真信都不发：演练红人的信进演练收件箱（假发件口），真红人这边没连邮箱（只排队、不提）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Assignment } from '@agentsws/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'

const T0 = '2026-09-15T09:00:00.000Z'
const SECRETS_KEY = 'e'.repeat(64)
const MIN = 60_000

let t = Date.parse(T0)
let server: Server
let url: string
let youtube: Assignment
let dir: string | undefined

const api = async (path: string, init: RequestInit = {}, token?: string): Promise<Response> => {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${token ?? server.bootstrap.internalToken}`)
  headers.set('X-Assignment', youtube.id)
  if (init.body !== undefined) headers.set('content-type', 'application/json')
  return fetch(`${url}${path}`, { ...init, headers })
}
const post = (path: string, body: unknown, token?: string): Promise<Response> =>
  api(path, { method: 'POST', body: JSON.stringify(body) }, token)
const data = async <T>(res: Response): Promise<T> => ((await res.json()) as { data: T }).data

async function boot(dbDir?: string): Promise<void> {
  server = await createServer({
    quiet: true,
    clock: { now: () => new Date(t).toISOString() },
    scheduleIntervalMs: 0,
    startRun: false,
    ...(dbDir === undefined ? {} : { dbDir }),
    env: { AGENTSWS_OWNER_EMAIL: 'luoye@example.com', AGENTSWS_SECRETS_KEY: SECRETS_KEY },
  })
  ;({ url } = await server.listen(0))
  // 重启那一条：分配已经在库里了（同一个数据目录）
  const existing = server.roles.assignments
    .listByPerson(server.bootstrap.person.id, { workspace_id: server.bootstrap.workspace.id })
    .find((a) => a.role_id === 'kol.youtube' && a.revoked_at === undefined)
  youtube =
    existing ??
    server.roles.assignments.create({
      person_id: server.bootstrap.person.id,
      workspace_id: server.bootstrap.workspace.id,
      role_id: 'kol.youtube',
      granted_by: server.bootstrap.person.id,
      ranges: [{ kind: 'store', id: 'store_1' }],
    })
}

beforeEach(() => {
  t = Date.parse(T0)
  dir = undefined
})

afterEach(async () => {
  await server.close()
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
})

interface Progress {
  state: string
  per_hour: number
  total: number
  sent: number
  queued: number
  skipped: number
  cancelled: number
  waiting?: string
  next_at?: string
  rows: { creator_id: string; state: string }[]
}

const BODY = { product: '65W 氮化镓充电器', brand_pitch: '我们做桌面周边的充电与理线。' }

const outreach = async (): Promise<{ id: string; after: unknown }[]> =>
  server.txn.ledger.list({ workspace_id: server.bootstrap.workspace.id, kind: 'kol_outreach' })
const firsts = async (): Promise<string[]> =>
  (await outreach())
    .map((c) => (c.after as { creator_id?: string; step?: string }) ?? {})
    .filter((a) => a.step === 'first')
    .map((a) => a.creator_id as string)

async function pump(): Promise<void> {
  const brand = await server.brands.forWorkspace(server.bootstrap.workspace.id)
  await brand.kolService.pumpOutreachBatches()
}

async function progressOf(id: string): Promise<Progress> {
  const rows = await data<Progress[]>(await api(`/v1/kol/outreach/batches?approval_item_id=${id}`))
  return rows[0] as Progress
}

/** 演练红人（信进演练收件箱，不要邮箱）里还没联系过的前 n 个。 */
async function sandboxIds(n: number): Promise<string[]> {
  expect((await post('/v1/kol/sandbox', { channel: 'youtube' })).status).toBeLessThan(300)
  const pool = await data<{
    rows: { creator_id: string; has_contact: boolean; collab?: { stage: string } }[]
  }>(await api('/v1/kol/creators?channel=youtube'))
  const ids = pool.rows
    .filter((r) => r.has_contact && (r.collab === undefined || r.collab.stage === 'sourced'))
    .slice(0, n)
    .map((r) => r.creator_id)
  expect(ids).toHaveLength(n)
  return ids
}

async function plan(ids: string[]): Promise<string> {
  const out = await data<{ ok: boolean; approval_item_id?: string }>(
    await post('/v1/kol/outreach/batch', { channel: 'youtube', creator_ids: ids, ...BODY }),
  )
  expect(out.ok).toBe(true)
  return out.approval_item_id as string
}

async function approve(id: string): Promise<void> {
  expect((await post(`/v1/approvals/${id}/decide`, { action: 'approve' })).status).toBe(200)
}

describe('WP506 批量开发信分时发', () => {
  it('卡上带节奏（没连邮箱 = 新邮箱，每小时 5 封），没批之前能改；批了第一封当场发，其余按间隔一封一封', async () => {
    await boot()
    const ids = await sandboxIds(3)
    const id = await plan(ids)
    const card = await server.txn.approvals.get(id)
    const payload = card?.payload as {
      per_hour: number
      pace_basis: string
      cadence: string
      quota_remaining: number
    }
    expect(payload.per_hour).toBe(5)
    expect(payload.pace_basis).toBe('new')
    expect(payload.cadence).toContain('新邮箱，每小时最多 5 封')
    expect(payload.quota_remaining).toBe(30)
    // 没批之前改成每小时 2 封（= 30 分钟一封）
    const edited = await data<Progress>(
      await post(`/v1/kol/outreach/batches/${id}/control`, { per_hour: 2 }),
    )
    expect(edited).toMatchObject({
      state: 'pending',
      per_hour: 2,
      pace_edited: true,
      total: 3,
      sent: 0,
    })
    // 没批不能暂停 / 取消（不想发就在卡上点「不发」）
    expect((await post(`/v1/kol/outreach/batches/${id}/control`, { action: 'pause' })).status).toBe(
      409,
    )

    await approve(id)
    expect(await firsts()).toEqual([ids[0]])
    let p = await progressOf(id)
    expect(p).toMatchObject({ state: 'sending', sent: 1, queued: 2, waiting: 'gap' })
    expect(p.next_at).toBe(new Date(Date.parse(T0) + 30 * MIN).toISOString())
    // 名单上的人：发了的「已发」，排着的「排队中」
    const rows = await data<{ rows: { creator_id: string; outreach_queue?: string }[] }>(
      await api('/v1/kol/creators?channel=youtube'),
    )
    const mark = new Map(rows.rows.map((r) => [r.creator_id, r.outreach_queue]))
    expect(mark.get(ids[0] as string)).toBe('sent')
    expect(mark.get(ids[1] as string)).toBe('queued')
    expect(mark.get(ids[2] as string)).toBe('queued')

    // 间隔没到：这一拍什么都不发
    t += 10 * MIN
    await pump()
    expect(await firsts()).toHaveLength(1)
    // 到了：发第二封，一拍只发一封
    t += 20 * MIN
    await pump()
    await pump()
    expect(await firsts()).toEqual([ids[0], ids[1]])
    t += 30 * MIN
    await pump()
    expect(await firsts()).toEqual(ids)
    await pump()
    p = await progressOf(id)
    expect(p).toMatchObject({ state: 'done', sent: 3, queued: 0 })
  })

  it('这一小时发满了（别的开发信也算）：等窗口空出来；另一批里排着的人跳过', async () => {
    await boot()
    const ids = await sandboxIds(4)
    // 先单发一封（算进这一小时）
    const single = await data<{ staged: boolean }>(
      await post('/v1/kol/outreach', { creator_id: ids[3], channel: 'youtube', ...BODY }),
    )
    expect(single.staged).toBe(true)
    const id = await plan(ids.slice(0, 3))
    await post(`/v1/kol/outreach/batches/${id}/control`, { per_hour: 2 })
    await approve(id)
    expect((await firsts()).length).toBe(2)
    t += 30 * MIN
    await pump()
    const p = await progressOf(id)
    expect(p.waiting).toBe('hour')
    expect(p.next_at).toBe(new Date(Date.parse(T0) + 60 * MIN).toISOString())
    expect((await firsts()).length).toBe(2)
    t += 31 * MIN
    await pump()
    expect((await firsts()).length).toBe(3)
    // 还排着队的人不进新的一批
    const again = await data<{ ok: boolean; skipped: { creator_id: string; reason: string }[] }>(
      await post('/v1/kol/outreach/batch', {
        channel: 'youtube',
        creator_ids: [ids[2]],
        ...BODY,
      }),
    )
    expect(again.ok).toBe(false)
    expect(again.skipped[0]?.reason).toBe('在发送队列里')
  })

  it('暂停了不发、继续接着发；取消剩下的：没发的不再发，已发的不撤', async () => {
    await boot()
    const ids = await sandboxIds(3)
    const id = await plan(ids)
    await approve(id)
    expect(await firsts()).toHaveLength(1)
    const paused = await data<Progress>(
      await post(`/v1/kol/outreach/batches/${id}/control`, { action: 'pause' }),
    )
    expect(paused.state).toBe('paused')
    t += 60 * MIN
    await pump()
    expect(await firsts()).toHaveLength(1)
    // 继续：间隔早到了，当场发下一封
    const resumed = await data<Progress>(
      await post(`/v1/kol/outreach/batches/${id}/control`, { action: 'resume' }),
    )
    expect(resumed).toMatchObject({ state: 'sending', sent: 2, queued: 1 })
    const cancelled = await data<Progress>(
      await post(`/v1/kol/outreach/batches/${id}/control`, { action: 'cancel' }),
    )
    expect(cancelled).toMatchObject({ state: 'cancelled', sent: 2, queued: 0, cancelled: 1 })
    t += 60 * MIN
    await pump()
    expect(await firsts()).toEqual(ids.slice(0, 2))
    // 定完了的改不了
    expect(
      (await post(`/v1/kol/outreach/batches/${id}/control`, { action: 'resume' })).status,
    ).toBe(409)
  })

  it('今天额度满了：排着等（滚动 24 小时空出来再发），不跳过', async () => {
    await boot()
    const ids = await sandboxIds(2)
    // 两小时前先用掉 29 封（真红人、没连邮箱：每封一张卡，照样算进额度；不算进这一小时）
    t = Date.parse(T0) - 120 * MIN
    for (let i = 0; i < 29; i++) {
      const c = await data<{ creator: { id: string } }>(
        await post('/v1/kol/creators', {
          display_name: `Filler ${i}`,
          channel: 'youtube',
          handle: `filler${i}`,
          followers: 12_000,
          engagement_rate: 0.04,
          category: '数码',
        }),
      )
      await post(`/v1/kol/creators/${c.creator.id}/contacts`, {
        kind: 'email',
        value: `filler${i}@example.com`,
      })
      const one = await data<{ staged: boolean }>(
        await post('/v1/kol/outreach', { creator_id: c.creator.id, channel: 'youtube', ...BODY }),
      )
      expect(one.staged).toBe(true)
    }
    t = Date.parse(T0)
    const id = await plan(ids)
    const card = await server.txn.approvals.get(id)
    // 今天只剩 1 封也照样出卡、两个人都在名单上（超了的明天接着发）
    const shown = card?.payload as { count: number; quota_remaining: number } | undefined
    expect(shown?.count).toBe(2)
    expect(shown?.quota_remaining).toBe(1)
    await approve(id)
    expect(await firsts()).toHaveLength(30)
    t += 60 * MIN
    await pump()
    const p = await progressOf(id)
    expect(p).toMatchObject({ state: 'sending', sent: 1, queued: 1, waiting: 'quota' })
    // 最早那一封（两小时前）滑出 24 小时窗口时空出名额
    expect(p.next_at).toBe(new Date(Date.parse(T0) + 22 * 60 * MIN).toISOString())
    t = Date.parse(T0) + 22 * 60 * MIN + MIN
    await pump()
    expect((await progressOf(id)).sent).toBe(2)
  })

  it('AI 运行的令牌管不了这一批（暂停 / 取消 / 改节奏只给人点）', async () => {
    await boot()
    const ids = await sandboxIds(2)
    const id = await plan(ids)
    const runtime = server.identity.issue(
      'runtime',
      server.bootstrap.person.id,
      server.bootstrap.workspace.id,
    ).token
    const res = await post(`/v1/kol/outreach/batches/${id}/control`, { per_hour: 30 }, runtime)
    expect(res.status).toBe(403)
    expect((await progressOf(id)).per_hour).toBe(5)
  })

  it('重启后接着发、不重发：发到一半关掉进程，再开起来照节奏发剩下的', async () => {
    dir = mkdtempSync(join(tmpdir(), 'agentsws-wp506-'))
    await boot(dir)
    const ids = await sandboxIds(3)
    const id = await plan(ids)
    await approve(id)
    expect(await firsts()).toEqual([ids[0]])
    await server.close()

    t += 12 * MIN
    await boot(dir)
    await pump()
    await pump()
    expect(await firsts()).toEqual([ids[0], ids[1]])
    t += 12 * MIN
    await pump()
    expect(await firsts()).toEqual(ids)
    const p = await progressOf(id)
    expect(p.sent).toBe(3)
  })

  it('崩在半路（记了「在发」、没记完）：账本里有那封就当已发，没有就退回排队——不重发', async () => {
    await boot()
    const ids = await sandboxIds(3)
    const id = await plan(ids)
    await approve(id)
    expect(await firsts()).toEqual([ids[0]])
    // 手工把第一封退回「在发」（它其实已经提上去了）、第二封也记成「在发」（其实没提）
    const brand = await server.brands.forWorkspace(server.bootstrap.workspace.id)
    type Row = { approval_item_id: string; queue: { creator_id: string; state: string }[] }
    const rows = brand.kol.setting<Row[]>('outreach_batches') ?? []
    brand.kol.saveSetting(
      'outreach_batches',
      rows.map((r) =>
        r.approval_item_id !== id
          ? r
          : {
              ...r,
              queue: r.queue.map((e, i) => (i < 2 ? { ...e, state: 'sending' } : e)),
            },
      ),
      new Date(t).toISOString(),
    )
    await pump()
    // 第一封认回「已发」，第二封退回排队（间隔还没到，这一拍不发）
    expect(await firsts()).toEqual([ids[0]])
    const p = await progressOf(id)
    expect(p.rows.map((r) => r.state)).toEqual(['sent', 'queued', 'queued'])
    t += 12 * MIN
    await pump()
    expect(await firsts()).toEqual([ids[0], ids[1]])
  })
})
