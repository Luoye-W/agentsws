/**
 * WP380：官方事实表、对外说法一致性、登记复查在网关这一层的形状——转给端口、校验入参、没装配 501、
 * 没人持有内容职责 409。业务在 `geo-quality-service.ts`（服务进程有自己的测试）。
 */
import type { GeoOfficialFact } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import type { SeoPort } from '../src/index.js'
import { createGateway } from '../src/index.js'
import { harness } from './helpers.js'

async function wired(full = true) {
  const h = await harness()
  const calls: unknown[] = []
  const no = () => {
    throw new Error('不该调')
  }
  const facts: GeoOfficialFact[] = [
    { key: 'name', value: 'NordVolt', as_of: '2026-10-01', source: 'profile' },
  ]
  const port: SeoPort = {
    geoQuestions: no,
    setGeoQuestions: no,
    run: no,
    ...(full
      ? {
          watchFacts: () => facts,
          watchSetFacts: (_a, input) => {
            calls.push(input)
            return facts
          },
          watchConsistency: (_a, input) => {
            calls.push(input)
            return input.urls?.[0] === 'https://nobody.example/'
              ? undefined
              : { id: 'gcs_1', at: '2026-10-12T00:00:00Z', pages: [], findings: [] }
          },
          watchRecheck: (_a, input) => {
            calls.push(input)
            return {
              id: 'grc_1',
              created_at: '2026-10-12T00:00:00Z',
              source: 'human',
              ...input,
              due: '2026-10-26',
              before: { n: 0 },
              status: 'waiting',
            }
          },
        }
      : {}),
  }
  const gateway = createGateway({
    ...h.deps,
    seo: port,
    roles: { ...h.deps.roles, can: () => true },
  })
  const call = (method: string, path: string, body?: unknown) =>
    gateway.fetch(
      new Request(`http://127.0.0.1${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${h.token}`,
          'X-Assignment': h.assignment.id,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  return { call, calls }
}

describe('WP380 /v1/seo/watch/{facts,consistency,rechecks}', () => {
  it('官方事实：读、改（只认五格）', async () => {
    const { call, calls } = await wired()
    const got = await call('GET', '/v1/seo/watch/facts')
    expect(got.status).toBe(200)
    expect(JSON.stringify(await got.json())).toContain('NordVolt')
    const put = await call('PUT', '/v1/seo/watch/facts', {
      facts: [{ key: 'price', value: '$45–$69' }],
    })
    expect(put.status).toBe(200)
    expect(calls).toEqual([{ facts: [{ key: 'price', value: '$45–$69' }] }])
    expect(
      (await call('PUT', '/v1/seo/watch/facts', { facts: [{ key: 'color', value: 'red' }] }))
        .status,
    ).toBe(400)
  })

  it('一致性：转给端口；没人持有内容职责 → 409；网址要像网址', async () => {
    const { call } = await wired()
    expect((await call('POST', '/v1/seo/watch/consistency', {})).status).toBe(200)
    expect(
      (await call('POST', '/v1/seo/watch/consistency', { urls: ['https://nobody.example/'] }))
        .status,
    ).toBe(409)
    expect((await call('POST', '/v1/seo/watch/consistency', { urls: ['不是网址'] })).status).toBe(
      400,
    )
  })

  it('登记复查：看哪个数只认四种；转给端口', async () => {
    const { call, calls } = await wired()
    const ok = await call('POST', '/v1/seo/watch/rechecks', {
      change: '改了标题',
      metric: 'win_rate',
      prompt_ids: ['gp_1'],
      due_days: 14,
    })
    expect(ok.status).toBe(200)
    expect(calls[0]).toMatchObject({ metric: 'win_rate', prompt_ids: ['gp_1'] })
    expect(
      (
        await call('POST', '/v1/seo/watch/rechecks', {
          change: 'x',
          metric: 'clicks',
          prompt_ids: ['gp_1'],
        })
      ).status,
    ).toBe(400)
  })

  it('没装配 → 501', async () => {
    const { call } = await wired(false)
    expect((await call('GET', '/v1/seo/watch/facts')).status).toBe(501)
    expect((await call('POST', '/v1/seo/watch/consistency', {})).status).toBe(501)
  })
})
