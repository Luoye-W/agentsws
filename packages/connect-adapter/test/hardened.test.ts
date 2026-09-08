import { describe, expect, it } from 'vitest'
import type { FetchLike } from '../src/index.js'
import { assertRuntimeHardened, createReplayFetch } from '../src/index.js'
import { loadCassette } from './replay-harness.js'

function stub(routes: Record<string, { status: number; body?: unknown }>): FetchLike {
  return async (url) => {
    const path = new URL(url).pathname
    const hit = routes[path]
    if (hit === undefined) return new Response('{}', { status: 404 })
    return new Response(JSON.stringify(hit.body ?? {}), {
      status: hit.status,
      headers: { 'content-type': 'application/json' },
    })
  }
}

const BASE = 'http://127.0.0.1:3000'

describe('assertRuntimeHardened（31 §3.5 安装器策略）', () => {
  it('鉴权全开 + 加密密钥在 + proxy 封死 → ok（用真 runtime 录下来的探针回放）', async () => {
    const report = await assertRuntimeHardened(BASE, {
      fetchImpl: createReplayFetch(loadCassette()),
      adminTokenEnv: 'OC_ADMIN',
      env: {
        OC_ADMIN: 'admin_fixture_1',
        OOMOL_CONNECT_ENCRYPTION_KEY: 'k',
        OOMOL_CONNECT_BLOCKED_PROXIES: '*',
      },
    })
    expect(report.reasons).toEqual([])
    expect(report.ok).toBe(true)
    expect(report.checks.map((c) => c.name)).toEqual([
      'health',
      'runtime_auth',
      'admin_auth',
      'encryption',
      'admin_token_env',
      'proxies_blocked',
    ])
  })

  it('鉴权没开（admin 与 /v1 都能匿名访问）→ 拒绝启动', async () => {
    const report = await assertRuntimeHardened(BASE, {
      fetchImpl: stub({
        '/v1/health': {
          status: 200,
          body: { success: true, data: { ok: true, runtime: 'oomol-connect' } },
        },
        '/api/connections': { status: 200, body: [] },
      }),
      adminTokenEnv: 'OC_ADMIN',
      env: { OOMOL_CONNECT_BLOCKED_PROXIES: '*' },
    })
    expect(report.ok).toBe(false)
    expect(report.reasons).toContain('runtime_auth_disabled')
    expect(report.reasons).toContain('admin_auth_disabled')
    expect(report.reasons).toContain('admin_token_env_missing')
    // health 读得到、加密字段没有 → 退回环境变量，也没有
    expect(report.reasons).toContain('encryption_disabled')
  })

  it('health 自报加密开着时采信 health，不再要求环境变量', async () => {
    const report = await assertRuntimeHardened(BASE, {
      fetchImpl: stub({
        '/v1/health': {
          status: 200,
          body: { success: true, data: { ok: true, runtime: 'oomol-connect', encryption: true } },
        },
        '/api/connections': { status: 401 },
      }),
      adminTokenEnv: 'OC_ADMIN',
      env: { OC_ADMIN: 'x', OOMOL_CONNECT_BLOCKED_PROXIES: '*' },
    })
    expect(report.reasons).toEqual(['runtime_auth_disabled'])
    expect(report.checks.find((c) => c.name === 'encryption')?.ok).toBe(true)
  })

  it('runtime 不可达 → 只报 runtime_unreachable 并短路', async () => {
    const report = await assertRuntimeHardened(BASE, {
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED')
      },
      env: {},
    })
    expect(report.ok).toBe(false)
    expect(report.reasons).toEqual(['runtime_unreachable'])
    expect(report.checks).toHaveLength(1)
  })

  it('proxy 没封死单独成一条理由', async () => {
    const report = await assertRuntimeHardened(BASE, {
      fetchImpl: stub({ '/v1/health': { status: 401 }, '/api/connections': { status: 401 } }),
      adminTokenEnv: 'OC_ADMIN',
      env: { OC_ADMIN: 'x', OOMOL_CONNECT_ENCRYPTION_KEY: 'k' },
    })
    expect(report.reasons).toEqual(['proxies_not_blocked'])
    expect(report.checks.find((c) => c.name === 'health')?.ok).toBe(true)
  })
})
