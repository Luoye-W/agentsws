/**
 * WP134：第三种模型来源「用我的 DeepSeek 账号登录」的服务端装配。
 *
 * 两组：
 *
 * (a) **装配与边界**（替身宿主，不挂官方模块）：默认关——没人点就不挂、不建凭据库目录；
 *     只在本机档；登录 → 授权页地址 → 回来后显示账号与余额；余额查不到说人话；失败码说人话；
 *     重启按"选过没有"挂回来；登出摘模块。
 * (b) **整条路 + 凭据守卫**（真服务进程 + **官方模块原样跑** + 替身平台 + 替身 Messages 口）：
 *     经 `/v1` 起登录 → 浏览器回到**服务进程现有端口**的 `/oauth/callback` → 登上 →
 *     存这一条 provider → 三步验证（连通 → 文字 → 看图）通过 → 登出。全程之后查：令牌只在
 *     dsh 的本机凭据库文件里；不在任何 `/v1` 响应、不在我们的库（数据目录里别的文件）、
 *     不在事件日志、不在控制台输出、不在发给模型口的请求体里。
 *
 * 替身不认识的非本机请求当场抛——CI 一个包都不出网。
 */
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DeepSeekAccountView, ModelProviderView, ModelTestResult } from '@agentsws/api'
import type { EventEnvelope } from '@agentsws/contracts'
import type { DeepSeekAccountHost } from '@agentsws/dsh-adapter/deepseek-account'
import { createDeepSeekAccountHost } from '@agentsws/dsh-adapter/deepseek-account'
import {
  createFakeDeepSeekPlatform,
  createStandInDeepSeekAccountHost,
  type FakeDeepSeekPlatform,
} from '@agentsws/dsh-adapter/deepseek-account-stand-in'
import { type AccountFetch, VISION_PROBE_WORD } from '@agentsws/model-gateway'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createDeepSeekAccount,
  DEEPSEEK_ACCOUNT_UNAVAILABLE,
  DEEPSEEK_BALANCE_FAILED,
  DEEPSEEK_SIGN_IN_ERRORS,
  DEEPSEEK_SIGN_OUT_STOPPED,
} from '../src/deepseek-account.js'
import { SECRETS_KEY_ENV } from '../src/secret-store.js'
import { createServer, type Server } from '../src/server.js'

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'agentsws-dsa-'))
  dirs.push(dir)
  return dir
}

async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, ms = 8000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const v = await read()
    if (ok(v)) return v
    if (Date.now() > deadline) throw new Error(`等不到：${JSON.stringify(v)}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

// ── (a) 装配与边界 ─────────────────────────────────────────────────────

describe('WP134 (a) 装配：默认关、选了才开', () => {
  it('没人点：不挂模块、不建 dsh 凭据库目录；卡片显示"没开"', async () => {
    const dir = tempDir()
    const createHost = vi.fn(async () => createStandInDeepSeekAccountHost())
    const acct = createDeepSeekAccount({
      runtimeMode: () => 'local',
      dbDir: dir,
      callbackOrigin: () => 'http://127.0.0.1:4999',
      createHost,
    })
    await acct.resume()
    const view = await acct.view()
    expect(view).toMatchObject({ available: true, enabled: false, signed_in: false, region: 'cn' })
    expect(view.default_model).toBe('deepseek-flash')
    expect(createHost).not.toHaveBeenCalled()
    expect(acct.signedIn()).toBe(false)
    expect(existsSync(join(dir, 'dsh-home'))).toBe(false)
    expect(await acct.resolveToken('https://api.deepseek.com/anthropic')).toBeUndefined()
  })

  it('公司档 / 托管档：不可用，登录直接拒', async () => {
    const acct = createDeepSeekAccount({
      runtimeMode: () => 'docker',
      callbackOrigin: () => 'http://127.0.0.1:4999',
      createHost: async () => createStandInDeepSeekAccountHost(),
    })
    const view = await acct.view()
    expect(view.available).toBe(false)
    expect(view.unavailable_reason).toBe(DEEPSEEK_ACCOUNT_UNAVAILABLE)
    await expect(acct.login()).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('登录：拿到授权页地址 → 浏览器回来 → 账号名与余额；状态变了就通知模型面', async () => {
    const dir = tempDir()
    const stand = createStandInDeepSeekAccountHost()
    const onChange = vi.fn()
    const acct = createDeepSeekAccount({
      runtimeMode: () => 'local',
      dbDir: dir,
      callbackOrigin: () => 'http://127.0.0.1:4999',
      createHost: async () => stand,
      onChange,
    })
    const started = await acct.login()
    expect(started.enabled).toBe(true)
    expect(started.attempt?.phase).toBe('waiting-browser')
    expect(started.attempt?.authorize_url).toContain('/oauth/callback')
    expect(JSON.parse(readFileSync(join(dir, 'deepseek-account.json'), 'utf8'))).toEqual({
      version: 1,
      enabled: true,
    })
    // 浏览器回来（替身：直接调它的回调处理）
    const url = new URL(started.attempt?.authorize_url ?? '')
    const res = { writeHead: () => ({ end: () => undefined }) }
    expect(stand.handle({ url: `${url.pathname}${url.search}` } as never, res as never)).toBe(true)
    const done = await until(
      () => acct.view(),
      (v) => v.signed_in,
    )
    expect(done.account).toBe('替身账号')
    expect(done.balance).toEqual({
      status: 'ready',
      wallets: [{ currency: 'CNY', balance: '42.50' }],
      bonus: [{ currency: 'CNY', balance: '10.00' }],
    })
    expect(done.attempt?.authorize_url).toBeUndefined()
    expect(acct.signedIn()).toBe(true)
    expect(onChange).toHaveBeenCalled()

    stand.setBalance('fail')
    const failed = await acct.view()
    expect(failed.balance).toEqual({ status: 'failed', message: DEEPSEEK_BALANCE_FAILED })
    await acct.close()
  })

  it('失败码说人话（网络 / 协议 / 过期 / 存储四种）', async () => {
    for (const code of ['network', 'protocol', 'expired', 'storage'] as const) {
      const stand = createStandInDeepSeekAccountHost()
      const host: DeepSeekAccountHost = {
        ...stand,
        state: async () => ({
          status: 'signed-out',
          links: { usageUrl: 'https://x/usage', topUpUrl: 'https://x/top_up' },
          attempt: {
            id: 'a1' as never,
            phase: code === 'expired' ? 'expired' : 'failed',
            errorCode: code,
          },
        }),
      }
      const acct = createDeepSeekAccount({
        runtimeMode: () => 'local',
        callbackOrigin: () => 'http://127.0.0.1:4999',
        createHost: async () => host,
      })
      const view = await acct.login()
      expect(view.attempt?.error_code).toBe(code)
      expect(view.attempt?.error).toBe(DEEPSEEK_SIGN_IN_ERRORS[code])
      await acct.close()
    }
  })

  it('重启：上次选过就挂回来（已登录的账号接着能用）；登出后记回"没选"并摘掉模块', async () => {
    const dir = tempDir()
    const stand = createStandInDeepSeekAccountHost()
    const make = () =>
      createDeepSeekAccount({
        runtimeMode: () => 'local',
        dbDir: dir,
        callbackOrigin: () => 'http://127.0.0.1:4999',
        createHost: async () => stand,
        signOutGraceMs: 0,
      })
    const first = make()
    const started = await first.login()
    const url = new URL(started.attempt?.authorize_url ?? '')
    stand.handle(
      { url: `${url.pathname}${url.search}` } as never,
      { writeHead: () => ({ end: () => undefined }) } as never,
    )
    await until(
      () => first.view(),
      (v) => v.signed_in,
    )

    const again = make()
    await again.resume()
    expect((await again.view()).signed_in).toBe(true)
    expect(await again.resolveToken('https://api.deepseek.com/anthropic')).toMatch(/^dsk_stand_in_/)

    await again.signOut()
    expect((await again.view()).enabled).toBe(false)
    expect(again.signedIn()).toBe(false)
    expect(JSON.parse(readFileSync(join(dir, 'deepseek-account.json'), 'utf8')).enabled).toBe(false)
    const third = make()
    await third.resume()
    expect((await third.view()).enabled).toBe(false)
  })
})

// ── (b) 整条路 + 凭据守卫 ──────────────────────────────────────────────

const TOKEN = `dsk_SECRET_${randomBytes(8).toString('hex')}`
const SECRETS_KEY = randomBytes(32).toString('hex')

interface Seen {
  headers: Record<string, string>
  body: string
}

/** WP150：让替身 Messages 口不认这份令牌了（模拟平台那边登录失效）。 */
let forceUnauthorized = false
/**
 * WP150：给了就让替身 Messages 口**卡在这里**，放行后回一个工具调用——模拟"一件正在用账号跑、
 * 还没跑完的事"（回工具调用，运行循环才会往下走、看得见中断）。
 */
let hold: Promise<void> | undefined

/** 替身 Messages 口：看见测试图就念出那个词。 */
function fakeMessages(): { fetch: AccountFetch; seen: Seen[] } {
  const seen: Seen[] = []
  const fetch: AccountFetch = async (_url, init) => {
    seen.push({ headers: init.headers, body: init.body })
    if (forceUnauthorized || init.headers['x-dsh-auth-token'] !== TOKEN) {
      return { ok: false, status: 401, json: async () => ({}), text: async () => 'unauthorized' }
    }
    if (hold !== undefined) {
      const waiting = hold
      hold = undefined
      await waiting
      return {
        ok: true,
        status: 200,
        json: async () => ({
          content: [{ type: 'tool_use', id: 't1', name: 'search_policies', input: {} }],
          usage: { input_tokens: 10, output_tokens: 1 },
        }),
        text: async () => '',
      }
    }
    const req = JSON.parse(init.body) as { messages: { content: { type: string }[] }[] }
    const image = req.messages.some((m) => m.content.some((b) => b.type === 'image'))
    return {
      ok: true,
      status: 200,
      json: async () => ({
        content: [{ type: 'text', text: image ? VISION_PROBE_WORD : '好' }],
        usage: { input_tokens: 10, output_tokens: 1 },
      }),
      text: async () => '',
    }
  }
  return { fetch, seen }
}

function filesUnder(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...filesUnder(path))
    else out.push(path)
  }
  return out
}

describe('WP134 (b) 整条路：官方模块 + 服务进程现有端口的回调 + 三步验证 + 凭据守卫', () => {
  let server: Server
  let url = ''
  let dir = ''
  let platform: FakeDeepSeekPlatform
  let messages: ReturnType<typeof fakeMessages>
  const realFetch = globalThis.fetch
  const bodies: string[] = []
  const logs: string[] = []

  beforeEach(async () => {
    dir = tempDir()
    platform = createFakeDeepSeekPlatform({ token: TOKEN })
    messages = fakeMessages()
    forceUnauthorized = false
    hold = undefined
    bodies.length = 0
    logs.length = 0
    for (const level of ['info', 'log', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
      })
    }
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const target =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const hit = platform.handle(target, init)
      if (hit !== undefined) return hit
      if (new URL(target).hostname === '127.0.0.1') return realFetch(input, init)
      throw new Error(`测试不许出网：${target}`)
    })
    server = await boot()
    ;({ url } = await server.listen(0))
  })

  /** 起（或重启）服务进程：同一个数据目录、同一个 dsh 凭据库。 */
  const boot = () =>
    createServer({
      dbDir: dir,
      quiet: true,
      env: { [SECRETS_KEY_ENV]: SECRETS_KEY, AGENTSWS_RUNTIME_MODE: 'local' },
      tokenRefreshIntervalMs: 0,
      deepseekAccount: {
        // 官方模块原样跑：真的 dsh-credentials-local（文件落在 <dbDir>/dsh-home），平台指向替身
        createHost: () =>
          createDeepSeekAccountHost({
            dshHome: join(dir, 'dsh-home'),
            config: { platformOrigin: platform.origin },
          }),
        fetch: messages.fetch,
        signOutGraceMs: 0,
      },
    })

  afterEach(async () => {
    await server.close()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  const api = async (path: string, init: RequestInit = {}): Promise<unknown> => {
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${server.bootstrap.internalToken}`)
    headers.set('X-Assignment', server.bootstrap.ownerAssignment.id)
    if (init.body !== undefined) headers.set('content-type', 'application/json')
    const res = await realFetch(`${url}${path}`, { ...init, headers })
    const text = await res.text()
    bodies.push(text)
    if (!res.ok) throw new Error(`${path} → ${res.status} ${text}`)
    return (JSON.parse(text) as { data: unknown }).data
  }
  const view = () => api('/v1/settings/models/deepseek-account') as Promise<DeepSeekAccountView>

  it('没选：卡片是关的，dsh 凭据库目录都没有建', async () => {
    const v = await view()
    expect(v).toMatchObject({ available: true, enabled: false, signed_in: false })
    expect(existsSync(join(dir, 'dsh-home'))).toBe(false)
    const { providers } = (await api('/v1/models/providers')) as { providers: ModelProviderView[] }
    expect(providers.some((p) => p.kind === 'deepseek_account')).toBe(false)
  })

  it('登录 → 回调 → 存 provider → 三步验证过 → 登出；令牌只在 dsh 凭据库文件里', async () => {
    // ① 选中这条路：挂官方模块、起登录，拿到授权页
    const started = (await api('/v1/settings/models/deepseek-account/login', {
      method: 'POST',
    })) as DeepSeekAccountView
    expect(started.enabled).toBe(true)
    expect(started.attempt?.phase).toBe('waiting-browser')
    expect(new URL(started.attempt?.authorize_url ?? '').origin).toBe(platform.origin)
    // 回调地址就是服务进程这一个端口（不另开端口）
    expect(platform.lastInit()?.redirect_uri).toBe(`${url}/oauth/callback`)

    // ② 用户在系统浏览器里点了同意 → 平台把浏览器带回服务进程的 /oauth/callback
    const init = platform.lastInit()
    const back = await realFetch(
      `${init?.redirect_uri}?code=c1&state=${encodeURIComponent(init?.state ?? '')}`,
      { redirect: 'manual' },
    )
    expect(back.status).toBe(302)
    const signed = await until(view, (v) => v.signed_in)
    expect(signed.account).toBe('替身账号')
    expect(signed.balance?.status).toBe('ready')
    const credentials = join(dir, 'dsh-home', '.credentials.yaml')
    expect(readFileSync(credentials, 'utf8')).toContain(TOKEN)

    // ③ 存这一条 provider（不填 key）→ 三步验证
    await api('/v1/models/providers/deepseek-account', {
      method: 'PUT',
      body: JSON.stringify({ kind: 'deepseek_account', model: 'deepseek-flash' }),
    })
    const tested = (await api('/v1/models/providers/deepseek-account/test', {
      method: 'POST',
    })) as ModelTestResult
    expect(tested.ok).toBe(true)
    expect(tested.steps?.map((s) => [s.step, s.ok])).toEqual([
      ['connect', true],
      ['text', true],
      ['vision', true],
    ])
    const { providers } = (await api('/v1/models/providers')) as { providers: ModelProviderView[] }
    const row = providers.find((p) => p.id === 'deepseek-account')
    expect(row).toMatchObject({
      kind: 'deepseek_account',
      region: 'cn',
      active: true,
      has_key: true,
    })
    expect(row?.vision_status).toBe('ok')
    // 模型口那一侧：令牌只在 x-dsh-auth-token 头里
    expect(messages.seen.length).toBe(2)
    for (const s of messages.seen) {
      expect(s.headers['x-dsh-auth-token']).toBe(TOKEN)
      expect(s.headers.authorization).toBeUndefined()
      expect(s.body).not.toContain(TOKEN)
    }

    // ④ 守卫：令牌不在任何 /v1 响应、不在我们的库、不在事件日志、不在控制台
    for (const b of bodies) expect(b).not.toContain(TOKEN)
    for (const file of filesUnder(dir)) {
      if (file === credentials) continue
      expect(readFileSync(file).includes(TOKEN), file).toBe(false)
    }
    const events: EventEnvelope[] = []
    for await (const e of server.kernel.eventLog.read({
      workspace_id: server.bootstrap.workspace.id,
      limit: 5000,
    }))
      events.push(e)
    expect(JSON.stringify(events)).not.toContain(TOKEN)
    for (const r of platform.requests) expect(r.body).not.toContain(TOKEN)
    expect(logs.join('\n')).not.toContain(TOKEN)

    // ⑤ 登出：官方删本机凭据 + 后台 logout；这条 provider 一起摘掉
    await api('/v1/settings/models/deepseek-account', { method: 'DELETE' })
    const out = await view()
    expect(out.signed_in).toBe(false)
    expect(readFileSync(credentials, 'utf8')).not.toContain(TOKEN)
    const after = (await api('/v1/models/providers')) as { providers: ModelProviderView[] }
    expect(after.providers.some((p) => p.id === 'deepseek-account')).toBe(false)
    await until(
      async () => platform.requests.some((r) => r.url.endsWith('/auth-api/v0/users/logout')),
      (v) => v,
    )
  })

  it('没登录就想存这一条：拒，并说先登录', async () => {
    await expect(
      api('/v1/models/providers/deepseek-account', {
        method: 'PUT',
        body: JSON.stringify({ kind: 'deepseek_account', model: 'deepseek-flash' }),
      }),
    ).rejects.toThrow(/还没用 DeepSeek 账号登录/)
  })
  /** 登录 → 回调 → 存这一条 → 三步验证过（WP150 两条用例的前半段）。 */
  const signInAndConnect = async (): Promise<void> => {
    await api('/v1/settings/models/deepseek-account/login', { method: 'POST' })
    const init = platform.lastInit()
    await realFetch(
      `${init?.redirect_uri}?code=c1&state=${encodeURIComponent(init?.state ?? '')}`,
      { redirect: 'manual' },
    )
    await until(view, (v) => v.signed_in)
    await api('/v1/models/providers/deepseek-account', {
      method: 'PUT',
      body: JSON.stringify({ kind: 'deepseek_account', model: 'deepseek-flash' }),
    })
    const tested = (await api('/v1/models/providers/deepseek-account/test', {
      method: 'POST',
    })) as ModelTestResult
    expect(tested.ok).toBe(true)
  }
  const providerRows = async () =>
    ((await api('/v1/models/providers')) as { providers: ModelProviderView[] }).providers
  const allEvents = async (): Promise<EventEnvelope[]> => {
    const out: EventEnvelope[] = []
    for await (const e of server.kernel.eventLog.read({
      workspace_id: server.bootstrap.workspace.id,
      limit: 5000,
    }))
      out.push(e)
    return out
  }

  it('WP150 推理口 401：本机登录清掉、状态未登录 + 一句人话、这条来源摘掉、记一条事件；令牌守卫不退化', async () => {
    await signInAndConnect()
    const credentials = join(dir, 'dsh-home', '.credentials.yaml')
    const before = platform.requests.length

    // 平台那边不认这份登录了：下一次推理回 401（三步验证那一下就是一次推理）
    forceUnauthorized = true
    const tested = (await api('/v1/models/providers/deepseek-account/test', {
      method: 'POST',
    })) as ModelTestResult
    expect(tested.ok).toBe(false)
    expect(tested.reason).toBe('unauthenticated')
    expect(tested.detail).toContain('DeepSeek 账号的登录过期了')

    const out = await until(view, (v) => !v.signed_in && v.session_expired !== undefined)
    expect(out.session_expired?.message).toContain('点一下重新登录')
    expect(out.enabled).toBe(true)
    // 和手动登出同一条路：这条模型来源摘掉 → "还没接模型"那条提示与三步验证状态跟着变
    const rows = await until(providerRows, (r) => !r.some((p) => p.id === 'deepseek-account'))
    expect(rows.some((p) => p.active)).toBe(false)
    const events = await until(allEvents, (e) =>
      e.some((x) => x.type === 'model.account_signed_out'),
    )
    const dropped = events.find((x) => x.type === 'model.account_signed_out')
    expect(dropped?.payload).toEqual({ providers: ['deepseek-account'], reason: 'expired' })
    // 官方清了本机凭据；失效不是登出，不去调平台 logout
    expect(readFileSync(credentials, 'utf8')).not.toContain(TOKEN)
    expect(
      platform.requests.slice(before).some((r) => r.url.endsWith('/auth-api/v0/users/logout')),
    ).toBe(false)

    // 令牌守卫（WP134 那一套）：不在任何 /v1 响应、我们的库、事件日志、控制台、平台请求体里
    for (const b of bodies) expect(b).not.toContain(TOKEN)
    for (const file of filesUnder(dir)) {
      expect(readFileSync(file).includes(TOKEN), file).toBe(false)
    }
    expect(JSON.stringify(events)).not.toContain(TOKEN)
    for (const r of platform.requests) expect(r.body).not.toContain(TOKEN)
    expect(logs.join('\n')).not.toContain(TOKEN)
  })

  it('WP150 平台口 40003（查余额那一下）：同样未登录 + 一句人话 + 来源摘掉；这一轮回的就已经是"过期了"', async () => {
    await signInAndConnect()
    platform.setSession('40003')
    const out = await view()
    expect(out.signed_in).toBe(false)
    expect(out.session_expired?.message).toContain('登录过期了')
    expect(out.balance).toBeUndefined()
    await until(providerRows, (r) => !r.some((p) => p.id === 'deepseek-account'))
    // 重新登录：平台又认了 → 登上、那句话消失
    platform.setSession('ok')
    await api('/v1/settings/models/deepseek-account/login', { method: 'POST' })
    const init = platform.lastInit()
    await realFetch(
      `${init?.redirect_uri}?code=c2&state=${encodeURIComponent(init?.state ?? '')}`,
      { redirect: 'manual' },
    )
    const back = await until(view, (v) => v.signed_in)
    expect(back.session_expired).toBeUndefined()
    for (const b of bodies) expect(b).not.toContain(TOKEN)
  })
  it('WP150 登出前停任务（真服务进程）：重启后账号任务真跑在账号上、列进 running_tasks；登出先停它再登出', async () => {
    await signInAndConnect()
    // 重启：只接了 DeepSeek 账号的机器，重启后运行时也得是真模型（挂回账号在建品牌之前）
    await server.close()
    server = await boot()
    ;({ url } = await server.listen(0))
    expect((await view()).signed_in).toBe(true)

    let release: () => void = () => undefined
    hold = new Promise<void>((resolve) => {
      release = resolve
    })
    const runtime = server.runtime
    if (runtime === undefined) throw new Error('没有运行时')
    const matter = server.work.createMatter({ kind: 'conversation', title: '回复客户 Anna 的退货' })
    const running = runtime.startRun({
      matter,
      brief: '客户问退货进度',
      actor: {
        person_id: server.bootstrap.person.id,
        assignment_id: server.bootstrap.ownerAssignment.id,
      },
    } as Parameters<typeof runtime.startRun>[0])

    // 确认框要列的：正在用这个账号跑的那一件（事项名）
    const listed = await until(view, (v) => (v.running_tasks?.length ?? 0) === 1)
    expect(listed.running_tasks?.[0]).toMatchObject({
      matter_id: matter.id,
      title: '回复客户 Anna 的退货',
    })
    const run_id = listed.running_tasks?.[0]?.run_id ?? ''

    // 点了确认：先停这件事（它还卡在模型那一下），停完才登出
    const signingOut = api('/v1/settings/models/deepseek-account', { method: 'DELETE' })
    await new Promise((r) => setTimeout(r, 100))
    expect((await view()).signed_in).toBe(true)
    release()
    await signingOut
    await running
    const out = await view()
    expect(out.signed_in).toBe(false)
    expect(out.running_tasks).toBeUndefined()
    expect((await providerRows()).some((p) => p.id === 'deepseek-account')).toBe(false)
    const timeline = (await api(`/v1/matters/${matter.id}/timeline?limit=50`)) as {
      events: { text?: string }[]
    }
    expect(timeline.events.some((e) => e.text === DEEPSEEK_SIGN_OUT_STOPPED)).toBe(true)
    const events = await allEvents()
    expect(events.some((e) => e.type === 'run.cancelled' && e.correlation.run_id === run_id)).toBe(
      true,
    )
    for (const b of bodies) expect(b).not.toContain(TOKEN)
  })
})
