/** WP337：`/v1/update/*` 在网关这一层——没装配 501、装配了原样转给端口、要凭据与岗位分配。 */
import { describe, expect, it } from 'vitest'
import { createGateway, type UpdatePausePort } from '../src/index.js'
import { harness } from './helpers.js'

const VIEW = {
  idle: false,
  paused: false,
  counts: { output: 1, background: 0, scheduled: 2 },
  items: [{ kind: 'output' as const, title: '回复 Anna' }],
}

async function wired(port?: UpdatePausePort) {
  const h = await harness()
  const gateway = createGateway(port === undefined ? h.deps : { ...h.deps, updatePause: port })
  const auth = { Authorization: `Bearer ${h.token}`, 'X-Assignment': h.assignment.id }
  const call = (method: string, path: string, headers: Record<string, string>, body?: unknown) =>
    gateway.fetch(
      new Request(`http://127.0.0.1${path}`, {
        method,
        headers: {
          ...headers,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  return { call, auth }
}

describe('WP337 更新前暂停的路由', () => {
  it('没装配 → 501（壳当「不知道」）', async () => {
    const { call, auth } = await wired()
    expect((await call('GET', '/v1/update/readiness', auth)).status).toBe(501)
  })

  it('装配了：看一眼 / 暂停（带版本号）/ 放开 都转给端口', async () => {
    const asked: unknown[] = []
    const { call, auth } = await wired({
      readiness: () => VIEW,
      pause: async (input) => {
        asked.push(input)
        return { paused: VIEW.counts }
      },
      resume: async () => ({ at: 'now', runs: 1, failed: 0, reran: 0, caught_up: 0 }),
    })
    const r = await call('GET', '/v1/update/readiness', auth)
    expect(((await r.json()) as { data: unknown }).data).toEqual(VIEW)
    const p = await call('POST', '/v1/update/pause', auth, { to: '0.2.2' })
    expect(p.status).toBe(200)
    expect(asked).toEqual([{ to: '0.2.2' }])
    const back = await call('POST', '/v1/update/resume', auth)
    expect(((await back.json()) as { data: { runs: number } }).data.runs).toBe(1)
  })

  it('没凭据 401', async () => {
    const { call } = await wired({
      readiness: () => VIEW,
      pause: async () => ({ paused: VIEW.counts }),
      resume: async () => ({ at: 'now', runs: 0, failed: 0, reran: 0, caught_up: 0 }),
    })
    expect((await call('GET', '/v1/update/readiness', {})).status).toBe(401)
  })
})
