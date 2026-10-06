/**
 * WP241（docs/54 §7）：岗位页「工作」——本岗位的工作项视图。
 *
 * 两层钉：
 * 1. `buildPositionWork` 纯函数：四类合并、分组、挂卡、已完成窗口、排期按渠道 → 职责；
 * 2. 真装配线（合并出「Reddit 运营」→ 交给它一件事 → 加待办 → 建定时 → `GET /v1/positions/:id/work`），
 *    以及 #73（Luoye 10-06）：职责拆出去时，没做完的事**跟着职责走**。
 */
import type { ApprovalItem, Matter, PositionWorkView, Todo } from '@agentsws/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'
import { buildPositionWork, socialRoleOfChannel } from '../src/position-work.js'

const NOW = '2026-10-06T12:00:00.000Z'

const matter = (over: Partial<Matter>): Matter => ({
  id: 'm_1',
  schema_version: 1,
  workspace_id: 'ws_1',
  kind: 'adhoc',
  title: '近视求助帖的回帖',
  status: 'open',
  context: { summary: '', pinned: [], participants: [], last_activity: NOW },
  created_at: NOW,
  updated_at: NOW,
  ...over,
})

const todo = (over: Partial<Todo>): Todo => ({
  id: 't_1',
  schema_version: 1,
  workspace_id: 'ws_1',
  title: '私信版主问 flair',
  owner: 'p_1',
  horizon: 'short',
  source: 'manual',
  status: 'open',
  cards: [],
  runs: [],
  created_at: NOW,
  updated_at: NOW,
  ...over,
})

const card = (id: string, matter_id?: string): ApprovalItem =>
  ({
    id,
    state: 'pending',
    role_id: 'pr.reddit',
    subject: matter_id === undefined ? {} : { matter_id },
  }) as unknown as ApprovalItem

const base = {
  position_id: 'pos-reddit',
  now: NOW,
  today: { from: '2026-10-06T00:00:00.000Z', to: '2026-10-07T00:00:00.000Z' },
  duties: [
    { role_id: 'pr.reddit', role_name: 'Reddit 营销', assignment_id: 'asg_pr' },
    { role_id: 'social.reddit', role_name: '自家版运营', assignment_id: 'asg_social' },
  ],
  matters: [] as Matter[],
  todos: [] as Todo[],
  schedules: [],
  posts: [],
  cards: [] as ApprovalItem[],
  roleName: (id: string) => id,
  roleOfAssignment: (id: string) =>
    id === 'asg_pr' ? 'pr.reddit' : id === 'asg_social' ? 'social.reddit' : undefined,
}

describe('buildPositionWork', () => {
  it('四类合成一份，按 进行中 / 排着的 / 等别人 / 已完成 排；每项带所属职责；系统例行不进', () => {
    const view = buildPositionWork({
      ...base,
      matters: [
        matter({ id: 'm_open', role_id: 'pr.reddit', entry: 'position' }),
        matter({ id: 'm_wait', status: 'waiting', position_id: 'asg_social' }),
        matter({ id: 'm_done', status: 'closed', closed_at: '2026-10-05T00:00:00.000Z' }),
      ],
      todos: [todo({ position_id: 'asg_social', due: '2026-10-06T18:00:00.000Z' })],
      schedules: [
        {
          id: 'sch_1',
          title: '扫一遍 Reddit',
          role_id: 'pr.reddit',
          assignment_id: 'asg_pr',
          state: 'active',
          created_by: 'user',
          next_fire_at: '2026-10-07T01:00:00.000Z',
        },
        {
          id: 'sch_sys',
          title: '晚上做一次复盘',
          role_id: 'pr.reddit',
          assignment_id: 'asg_pr',
          state: 'active',
          created_by: 'system',
          next_fire_at: '2026-10-06T12:00:00.000Z',
        },
      ],
      posts: [
        {
          id: 'post_1',
          channel: 'reddit',
          status: 'scheduled',
          body: 'r/INMO 每周问答帖',
          scheduled_at: '2026-10-09T01:00:00.000Z',
        },
        { id: 'post_x', channel: 'tiktok', status: 'scheduled', body: '不是这个岗位的' },
      ],
    })
    expect(view.items.map((i) => [i.id, i.group])).toEqual([
      ['todo:t_1', 'doing'],
      ['matter:m_open', 'doing'],
      ['schedule:sch_1', 'queued'],
      ['post:post_1', 'queued'],
      ['matter:m_wait', 'waiting'],
      ['matter:m_done', 'done'],
    ])
    const byId = new Map(view.items.map((i) => [i.id, i]))
    expect(byId.get('matter:m_wait')?.role_id).toBe('social.reddit')
    expect(byId.get('matter:m_wait')?.role_name).toBe('自家版运营')
    expect(byId.get('matter:m_open')?.source).toBe('you')
    expect(byId.get('todo:t_1')?.movable).toBe(true)
    expect(byId.get('matter:m_open')?.movable).toBe(false)
    expect(byId.get('post:post_1')?.role_id).toBe('social.reddit')
    expect(view.counts).toMatchObject({ doing: 2, queued: 2, waiting: 1, done: 1, todos_today: 1 })
  })

  it('等你的卡挂到它那件事上；待办挂着的事项上的卡也算它的；卡数去重', () => {
    const view = buildPositionWork({
      ...base,
      matters: [matter({ id: 'm_1' })],
      todos: [todo({ id: 't_1', matter_id: 'm_1', cards: ['c_2', 'c_gone'] })],
      cards: [card('c_1', 'm_1'), card('c_2')],
    })
    const m = view.items.find((i) => i.id === 'matter:m_1')
    const t = view.items.find((i) => i.id === 'todo:t_1')
    expect(m?.card_ids).toEqual(['c_1'])
    expect(t?.card_ids.sort()).toEqual(['c_1', 'c_2'])
    expect(view.counts.cards).toBe(2)
  })

  it('已完成只带最近 14 天；归档了的进行中不出；不做了的待办不出', () => {
    const view = buildPositionWork({
      ...base,
      matters: [
        matter({ id: 'm_old', status: 'closed', closed_at: '2026-09-01T00:00:00.000Z' }),
        matter({ id: 'm_arch', archived_at: '2026-10-05T00:00:00.000Z' }),
      ],
      todos: [todo({ id: 't_drop', status: 'dropped' })],
    })
    expect(view.items).toEqual([])
  })

  it('进展：摘要优先，截短成一句', () => {
    const long = '草稿写好了，'.repeat(30)
    const view = buildPositionWork({
      ...base,
      matters: [matter({ context: { ...matter({}).context, summary: long } })],
    })
    const progress = view.items[0]?.progress ?? ''
    expect(progress.length).toBeLessThanOrEqual(80)
    expect(progress.endsWith('…')).toBe(true)
  })

  it('渠道 → 职责', () => {
    expect(socialRoleOfChannel('facebook_group')).toBe('social.facebook-group')
  })
})

// ── 真装配线 ───────────────────────────────────────────────────────────

let server: Server
let positionId = ''
const held = new Map<string, string>()

const call = async (
  method: string,
  path: string,
  body?: unknown,
  assignment = server.bootstrap.ownerAssignment.id,
): Promise<Response> => {
  const headers = new Headers()
  headers.set('Authorization', `Bearer ${server.bootstrap.internalToken}`)
  headers.set('X-Assignment', assignment)
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

const workOf = async (id: string): Promise<PositionWorkView> =>
  dataOf<PositionWorkView>(await call('GET', `/v1/positions/${encodeURIComponent(id)}/work`))

beforeEach(async () => {
  server = await createServer({
    clock: { now: () => NOW },
    quiet: true,
    tokenRefreshIntervalMs: 0,
    scheduleIntervalMs: 0,
  })
  held.clear()
  for (const role_id of ['pr.reddit', 'social.reddit']) {
    const a = server.roles.assignments.create({
      person_id: server.bootstrap.person.id,
      workspace_id: server.bootstrap.workspace.id,
      role_id,
      granted_by: server.bootstrap.person.id,
      ranges: [],
    })
    held.set(role_id, a.id)
  }
  const merged = await dataOf<{ created?: string }>(
    await call('POST', '/v1/org/positions/pr/merge', { into: 'social-media' }),
  )
  positionId = merged.created ?? ''
  expect(positionId).toMatch(/^pos-/)
})

afterEach(async () => {
  await server.close()
})

describe('GET /v1/positions/:id/work', () => {
  it('交给它的事、手动加的待办、定时任务都在；两种 id 都认', async () => {
    const social = held.get('social.reddit') ?? ''
    await call('POST', `/v1/positions/${positionId}/matters`, {
      title: '帮我做一份 Reddit 调研',
      role_id: 'pr.reddit',
    })
    expect(
      (await call('POST', '/v1/todos', { title: '私信版主问 flair', due: NOW }, social)).status,
    ).toBe(201)
    expect(
      (
        await call(
          'POST',
          '/v1/schedules',
          { title: 'r/INMO 入群审核', trigger: { kind: 'interval', every_ms: 7_200_000 } },
          social,
        )
      ).status,
    ).toBe(201)

    const view = await workOf(positionId)
    expect(view.position_id).toBe(positionId)
    const kinds = view.items.map((i) => `${i.kind}:${i.title}`)
    expect(kinds).toContain('matter:帮我做一份 Reddit 调研')
    expect(kinds).toContain('todo:私信版主问 flair')
    expect(kinds).toContain('schedule:r/INMO 入群审核')
    const todoItem = view.items.find((i) => i.kind === 'todo')
    expect(todoItem?.role_id).toBe('social.reddit')
    expect(todoItem?.assignment_id).toBe(social)
    expect(view.counts.todos_today).toBe(1)
    expect(view.duties.map((d) => d.role_id).sort()).toEqual(['pr.reddit', 'social.reddit'])
    // 给分配 id 也认（工作台地址栏里那一条）
    expect((await workOf(social)).position_id).toBe(positionId)
  })

  it('#73 拆出去：自家版那条职责的待办、定时、事项跟着走，原岗位不再列', async () => {
    const social = held.get('social.reddit') ?? ''
    await call('POST', `/v1/positions/${positionId}/matters`, {
      title: '整理 r/INMO 版规',
      role_id: 'social.reddit',
    })
    await call('POST', '/v1/todos', { title: '回复新成员' }, social)
    await call(
      'POST',
      '/v1/schedules',
      { title: '每周问答帖', trigger: { kind: 'interval', every_ms: 7_200_000 } },
      social,
    )
    const split = await dataOf<{ positions: { id: string; name: string }[] }>(
      await call('POST', `/v1/org/positions/${positionId}/split`, {
        name: '自家版',
        role_ids: ['social.reddit'],
      }),
    )
    const created = split.positions.find((p) => p.name === '自家版')?.id ?? ''
    expect(created).not.toBe('')
    const moved = await workOf(created)
    const titles = moved.items.map((i) => i.title)
    expect(titles).toEqual(expect.arrayContaining(['整理 r/INMO 版规', '回复新成员', '每周问答帖']))
    const left = (await workOf(positionId)).items.map((i) => i.title)
    expect(left).not.toContain('整理 r/INMO 版规')
    expect(left).not.toContain('回复新成员')
    expect(left).not.toContain('每周问答帖')
  })
})
