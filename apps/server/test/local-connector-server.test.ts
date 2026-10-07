/**
 * WP247：真装配线端到端——桌面壳说了「本机连接器归我管」（`AGENTSWS_CONNECT_LOCAL_RUNTIME=1`）时，
 * 连接页上依赖连接器的卡点得动（点了先下载）、顶上那一行从「没下载」走到「就绪」；加固不过算「出错」；
 * AI 运行（runtime 令牌）调不到下载 / 删除；不归我们管时那几条路由回 501。
 *
 * 「本机 runtime」是一个本地小 http 服务冒充的（只答加固检查要的两个匿名接口）；下载用假 npm。不联网。
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { localRuntimeLayout, parseControlFile } from '@agentsws/connect-adapter'
import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'
import { writeJsonAtomic } from '../src/open-connector-installer.js'
import { writeFakeOcNpm } from './fixtures/fake-oc-npm.js'

const servers: Server[] = []
const https: HttpServer[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
  for (const h of https.splice(0)) h.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** 冒充 OpenConnector：`down` 一律断开（= 没起来），`hardened` 匿名 401，`open` 匿名 200（没加固）。 */
async function fakeRuntime(): Promise<{
  url: string
  mode: (m: 'down' | 'hardened' | 'open') => void
}> {
  let mode: 'down' | 'hardened' | 'open' = 'down'
  const server = createHttpServer((req, res) => {
    if (mode === 'down') {
      req.socket.destroy()
      return
    }
    const authed = (req.headers.authorization ?? '') !== ''
    if (mode === 'hardened' && !authed) {
      res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"unauthorized"}')
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(req.url === '/v1/health' ? '{"ok":true}' : '[]')
  })
  https.push(server)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${port}`, mode: (m) => (mode = m) }
}

type Status = {
  state: string
  local?: { status: string; installed?: string; job?: { phase: string; error?: { code: string } } }
}
type Providers = { providers: { service: string; available: boolean; needs_download?: boolean }[] }

async function machine(opts: { managed?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wp247-srv-'))
  dirs.push(root)
  const runtime = await fakeRuntime()
  const npm = writeFakeOcNpm(root)
  const dbDir = join(root, 'data')
  const server = await createServer({
    dbDir,
    quiet: true,
    mdns: () => ({ mdns: { publish() {}, browse() {}, stop() {} } }),
    startRun: false,
    tokenRefreshIntervalMs: 0,
    env: {
      AGENTSWS_OWNER_EMAIL: 'owner@example.test',
      AGENTSWS_CONNECT_URL: runtime.url,
      ...(opts.managed === false ? {} : { AGENTSWS_CONNECT_LOCAL_RUNTIME: '1' }),
      OOMOL_CONNECT_ENCRYPTION_KEY: 'k'.repeat(64),
      OOMOL_CONNECT_ADMIN_TOKEN: 'a'.repeat(64),
      OOMOL_CONNECT_BLOCKED_PROXIES: '*',
      AGENTSWS_SECRETS_KEY: 'b'.repeat(64),
    },
    localConnector: { npmCli: async () => npm.npmCli, verify: async () => undefined },
  })
  servers.push(server)
  const raw = async (method: string, path: string, token?: string): Promise<Response> =>
    server.gateway.fetch(
      new Request(`http://127.0.0.1${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token ?? server.bootstrap.internalToken}`,
          'X-Assignment': server.bootstrap.ownerAssignment.id,
        },
      }),
    )
  const call = async <T>(method: string, path: string): Promise<T> => {
    const res = await raw(method, path)
    const parsed = (await res.json()) as { data?: T }
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(parsed)}`)
    return parsed.data as T
  }
  const layout = localRuntimeLayout(dbDir)
  return { server, runtime, call, raw, layout }
}

const shop = (p: Providers) => p.providers.find((x) => x.service === 'shopify_admin')

describe('WP247 本机连接器：从没下载到就绪', () => {
  it('没下载 → 卡点得动（needs_download）→ 下载 → 启动中 → 壳报起来了 + 加固过 → 就绪', async () => {
    const m = await machine()
    const first = await m.call<Status>('GET', '/v1/connections/runtime')
    expect(first.state).toBe('absent')
    expect(first.local?.status).toBe('not_installed')
    expect(shop(await m.call<Providers>('GET', '/v1/connections/providers'))).toMatchObject({
      available: true,
      needs_download: true,
    })

    await m.call<Status>('POST', '/v1/connections/runtime/local/install')
    let s = first
    for (let n = 0; n < 200; n += 1) {
      s = await m.call<Status>('GET', '/v1/connections/runtime')
      if (s.local?.status !== 'downloading') break
      await new Promise((r) => setTimeout(r, 25))
    }
    expect(s.local).toMatchObject({ status: 'starting', installed: '1.8.0' })

    // 桌面壳起了它、报上来；runtime 也真答了（加固过）
    writeJsonAtomic(m.layout.supervisor, { state: 'running', pid: 4242, port: 1, attempts: 0 })
    m.runtime.mode('hardened')
    const ready = await m.call<Status>('GET', '/v1/connections/runtime')
    expect(ready.state).toBe('ready')
    expect(ready.local?.status).toBe('ready')
    const card = shop(await m.call<Providers>('GET', '/v1/connections/providers'))
    expect(card?.available).toBe(true)
    expect(card?.needs_download).toBeUndefined()
  })

  it('起着但加固不过（匿名能读）→ 出错，卡不给连', async () => {
    const m = await machine()
    await m.call('POST', '/v1/connections/runtime/local/install')
    for (let n = 0; n < 200; n += 1) {
      const s = await m.call<Status>('GET', '/v1/connections/runtime')
      if (s.local?.status !== 'downloading') break
      await new Promise((r) => setTimeout(r, 25))
    }
    writeJsonAtomic(m.layout.supervisor, { state: 'running', pid: 1, port: 1, attempts: 0 })
    m.runtime.mode('open')
    const s = await m.call<Status>('GET', '/v1/connections/runtime')
    expect(s.state).toBe('unhardened')
    expect(s.local?.status).toBe('error')
    expect(shop(await m.call<Providers>('GET', '/v1/connections/providers'))?.available).toBe(false)
  })

  it('重启 = 控制文件次数 +1；删除下载等壳报停了再删', async () => {
    const m = await machine()
    // 没装就重启：409
    expect((await m.raw('POST', '/v1/connections/runtime/local/restart')).status).toBe(409)
    await m.call('POST', '/v1/connections/runtime/local/install')
    for (let n = 0; n < 200; n += 1) {
      const s = await m.call<Status>('GET', '/v1/connections/runtime')
      if (s.local?.status !== 'downloading') break
      await new Promise((r) => setTimeout(r, 25))
    }
    await m.call('POST', '/v1/connections/runtime/local/restart')
    expect(parseControlFile(JSON.parse(readFileSync(m.layout.control, 'utf8')))?.restart_seq).toBe(
      1,
    )
    writeJsonAtomic(m.layout.supervisor, { state: 'stopped', port: 1, attempts: 0 })
    const after = await m.call<Status>('DELETE', '/v1/connections/runtime/local')
    expect(after.local?.status).toBe('not_installed')
  })

  it('AI 运行（runtime 令牌）下载 / 删除一律 403', async () => {
    const m = await machine()
    const { person, workspace } = m.server.bootstrap
    const token = m.server.identity.issue('runtime', person.id, workspace.id).token
    expect((await m.raw('POST', '/v1/connections/runtime/local/install', token)).status).toBe(403)
    expect((await m.raw('DELETE', '/v1/connections/runtime/local', token)).status).toBe(403)
  })

  it('不归我们管（没有那个开关 = 外部 / Docker 的 runtime）：没有 local，卡照旧置灰，路由 501', async () => {
    const m = await machine({ managed: false })
    const s = await m.call<Status>('GET', '/v1/connections/runtime')
    expect(s.local).toBeUndefined()
    const card = shop(await m.call<Providers>('GET', '/v1/connections/providers'))
    expect(card?.available).toBe(false)
    expect(card?.needs_download).toBeUndefined()
    expect((await m.raw('POST', '/v1/connections/runtime/local/install')).status).toBe(501)
  })
})
