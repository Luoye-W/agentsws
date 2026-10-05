/**
 * WP235（Fable 10-06 在 Luoye 的 Windows 真机上实测）：老工作区的岗位在公司页上写「还没人做」、
 * 合并对着模板整包操作。真装配线（路由 → org / positions / learning），不打桩。
 *
 * 钉住的：
 * - 老工作区（两条跨模板分配、没有安放行）：持有模板里一条职责就算这个岗位的持有人，
 *   卡上带他手上是哪几条；「普通成员」「负责人」仍按默认包算；
 * - 合并「公共关系（只做 pr.reddit）」到「社媒运营（只做 social.reddit）」→ 一个自建岗位
 *   「Reddit 运营」装这两条，左栏只剩它；两个模板一个字不变；事项与岗位层记忆跟过去；
 * - 合并时可以给名字；没人做的模板不能当被合并的那一个；
 * - 移动职责到一个模板：同名自建岗位接住，模板不变。
 */
import type { Matter, PositionInstance } from '@agentsws/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'

const T0 = '2026-10-06T01:00:00.000Z'

function makeClock(start = T0) {
  let t = Date.parse(start)
  return {
    now: () => new Date(t).toISOString(),
    advance: (ms: number) => {
      t += ms
    },
  }
}

function seeded(seed = 235): () => number {
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

const call = async (method: string, path: string, body?: unknown): Promise<Response> => {
  const headers = new Headers()
  headers.set('Authorization', `Bearer ${server.bootstrap.internalToken}`)
  headers.set('X-Assignment', server.bootstrap.ownerAssignment.id)
  if (body !== undefined) headers.set('content-type', 'application/json')
  return server.gateway.fetch(
    new Request(`http://127.0.0.1${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )
}

const dataOf = async <T>(res: Response): Promise<T> => {
  const parsed = (await res.json()) as { data?: unknown; code?: string; message?: string }
  if (parsed.data === undefined) throw new Error(`没有 data：${parsed.code} ${parsed.message}`)
  return parsed.data as T
}

interface OrgPosition {
  id: string
  name: string
  source: 'bundled' | 'custom'
  roles: { role_id: string }[]
  holders: { person_id: string; name: string; role_ids: string[] }[]
}

const orgPositions = async (): Promise<OrgPosition[]> =>
  dataOf<OrgPosition[]>(await call('GET', '/v1/org/positions'))

const mine = async (): Promise<PositionInstance[]> =>
  (await dataOf<{ instances?: PositionInstance[] }>(await call('GET', '/v1/positions')))
    .instances ?? []

/** 老分配：没走 WP234 的向导、没有安放行（Luoye 的工作区就是这样建的）。 */
const oldAssignment = (role_id: string) =>
  server.roles.assignments.create({
    person_id: server.bootstrap.person.id,
    workspace_id: server.bootstrap.workspace.id,
    role_id,
    granted_by: server.bootstrap.person.id,
    ranges: [],
  })

const matterAt = (position_template_id: string, role_id: string, title: string): Matter =>
  server.work.createMatter({
    kind: 'adhoc',
    title,
    entry: 'position',
    position_template_id,
    role_id,
    participants: [server.bootstrap.person.id],
  })

beforeEach(async () => {
  server = await createServer({
    clock: makeClock(),
    random: seeded(),
    quiet: true,
    tokenRefreshIntervalMs: 0,
    scheduleIntervalMs: 0,
  })
})

afterEach(async () => {
  await server.close()
})

describe('WP235 老工作区的持有人', () => {
  it('持有模板里一条职责就算这个岗位的持有人，卡上带他手上那几条', async () => {
    const reddit = oldAssignment('pr.reddit')
    oldAssignment('social.reddit')
    expect(server.org.placementOf(reddit.id)).toBeUndefined()
    const list = await orgPositions()
    const me = server.bootstrap.person.id
    const pr = list.find((p) => p.id === 'pr')
    const social = list.find((p) => p.id === 'social-media')
    expect(pr?.holders.map((h) => [h.person_id, h.role_ids])).toEqual([[me, ['pr.reddit']]])
    expect(social?.holders.map((h) => [h.person_id, h.role_ids])).toEqual([[me, ['social.reddit']]])
    // 没人碰过的模板照旧没人
    expect(list.find((p) => p.id === 'customer-care')?.holders).toEqual([])
    // 「负责人」那一行照旧按默认包（common.owner）算，不因为底座职责被别的岗位拉进来
    expect(list.find((p) => p.id === 'owner')?.holders.map((h) => h.person_id)).toEqual([me])
    // 左栏与公司页同一条规则
    expect((await mine()).map((p) => p.position_id).sort()).toEqual(['pr', 'social-media'])
    // 岗位页的持有人与公司页一致
    const prPage = (await mine()).find((p) => p.position_id === 'pr')
    expect(prPage?.holders).toEqual([me])
  })
})

describe('WP235 合并作用在「你们的岗位」上', () => {
  it('公共关系（pr.reddit）合并到社媒运营（social.reddit）→ 一个自建「Reddit 运营」，模板不变，事项与记忆跟过去', async () => {
    oldAssignment('pr.reddit')
    oldAssignment('social.reddit')
    const before = server.org.positions().filter((p) => p.id === 'pr' || p.id === 'social-media')
    const prMatter = matterAt('pr', 'pr.reddit', '有人在 r/gadgets 说我们发货慢')
    const socialMatter = matterAt('social-media', 'social.reddit', '下周 AMA 的帖子')
    const by = server.bootstrap.person.id
    await server.learning.addMemory({ tier: 'position', scope_id: 'pr', text: '回帖不甩链接', by })
    await server.learning.addMemory({
      tier: 'position',
      scope_id: 'social-media',
      text: '发帖前看版规',
      by,
    })

    const res = await dataOf<{
      positions: OrgPosition[]
      moved_assignments: number
      moved_matters: number
      memory?: { moved: number; kept_both: number }
      created?: string
      deleted?: string
    }>(await call('POST', '/v1/org/positions/pr/merge', { into: 'social-media' }))
    const id = res.created ?? ''
    expect(id).toMatch(/^pos-/)
    expect(res).toMatchObject({ moved_assignments: 2, moved_matters: 2 })
    expect(res.deleted).toBeUndefined()
    expect(res.memory).toEqual({ moved: 2, kept_both: 0 })

    // 新岗位：建议名「Reddit 运营」，装这两条，Luoye 是持有人
    const merged = res.positions.find((p) => p.id === id)
    expect(merged?.name).toBe('Reddit 运营')
    expect(merged?.source).toBe('custom')
    expect(merged?.roles.map((r) => r.role_id).sort()).toEqual(['pr.reddit', 'social.reddit'])
    expect(merged?.holders.map((h) => h.role_ids.slice().sort())).toEqual([
      ['pr.reddit', 'social.reddit'],
    ])

    // 两个模板一个字不变，也没人在做了
    expect(server.org.positions().filter((p) => p.id === 'pr' || p.id === 'social-media')).toEqual(
      before,
    )
    const list = await orgPositions()
    expect(list.find((p) => p.id === 'pr')?.holders).toEqual([])
    expect(list.find((p) => p.id === 'social-media')?.holders).toEqual([])

    // 左栏只剩这一个；两条职责都归它
    const nav = await mine()
    expect(nav.map((p) => p.position_id)).toEqual([id])
    expect(
      nav[0]?.roles
        .filter((r) => r.my_assignment_id !== undefined)
        .map((r) => r.role_id)
        .sort(),
    ).toEqual(['pr.reddit', 'social.reddit'])

    // 事项与岗位层记忆跟过去
    expect(server.work.getMatter(prMatter.id)?.position_template_id).toBe(id)
    expect(server.work.getMatter(socialMatter.id)?.position_template_id).toBe(id)
    const bodies = server.learning
      .memoryAt({ tier: 'position', scope_id: id })
      .map((m) => m.body)
      .sort()
    expect(bodies).toEqual(['发帖前看版规', '回帖不甩链接'].sort())
    expect(server.learning.memoryAt({ tier: 'position', scope_id: 'pr' })).toEqual([])
  })

  it('合并时给了名字就用它；再合一个进自建岗位不再另建', async () => {
    oldAssignment('pr.reddit')
    oldAssignment('social.reddit')
    oldAssignment('dtc.support')
    const first = await dataOf<{ created?: string }>(
      await call('POST', '/v1/org/positions/pr/merge', {
        into: 'social-media',
        name: 'Reddit 全包',
      }),
    )
    const id = first.created ?? ''
    expect(server.org.positions().find((p) => p.id === id)?.name.zh).toBe('Reddit 全包')

    const second = await dataOf<{ created?: string; positions: OrgPosition[] }>(
      await call('POST', '/v1/org/positions/customer-care/merge', { into: id }),
    )
    expect(second.created).toBeUndefined()
    expect(second.positions.find((p) => p.id === id)?.roles.map((r) => r.role_id)).toEqual([
      'social.reddit',
      'pr.reddit',
      'dtc.support',
    ])
    // 客服模板也不变（它只是没人做了）
    expect(server.org.positions().find((p) => p.id === 'customer-care')?.source).toBe('bundled')
    expect((await mine()).map((p) => p.position_id)).toEqual([id])
  })

  it('没人做的模板不能当被合并的那一个', async () => {
    oldAssignment('social.reddit')
    const res = await call('POST', '/v1/org/positions/pr/merge', { into: 'social-media' })
    expect(res.status).toBe(400)
  })

  it('移动职责到一个模板：同名自建岗位接住，模板不变', async () => {
    oldAssignment('pr.reddit')
    oldAssignment('social.tiktok')
    const before = server.org.positions().find((p) => p.id === 'social-media')
    const out = await dataOf<{ created?: string; moved_assignments: number }>(
      await call('POST', '/v1/org/positions/pr/move-duty', {
        role_id: 'pr.reddit',
        to: 'social-media',
      }),
    )
    const id = out.created ?? ''
    expect(id).toMatch(/^pos-/)
    expect(out.moved_assignments).toBe(2)
    expect(server.org.positions().find((p) => p.id === 'social-media')).toEqual(before)
    const fork = server.org.positions().find((p) => p.id === id)
    expect(fork?.name.zh).toBe('社媒运营')
    expect(fork?.roles.map((r) => r.role)).toEqual(['social.tiktok', 'pr.reddit'])
    // 公共关系模板的清单也没被删一条
    expect(server.org.positions().find((p) => p.id === 'pr')?.roles.length).toBe(5)
    expect((await mine()).map((p) => p.position_id)).toEqual([id])
  })
})
