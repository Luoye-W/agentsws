/**
 * WP254（决策 100 / 123）端到端（真装配线：路由 → 端口 → 每台机的下载源 → 一键安装）：
 * 国内网络（假 npm 只认国内源）下一键装 CLI 先因网络失败、卡上的任务记着「官方源」；
 * 「换国内源再试」= `PUT /v1/settings/npm-registry {npmmirror}` + 再装 → 装上；AI 运行改不了下载源。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'
import { writeFakeNpm } from './fixtures/fake-cli.js'

const servers: Server[] = []
const tmpDirs: string[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function ticking(): { now: () => string } {
  let t = Date.parse('2026-10-07T09:00:00.000Z')
  return {
    now: () => {
      t += 1000
      return new Date(t).toISOString()
    },
  }
}

type CliView = {
  state: string
  job?: { phase: string; registry?: string; error?: { code: string } }
}
type View = { kit: null | { cli?: CliView } }
type Registry = { source: string; env_override: boolean; urls: Record<string, string> }

describe('WP254 换国内源再试（真装配线）', () => {
  it('网络失败（官方源）→ 换国内源 → 再装就成；下载源记住；runtime 令牌 403', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wp254-srv-'))
    tmpDirs.push(root)
    const { npmCli } = writeFakeNpm(root, 'mirror_only')
    const server = await createServer({
      clock: ticking(),
      random: () => 0.5,
      quiet: true,
      mdns: () => ({ mdns: { publish() {}, browse() {}, stop() {} } }),
      startRun: false,
      tokenRefreshIntervalMs: 0,
      env: { AGENTSWS_OWNER_EMAIL: 'owner@example.test' },
      platformCliRunner: { toolsDir: join(root, 'tools'), npmCli: async () => npmCli },
    })
    servers.push(server)
    const call = async <T>(method: string, path: string, body?: unknown, token?: string) => {
      const headers = new Headers({
        Authorization: `Bearer ${token ?? server.bootstrap.internalToken}`,
        'X-Assignment': server.bootstrap.ownerAssignment.id,
      })
      if (body !== undefined) headers.set('content-type', 'application/json')
      const res = await server.gateway.fetch(
        new Request(`http://127.0.0.1${path}`, {
          method,
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      )
      return { status: res.status, body: (await res.json()) as { data?: T } }
    }
    const ok = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
      const r = await call<T>(method, path, body)
      if (r.status >= 300) throw new Error(`${method} ${path} → ${r.status}`)
      return r.body.data as T
    }
    await ok('PUT', '/v1/workspace/profile', {
      legal_name: '一家耳机店',
      storefront_platform: 'shopify',
    })
    await ok('POST', '/v1/onboarding/apply', { position_ids: ['site'] })
    const until = async (pred: (c: CliView) => boolean): Promise<CliView> => {
      for (let i = 0; i < 300; i += 1) {
        const c = (await ok<View>('GET', '/v1/platform-kit?position_id=site')).kit?.cli as CliView
        if (pred(c)) return c
        await new Promise((r) => setTimeout(r, 30))
      }
      throw new Error('没等到')
    }

    expect((await ok<Registry>('GET', '/v1/settings/npm-registry')).source).toBe('official')
    await ok('POST', '/v1/platform-kit/cli/run', { action: 'install' })
    const failed = await until((c) => c.job?.phase === 'failed')
    expect(failed.job).toMatchObject({ registry: 'official', error: { code: 'network' } })

    // 卡上「换国内源再试」
    const switched = await ok<Registry>('PUT', '/v1/settings/npm-registry', { source: 'npmmirror' })
    expect(switched).toMatchObject({
      source: 'npmmirror',
      urls: { npmmirror: 'https://registry.npmmirror.com' },
    })
    await ok('POST', '/v1/platform-kit/cli/run', { action: 'install' })
    const done = await until((c) => c.state === 'needs_login')
    expect(done.job).toMatchObject({ phase: 'done', registry: 'npmmirror' })
    expect((await ok<Registry>('GET', '/v1/settings/npm-registry')).source).toBe('npmmirror')

    // 只认两个值；AI 运行改不了
    expect(
      (await call('PUT', '/v1/settings/npm-registry', { source: 'https://evil.example' })).status,
    ).toBe(400)
    const { person, workspace } = server.bootstrap
    const runtime = server.identity.issue('runtime', person.id, workspace.id).token
    expect(
      (await call('PUT', '/v1/settings/npm-registry', { source: 'official' }, runtime)).status,
    ).toBe(403)
  })
})
