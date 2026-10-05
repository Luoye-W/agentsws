/** WP225：`GET /v1/activity` 在网关这一层——没装配 501、装配了原样转给端口、要凭据与岗位分配。 */
import { describe, expect, it } from 'vitest'
import { type ActivityPort, createGateway } from '../src/index.js'
import { harness } from './helpers.js'

async function wired(port?: ActivityPort) {
  const h = await harness()
  const gateway = createGateway(port === undefined ? h.deps : { ...h.deps, activity: port })
  const get = (headers: Record<string, string> = {}) =>
    gateway.fetch(new Request('http://127.0.0.1/v1/activity', { headers }))
  const auth = { Authorization: `Bearer ${h.token}`, 'X-Assignment': h.assignment.id }
  return { get, auth }
}

describe('WP225 正在干活信号的路由', () => {
  it('没装配 → 501（壳当「不知道」）', async () => {
    const { get, auth } = await wired()
    expect((await get(auth)).status).toBe(501)
  })

  it('装配了：转给端口，回数量', async () => {
    const { get, auth } = await wired({ snapshot: () => ({ busy: true, runs: 2 }) })
    const res = await get(auth)
    expect(res.status).toBe(200)
    expect(((await res.json()) as { data: unknown }).data).toEqual({ busy: true, runs: 2 })
  })

  it('没凭据 401', async () => {
    const { get } = await wired({ snapshot: () => ({ busy: false, runs: 0 }) })
    expect((await get()).status).toBe(401)
  })
})
