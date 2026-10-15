/**
 * WP335：`GET /v1/seo/watch/answers/:id`（「一条回答」）在网关这一层的形状：
 * 没装配 = 501、转给端口带上 id、没有这条 = 404。业务在 `geo-monitor.ts`（服务进程有自己的测试）。
 */
import type { GeoAnswerDetail } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import type { SeoPort } from '../src/index.js'
import { createGateway } from '../src/index.js'
import { harness } from './helpers.js'

async function wired(withAnswer = true) {
  const h = await harness()
  const asked: string[] = []
  const no = () => {
    throw new Error('不该调')
  }
  const port: SeoPort = {
    geoQuestions: no,
    setGeoQuestions: no,
    run: no,
    ...(withAnswer
      ? {
          watchAnswer: (_a, id) => {
            asked.push(id)
            return id === 'a_1'
              ? ({ week: '2026-10-05', history: [] } as never as GeoAnswerDetail)
              : undefined
          },
        }
      : {}),
  }
  const gateway = createGateway({
    ...h.deps,
    seo: port,
    roles: { ...h.deps.roles, can: () => true },
  })
  const get = (path: string) =>
    gateway.fetch(
      new Request(`http://127.0.0.1${path}`, {
        headers: { Authorization: `Bearer ${h.token}`, 'X-Assignment': h.assignment.id },
      }),
    )
  return { get, asked }
}

describe('WP335 /v1/seo/watch/answers/:id', () => {
  it('转给端口、带上 id；没有这条 → 404', async () => {
    const { get, asked } = await wired()
    const ok = await get('/v1/seo/watch/answers/a_1')
    expect(ok.status).toBe(200)
    expect(JSON.stringify(await ok.json())).toContain('2026-10-05')
    expect((await get('/v1/seo/watch/answers/missing')).status).toBe(404)
    expect(asked).toEqual(['a_1', 'missing'])
  })
  it('没装配 → 501', async () => {
    const { get } = await wired(false)
    expect((await get('/v1/seo/watch/answers/a_1')).status).toBe(501)
  })
})
