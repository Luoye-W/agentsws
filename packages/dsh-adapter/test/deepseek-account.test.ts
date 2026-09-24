/**
 * WP134：用我的 DeepSeek 账号登录——**官方模块原样跑**，平台那一头是替身。
 *
 * 被测的是官方 `@deepseek-ai/dsh-deepseek-account-platform` 的状态机本身（开始 / 成功 /
 * 取消 / 超时 / issuer 不匹配），外加我们给它搭的那一圈：最小树、`webServer` 登记表、
 * 回调经"现有端口"交给官方处理器。平台请求全被 `globalThis.fetch` 的替身接住——
 * **替身不认识的非本机请求当场抛**，CI 一个包都不出网。
 *
 * 另有一组守卫：令牌只在「官方模块 ↔ dsh 凭据库」之间走——不在任何发给平台的请求体里、
 * 不在官方的诊断输出里、不在 `state()` / `profile()` / `balance()` 的返回值里。
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { Config as OfficialConfig } from '@deepseek-ai/dsh-deepseek-account-platform'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createDeepSeekAccountHost,
  DEEPSEEK_ACCOUNT_CALLBACK_PATH,
  DEEPSEEK_ACCOUNT_MESSAGES_BASE_URL,
  type DeepSeekAccountHost,
} from '../src/deepseek-account.js'
import {
  createFakeDeepSeekPlatform,
  createStandInDeepSeekAccountHost,
  type FakeDeepSeekPlatform,
  MemoryDeepSeekCredentials,
} from '../src/deepseek-account-stand-in.js'

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 })

const KEY = 'deepseek-account-platform/default'
const realFetch = globalThis.fetch

let platform: FakeDeepSeekPlatform
let host: DeepSeekAccountHost | undefined
let loopback: Server | undefined
let origin = ''
let logs: string[] = []

/** "服务进程现有的端口"：一个本机 http 服务，把回调交给 `host.handle`，别的一律 404。 */
async function startLoopback(): Promise<void> {
  loopback = createServer((req, res) => {
    if (host?.handle(req, res) === true) return
    res.writeHead(404).end()
  })
  await new Promise<void>((resolve) => loopback?.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(loopback.address() as AddressInfo).port}`
}

async function mount(
  records = new Map<string, CredentialRecord>(),
  config: Record<string, unknown> = {},
): Promise<DeepSeekAccountHost> {
  host = await createDeepSeekAccountHost({
    credentials: MemoryDeepSeekCredentials.withRecords(records),
    config: { platformOrigin: platform.origin, ...config },
  })
  return host
}

async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, ms = 5000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const v = await read()
    if (ok(v)) return v
    if (Date.now() > deadline) throw new Error(`等不到：${JSON.stringify(v)}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

/** 模拟"用户在系统浏览器里点了同意"：浏览器被平台带回我们的回环回调。 */
async function browserReturns(): Promise<Response> {
  const init = platform.lastInit()
  if (init === undefined) throw new Error('还没 auth_init')
  return realFetch(`${init.redirect_uri}?code=code_1&state=${encodeURIComponent(init.state)}`, {
    redirect: 'manual',
  })
}

beforeEach(async () => {
  platform = createFakeDeepSeekPlatform({ token: 'dsk_SECRET_TOKEN_wp134' })
  logs = []
  vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
    logs.push(JSON.stringify(args))
  })
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const hit = platform.handle(url, init)
    if (hit !== undefined) return hit
    if (new URL(url).hostname === '127.0.0.1') return realFetch(input, init)
    throw new Error(`测试不许出网：${url}`)
  })
  await startLoopback()
})

afterEach(async () => {
  await host?.dispose()
  host = undefined
  await new Promise<void>((resolve) => loopback?.close(() => resolve()))
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('WP134 登录状态机（官方模块 + 替身平台）', () => {
  it('开始：先 initializing，拿到授权地址后 waiting-browser；回调走我们现有端口的 /oauth/callback', async () => {
    const h = await mount()
    expect((await h.state()).status).toBe('signed-out')
    const first = await h.startSignIn({ callbackOrigin: origin, locale: 'zh-CN' })
    expect(first.attempt?.phase).toBe('initializing')
    const waiting = await until(
      () => h.state(),
      (v) => v.attempt?.phase === 'waiting-browser',
    )
    // 授权页只能是平台源上固定的 /dsh/authorize（官方 browserUrl 校验）
    expect(new URL(waiting.attempt?.authorizeUrl ?? '').origin).toBe(platform.origin)
    expect(new URL(waiting.attempt?.authorizeUrl ?? '').pathname).toBe('/dsh/authorize')
    const init = platform.lastInit()
    expect(init?.redirect_uri).toBe(`${origin}${DEEPSEEK_ACCOUNT_CALLBACK_PATH}`)
    expect(init?.login_source).toBe('web')
    const body = JSON.parse(platform.requests[0]?.body ?? '{}') as Record<string, unknown>
    expect(body.code_challenge_method).toBe('S256')
    expect(body.locale).toBe('zh_CN')
    // 官方默认 desktopPlatform=null → 所有平台请求带 x-client-platform: web；我们不加别的头
    expect(platform.requests[0]?.headers['x-client-platform']).toBe('web')
    expect(platform.requests[0]?.headers.cookie).toBeUndefined()
  })

  it('成功：浏览器回来 → 交换 → 令牌进 dsh 凭据库；推理只对 api.deepseek.com 给令牌', async () => {
    const records = new Map<string, CredentialRecord>()
    const h = await mount(records)
    await h.startSignIn({ callbackOrigin: origin, locale: 'zh-CN' })
    await until(
      () => h.state(),
      (v) => v.attempt?.phase === 'waiting-browser',
    )
    const res = await browserReturns()
    // 官方：提交授权之后 302 到平台的完成页，并带上 login_source
    expect(res.status).toBe(302)
    const location = new URL(res.headers.get('location') ?? '')
    expect(`${location.origin}${location.pathname}`).toBe(`${platform.origin}/dsh/authorized`)
    expect(location.searchParams.get('login_source')).toBe('web')

    const done = await until(
      () => h.state(),
      (v) => v.status === 'credential-stored',
    )
    expect(done.attempt?.phase).toBe('succeeded')
    const stored = records.get(KEY) as { kind: string; payload: { issuer: string } }
    expect(stored.kind).toBe('grant')
    expect(stored.payload.issuer).toBe(platform.origin)

    expect(await h.resolveToken(DEEPSEEK_ACCOUNT_MESSAGES_BASE_URL)).toBe(platform.token)
    expect(await h.resolveToken('https://api.openai.com/v1')).toBeUndefined()
    expect(await h.resolveToken(`${platform.origin}/anything`)).toBeUndefined()

    const profile = await h.profile()
    expect(profile).toEqual({
      status: 'ready',
      value: {
        id: 'stand-in-user',
        name: '替身账号',
        contact: 'de***@example.com',
        avatarUrl: null,
      },
    })
    const balance = await h.balance()
    expect(balance?.status).toBe('ready')
  })

  it('余额查询失败：官方回 { status: failed }，不是 0', async () => {
    const h = await mount()
    await h.startSignIn({ callbackOrigin: origin, locale: 'zh-CN' })
    await until(
      () => h.state(),
      (v) => v.attempt?.phase === 'waiting-browser',
    )
    await browserReturns()
    await until(
      () => h.state(),
      (v) => v.status === 'credential-stored',
    )
    platform.setBalance('fail')
    expect(await h.balance()).toEqual({ status: 'failed' })
  })

  it('取消：只取消这一次；迟到的回调不能把人登进去；后台发一次 auth_cancel', async () => {
    const h = await mount()
    await h.startSignIn({ callbackOrigin: origin, locale: 'en' })
    const waiting = await until(
      () => h.state(),
      (v) => v.attempt?.phase === 'waiting-browser',
    )
    const id = waiting.attempt?.id ?? ''
    await h.cancelSignIn('not-this-one')
    expect((await h.state()).attempt?.phase).toBe('waiting-browser')
    const after = await h.cancelSignIn(id)
    expect(after.attempt?.phase).toBe('cancelled')
    const late = await browserReturns()
    expect([404, 410]).toContain(late.status)
    expect((await h.state()).status).toBe('signed-out')
    await until(
      async () => platform.requests.map((r) => new URL(r.url).pathname),
      (paths) => paths.includes('/auth-api/v0/dsh/auth_cancel'),
    )
  })

  it('超时：attemptTimeoutMs 到了还没回来 → expired', async () => {
    const h = await mount(new Map(), { attemptTimeoutMs: 300 })
    await h.startSignIn({ callbackOrigin: origin, locale: 'zh-CN' })
    const view = await until(
      () => h.state(),
      (v) => v.attempt?.phase === 'expired',
    )
    expect(view.attempt?.errorCode).toBe('expired')
    expect(view.status).toBe('signed-out')
  })

  it('issuer 不匹配：本机那条授权在挂上时就被删掉，不发远端登出', async () => {
    const records = new Map<string, CredentialRecord>([
      [
        KEY,
        {
          kind: 'grant',
          payload: { version: 1, token: 'dsk_OTHER_ISSUER', issuer: 'https://other.example' },
        },
      ],
    ])
    const h = await mount(records)
    expect((await h.state()).status).toBe('signed-out')
    expect(records.has(KEY)).toBe(false)
    expect(platform.requests).toEqual([])
    expect(await h.resolveToken(DEEPSEEK_ACCOUNT_MESSAGES_BASE_URL)).toBeUndefined()
  })

  it('登出：本机凭据当场删掉，后台调平台 logout（令牌只在 x-dsh-auth-token 头里）', async () => {
    const records = new Map<string, CredentialRecord>()
    const h = await mount(records)
    await h.startSignIn({ callbackOrigin: origin, locale: 'zh-CN' })
    await until(
      () => h.state(),
      (v) => v.attempt?.phase === 'waiting-browser',
    )
    await browserReturns()
    await until(
      () => h.state(),
      (v) => v.status === 'credential-stored',
    )
    const out = await h.signOut()
    expect(out.status).toBe('signed-out')
    expect(records.has(KEY)).toBe(false)
    const logout = await until(
      async () => platform.requests.find((r) => r.url.endsWith('/auth-api/v0/users/logout')),
      (r) => r !== undefined,
    )
    expect(logout?.headers['x-dsh-auth-token']).toBe(platform.token)
    expect(await h.resolveToken(DEEPSEEK_ACCOUNT_MESSAGES_BASE_URL)).toBeUndefined()
  })

  it('守卫：令牌不在任何请求体、不在官方诊断输出、不在对外的状态 / 资料 / 余额里', async () => {
    const h = await mount()
    await h.startSignIn({ callbackOrigin: origin, locale: 'zh-CN' })
    await until(
      () => h.state(),
      (v) => v.attempt?.phase === 'waiting-browser',
    )
    await browserReturns()
    await until(
      () => h.state(),
      (v) => v.status === 'credential-stored',
    )
    const outward = JSON.stringify([await h.state(), await h.profile(), await h.balance()])
    await h.signOut()
    const secret = platform.token
    for (const r of platform.requests) expect(r.body).not.toContain(secret)
    expect(outward).not.toContain(secret)
    expect(logs.length).toBeGreaterThan(0) // 官方确实打了诊断——所以这条断言不是空转
    expect(logs.join('\n')).not.toContain(secret)
  })
})

describe('WP134 官方默认值', () => {
  it('哨兵：0.1.7-rc.1 的 Config({}) 里 desktopPlatform 没落成文档说的 null（所以我们显式传）', () => {
    // 上游修好之后这一条会红：那时把 OFFICIAL_DEFAULTS 删掉、这条改成 toBeNull 即可
    expect(OfficialConfig({}).desktopPlatform).toBeUndefined()
    expect(OfficialConfig({ desktopPlatform: null }).desktopPlatform).toBeNull()
  })

  it('除了 desktopPlatform 一项都不覆盖：平台源、推理源、超时全是官方的', () => {
    const resolved = OfficialConfig({ desktopPlatform: null })
    expect(resolved.platformOrigin).toBe('https://platform.deepseek.com')
    expect(resolved.inferenceOrigin).toBe('https://api.deepseek.com')
    expect(resolved.allowLoopbackHttp).toBe(false)
    expect(resolved.rewriteBrowserOrigin).toBe(false)
    expect(resolved.requestHeaders).toEqual({})
  })
})

describe('WP134 demo 替身宿主（不挂官方模块）', () => {
  it('授权地址就是本机回调；打开即登录，账号与余额是替身数据，登出即清', async () => {
    const stand = createStandInDeepSeekAccountHost()
    host = stand
    const view = await stand.startSignIn({ callbackOrigin: origin, locale: 'zh-CN' })
    const url = view.attempt?.authorizeUrl ?? ''
    expect(url.startsWith(`${origin}/oauth/callback`)).toBe(true)
    expect((await realFetch(url)).status).toBe(200)
    expect((await stand.state()).status).toBe('credential-stored')
    expect((await stand.profile())?.status).toBe('ready')
    stand.setBalance('fail')
    expect(await stand.balance()).toEqual({ status: 'failed' })
    expect(await stand.resolveToken(DEEPSEEK_ACCOUNT_MESSAGES_BASE_URL)).toMatch(/^dsk_stand_in_/)
    await stand.signOut()
    expect(await stand.resolveToken(DEEPSEEK_ACCOUNT_MESSAGES_BASE_URL)).toBeUndefined()
  })
})
