/**
 * WP151：DeepSeek **余额不足**——两条模型路都说人话、给「去充值」，而且去的地方不一样。
 *
 * | 组 | 用什么 | 钉什么 |
 * |---|---|---|
 * | (a) 账号路 | 真服务进程 + 替身账号宿主（钱包 0）+ 回 402 的替身 Messages 口 | 三步验证第 ② 步就是"账号余额不足"那句；账号卡与模型卡出那一行，充值链接是**官方 `links.topUpUrl`**；登录状态不变（不是失效）；余额刷新回来有钱了就收 |
 * | (b) API key 路 | 真服务进程 + 回 402 的替身上游（OpenAI 兼容口与 Messages 口各一遍） | 那一句是"API 余额不足，去开放平台充值"，充值链接是开放平台的；下一次调用成功就收 |
 *
 * 全程替身，不联网。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DeepSeekAccountView, ModelProviderView, ModelTestResult } from '@agentsws/api'
import { createStandInDeepSeekAccountHost } from '@agentsws/dsh-adapter/deepseek-account-stand-in'
import {
  type AccountFetch,
  DEEPSEEK_ACCOUNT_QUOTA_MESSAGE,
  DEEPSEEK_API_QUOTA_MESSAGE,
  DEEPSEEK_PLATFORM_TOP_UP_URL,
  type FetchLike,
  VISION_PROBE_WORD,
} from '@agentsws/model-gateway'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEEPSEEK_MESSAGES_ENV } from '../src/models.js'
import { SECRETS_KEY_ENV } from '../src/secret-store.js'
import { createServer, type Server } from '../src/server.js'

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

/** 替身账号模块给的充值页——故意和开放平台那个常量不同，才分得清用的是哪一个。 */
const ACCOUNT_TOP_UP = 'https://platform.deepseek.stand-in/top_up'
const INSUFFICIENT = JSON.stringify({
  error: { message: 'Insufficient Balance', type: 'unknown_error' },
})

let server: Server | undefined
let dir: string | undefined
afterEach(async () => {
  await server?.close()
  server = undefined
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

/** 上游替身：`broke` 为真时对话口回 402（官方那种错误信封），否则照常回话、认得测试图。 */
function upstream() {
  const state = { broke: true }
  const reply = (url: string, body: string) => {
    const image = body.includes('"image_url"') || body.includes('"type":"image"')
    const text = image ? VISION_PROBE_WORD : '好'
    if (url.endsWith('/models')) return { object: 'list', data: [{ id: 'deepseek-flash' }] }
    if (url.endsWith('/v1/messages')) {
      return { content: [{ type: 'text', text }], usage: { input_tokens: 9, output_tokens: 1 } }
    }
    return {
      choices: [{ message: { content: text } }],
      usage: { prompt_tokens: 9, completion_tokens: 1 },
    }
  }
  const fetch: FetchLike = async (url, init) => {
    const body = typeof init.body === 'string' ? init.body : ''
    if (state.broke && !url.endsWith('/models')) {
      return { ok: false, status: 402, json: async () => ({}), text: async () => INSUFFICIENT }
    }
    const json = reply(url, body)
    return { ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json) }
  }
  return { state, fetch, accountFetch: fetch as unknown as AccountFetch }
}

async function boot(opts: { env?: Record<string, string>; account?: boolean } = {}) {
  dir = mkdtempSync(join(tmpdir(), 'agentsws-wp151-'))
  const up = upstream()
  const stand = createStandInDeepSeekAccountHost({ balance: 'empty' })
  // 官方状态里的充值页换成替身自己的，分得清"账号的充值页"与"开放平台的充值页"
  const state = stand.state
  stand.state = async () => {
    const v = await state()
    return { ...v, links: { ...v.links, topUpUrl: ACCOUNT_TOP_UP } }
  }
  server = await createServer({
    dbDir: dir,
    quiet: true,
    env: { [SECRETS_KEY_ENV]: 'b'.repeat(64), AGENTSWS_RUNTIME_MODE: 'local', ...opts.env },
    modelFetch: up.fetch,
    tokenRefreshIntervalMs: 0,
    ...(opts.account === true
      ? {
          deepseekAccount: {
            createHost: async () => stand,
            fetch: up.accountFetch,
            signOutGraceMs: 0,
          },
        }
      : {}),
  })
  const { url } = await server.listen(0)
  const s = server
  const api = async (path: string, init: RequestInit = {}): Promise<unknown> => {
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${s.bootstrap.internalToken}`)
    headers.set('X-Assignment', s.bootstrap.ownerAssignment.id)
    if (init.body !== undefined) headers.set('content-type', 'application/json')
    const res = await fetch(`${url}${path}`, { ...init, headers })
    const text = await res.text()
    if (!res.ok) throw new Error(`${path} → ${res.status} ${text}`)
    return (JSON.parse(text) as { data: unknown }).data
  }
  const rows = async () =>
    ((await api('/v1/models/providers')) as { providers: ModelProviderView[] }).providers
  const test = (id: string) =>
    api(`/v1/models/providers/${id}/test`, { method: 'POST' }) as Promise<ModelTestResult>
  return { up, stand, url, api, rows, test }
}

describe('WP151 (a) 账号路：余额不足 → 人话 + 账号的充值页；不是登录失效', () => {
  it('第 ② 步就是那句；卡片与模型卡出那一行；登录不动；余额回来就收', async () => {
    const b = await boot({ account: true })
    const view = () => b.api('/v1/settings/models/deepseek-account') as Promise<DeepSeekAccountView>
    // 登录（替身：授权页就是本机回调，打开即登上）
    const started = (await b.api('/v1/settings/models/deepseek-account/login', {
      method: 'POST',
    })) as DeepSeekAccountView
    await fetch(started.attempt?.authorize_url ?? '', { redirect: 'manual' })
    expect((await view()).signed_in).toBe(true)
    await b.api('/v1/models/providers/deepseek-account', {
      method: 'PUT',
      body: JSON.stringify({ kind: 'deepseek_account', model: 'deepseek-flash' }),
    })

    const tested = await b.test('deepseek-account')
    expect(tested.ok).toBe(false)
    expect(tested.detail).toBe(DEEPSEEK_ACCOUNT_QUOTA_MESSAGE)
    expect(tested.steps?.map((s) => [s.step, s.ok])).toEqual([
      ['connect', true],
      ['text', false],
      ['vision', false],
    ])

    // 账号卡：那一行 + 官方充值页；登录着、没有"登录过期了"
    const v = await view()
    expect(v.signed_in).toBe(true)
    expect(v.session_expired).toBeUndefined()
    expect(v.quota_exceeded?.message).toBe(DEEPSEEK_ACCOUNT_QUOTA_MESSAGE)
    expect(v.top_up_url).toBe(ACCOUNT_TOP_UP)
    // 模型卡 / 顶栏读的那一格：同一句，充值链接是账号的，不是开放平台那个常量
    const row = (await b.rows()).find((p) => p.id === 'deepseek-account')
    expect(row?.active).toBe(true)
    expect(row?.quota_exceeded).toMatchObject({
      message: DEEPSEEK_ACCOUNT_QUOTA_MESSAGE,
      top_up_url: ACCOUNT_TOP_UP,
    })

    // 充了值：余额刷新回来有钱了 → 那一行收了（上游还没放行也一样）
    b.stand.setBalance('ok')
    const refreshed = await view()
    expect(refreshed.quota_exceeded).toBeUndefined()
    expect((await b.rows()).find((p) => p.id === 'deepseek-account')?.quota_exceeded).toBe(
      undefined,
    )
    expect(refreshed.signed_in).toBe(true)
  })

  it('一次调用成功也收（例如重新验证过了）', async () => {
    const b = await boot({ account: true })
    const started = (await b.api('/v1/settings/models/deepseek-account/login', {
      method: 'POST',
    })) as DeepSeekAccountView
    await fetch(started.attempt?.authorize_url ?? '', { redirect: 'manual' })
    await b.api('/v1/models/providers/deepseek-account', {
      method: 'PUT',
      body: JSON.stringify({ kind: 'deepseek_account', model: 'deepseek-flash' }),
    })
    await b.test('deepseek-account')
    expect((await b.rows()).find((p) => p.id === 'deepseek-account')?.quota_exceeded).toBeDefined()
    b.up.state.broke = false
    expect((await b.test('deepseek-account')).ok).toBe(true)
    expect((await b.rows()).find((p) => p.id === 'deepseek-account')?.quota_exceeded).toBe(
      undefined,
    )
  })
})

describe('WP151 (b) API key 路：余额不足 → "去开放平台充值"', () => {
  for (const [name, env] of [
    ['OpenAI 兼容口（默认）', {}],
    ['Messages 口（开关开了）', { [DEEPSEEK_MESSAGES_ENV]: '1' }],
  ] as const) {
    it(`${name}：第 ② 步那句、模型卡那一行 + 开放平台充值页；成功一次就收`, async () => {
      const b = await boot({ env })
      await b.api('/v1/models/providers/deepseek', {
        method: 'PUT',
        body: JSON.stringify({
          kind: 'deepseek',
          base_url: 'https://api.deepseek.com',
          model: 'deepseek-flash',
          api_key: 'sk-wp151-never-leaves',
        }),
      })
      const tested = await b.test('deepseek')
      expect(tested.ok).toBe(false)
      expect(tested.detail).toBe(DEEPSEEK_API_QUOTA_MESSAGE)
      const row = (await b.rows()).find((p) => p.id === 'deepseek')
      expect(row?.active).toBe(true)
      expect(row?.quota_exceeded).toMatchObject({
        message: DEEPSEEK_API_QUOTA_MESSAGE,
        top_up_url: DEEPSEEK_PLATFORM_TOP_UP_URL,
      })
      b.up.state.broke = false
      expect((await b.test('deepseek')).ok).toBe(true)
      expect((await b.rows()).find((p) => p.id === 'deepseek')?.quota_exceeded).toBeUndefined()
    })
  }

  it('改过地址的（代理 / 中转）不说"去开放平台充值"：照旧泛泛的余额不足', async () => {
    const b = await boot()
    await b.api('/v1/models/providers/deepseek', {
      method: 'PUT',
      body: JSON.stringify({
        kind: 'deepseek',
        base_url: 'https://proxy.example.com/v1',
        model: 'deepseek-flash',
        api_key: 'sk-wp151-never-leaves',
      }),
    })
    const tested = await b.test('deepseek')
    expect(tested.ok).toBe(false)
    expect(tested.detail).not.toBe(DEEPSEEK_API_QUOTA_MESSAGE)
    expect((await b.rows()).find((p) => p.id === 'deepseek')?.quota_exceeded).toBeUndefined()
  })
})
