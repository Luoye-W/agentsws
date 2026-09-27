/**
 * WP158：`GET / PUT /v1/seo/google-sources` 端到端（起真进程 → 打 HTTP）。
 *
 * 这一面只收发：选哪个站点 / 媒体资源的判断与读数都在 `google-reads.ts`（另有单测）。
 * 这里钉三件：装配通了、没连就说没连（不报错）、别的职责进不来。
 */
import type { Assignment } from '@agentsws/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'

const SECRETS_KEY = 'e'.repeat(64)

let server: Server
let url: string
let content: Assignment
let support: Assignment

const api = (path: string, init: RequestInit & { assignment?: string } = {}) => {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${server.bootstrap.internalToken}`)
  headers.set('X-Assignment', init.assignment ?? content.id)
  if (init.body !== undefined) headers.set('content-type', 'application/json')
  return fetch(`${url}${path}`, { ...init, headers })
}

beforeEach(async () => {
  server = await createServer({
    quiet: true,
    clock: { now: () => '2026-09-27T05:00:00.000Z' },
    scheduleIntervalMs: 0,
    startRun: false,
    env: { AGENTSWS_OWNER_EMAIL: 'luoye@example.com', AGENTSWS_SECRETS_KEY: SECRETS_KEY },
  })
  ;({ url } = await server.listen(0))
  const base = {
    person_id: server.bootstrap.person.id,
    workspace_id: server.bootstrap.workspace.id,
    granted_by: server.bootstrap.person.id,
    ranges: [{ kind: 'store' as const, id: 'store_1' }],
  }
  content = server.roles.assignments.create({ ...base, role_id: 'dtc.content' })
  support = server.roles.assignments.create({ ...base, role_id: 'dtc.support' })
})

afterEach(async () => {
  await server.close()
})

describe('WP158 /v1/seo/google-sources', () => {
  it('两家都没连：照实说没连，不出「选一下」', async () => {
    const res = await api('/v1/seo/google-sources')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: Record<string, unknown> }
    expect(body.data).toEqual({
      gsc: { connected: false, options: [], needs_pick: false },
      ga4: { connected: false, options: [], needs_pick: false },
    })
  })

  it('没连时选了也不报错（什么都不变）；乱填的字段挡在 400', async () => {
    const put = await api('/v1/seo/google-sources', {
      method: 'PUT',
      body: JSON.stringify({ gsc_site: 'sc-domain:example.com' }),
    })
    expect(put.status).toBe(200)
    const bad = await api('/v1/seo/google-sources', {
      method: 'PUT',
      body: JSON.stringify({ gsc_site: '' }),
    })
    expect(bad.status).toBe(400)
  })

  it('客服那条职责进不来（没有 content 域）', async () => {
    const res = await api('/v1/seo/google-sources', { assignment: support.id })
    expect(res.status).toBe(403)
  })
})
