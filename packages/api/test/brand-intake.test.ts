/**
 * 网关这一层的品牌接入面（WP121，70 §3）：路由形状、权限元组、信封，
 * 以及两条只有在这一层才看得出来的事：
 *
 * 1. **发起与重新分析是 `outbound`**，看进度与看结果不是。急停开关
 *    （`AGENTSWS_HALT=outbound`）该挡住前者、放过后者——急停期间用户照样
 *    读得到上一次的结果。
 * 2. **`/runs/latest` 不会被 `/runs/:id` 抢走**（定值段在前）。
 *
 * 真的抓取与解析在 `@agentsws/brand-intake`（那边有 27 条夹具用例），
 * 跑与存在 `apps/server`；这里只用一个记账用的假端口。
 */
import type { BrandIntakeRun } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import type { BrandIntakeActor, BrandIntakePort } from '../src/index.js'
import { createGateway } from '../src/index.js'
import { harness } from './helpers.js'

const T0 = '2026-09-19T09:00:00.000Z'

const RUN: BrandIntakeRun = {
  id: 'bi_0001',
  schema_version: 1,
  workspace_id: 'ws_test',
  status: 'awaiting_confirm',
  inputs: [{ url: 'https://nordvik.example/', kind: 'website' }],
  pages: [{ url: 'https://nordvik.example/', kind: 'home', ok: true }],
  budget: { estimated_credits: 1.8, cap_credits: 2, spent_credits: 1.05 },
  profile: {
    brand_name: {
      value: 'Nordvik Supply',
      confidence: 'high',
      evidence: [{ url: 'https://nordvik.example/', locator: 'jsonld:Organization.name' }],
    },
  },
  created_at: T0,
  updated_at: T0,
}

/** 记下每次调用与看到的入参。 */
class FakePort implements BrandIntakePort {
  readonly calls: { method: string; input: unknown }[] = []

  start(_a: BrandIntakeActor, input: { urls: string[]; cap_credits?: number }): BrandIntakeRun {
    this.calls.push({ method: 'start', input })
    return { ...RUN, status: 'queued' }
  }

  get(_a: BrandIntakeActor, run_id: string): BrandIntakeRun {
    this.calls.push({ method: 'get', input: run_id })
    return RUN
  }

  latest(): BrandIntakeRun | undefined {
    this.calls.push({ method: 'latest', input: undefined })
    return RUN
  }

  confirm(
    _a: BrandIntakeActor,
    input: { run_id: string; edits?: Record<string, unknown> },
  ): BrandIntakeRun {
    this.calls.push({ method: 'confirm', input })
    return { ...RUN, status: 'confirmed' }
  }

  reanalyze(_a: BrandIntakeActor, input: { run_id: string; urls?: string[] }): BrandIntakeRun {
    this.calls.push({ method: 'reanalyze', input })
    return { ...RUN, status: 'running' }
  }
}

async function wired(options: { withPort?: boolean } = {}): Promise<{
  h: Awaited<ReturnType<typeof harness>>
  port: FakePort
  call: (method: string, path: string, body?: unknown) => Promise<Response>
}> {
  const h = await harness()
  const port = new FakePort()
  const gateway = createGateway({
    ...h.deps,
    ...(options.withPort === false ? {} : { brandIntake: port }),
  })
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
  return { h, port, call }
}

const data = async <T>(res: Response): Promise<T> => ((await res.json()) as { data: T }).data

describe('WP121 网关：品牌接入面', () => {
  it('五条路由都在 /v1/brand-intake 之下，都要 Bearer + X-Assignment + 权限元组', async () => {
    const { h } = await wired()
    const specs = h.gateway.specs.filter((s) => s.path.startsWith('/v1/brand-intake'))
    expect(specs.map((s) => `${s.method.toUpperCase()} ${s.path}`).sort()).toEqual([
      'GET /v1/brand-intake/runs/:id',
      'GET /v1/brand-intake/runs/latest',
      'POST /v1/brand-intake/runs',
      'POST /v1/brand-intake/runs/:id/confirm',
      'POST /v1/brand-intake/runs/:id/reanalyze',
    ])
    for (const s of specs) {
      expect(s.auth).toBe('bearer')
      expect(s.assignment).toBe(true)
      expect(s.authz).toBeDefined()
    }
  })

  it('只有真会去敲别人服务器的那两条标了 outbound', async () => {
    const { h } = await wired()
    const outbound = h.gateway.specs
      .filter((s) => s.path.startsWith('/v1/brand-intake') && s.outbound === true)
      .map((s) => s.path)
      .sort()
    // 看进度与看结果不该被急停挡住——那时候用户读的是上一次的结果
    expect(outbound).toEqual(['/v1/brand-intake/runs', '/v1/brand-intake/runs/:id/reanalyze'])
  })

  it('定值段 latest 不会被 :id 抢走', async () => {
    const { call, port } = await wired()
    expect((await call('GET', '/v1/brand-intake/runs/latest')).status).toBe(200)
    expect(port.calls.at(-1)?.method).toBe('latest')
    expect((await call('GET', '/v1/brand-intake/runs/bi_0001')).status).toBe(200)
    expect(port.calls.at(-1)).toEqual({ method: 'get', input: 'bi_0001' })
  })

  it('发起：201 + 入参原样往下传一次', async () => {
    const { call, port } = await wired()
    const res = await call('POST', '/v1/brand-intake/runs', {
      urls: ['https://nordvik.example/'],
      cap_credits: 2,
    })
    expect(res.status).toBe(201)
    expect(await data<BrandIntakeRun>(res)).toMatchObject({ status: 'queued' })
    expect(port.calls.at(-1)).toEqual({
      method: 'start',
      input: { urls: ['https://nordvik.example/'], cap_credits: 2 },
    })
  })

  it('发起：不是网址 / 一条都没有 / 超过三条，都在网关这一层挡下来', async () => {
    const { call, port } = await wired()
    const before = port.calls.length
    for (const body of [
      { urls: ['随便打的几个字'] },
      { urls: [] },
      { urls: Array.from({ length: 4 }, (_, i) => `https://a${String(i)}.example/`) },
    ])
      expect((await call('POST', '/v1/brand-intake/runs', body)).status).toBe(400)
    // 一次都没往下传
    expect(port.calls.length).toBe(before)
  })

  it('确认：只带改过的那几格，网关不碰它们的内容', async () => {
    const { call, port } = await wired()
    const res = await call('POST', '/v1/brand-intake/runs/bi_0001/confirm', {
      edits: { brand_name: 'Nordvik Supply', support_email: null },
    })
    expect(res.status).toBe(200)
    expect(await data<BrandIntakeRun>(res)).toMatchObject({ status: 'confirmed' })
    expect(port.calls.at(-1)).toEqual({
      method: 'confirm',
      input: {
        run_id: 'bi_0001',
        // `null` 也原样传下去：那是"这一格我不要"，与"没带这一格"是两件事
        edits: { brand_name: 'Nordvik Supply', support_email: null },
      },
    })
  })

  it('确认：不带 edits 就是"按分析结果走"', async () => {
    const { call, port } = await wired()
    expect((await call('POST', '/v1/brand-intake/runs/bi_0001/confirm', {})).status).toBe(200)
    expect(port.calls.at(-1)).toEqual({ method: 'confirm', input: { run_id: 'bi_0001' } })
  })

  it('重新分析是独立一条，不是 start 的一个参数', async () => {
    const { call, port } = await wired()
    const res = await call('POST', '/v1/brand-intake/runs/bi_0001/reanalyze', {
      urls: ['https://nordvik.example/'],
    })
    expect(res.status).toBe(201)
    expect(port.calls.at(-1)).toEqual({
      method: 'reanalyze',
      input: { run_id: 'bi_0001', urls: ['https://nordvik.example/'] },
    })
  })

  it('没装配这一面：回 not_implemented，说清楚缺的是哪个口', async () => {
    const { call } = await wired({ withPort: false })
    const res = await call('GET', '/v1/brand-intake/runs/latest')
    expect(res.status).toBe(501)
    const body = (await res.json()) as { code: string; message: string }
    expect(body.code).toBe('not_implemented')
    expect(body.message).toContain('brandIntake')
  })
})
