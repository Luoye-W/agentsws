/**
 * WP355（决策 937）：指定的模型来源用它自带的联网搜索——名单判定、退回 WP353 的链、照实标来源、
 * 缓存 / 节流 / 搜索语言照旧在我们这一层。全用替身（不联网、不碰真账号）。
 */
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NativeSearchRequest, SubscriptionLoginHandle } from '@agentsws/dsh-adapter'
import { afterAll, describe, expect, it } from 'vitest'
import { createSecretStore, SECRETS_KEY_ENV } from '../src/secret-store.js'
import { createSubscription, subscriptionSecretId } from '../src/subscription.js'
import {
  createBrowserWebSearch,
  createSearchThrottle,
  type KeylessSearch,
  NATIVE_SEARCH_SOURCES,
  type NativeSearchPort,
  nativeSearchSourceOf,
} from '../src/web-browser/index.js'

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

type NativeCall = Parameters<NativeSearchPort['search']>[0]

/** 替身「ChatGPT 自带搜索」：按脚本回；记下每一次问了什么。 */
function fakeNative(
  script: (call: NativeCall) => Promise<Awaited<ReturnType<NativeSearchPort['search']>>>,
) {
  const calls: NativeCall[] = []
  const port: NativeSearchPort = {
    search: async (call) => {
      calls.push(call)
      return script(call)
    },
  }
  return { port, calls }
}

/** 替身公开搜索服务（WP353 链的最后一道；这里没有桌面壳，链 = 公开搜索服务）。 */
function fakePublic(urls: string[]) {
  const queries: string[] = []
  const keyless: KeylessSearch = {
    search: async (r) => {
      queries.push(r.query)
      return { sources: urls.map((url) => ({ url, title: url })) }
    },
  }
  return { keyless, queries }
}

const REDDIT = [
  'https://www.reddit.com/r/SmartGlasses/comments/a1/x/',
  'https://www.reddit.com/r/augmentedreality/comments/b2/y/',
]
const USAGE = { input_tokens: 300, output_tokens: 80, cached_tokens: 0 }

function setup(o: {
  native?: NativeSearchPort
  pub?: KeylessSearch
  markets?: string[]
  nativePerHour?: number
}) {
  let t = Date.parse('2026-10-16T10:00:00Z')
  const dir = mkdtempSync(join(tmpdir(), 'wp355-'))
  dirs.push(dir)
  const throttle = (maxPerHour: number) =>
    createSearchThrottle({
      now: () => t,
      random: () => 0.5,
      sleep: async (ms) => {
        t += ms
      },
      maxPerHour,
      minGapMs: 0,
      maxGapMs: 0,
    })
  const search = createBrowserWebSearch({
    workspace_id: 'ws_1',
    dir,
    throttle: throttle(60),
    profile: () => ({ markets: o.markets ?? ['US'] }),
    ...(o.pub === undefined ? {} : { keyless: () => o.pub }),
    ...(o.native === undefined ? {} : { native: o.native }),
    nativeThrottle: throttle(o.nativePerHour ?? 60),
    now: () => t,
  })
  return { search }
}

const CODEX = { source: 'openai-codex', model: 'gpt-5.5', person_id: 'per_1' }

describe('名单（代码里的常量，不给用户开关）', () => {
  it('第一版只有 ChatGPT 订阅登录；DeepSeek、工坊积分、各家 API key、Claude 订阅都不在', () => {
    expect([...NATIVE_SEARCH_SOURCES]).toEqual(['openai-codex'])
    expect(nativeSearchSourceOf('openai-codex')).toBe('openai-codex')
    for (const other of ['deepseek', 'deepseek-account', 'agentsws_cloud', 'anthropic', 'prov_x'])
      expect(nativeSearchSourceOf(other)).toBeUndefined()
    expect(nativeSearchSourceOf(undefined)).toBeUndefined()
  })
})

describe('判定：codex → 自带搜索；其他 → 我们的链', () => {
  it('ChatGPT 订阅：先问自带搜索，结果照实标来源；WP353 的链一次都不碰；带回用量', async () => {
    const native = fakeNative(async () => ({
      sources: REDDIT.map((url) => ({ url, title: 'T', snippet: 'S' })),
      model: 'gpt-5.5',
      usage: USAGE,
    }))
    const pub = fakePublic(['https://example.com/p'])
    const { search } = setup({ native: native.port, pub: pub.keyless })
    const r = await search.search('site:reddit.com smart glasses', 8, CODEX)
    expect(r.via).toBe('native')
    expect(r.native_source).toBe('openai-codex')
    expect(r.content).toContain('这次的结果来自 ChatGPT 自带搜索')
    expect(r.sources.map((s) => s.url)).toEqual(REDDIT)
    // 工具面不变：仍是 url / title / snippet
    expect(r.sources[0]).toEqual({ url: REDDIT[0], title: 'T', snippet: 'S' })
    expect(r.native_usage).toEqual({ model: 'gpt-5.5', ...USAGE })
    expect(pub.queries).toEqual([])
    // 问自带搜索时带上：哪一家、谁、哪个模型、原句、搜索语言（决策 922，按品牌主市场）
    expect(native.calls).toEqual([
      {
        source: 'openai-codex',
        person_id: 'per_1',
        model: 'gpt-5.5',
        query: 'site:reddit.com smart glasses',
        maxResults: 8,
        locale: { language: 'en', market: 'US' },
      },
    ])
  })

  it('DeepSeek / 工坊积分 / API key / 没给模型来源：照旧走 WP353 的链，自带搜索一次都不问', async () => {
    const native = fakeNative(async () => ({ sources: [], usage: USAGE }))
    const pub = fakePublic(['https://example.com/p'])
    const { search } = setup({ native: native.port, pub: pub.keyless })
    for (const who of [
      { source: 'deepseek', model: 'deepseek-chat', person_id: 'per_1' },
      { source: 'agentsws_cloud', model: 'x' },
      { source: 'anthropic', model: 'claude-sonnet-4-5' },
      undefined,
    ]) {
      const r = await search.search(`q ${who?.source ?? 'none'}`, 5, who)
      expect(r.via).toBe('public')
      expect(r.native_usage).toBeUndefined()
    }
    expect(native.calls).toEqual([])
  })

  it('德国品牌：语言 de、市场 DE；中文查询：zh-CN、不带市场（与 WP353 同一套规矩）', async () => {
    const native = fakeNative(async () => ({ sources: [{ url: 'https://heise.de/a' }] }))
    const { search } = setup({ native: native.port, markets: ['DE'] })
    await search.search('smarte Brille Test', 5, CODEX)
    await search.search('IVRA 智能眼镜 竞品', 5, CODEX)
    expect(native.calls.map((c) => c.locale)).toEqual([
      { language: 'de', market: 'DE' },
      { language: 'zh-CN' },
    ])
  })
})

describe('退回 WP353 的链（照实标「来自哪一路」）', () => {
  it('自带搜索出错（没登录 / 超时 / 没真的去搜）→ 走链；前面那一路为什么没用上写进结果', async () => {
    const native = fakeNative(async () => {
      throw Object.assign(new Error('还没用 ChatGPT 订阅登录'), {
        code: 'WEB_PROVIDER_CREDENTIAL_MISSING',
      })
    })
    const pub = fakePublic(REDDIT)
    const { search } = setup({ native: native.port, pub: pub.keyless })
    const r = await search.search('site:reddit.com smart glasses', 8, CODEX)
    expect(r.via).toBe('public')
    expect(r.content).toContain('这次的结果来自公开搜索服务')
    expect(r.content).toContain('ChatGPT 自带搜索 这次没搜成（还没用 ChatGPT 订阅登录）')
    expect(pub.queries).toEqual(['site:reddit.com smart glasses'])
  })

  it('自带搜索回空、或回的都不在 site: 那个站上 → 走链；用量照样带回（订阅额度确实花了）', async () => {
    const native = fakeNative(async () => ({
      sources: [{ url: 'https://example.com/not-reddit' }],
      model: 'gpt-5.5',
      usage: USAGE,
    }))
    const pub = fakePublic(REDDIT)
    const { search } = setup({ native: native.port, pub: pub.keyless })
    const r = await search.search('site:reddit.com smart glasses', 8, CODEX)
    expect(r.via).toBe('public')
    expect(r.content).toContain('ChatGPT 自带搜索 没搜到相关结果')
    expect(r.native_usage).toEqual({ model: 'gpt-5.5', ...USAGE })
  })

  it('宿主没接自带搜索（测试 / 公司档）→ 名单里的来源也走链，说一句', async () => {
    const pub = fakePublic(REDDIT)
    const { search } = setup({ pub: pub.keyless })
    const r = await search.search('site:reddit.com smart glasses', 8, CODEX)
    expect(r.via).toBe('public')
    expect(r.content).toContain('ChatGPT 自带搜索 在这里没接上')
  })
})

describe('缓存、节流照旧在我们这一层', () => {
  it('同一句 7 天内命中缓存（不再花订阅额度），缓存那一句照实写来自自带搜索', async () => {
    const native = fakeNative(async () => ({ sources: [{ url: REDDIT[0] as string }] }))
    const { search } = setup({ native: native.port })
    await search.search('smart glasses', 5, CODEX)
    const again = await search.search('smart glasses', 5, CODEX)
    expect(native.calls).toHaveLength(1)
    expect(again.cached).toBe(true)
    expect(again.content).toContain('ChatGPT 自带搜索')
    expect(again.content).toContain('7 天内搜过同一句')
  })

  it('每小时上限满了：不再问自带搜索，这一次走链，不算失败', async () => {
    const native = fakeNative(async () => ({ sources: [{ url: 'https://example.com/n' }] }))
    const pub = fakePublic(['https://example.com/p'])
    const { search } = setup({ native: native.port, pub: pub.keyless, nativePerHour: 2 })
    for (const q of ['a', 'b', 'c']) await search.search(q, 5, CODEX)
    expect(native.calls.map((c) => c.query)).toEqual(['a', 'b'])
    const third = await search.search('d', 5, CODEX)
    expect(third.via).toBe('public')
    expect(third.content).toContain('这一小时 ChatGPT 自带搜索 已经搜了 2 次（上限）')
  })
})

describe('订阅那一半：用这个人自己的订阅，没登录就不起登录树', () => {
  function assembly(mode: 'local' | 'hosted' = 'local') {
    const secrets = createSecretStore({
      dbPath: ':memory:',
      clock: { now: () => '2026-10-16T10:00:00.000Z' },
      env: { [SECRETS_KEY_ENV]: randomBytes(32).toString('hex') },
    })
    const asked: { provider: string; request: NativeSearchRequest }[] = []
    let trees = 0
    const sub = createSubscription({
      clock: { now: () => '2026-10-16T10:00:00.000Z' },
      secrets,
      runtimeMode: () => mode,
      createLogin: async () => {
        trees += 1
        return {
          nativeSearch: async (provider, request) => {
            asked.push({ provider, request })
            return { sources: [{ url: 'https://example.com/a' }], model: 'gpt-5.5' }
          },
          dispose: async () => undefined,
        } as unknown as SubscriptionLoginHandle
      },
    })
    return { sub, secrets, asked, trees: () => trees }
  }

  it('没登录 → WEB_PROVIDER_CREDENTIAL_MISSING，登录树一棵都不起；登录了 → 用那个人的那一棵', async () => {
    const a = assembly()
    await expect(a.sub.nativeSearch('per_1', 'openai-codex', { query: 'x' })).rejects.toMatchObject(
      { code: 'WEB_PROVIDER_CREDENTIAL_MISSING' },
    )
    expect(a.trees()).toBe(0)
    a.secrets.put(subscriptionSecretId('per_1', 'openai-codex'), { record: '{"type":"oauth"}' })
    const got = await a.sub.nativeSearch('per_1', 'openai-codex', { query: 'x', maxResults: 3 })
    expect(got.sources).toEqual([{ url: 'https://example.com/a' }])
    expect(a.asked).toEqual([{ provider: 'openai-codex', request: { query: 'x', maxResults: 3 } }])
    // 别人的订阅不借：per_2 没登录就是没登录
    await expect(a.sub.nativeSearch('per_2', 'openai-codex', { query: 'x' })).rejects.toMatchObject(
      { code: 'WEB_PROVIDER_CREDENTIAL_MISSING' },
    )
    await expect(
      a.sub.nativeSearch(undefined, 'openai-codex', { query: 'x' }),
    ).rejects.toMatchObject({ code: 'WEB_PROVIDER_UNAVAILABLE' })
    a.secrets.close()
  })

  it('公司档 / 托管档：不用个人订阅搜（宿主退回 WP353 的链）', async () => {
    const a = assembly('hosted')
    await expect(a.sub.nativeSearch('per_1', 'openai-codex', { query: 'x' })).rejects.toMatchObject(
      { code: 'WEB_PROVIDER_UNAVAILABLE' },
    )
    a.secrets.close()
  })
})
