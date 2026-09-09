/**
 * WP24 §8 服务进程加固（配合 `apps/desktop`，13 §5 / 28 §1）：
 *
 * 1. `PUT /v1/halt` 运行期急停（owner 权限，四个 scope，急停时它自己不被拦）
 * 2. 内核认 `AGENTSWS_HALT_FILE`（启动读 + 变更写回）
 * 3. `GET /v1/health` 带 `pid` 与 `port`
 * 4. `AGENTSWS_SESSION_KEY` → HttpOnly + SameSite=Strict cookie；之后 cookie 或 bearer 二选一，
 *    **token 一次都不出现在 URL 与日志里**
 * 5. `AGENTSWS_CONNECT_URL` 是 OpenConnector 地址的唯一真源
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { connectBaseUrl, createServer, DEFAULT_CONNECT_URL, type Server } from '../src/index.js'

const T0 = '2026-09-07T09:00:00.000Z'

function seeded(seed = 11): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const clock = { now: () => T0 }

const servers: Server[] = []
const dirs: string[] = []

async function start(env: Record<string, string | undefined> = {}): Promise<{
  server: Server
  url: string
}> {
  const server = await createServer({
    quiet: true,
    clock,
    random: seeded(),
    // 运行时不装：这几条用例只测加固面，不想顺带跑一次 Run
    startRun: false,
    env: { AGENTSWS_OWNER_EMAIL: 'luoye@example.com', ...env },
  })
  servers.push(server)
  const { url } = await server.listen(0)
  return { server, url }
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentsws-halt-'))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const bearer = (server: Server): Headers =>
  new Headers({
    Authorization: `Bearer ${server.bootstrap.internalToken}`,
    'X-Assignment': server.bootstrap.ownerAssignment.id,
    'content-type': 'application/json',
  })

describe('运行期急停（PUT /v1/halt）', () => {
  it('owner 能停能解；停着的时候 halt 与 health 自己不被拦', async () => {
    const { server, url } = await start()
    const on = await fetch(`${url}/v1/halt`, {
      method: 'PUT',
      headers: bearer(server),
      body: JSON.stringify({ scope: 'all', on: true, reason: '托盘暂停' }),
    })
    expect(on.status).toBe(200)
    expect(server.kernel.halt.isHalted('all')).toBe(true)

    // 别的路由这时候一律 halted
    const blocked = await fetch(`${url}/v1/me`, { headers: bearer(server) })
    expect(blocked.status).toBe(503)

    // 但健康与解停这两条还能用——否则停下来就再也解不开了
    const health = await fetch(`${url}/v1/health`)
    expect(health.status).toBe(200)
    const off = await fetch(`${url}/v1/halt`, {
      method: 'PUT',
      headers: bearer(server),
      body: JSON.stringify({ scope: 'all', on: false }),
    })
    expect(off.status).toBe(200)
    expect(server.kernel.halt.isHalted('all')).toBe(false)
    expect((await fetch(`${url}/v1/me`, { headers: bearer(server) })).status).toBe(200)
  })

  it('四个 scope 各自独立；outbound 停了读照常', async () => {
    const { server, url } = await start()
    for (const scope of ['model', 'outbound', 'learning'] as const) {
      const res = await fetch(`${url}/v1/halt`, {
        method: 'PUT',
        headers: bearer(server),
        body: JSON.stringify({ scope, on: true }),
      })
      expect(res.status).toBe(200)
      expect(server.kernel.halt.isHalted(scope)).toBe(true)
    }
    expect(server.kernel.halt.isHalted('all')).toBe(false)
    // 读路由不受 outbound 急停影响（28 §4 用例 3）
    expect((await fetch(`${url}/v1/me`, { headers: bearer(server) })).status).toBe(200)
    const state = await fetch(`${url}/v1/halt`, { headers: bearer(server) })
    expect(((await state.json()) as { data: Record<string, { on: boolean }> }).data.model.on).toBe(
      true,
    )
  })

  it('不是 owner 的岗位改不了急停（403）', async () => {
    const { server, url } = await start()
    const aftersales = server.roles.assignments.create({
      person_id: server.bootstrap.person.id,
      workspace_id: server.bootstrap.workspace.id,
      role_id: 'dtc.aftersales',
      granted_by: server.bootstrap.person.id,
      ranges: [{ kind: 'store', id: 'store_1' }],
    })
    const headers = bearer(server)
    headers.set('X-Assignment', aftersales.id)
    const res = await fetch(`${url}/v1/halt`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ scope: 'all', on: true }),
    })
    expect(res.status).toBe(403)
    expect(server.kernel.halt.isHalted('all')).toBe(false)
  })

  it('急停改动进事件日志（21 §1：谁在什么时候停了什么）', async () => {
    const { server, url } = await start()
    await fetch(`${url}/v1/halt`, {
      method: 'PUT',
      headers: bearer(server),
      body: JSON.stringify({ scope: 'learning', on: true, reason: '先别学' }),
    })
    const events = []
    for await (const e of server.kernel.eventLog.read({
      workspace_id: server.bootstrap.workspace.id,
      types: ['halt.changed'],
    }))
      events.push(e)
    expect(events).toHaveLength(1)
    expect(events[0]?.payload).toMatchObject({ scope: 'learning', on: true })
  })
})

describe('AGENTSWS_HALT_FILE（启动读 + 变更写回）', () => {
  it('文件里写着 all → 起来就是停的', async () => {
    const dir = tempDir()
    const file = join(dir, 'halt.json')
    writeFileSync(file, JSON.stringify({ scopes: ['all'] }), 'utf8')
    const { server, url } = await start({ AGENTSWS_HALT_FILE: file })
    expect(server.kernel.halt.isHalted('all')).toBe(true)
    const health = (await (await fetch(`${url}/v1/health`)).json()) as {
      data: { status: string }
    }
    expect(health.data.status).toBe('halted')
  })

  it('运行期改急停会写回同一个文件（桌面壳与服务进程共用一份真源）', async () => {
    const dir = tempDir()
    const file = join(dir, 'halt.json')
    const { server, url } = await start({ AGENTSWS_HALT_FILE: file })
    await fetch(`${url}/v1/halt`, {
      method: 'PUT',
      headers: bearer(server),
      body: JSON.stringify({ scope: 'outbound', on: true }),
    })
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ scopes: ['outbound'] })
    await fetch(`${url}/v1/halt`, {
      method: 'PUT',
      headers: bearer(server),
      body: JSON.stringify({ scope: 'outbound', on: false }),
    })
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ scopes: [] })
  })

  it('坏文件当成「没停」，不会把系统卡在停止态', async () => {
    const dir = tempDir()
    const file = join(dir, 'halt.json')
    writeFileSync(file, '{ 这不是 json', 'utf8')
    const { server } = await start({ AGENTSWS_HALT_FILE: file })
    expect(server.kernel.halt.isHalted('all')).toBe(false)
  })
})

describe('GET /v1/health 带 pid 与 port（13 §5）', () => {
  it('listen 之后 port 是真实绑定的那个端口', async () => {
    const { server, url } = await start()
    const res = (await (await fetch(`${url}/v1/health`)).json()) as {
      data: { pid: number; port: number; status: string }
    }
    expect(res.data.pid).toBe(process.pid)
    expect(res.data.port).toBe(Number(new URL(url).port))
    expect(res.data.status).toBe('ok')
    void server
  })
})

describe('AGENTSWS_SESSION_KEY → HttpOnly cookie（13 §5）', () => {
  const KEY = 'test-session-key-0123456789abcdef'

  it('拿密钥换 cookie：HttpOnly + SameSite=Strict，响应体里没有 token', async () => {
    const { url } = await start({ AGENTSWS_SESSION_KEY: KEY })
    const res = await fetch(`${url}/v1/auth/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: KEY }),
    })
    expect(res.status).toBe(200)
    const setCookie = res.headers.get('set-cookie') ?? ''
    expect(setCookie).toContain('agentsws_session=')
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('SameSite=Strict')
    expect(setCookie).toContain('Path=/')
    const body = await res.text()
    // 响应体里只有人与工作区，**没有** token（它只在 Set-Cookie 里）
    expect(body).toContain('luoye@example.com')
    const token = /agentsws_session=([^;]+)/.exec(setCookie)?.[1] ?? ''
    expect(token.length).toBeGreaterThan(8)
    expect(body).not.toContain(token)
  })

  it('之后浏览器只带 cookie 就能用；SDK 仍然可以只带 bearer', async () => {
    const { server, url } = await start({ AGENTSWS_SESSION_KEY: KEY })
    const exchange = await fetch(`${url}/v1/auth/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: KEY }),
    })
    const cookie = (exchange.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
    const byCookie = await fetch(`${url}/v1/me`, { headers: { Cookie: cookie } })
    expect(byCookie.status).toBe(200)
    const byBearer = await fetch(`${url}/v1/me`, {
      headers: { Authorization: `Bearer ${server.bootstrap.internalToken}` },
    })
    expect(byBearer.status).toBe(200)
    // 两个都不给 → 401
    expect((await fetch(`${url}/v1/me`)).status).toBe(401)
  })

  it('密钥不对 → 401；没配密钥 → 501', async () => {
    const { url } = await start({ AGENTSWS_SESSION_KEY: KEY })
    const bad = await fetch(`${url}/v1/auth/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: `${KEY}x` }),
    })
    expect(bad.status).toBe(401)

    const plain = await start()
    const none = await fetch(`${plain.url}/v1/auth/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: KEY }),
    })
    expect(none.status).toBe(501)
  })

  it('token 与密钥都不出现在 URL 与启动输出里', async () => {
    const printed: string[] = []
    const original = process.stdout.write.bind(process.stdout)
    // biome-ignore lint/suspicious/noExplicitAny: 只为捕获这几行启动输出
    ;(process.stdout as any).write = (chunk: unknown): boolean => {
      printed.push(String(chunk))
      return true
    }
    let url: string
    try {
      const server = await createServer({
        clock,
        random: seeded(),
        startRun: false,
        env: { AGENTSWS_OWNER_EMAIL: 'luoye@example.com', AGENTSWS_SESSION_KEY: KEY },
      })
      servers.push(server)
      url = (await server.listen(0)).url
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: 恢复
      ;(process.stdout as any).write = original
    }
    const res = await fetch(`${url}/v1/auth/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: KEY }),
    })
    const setCookie = res.headers.get('set-cookie') ?? ''
    const token = /agentsws_session=([^;]+)/.exec(setCookie)?.[1] ?? ''
    const out = printed.join('')
    // 会话密钥与会话 token 一个字都不该出现在 stdout
    expect(out).not.toContain(KEY)
    expect(out).not.toContain(token)
    // 也不该出现在任何 URL 里：兑换是 POST body，重定向一个都没有
    expect(res.redirected).toBe(false)
    expect(res.url).not.toContain(token)
    expect(res.url).not.toContain(KEY)
  })
})

describe('AGENTSWS_CONNECT_URL 是唯一真源（08 / 18）', () => {
  it('不设就是默认 origin；设了按它走；末尾斜杠去掉', () => {
    expect(connectBaseUrl({})).toBe(DEFAULT_CONNECT_URL)
    expect(connectBaseUrl({ AGENTSWS_CONNECT_URL: 'http://127.0.0.1:3999/' })).toBe(
      'http://127.0.0.1:3999',
    )
    expect(connectBaseUrl({ AGENTSWS_CONNECT_URL: '  ' })).toBe(DEFAULT_CONNECT_URL)
  })

  it('不合法的值直接抛，不静默退回默认值', () => {
    expect(() => connectBaseUrl({ AGENTSWS_CONNECT_URL: 'not a url' })).toThrow()
    expect(() => connectBaseUrl({ AGENTSWS_CONNECT_URL: 'file:///etc/passwd' })).toThrow()
  })

  it('服务进程把解析结果挂出来，别处不再自己拼', async () => {
    const { server } = await start({ AGENTSWS_CONNECT_URL: 'http://127.0.0.1:3111' })
    expect(server.connectUrl).toBe('http://127.0.0.1:3111')
  })
})
