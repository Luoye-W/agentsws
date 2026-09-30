/**
 * WP207 归档与找回路由：路径、信封、参数校验、只读的找回、一次一件的恢复、没装配时 501。
 */
import type { ArchivedWorkCandidate, FindArchivedWorkInput, Matter } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import type {
  ArchivedListFilter,
  ArchivedMatterView,
  GatewayDeps,
  WorkActor,
  WorkArchivePort,
  WorkRailView,
} from '../src/index.js'
import { createGateway } from '../src/index.js'
import { harness, T0 } from './helpers.js'

const matter: Matter = {
  id: 'mat_1',
  schema_version: 1,
  workspace_id: 'ws_test',
  kind: 'adhoc',
  title: '美国红人样品',
  status: 'open',
  context: { summary: '', pinned: [], participants: [], last_activity: T0 },
  created_at: T0,
  updated_at: T0,
}

class FakeArchive implements WorkArchivePort {
  calls: { method: string; args: unknown[] }[] = []
  idle: number | null = 3
  last(method: string): unknown[] | undefined {
    return this.calls.filter((c) => c.method === method).at(-1)?.args
  }
  rail(actor: WorkActor, options: { limit?: number }): WorkRailView {
    this.calls.push({ method: 'rail', args: [actor, options] })
    return {
      idle_days: this.idle,
      positions: [
        {
          position_id: 'web-ops',
          awaiting: 1,
          duties: [
            {
              role_id: 'dtc.ops',
              matters: [
                { id: 'mat_1', title: 'x', state: 'awaiting', last_activity: T0, cards: 1 },
              ],
              more: 0,
              archived: 2,
            },
          ],
        },
      ],
    }
  }
  archived(actor: WorkActor, filter: ArchivedListFilter): ArchivedMatterView[] {
    this.calls.push({ method: 'archived', args: [actor, filter] })
    return [{ id: 'mat_1', title: 'x', summary: '', status: 'open', last_activity: T0 }]
  }
  search(actor: WorkActor, input: { q: string; limit?: number }): ArchivedMatterView[] {
    this.calls.push({ method: 'search', args: [actor, input] })
    return []
  }
  find(actor: WorkActor, input: FindArchivedWorkInput) {
    this.calls.push({ method: 'find', args: [actor, input] })
    const c: ArchivedWorkCandidate = {
      matter_id: 'mat_1',
      title: '美国红人样品',
      summary: '',
      archived_at: T0,
      last_activity: T0,
      score: 0.8,
      why: ['title:红人'],
    }
    return { candidates: [c], semantic: false }
  }
  unarchive(actor: WorkActor, id: string, by: 'user' | 'ai_suggested') {
    this.calls.push({ method: 'unarchive', args: [actor, id, by] })
    return { matter }
  }
  settings() {
    return { idle_days: this.idle }
  }
  setSettings(_actor: WorkActor, input: { idle_days: number | null }) {
    this.idle = input.idle_days
    return { idle_days: this.idle }
  }
}

async function setup(withPort = true) {
  const h = await harness()
  const port = new FakeArchive()
  const deps: GatewayDeps = withPort ? { ...h.deps, workArchive: port } : h.deps
  const gateway = createGateway(deps)
  const call = (method: string, path: string, body?: unknown): Promise<Response> => {
    const headers = new Headers({
      Authorization: `Bearer ${h.token}`,
      'X-Assignment': h.assignment.id,
    })
    if (body !== undefined) headers.set('content-type', 'application/json')
    return Promise.resolve(
      gateway.fetch(
        new Request(`http://127.0.0.1${path}`, {
          method,
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      ),
    )
  }
  return { port, call, gateway }
}

const data = async (res: Response): Promise<Record<string, unknown>> =>
  ((await res.json()) as { data: Record<string, unknown> }).data

describe('WP207 归档与找回路由', () => {
  it('没装配时 501；装了之后左栏一份、带 limit', async () => {
    const bare = await setup(false)
    expect((await bare.call('GET', '/v1/work/rail')).status).toBe(501)
    const t = await setup()
    const res = await t.call('GET', '/v1/work/rail?limit=3')
    expect(res.status).toBe(200)
    expect((await data(res)).positions).toHaveLength(1)
    expect(t.port.last('rail')?.[1]).toEqual({ limit: 3 })
    expect((await t.call('GET', '/v1/work/rail?limit=0')).status).toBe(400)
  })

  it('已归档列表：筛选参数原样往下递，时间要是 ISO', async () => {
    const t = await setup()
    const res = await t.call(
      'GET',
      '/v1/work/archived?q=红人&position_id=kol&role_id=kol.youtube&from=2026-09-01T00:00:00Z',
    )
    expect(res.status).toBe(200)
    expect(t.port.last('archived')?.[1]).toEqual({
      q: '红人',
      position_id: 'kol',
      role_id: 'kol.youtube',
      from: '2026-09-01T00:00:00Z',
    })
    expect((await t.call('GET', '/v1/work/archived?from=上周')).status).toBe(400)
  })

  it('搜索要 q', async () => {
    const t = await setup()
    expect((await t.call('GET', '/v1/work/search')).status).toBe(400)
    expect((await t.call('GET', '/v1/work/search?q=样品')).status).toBe(200)
  })

  it('找回只读：给候选，不恢复', async () => {
    const t = await setup()
    const res = await t.call('POST', '/v1/work/archived/find', {
      query: '上周那个美国红人谈样品的',
      limit: 5,
    })
    expect(res.status).toBe(200)
    expect(((await data(res)).candidates as unknown[]).length).toBe(1)
    expect(t.port.calls.some((c) => c.method === 'unarchive')).toBe(false)
    expect((await t.call('POST', '/v1/work/archived/find', { query: '' })).status).toBe(400)
    expect((await t.call('POST', '/v1/work/archived/find', { query: 'x', limit: 20 })).status).toBe(
      400,
    )
  })

  it('恢复一次一件，默认 by=user；by 只收 user / ai_suggested', async () => {
    const t = await setup()
    expect((await t.call('POST', '/v1/matters/mat_1/unarchive', {})).status).toBe(200)
    expect(t.port.last('unarchive')?.slice(1)).toEqual(['mat_1', 'user'])
    await t.call('POST', '/v1/matters/mat_1/unarchive', { by: 'ai_suggested' })
    expect(t.port.last('unarchive')?.slice(1)).toEqual(['mat_1', 'ai_suggested'])
    expect((await t.call('POST', '/v1/matters/mat_1/unarchive', { by: 'activity' })).status).toBe(
      400,
    )
  })

  it('设置：1–30 天或 null', async () => {
    const t = await setup()
    expect(await data(await t.call('GET', '/v1/settings/work-archive'))).toEqual({ idle_days: 3 })
    expect(await data(await t.call('PUT', '/v1/settings/work-archive', { idle_days: 7 }))).toEqual({
      idle_days: 7,
    })
    expect(
      await data(await t.call('PUT', '/v1/settings/work-archive', { idle_days: null })),
    ).toEqual({ idle_days: null })
    expect((await t.call('PUT', '/v1/settings/work-archive', { idle_days: 0 })).status).toBe(400)
    expect((await t.call('PUT', '/v1/settings/work-archive', { idle_days: 31 })).status).toBe(400)
  })
})
