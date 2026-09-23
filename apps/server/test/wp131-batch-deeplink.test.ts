/**
 * WP131 ⑤：「回作战室看这批」深链的整条路（起真进程 → 打 HTTP）。
 *
 * 插件配对 → 列表采集分两块发（第二块带回第一块拿到的批次 id）→ 工作台打
 * `GET /v1/kol/creators?batch=<id>` 只看到这一批的人；另一次采集、主页单条观测都不混进来。
 * 顺带钉住自动评分开关的两条路（默认关、插件令牌能开）。
 */
import type { Assignment } from '@agentsws/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'

const T0 = '2026-09-23T09:00:00.000Z'
const EXT_ORIGIN = 'chrome-extension://abcdefghijklmnop'

let server: Server
let url: string
let tiktok: Assignment

const owner = async (
  method: string,
  path: string,
  body?: unknown,
  assignment?: string,
): Promise<Response> => {
  const headers = new Headers({
    Authorization: `Bearer ${server.bootstrap.internalToken}`,
    'X-Assignment': assignment ?? tiktok.id,
  })
  if (body !== undefined) headers.set('content-type', 'application/json')
  return fetch(`${url}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

const plugin = async (
  method: string,
  path: string,
  init: { token?: string; body?: unknown } = {},
): Promise<Response> => {
  const headers = new Headers({ Origin: EXT_ORIGIN })
  if (init.token !== undefined) headers.set('Authorization', `Bearer ${init.token}`)
  if (init.body !== undefined) headers.set('content-type', 'application/json')
  return fetch(`${url}${path}`, {
    method,
    headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  })
}

const data = async <T>(res: Response): Promise<T> => ((await res.json()) as { data: T }).data

async function pairedToken(): Promise<string> {
  // 发码是策略层动作（policy.stage）：用所有者那条分配
  const made = await owner(
    'POST',
    '/v1/extension/pairings',
    {},
    server.bootstrap.ownerAssignment.id,
  )
  const { code } = await data<{ code: string }>(made)
  const res = await plugin('POST', '/v1/extension/pair', { body: { code } })
  return (await data<{ token: string }>(res)).token
}

const row = (handle: string, source = 'search_results') => ({
  channel: 'tiktok',
  handle,
  followers_text: '48.2K',
  observed_at: T0,
  source,
  ...(source === 'search_results' ? { source_page: 'search', source_query: 'meal prep' } : {}),
})

beforeEach(async () => {
  server = await createServer({
    quiet: true,
    clock: { now: () => T0 },
    random: (() => {
      let a = 131
      return () => {
        a = (a * 16807) % 2147483647
        return a / 2147483647
      }
    })(),
    scheduleIntervalMs: 0,
    startRun: false,
    env: { AGENTSWS_OWNER_EMAIL: 'luoye@example.com', AGENTSWS_SECRETS_KEY: 'c'.repeat(64) },
  })
  ;({ url } = await server.listen(0))
  tiktok = server.roles.assignments.create({
    person_id: server.bootstrap.person.id,
    workspace_id: server.bootstrap.workspace.id,
    role_id: 'kol.tiktok',
    granted_by: server.bootstrap.person.id,
    ranges: [{ kind: 'store', id: 'store_1' }],
  })
})

afterEach(async () => {
  await server.close()
})

describe('WP131 ⑤ 回作战室看这批：批次深链', () => {
  it('两块发的一批 → /v1/kol/creators?batch= 只列这一批；别的采集不混进来', async () => {
    const token = await pairedToken()
    const first = await plugin('POST', '/v1/extension/observations', {
      token,
      body: { observations: [row('alpha'), row('bravo')] },
    })
    expect(first.status).toBe(200)
    const { batch_id } = await data<{ batch_id: string }>(first)
    expect(batch_id).toMatch(/^bt_/)
    const second = await plugin('POST', '/v1/extension/observations', {
      token,
      body: { observations: [row('charlie')], batch_id },
    })
    expect((await data<{ batch_id: string }>(second)).batch_id).toBe(batch_id)

    // 另一次采集与主页单条观测
    await plugin('POST', '/v1/extension/observations', {
      token,
      body: { observations: [row('delta')] },
    })
    await plugin('POST', '/v1/extension/observations', {
      token,
      body: { observations: [row('echo', 'channel_page')] },
    })

    const listed = await owner('GET', `/v1/kol/creators?channel=tiktok&batch=${batch_id}`)
    expect(listed.status).toBe(200)
    const { rows } = await data<{ rows: { handle: string }[] }>(listed)
    expect(rows.map((r) => r.handle).sort()).toEqual(['alpha', 'bravo', 'charlie'])

    // 认不出的批次 = 空清单，不是报错
    const unknown = await owner('GET', '/v1/kol/creators?channel=tiktok&batch=bt_nosuchbatch')
    expect((await data<{ rows: unknown[] }>(unknown)).rows).toEqual([])

    // 不带批次照旧全列
    const all = await owner('GET', '/v1/kol/creators?channel=tiktok')
    expect((await data<{ rows: unknown[] }>(all)).rows).toHaveLength(5)
  })

  it('批次 id 只认服务端发的形状：插件自己编的整批拒', async () => {
    const token = await pairedToken()
    const res = await plugin('POST', '/v1/extension/observations', {
      token,
      body: { observations: [row('alpha')], batch_id: '../../etc' },
    })
    expect(res.status).toBe(400)
  })
})

describe('WP131 ④ 自动评分开关：两条路', () => {
  it('默认关；插件令牌能开能关；开着时回执带排队数', async () => {
    const token = await pairedToken()
    const initial = await plugin('GET', '/v1/extension/auto-score', { token })
    expect(initial.status).toBe(200)
    expect(await data<{ enabled: boolean }>(initial)).toMatchObject({
      enabled: false,
      cloud_linked: false,
      credits_per_creator: 0,
    })
    const on = await plugin('PUT', '/v1/extension/auto-score', { token, body: { enabled: true } })
    expect((await data<{ enabled: boolean }>(on)).enabled).toBe(true)

    const captured = await plugin('POST', '/v1/extension/observations', {
      token,
      body: { observations: [row('alpha')] },
    })
    expect((await data<{ auto_score?: { queued: number } }>(captured)).auto_score?.queued).toBe(1)

    const bad = await plugin('PUT', '/v1/extension/auto-score', {
      token,
      body: { enabled: 'yes' },
    })
    expect(bad.status).toBe(400)
  })
})
