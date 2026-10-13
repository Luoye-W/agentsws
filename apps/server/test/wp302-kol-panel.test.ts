/**
 * WP302（决策 406）：合作清单每一行带紧急程度、停了几天、分段进度；红人行带分项分与那条合作的进度。
 * 阶段一变，存储那一层就盖 `stage_changed_at` 戳。
 */
import type { Assignment } from '@agentsws/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'

const T0 = '2026-10-13T09:00:00.000Z'
let t = Date.parse(T0)
let server: Server
let url: string
let youtube: Assignment

const api = (path: string, init: RequestInit = {}): Promise<Response> => {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${server.bootstrap.internalToken}`)
  headers.set('X-Assignment', youtube.id)
  if (init.body !== undefined) headers.set('content-type', 'application/json')
  return fetch(`${url}${path}`, { ...init, headers })
}
const data = async <T>(res: Response): Promise<T> => ((await res.json()) as { data: T }).data
const kol = async () => (await server.brands.forWorkspace(server.bootstrap.workspace.id)).kol

beforeEach(async () => {
  t = Date.parse(T0)
  server = await createServer({
    quiet: true,
    clock: { now: () => new Date(t).toISOString() },
    scheduleIntervalMs: 0,
    startRun: false,
    env: { AGENTSWS_OWNER_EMAIL: 'luoye@example.com', AGENTSWS_SECRETS_KEY: 'a'.repeat(64) },
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

describe('WP302 合作清单的紧急程度与分段进度', () => {
  it('阶段一变就盖戳；停满 7 天标卡住；行上带五档色那一句与分段', async () => {
    const store = await kol()
    store.saveCreator({ id: 'cre_1', display_name: 'Gadget Jonas', merged_from: [] })
    store.saveCollaboration({
      id: 'col_1',
      creator_id: 'cre_1',
      channel: 'youtube',
      stage: 'agreed',
      currency: 'USD',
    })
    expect(store.collaboration('col_1')?.stage_changed_at).toBe(T0)
    // 同一阶段再存一次不重盖
    t += 3 * 86_400_000
    store.saveCollaboration({ ...(store.collaboration('col_1') as never), budget: 400 })
    expect(store.collaboration('col_1')?.stage_changed_at).toBe(T0)

    t += 5 * 86_400_000
    const rows = (
      await data<{
        rows: {
          id: string
          status: { tier: string; label: string }
          dwell_days: number
          stalled: boolean
          segments: { stage: string; state: string; stalled: boolean }[]
        }[]
      }>(await api('/v1/kol/collaborations?channel=youtube'))
    ).rows
    const row = rows.find((r) => r.id === 'col_1')
    expect(row?.status).toEqual({ tier: 'active', label: '已签定' })
    expect(row?.dwell_days).toBe(8)
    expect(row?.stalled).toBe(true)
    expect(row?.segments.find((s) => s.state === 'current')).toEqual({
      stage: 'agreed',
      state: 'current',
      stalled: true,
    })
  })

  it('红人行带分项分与这个人那条合作的进度（卡上的迷你进度条）', async () => {
    const store = await kol()
    store.saveCreator({ id: 'cre_1', display_name: 'Gadget Jonas', merged_from: [] })
    store.saveAccount({
      id: 'pa_1',
      creator_id: 'cre_1',
      channel: 'youtube',
      handle: 'gadgetjonas',
      url: 'https://www.youtube.com/@gadgetjonas',
      followers: 48_000,
      engagement_rate: 0.06,
      observed_at: T0,
    })
    store.saveCollaboration({
      id: 'col_1',
      creator_id: 'cre_1',
      channel: 'youtube',
      stage: 'contacted',
      currency: 'USD',
    })
    const [row] = (
      await data<{
        rows: {
          factors: { id: string; score: number }[]
          collab: { stage: string; segments: unknown[]; stalled: boolean }
        }[]
      }>(await api('/v1/kol/creators?channel=youtube'))
    ).rows
    expect(row?.factors.map((f) => f.id)).toEqual([
      'followers',
      'engagement',
      'category',
      'locale',
      'activity',
    ])
    expect(row?.collab.stage).toBe('contacted')
    expect(row?.collab.segments.length).toBeGreaterThan(5)
    expect(row?.collab.stalled).toBe(false)
  })
})
