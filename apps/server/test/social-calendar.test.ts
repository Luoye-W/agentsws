/**
 * WP73（56 §6 第四项）内容日历：路由 + 定时发布那一跳。
 *
 * 钉五件事：
 *
 * 1. **建草稿 = 一张发布卡**，而且排期时间**写在卡面上**（36 §2：批了之后它会在
 *    那个时刻自己出去，人按下那一下之前必须看得见）。
 * 2. **撞车当场判、在卡上说明**：同一个号 90 分钟内两条 → 卡面带 ⚠ 那句话。
 * 3. **拖一下 = 重新出一张卡**：换个时间发也是一次发布（`social_post` 永远 L1）。
 * 4. **到点只发批准过的**：没批的到点了也不发，照实记一句。
 * 5. **发失败写回原话、不重试**：平台说什么就记什么，那一条单独摆着。
 */
import type { Assignment } from '@agentsws/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'

const T0 = '2026-09-15T02:00:00.000Z'
const SECRETS_KEY = 'e'.repeat(64)

function makeClock(start = T0) {
  let t = Date.parse(start)
  return {
    now: () => new Date(t).toISOString(),
    advance: (ms: number) => {
      t += ms
    },
  }
}

function seeded(seed = 731): () => number {
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
let url: string
let clock: ReturnType<typeof makeClock>
let discord: Assignment
/** 每一跳打到哪儿（真 fetch 一次都不出去）。 */
let calls: { url: string; body?: string }[]
let reply: (url: string) => { status: number; body: string }

const api = async (
  path: string,
  init: RequestInit & { assignment?: string } = {},
): Promise<Response> => {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${server.bootstrap.internalToken}`)
  headers.set('X-Assignment', init.assignment ?? discord.id)
  if (init.body !== undefined) headers.set('content-type', 'application/json')
  return fetch(`${url}${path}`, { ...init, headers })
}

const post = (path: string, body: unknown, assignment?: string): Promise<Response> =>
  api(path, {
    method: 'POST',
    body: JSON.stringify(body),
    ...(assignment === undefined ? {} : { assignment }),
  })

const data = async <T>(res: Response): Promise<T> => ((await res.json()) as { data: T }).data

beforeEach(async () => {
  clock = makeClock()
  calls = []
  reply = () => ({ status: 200, body: '{"id":"dc_new"}' })
  server = await createServer({
    quiet: true,
    clock: { now: () => clock.now() },
    random: seeded(),
    scheduleIntervalMs: 0,
    startRun: false,
    socialFetch: async (input, init) => {
      calls.push({ url: input, ...(init.body === undefined ? {} : { body: init.body }) })
      const r = reply(input)
      return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => r.body }
    },
    env: { AGENTSWS_OWNER_EMAIL: 'luoye@example.com', AGENTSWS_SECRETS_KEY: SECRETS_KEY },
  })
  ;({ url } = await server.listen(0))
  discord = server.roles.assignments.create({
    person_id: server.bootstrap.person.id,
    workspace_id: server.bootstrap.workspace.id,
    role_id: 'social.discord',
    granted_by: server.bootstrap.person.id,
    ranges: [{ kind: 'store', id: 'store_1' }],
  })
})

afterEach(async () => {
  await server.close()
})

async function addAccount(): Promise<string> {
  const res = await post('/v1/social/accounts', {
    channel: 'discord',
    handle: 'nordvolt-desk',
    display_name: 'Nordvolt 桌面党',
    url: 'https://discord.gg/nordvolt',
    external_id: '900000000000001/900000000000002',
  })
  return (await data<{ id: string }>(res)).id
}

/** 批一张卡（投递是 create 之后才路由的，所以 decision_token 要从库里重读）。 */
async function approve(approval_item_id: string | undefined): Promise<void> {
  const fresh = await server.txn.approvals.get(approval_item_id as string)
  const token = [...(fresh?.deliveries ?? [])]
    .reverse()
    .find((d) => d.status === 'sent')?.decision_token
  if (token === undefined) throw new Error(`这张卡没有本人的 decision_token：${fresh?.state}`)
  await server.txn.approvals.decide(approval_item_id as string, server.bootstrap.person.id, {
    action: 'approve',
    decision_token: token,
    via: 'workstation',
  })
}

/** 卡面上那几句（标题 + 摘要 + 备注）。 */
async function cardOf(change_id: string | undefined): Promise<string> {
  const items = await server.txn.approvals.queue({
    workspace_id: server.bootstrap.workspace.id,
    person_id: server.bootstrap.person.id,
    lane: 'mine',
  })
  const item = items.find((i) => i.subject.change_id === change_id) ?? items[items.length - 1]
  return `${item?.title ?? ''} ${item?.summary ?? ''}`
}

describe('WP73 内容日历：建草稿与撞车', () => {
  it('建一条排期 = 一张发布卡，排期时间写在卡面上', async () => {
    const account_id = await addAccount()
    const at = '2026-09-17T10:00:00.000Z'
    const view = await data<{
      post: { id: string; status: string }
      conflicts: string[]
      staged: { staged: boolean; level?: string; change_id?: string }
    }>(
      await post('/v1/social/posts', {
        account_id,
        kind: 'post',
        body: '周四直播',
        scheduled_at: at,
      }),
    )
    expect(view.post.status).toBe('scheduled')
    expect(view.staged.staged).toBe(true)
    // `social_post` 在 HARD_L1 里：报什么都按回人审
    expect(view.staged.level).toBe('L1')
    expect(view.conflicts).toEqual([])
    expect(await cardOf(view.staged.change_id)).toContain(at)
  })

  it('同一个号 90 分钟内第二条 → 撞车在卡面上说明（同渠道同一小时两条）', async () => {
    const account_id = await addAccount()
    await post('/v1/social/posts', {
      account_id,
      kind: 'post',
      body: '第一条',
      scheduled_at: '2026-09-17T10:00:00.000Z',
    })
    const view = await data<{
      conflicts: string[]
      next_free_slot?: string
      staged: { change_id?: string }
    }>(
      await post('/v1/social/posts', {
        account_id,
        kind: 'post',
        body: '第二条',
        scheduled_at: '2026-09-17T10:30:00.000Z',
      }),
    )
    expect(view.conflicts.join(' ')).toContain('挨得太近')
    // 撞了要给得出一个能点的建议，不能只说"撞了"
    expect(view.next_free_slot).toBeDefined()
    expect(await cardOf(view.staged.change_id)).toContain('挨得太近')
  })

  it('周视图那一屏：一行一条渠道，格子带撞车说明', async () => {
    const account_id = await addAccount()
    await post('/v1/social/posts', {
      account_id,
      kind: 'post',
      body: '周四直播',
      scheduled_at: '2026-09-17T10:00:00.000Z',
    })
    const view = await data<{
      channels: string[]
      cells: { post_id: string; channel: string; conflicts: string[] }[]
    }>(await api('/v1/social/calendar?from=2026-09-14T00:00:00.000Z&to=2026-09-21T00:00:00.000Z'))
    expect(view.channels).toEqual(['discord'])
    expect(view.cells).toHaveLength(1)
    expect(view.cells[0]?.conflicts).toEqual([])
  })

  it('拖一下改排期 = 重新出一张卡（换个时间发也是一次发布）', async () => {
    const account_id = await addAccount()
    const made = await data<{ post: { id: string } }>(
      await post('/v1/social/posts', {
        account_id,
        kind: 'post',
        body: '周四直播',
        scheduled_at: '2026-09-17T10:00:00.000Z',
      }),
    )
    const moved = await data<{ post: { scheduled_at?: string }; staged: { staged: boolean } }>(
      await api(`/v1/social/posts/${made.post.id}/schedule`, {
        method: 'PATCH',
        body: JSON.stringify({ scheduled_at: '2026-09-18T10:00:00.000Z' }),
      }),
    )
    expect(moved.post.scheduled_at).toBe('2026-09-18T10:00:00.000Z')
    expect(moved.staged.staged).toBe(true)
    const changes = await server.txn.ledger.list({
      workspace_id: server.bootstrap.workspace.id,
      kind: 'social_post',
    })
    // 两张：建的那一次 + 改时间那一次
    expect(changes).toHaveLength(2)
  })
})

describe('WP73 定时发布：到点只发批准过的', () => {
  /** 到点那一跳（调度器按品牌各跑一轮，这里直接调那个品牌的）。 */
  const sweep = async () => {
    const brand = await server.brands.forWorkspace(server.bootstrap.workspace.id)
    return brand.socialService.publishDue()
  }

  it('没批的到点了也不发，照实记一句', async () => {
    const account_id = await addAccount()
    await post('/v1/social/posts', {
      account_id,
      kind: 'post',
      body: '周四直播',
      scheduled_at: '2026-09-15T03:00:00.000Z',
    })
    clock.advance(2 * 3_600_000)
    const out = await sweep()
    expect(out.due).toBe(1)
    expect(out.published).toBe(0)
    expect(out.skipped[0]?.reason).toContain('还没人点头')
    // 一跳都没打出去
    expect(calls).toHaveLength(0)
  })

  it('批了之后到点真去调那一跳；这条渠道没连上就照实说，**不假装发出去了**', async () => {
    const account_id = await addAccount()
    const view = await data<{ post: { id: string }; staged: { approval_item_id?: string } }>(
      await post('/v1/social/posts', {
        account_id,
        kind: 'post',
        body: '周四直播',
        scheduled_at: '2026-09-15T03:00:00.000Z',
      }),
    )
    await approve(view.staged.approval_item_id)
    clock.advance(2 * 3_600_000)
    const out = await sweep()
    // 这台测试机上 Discord 没连（`connected()` 为假）——所以适配器一跳都不打，
    // 回的是"还没连上"那句人话。**不是**"发出去了"，也不是一个空的成功。
    expect(out.published).toBe(0)
    expect(out.failed).toBe(1)
    expect(calls).toHaveLength(0)
    const brand = await server.brands.forWorkspace(server.bootstrap.workspace.id)
    const row = brand.social.post(view.post.id)
    expect(row?.status).toBe('failed')
    expect(row?.failure_reason).toContain('还没连上')
  })

  it('发失败写回原话、**不重试**（那一条单独摆着，不会再发一遍）', async () => {
    const account_id = await addAccount()
    const view = await data<{ post: { id: string }; staged: { approval_item_id?: string } }>(
      await post('/v1/social/posts', {
        account_id,
        kind: 'post',
        body: '周四直播',
        scheduled_at: '2026-09-15T03:00:00.000Z',
      }),
    )
    await approve(view.staged.approval_item_id)
    clock.advance(2 * 3_600_000)
    const first = await sweep()
    expect(first.failed).toBe(1)
    const brand = await server.brands.forWorkspace(server.bootstrap.workspace.id)
    expect(brand.social.post(view.post.id)?.status).toBe('failed')
    // 再跑一轮：它已经不是 `scheduled` 了，所以**不会重发**
    const again = await sweep()
    expect(again.due).toBe(0)
    expect(calls).toHaveLength(0)
  })
})
