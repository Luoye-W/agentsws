/**
 * WP321：`/v1/seo/watch*` 在**网关这一层**的形状（业务在服务进程 `seo-service.ts` / `geo-monitor.ts`，
 * 那边有自己的测试）。只钉：没装配 = 501、入参校验、五条路由都转给端口、可选格不带 `undefined`。
 */
import type { GeoMetricsView, GeoWatchView } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import type { SeoPort } from '../src/index.js'
import { createGateway } from '../src/index.js'
import { harness } from './helpers.js'

async function wired(withWatch = true) {
  const h = await harness()
  const calls: string[] = []
  const rec = <T>(tag: string, value: T): T => {
    calls.push(tag)
    return value
  }
  const view = {} as GeoWatchView
  const port: SeoPort = {
    geoQuestions: () => {
      throw new Error('不该调')
    },
    setGeoQuestions: () => {
      throw new Error('不该调')
    },
    run: () => {
      throw new Error('不该调')
    },
    ...(withWatch
      ? {
          watchView: () => rec('view', view),
          watchApply: (_a, input) => rec(`apply:${JSON.stringify(input)}`, view),
          watchSuggest: (_a, input) =>
            rec(`suggest:${JSON.stringify(input)}`, {
              strategy: {} as never,
              estimate: {} as never,
            }),
          watchRun: (_a, input) =>
            rec(`run:${JSON.stringify(input)}`, {
              started: false,
              estimate: {} as never,
              runs: [],
              pending_tasks: 0,
              notes: [],
            }),
          watchMetrics: (_a, input) =>
            rec(`metrics:${JSON.stringify(input)}`, {} as GeoMetricsView),
        }
      : {}),
  }
  // 测试 harness 的岗位没有 content 域：这里放行，只看路由本身
  const gateway = createGateway({
    ...h.deps,
    seo: port,
    roles: { ...h.deps.roles, can: () => true },
  })
  const call = (method: string, path: string, body?: unknown) => {
    const headers = new Headers({
      Authorization: `Bearer ${h.token}`,
      'X-Assignment': h.assignment.id,
    })
    if (body !== undefined) headers.set('content-type', 'application/json')
    return gateway.fetch(
      new Request(`http://127.0.0.1${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  }
  return { call, calls }
}

describe('WP321 /v1/seo/watch*', () => {
  it('没装配 → 501', async () => {
    const { call } = await wired(false)
    expect((await call('GET', '/v1/seo/watch')).status).toBe(501)
    expect((await call('POST', '/v1/seo/watch/run', {})).status).toBe(501)
  })

  it('五条路由都转给端口；可选格没给就不带', async () => {
    const { call, calls } = await wired()
    expect((await call('GET', '/v1/seo/watch')).status).toBe(200)
    expect(
      (await call('PUT', '/v1/seo/watch', { prompt_limit: 10, platforms: ['chatgpt', 'claude'] }))
        .status,
    ).toBe(200)
    expect((await call('POST', '/v1/seo/watch/strategy', { card: true })).status).toBe(200)
    expect((await call('POST', '/v1/seo/watch/run', { confirm: true })).status).toBe(200)
    expect((await call('GET', '/v1/seo/watch/metrics?weeks=8')).status).toBe(200)
    expect((await call('GET', '/v1/seo/watch/metrics')).status).toBe(200)
    expect(calls).toEqual([
      'view',
      'apply:{"platforms":["chatgpt","claude"],"prompt_limit":10}',
      'suggest:{"card":true}',
      'run:{"confirm":true}',
      'metrics:{"weeks":8}',
      'metrics:{}',
    ])
  })

  it('入参校验：已选上限、认不出的 AI、周数', async () => {
    const { call, calls } = await wired()
    expect((await call('PUT', '/v1/seo/watch', { prompt_limit: 0 })).status).toBe(400)
    expect((await call('PUT', '/v1/seo/watch', { platforms: ['perplexity'] })).status).toBe(400)
    expect((await call('POST', '/v1/seo/watch/run', { kinds: [] })).status).toBe(400)
    expect((await call('GET', '/v1/seo/watch/metrics?weeks=99')).status).toBe(400)
    expect(calls).toEqual([])
  })
})
