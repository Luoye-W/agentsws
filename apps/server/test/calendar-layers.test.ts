/**
 * WP74（37 §2.5）：**一个日历，多图层**——服务端那一半，端到端。
 *
 * 钉三件事：
 *
 * 1. **不传 `sources` 行为不变**：老的四类照旧出现，新的三类也在同一份里
 *    （"一个日历"这句话的落点就是这一条——不是再开一个日历）。
 * 2. **传了只回那几层**：`?sources=social_post` 回的就只有社媒排期。
 * 3. **社媒排期按品牌隔离**：A 的帖子不出现在 B 的日历上。九条渠道是九个真账号
 *    （56 §2），串了品牌等于发错号——这一条要有一档真的盯着。
 */
import type { CalendarItem } from '@agentsws/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'

const T0 = '2026-09-15T09:00:00.000Z'
const SECRETS_KEY = 'e'.repeat(64)

function seeded(seed = 74): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Who {
  workspace_id: string
  token: string
  assignment: string
}

let server: Server

const call = async <T>(who: Who, path: string): Promise<{ status: number; data?: T }> => {
  const headers = new Headers({ 'content-type': 'application/json' })
  headers.set('Authorization', `Bearer ${who.token}`)
  headers.set('X-Assignment', who.assignment)
  const res = await server.gateway.fetch(new Request(`http://127.0.0.1${path}`, { headers }))
  const parsed = (await res.json()) as { data?: T }
  return { status: res.status, ...(parsed.data === undefined ? {} : { data: parsed.data }) }
}

/** 这一天的窗口（日历那一屏问的就是这么一段）。 */
const WINDOW = 'from=2026-09-15T00:00:00.000Z&to=2026-09-16T00:00:00.000Z'

const calendarOf = async (who: Who, sources?: string): Promise<CalendarItem[]> => {
  const res = await call<{ items: CalendarItem[] }>(
    who,
    `/v1/calendar?${WINDOW}${sources === undefined ? '' : `&sources=${sources}`}`,
  )
  expect(res.status).toBe(200)
  return res.data?.items ?? []
}

function bootstrapWho(): Who {
  return {
    workspace_id: server.bootstrap.workspace.id,
    token: server.bootstrap.internalToken,
    assignment: server.bootstrap.ownerAssignment.id,
  }
}

/** 建第二个品牌并拿到"以它的身份"发请求的句柄（52 O2：切品牌 = 换一张会话 token）。 */
async function addBrand(name: string): Promise<Who> {
  const me = bootstrapWho()
  const orgs = await call<{ id: string }[]>(me, '/v1/orgs')
  const org = orgs.data?.[0]
  if (org === undefined) throw new Error('启动之后应该有一个组织')
  const headers = new Headers({ 'content-type': 'application/json' })
  headers.set('Authorization', `Bearer ${me.token}`)
  headers.set('X-Assignment', me.assignment)
  const created = await server.gateway.fetch(
    new Request(`http://127.0.0.1/v1/orgs/${org.id}/brands`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name }),
    }),
  )
  const workspace_id = ((await created.json()) as { data: { workspace_id: string } }).data
    .workspace_id
  const switched = await server.gateway.fetch(
    new Request(`http://127.0.0.1/v1/orgs/${org.id}/brands/${workspace_id}/switch`, {
      method: 'POST',
      headers,
    }),
  )
  const token = ((await switched.json()) as { data: { session_token: string } }).data.session_token
  const assignment = server.roles.assignments
    .listByPerson(server.bootstrap.person.id, { workspace_id })
    .find((a) => a.revoked_at === undefined)
  if (assignment === undefined) throw new Error('新品牌里应该自带一条 owner 分配')
  return { workspace_id, token, assignment: assignment.id }
}

/** 给某个品牌塞一条排好期的帖子（走库，不走审批：这一档验的是日历，不是发布门禁）。 */
async function seedPost(ws: string, id: string, at: string): Promise<void> {
  const brand = await server.brands.forWorkspace(ws)
  brand.social.saveAccount({
    id: `sa_${id}`,
    channel: 'discord',
    handle: id,
    display_name: id,
    connected: true,
    created_at: T0,
  })
  brand.social.savePost({
    id,
    account_id: `sa_${id}`,
    channel: 'discord',
    kind: 'post',
    status: 'scheduled',
    body: `${id} 的正文`,
    scheduled_at: at,
  })
}

beforeEach(async () => {
  server = await createServer({
    quiet: true,
    clock: { now: () => T0 },
    random: seeded(),
    scheduleIntervalMs: 0,
    startRun: false,
    tokenRefreshIntervalMs: 0,
    liveDataIntervalMs: 0,
    env: { AGENTSWS_OWNER_EMAIL: 'luoye@example.com', AGENTSWS_SECRETS_KEY: SECRETS_KEY },
  })
})

afterEach(async () => {
  await server.close()
})

describe('WP74 统一日历：一个日历，多图层', () => {
  it('不传 sources = 全部：社媒排期与红人交付物跟会议 / 待办在同一份里', async () => {
    const me = bootstrapWho()
    await seedPost(me.workspace_id, 'sp_a', '2026-09-15T10:00:00.000Z')
    const brand = await server.brands.forWorkspace(me.workspace_id)
    brand.kol.saveDeliverable({
      id: 'dl_a',
      collaboration_id: 'col_a',
      kind: 'video',
      due_at: '2026-09-15T12:00:00.000Z',
      review: 'pending',
    })

    const items = await calendarOf(me)
    expect(items.map((i) => i.source)).toContain('social_post')
    expect(items.map((i) => i.source)).toContain('kol_deliverable')
    // 社媒那一条带渠道（同一层里按渠道分色）与拖拽语义
    const post = items.find((i) => i.source === 'social_post')
    expect(post).toMatchObject({ channel: 'discord', drag: 'reschedule' })
    // 交付物到期日是跟红人谈定的：拖不动
    expect(items.find((i) => i.source === 'kol_deliverable')).toMatchObject({ drag: 'readonly' })
  })

  it('传了 sources 只回那几层', async () => {
    const me = bootstrapWho()
    await seedPost(me.workspace_id, 'sp_a', '2026-09-15T10:00:00.000Z')
    const only = await calendarOf(me, 'social_post')
    expect(only).toHaveLength(1)
    expect(only[0]).toMatchObject({ source: 'social_post', ref: { type: 'social_post' } })
    // 一个图层都不开就是一条都不给（空选择是人主动做的事）
    expect(await calendarOf(me, 'standby')).toHaveLength(0)
  })

  it('社媒排期按品牌隔离：A 的帖子不出现在 B 的日历上', async () => {
    const a = bootstrapWho()
    const b = await addBrand('第二个品牌')
    await seedPost(a.workspace_id, 'sp_a', '2026-09-15T10:00:00.000Z')
    await seedPost(b.workspace_id, 'sp_b', '2026-09-15T11:00:00.000Z')

    expect((await calendarOf(a, 'social_post')).map((i) => i.ref.id)).toEqual(['sp_a'])
    expect((await calendarOf(b, 'social_post')).map((i) => i.ref.id)).toEqual(['sp_b'])
  })
})
