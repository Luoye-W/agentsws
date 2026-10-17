/**
 * WP367（决策 919 后半条）：「用 DeepSeek 账号登录」那一路的模型目录从账号的 `GET /models` 取
 * （移植自官方 `@deepseek-ai/dsh-llm-deepseek-account@0.2.1-alpha.4`）。
 *
 * 四组：
 * (a) **解码**：`data` 数组逐条读；没 id / 重复的跳过；版本要求与能力照官方读法。
 * (b) **目录解析**：没清单 = 内置两个；声明了最低版本的按语义化版本比（含 alpha / rc）；
 *     没声明的只认内置 id；能力不够的拒；单模型覆盖不能加模型、不能救被拒的。
 * (c) **缓存**：第一次等、之后用缓存、老了后台刷新、单飞；失败 / 超时 / 401 退回内置（或保留上一份）；
 *     换账号重取；没登录不发请求；令牌只进 `x-dsh-auth-token` 头、不进日志。
 * (d) **推理口**：`listModels` 照清单（没登录回空）；被拒的模型发请求前就失败；输出上限取小的。
 *
 * 上游全是替身，不联网。
 */
import { describe, expect, it } from 'vitest'
import {
  type AccountFetch,
  AccountModelListingError,
  DEEPSEEK_ACCOUNT_BASE_URL,
  DEEPSEEK_ACCOUNT_MODELS,
  DeepSeekAccountModelCatalog,
  type DeepSeekAccountModelCatalogOptions,
  deepseekAccountProvider,
  GatewayError,
  type ListingFetch,
  listingEndpoint,
  parseModelListing,
  resolveAccountCatalog,
} from '../src/index.js'

const TOKEN = 'dsk_SECRET_TOKEN_models'
const LISTING_URL = 'https://api.deepseek.com/models'

/** 清单里的一条（照官方 `/models` 的形状）。 */
const row = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  api_capabilities: { anthropic_messages: {} },
  ...extra,
})

interface ListingSeen {
  url: string
  method: string
  redirect: string
  headers: Record<string, string>
}

/** 一个假的 `/models`：按次序回 `replies` 里的东西（最后一个重复用）。 */
function fakeListing(
  ...replies: (
    | { status?: number; body: unknown }
    | 'hang'
    | 'network'
    | ((seen: ListingSeen) => { status?: number; body: unknown })
  )[]
): { fetch: ListingFetch; seen: ListingSeen[] } {
  const seen: ListingSeen[] = []
  const fetch: ListingFetch = async (url, init) => {
    const s = { url, method: init.method, redirect: init.redirect, headers: init.headers }
    seen.push(s)
    const reply = replies[Math.min(seen.length - 1, replies.length - 1)]
    if (reply === 'network') throw new TypeError('fetch failed')
    if (reply === 'hang') {
      return new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
      })
    }
    const r = typeof reply === 'function' ? reply(s) : (reply ?? { body: {} })
    const status = r.status ?? 200
    return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(r.body) }
  }
  return { fetch, seen }
}

const signedIn = async (url: string): Promise<string | undefined> =>
  new URL(url).origin === 'https://api.deepseek.com' ? TOKEN : undefined

function catalogOf(
  fetch: ListingFetch,
  extra: Partial<DeepSeekAccountModelCatalogOptions> = {},
): { catalog: DeepSeekAccountModelCatalog; logs: string[] } {
  const logs: string[] = []
  const catalog = new DeepSeekAccountModelCatalog({
    resolveToken: signedIn,
    clientVersion: '0.2.1-alpha.4',
    builtin: DEEPSEEK_ACCOUNT_MODELS,
    baseUrl: DEEPSEEK_ACCOUNT_BASE_URL,
    fetch,
    log: { info: (m) => logs.push(`info ${m}`), warn: (m) => logs.push(`warn ${m}`) },
    ...extra,
  })
  return { catalog, logs }
}

const ids = (c: DeepSeekAccountModelCatalog): string[] => c.resolve().offered.map((m) => m.id)

describe('WP367 (a) 清单解码', () => {
  it('地址：Messages 根的源下的 /models（不可配）', () => {
    expect(listingEndpoint(DEEPSEEK_ACCOUNT_BASE_URL)).toBe(LISTING_URL)
    expect(listingEndpoint('https://api.deepseek.com/anthropic/v1/')).toBe(LISTING_URL)
  })

  it('没有 data 数组 / 一条可用的都没有：INVALID_RESPONSE', () => {
    expect(() => parseModelListing({})).toThrow(AccountModelListingError)
    expect(() => parseModelListing({ data: [{ name: 'x' }, 3] })).toThrow(/no model entry/)
  })

  it('没 id / 重复的跳过；版本要求与能力照官方读', () => {
    const listing = parseModelListing({
      data: [
        row('a', { name: 'A', input_modalities: ['image', 'text', 'audio'] }),
        row('a'),
        { name: 'no id' },
        row('b', { client_requirements: { 'deepseek-harness': { min_version: '0.3.0' } } }),
        row('c', { client_requirements: { 'deepseek-harness': { min_version: 3 } } }),
        row('d', { client_requirements: { other: { min_version: '9.0.0' } } }),
        { id: 'e' },
        row('f', { output_modalities: ['image'] }),
        row('g', { max_output_tokens: -1 }),
      ],
    })
    expect(listing.skipped).toBe(2)
    const byId = new Map(listing.entries.map((e) => [e.id, e]))
    expect(byId.get('a')).toEqual({
      id: 'a',
      name: 'A',
      requirement: { kind: 'none' },
      capabilities: { usable: true, facts: { inputModalities: ['image', 'text'] } },
    })
    expect(byId.get('b')?.requirement).toEqual({ kind: 'min-version', version: '0.3.0' })
    expect(byId.get('c')?.requirement).toEqual({ kind: 'invalid' })
    expect(byId.get('d')?.requirement).toEqual({ kind: 'none' })
    expect(byId.get('e')?.capabilities.usable).toBe(false)
    expect(byId.get('f')?.capabilities.usable).toBe(false)
    expect(byId.get('g')?.capabilities.usable).toBe(false)
  })
})

describe('WP367 (b) 目录解析：版本门槛 + 内置目录 + 单模型覆盖', () => {
  const resolve = (data: unknown[], clientVersion = '0.2.1-alpha.4', overrides = {}) =>
    resolveAccountCatalog({
      listing: parseModelListing({ data }).entries,
      builtin: DEEPSEEK_ACCOUNT_MODELS,
      clientVersion,
      overrides,
    })

  it('没清单：就是写死的那两个', () => {
    const r = resolveAccountCatalog({
      listing: undefined,
      builtin: DEEPSEEK_ACCOUNT_MODELS,
      clientVersion: '0.2.1-alpha.4',
    })
    expect(r.source).toBe('builtin')
    expect(r.offered).toEqual([
      { id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash', vision: true },
      { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', vision: false },
    ])
  })

  it('最低版本按语义化版本比：预发布号低于正式版，0.2.1 拒 0.2.1-alpha.4，0.2.1-alpha.0 收', () => {
    const need = (v: string) => ({
      client_requirements: { 'deepseek-harness': { min_version: v } },
    })
    const r = resolve([
      row('new-ok', need('0.2.1-alpha.0')),
      row('new-rc', need('0.2.1-rc.1')),
      row('new-release', need('0.2.1')),
      row('old', need('0.2.0')),
      row('junk', need('not-a-version')),
    ])
    expect(r.offered.map((m) => m.id)).toEqual(['new-ok', 'old'])
    expect(r.refusals.get('new-rc')).toEqual({
      kind: 'upgrade-required',
      requiredVersion: '0.2.1-rc.1',
    })
    expect(r.refusals.get('new-release')).toEqual({
      kind: 'upgrade-required',
      requiredVersion: '0.2.1',
    })
    expect(r.refusals.get('junk')).toEqual({ kind: 'unsupported' })
    expect(r.problems.join('\n')).toContain('unreadable client requirement')
  })

  it('没声明版本的：只认内置 id；名字 / 看图 / 输出上限取清单的', () => {
    const r = resolve([
      row('deepseek-v4-pro', {
        name: 'DeepSeek-V4-Pro (account)',
        input_modalities: ['text', 'image'],
        max_output_tokens: 4096,
        context_window: 1_000_000,
      }),
      row('deepseek-secret-preview'),
    ])
    expect(r.source).toBe('listing')
    expect(r.offered).toEqual([
      {
        id: 'deepseek-v4-pro',
        name: 'DeepSeek-V4-Pro (account)',
        vision: true,
        maxOutputTokens: 4096,
        contextWindow: 1_000_000,
      },
    ])
    // 清单里没有 deepseek-flash：不在下拉里，但也不算"被拒"（点名要它照样放行）
    expect(r.refusals.has('deepseek-flash')).toBe(false)
    expect(r.refusals.get('deepseek-secret-preview')).toEqual({ kind: 'unsupported' })
  })

  it('能力不够（没有 Messages 能力）的拒，并记一条原因', () => {
    const r = resolve([{ id: 'deepseek-flash' }])
    expect(r.offered).toEqual([])
    expect(r.refusals.get('deepseek-flash')).toEqual({ kind: 'unsupported' })
    expect(r.problems[0]).toContain('anthropic_messages')
  })

  it('modelOverrides：只调单个模型；不能加模型、不能救被拒的；写错的不生效并说出来', () => {
    const r = resolve(
      [
        row('deepseek-flash', { input_modalities: ['text', 'image'] }),
        row('later', { client_requirements: { 'deepseek-harness': { min_version: '9.0.0' } } }),
      ],
      '0.2.1-alpha.4',
      {
        'deepseek-flash': { maxTokens: 2048, name: 'Flash（调过）' },
        later: { maxTokens: 10 },
        ghost: { maxTokens: 10 },
      },
    )
    expect(r.offered).toEqual([
      { id: 'deepseek-flash', name: 'Flash（调过）', vision: true, maxOutputTokens: 2048 },
    ])
    expect(r.refusals.get('later')?.kind).toBe('upgrade-required')
    expect(r.overrideErrors.join('\n')).toContain('"ghost"')

    const bad = resolve([row('deepseek-flash')], '0.2.1-alpha.4', {
      'deepseek-flash': { maxTokens: -5 },
    })
    expect(bad.offered[0]?.maxOutputTokens).toBeUndefined()
    expect(bad.overrideErrors[0]).toContain('maxTokens')
  })
})

describe('WP367 (c) 缓存：按令牌一份、单飞、后台刷新、失败退回', () => {
  const LISTING = {
    data: [
      row('deepseek-flash', { name: 'DeepSeek-V4.1-Flash', input_modalities: ['text', 'image'] }),
      row('deepseek-v4-pro'),
      row('deepseek-v5', {
        input_modalities: ['text', 'image'],
        client_requirements: { 'deepseek-harness': { min_version: '0.2.1-alpha.3' } },
      }),
    ],
  }

  it('第一次等清单；请求是 GET、拒绝重定向、令牌只在 x-dsh-auth-token；之后用缓存', async () => {
    const { fetch, seen } = fakeListing({ body: LISTING })
    const { catalog, logs } = catalogOf(fetch)
    expect(ids(catalog)).toEqual(['deepseek-flash', 'deepseek-v4-pro'])

    const view = await catalog.view()
    expect(view.signedIn).toBe(true)
    expect(ids(catalog)).toEqual(['deepseek-flash', 'deepseek-v4-pro', 'deepseek-v5'])
    expect(catalog.model('deepseek-v5')?.vision).toBe(true)
    expect(seen).toEqual([
      {
        url: LISTING_URL,
        method: 'GET',
        redirect: 'error',
        headers: { accept: 'application/json', 'x-dsh-auth-token': TOKEN },
      },
    ])
    await catalog.view()
    await catalog.view()
    expect(seen.length).toBe(1)
    expect(logs.join('\n')).toContain('loaded 3 model(s)')
    expect(logs.join('\n')).not.toContain(TOKEN)
  })

  it('同时来几次：只发一个请求（单飞）', async () => {
    const { fetch, seen } = fakeListing({ body: LISTING })
    const { catalog } = catalogOf(fetch)
    await Promise.all([catalog.view(), catalog.view(), catalog.view()])
    expect(seen.length).toBe(1)
  })

  it('老过 maxAge：这一次照旧回、后台重取；到了就换，并通知装配方', async () => {
    let now = 0
    let loaded = 0
    const { fetch, seen } = fakeListing(
      { body: LISTING },
      { body: { data: [row('deepseek-flash')] } },
    )
    const { catalog } = catalogOf(fetch, {
      now: () => now,
      maxAgeMs: 1000,
      onLoaded: () => {
        loaded += 1
      },
    })
    await catalog.view()
    expect(loaded).toBe(1)
    now = 999
    await catalog.view()
    expect(seen.length).toBe(1)
    now = 1000
    const stale = await catalog.view()
    // 后台刷新：这一次回的还是上一份
    expect(stale.listing?.entries.length).toBe(3)
    await new Promise((r) => setTimeout(r, 0))
    expect(seen.length).toBe(2)
    expect(ids(catalog)).toEqual(['deepseek-flash'])
    expect(loaded).toBe(2)
  })

  it('一份都没拉到时失败：退回写死的两个；之前拉到过：保留上一份；连着失败只记一次', async () => {
    let now = 0
    const { fetch, seen } = fakeListing('network', { body: LISTING }, 'network')
    const { catalog, logs } = catalogOf(fetch, { now: () => now, maxAgeMs: 10 })
    await catalog.view()
    expect(catalog.resolve().source).toBe('builtin')
    expect(ids(catalog)).toEqual(['deepseek-flash', 'deepseek-v4-pro'])
    expect(logs.at(-1)).toContain('TRANSPORT')
    expect(logs.at(-1)).toContain('using the bundled catalog')

    now = 10
    await catalog.view()
    await new Promise((r) => setTimeout(r, 0))
    expect(ids(catalog)).toContain('deepseek-v5')

    now = 20
    await catalog.view()
    await new Promise((r) => setTimeout(r, 0))
    now = 30
    await catalog.view()
    await new Promise((r) => setTimeout(r, 0))
    expect(seen.length).toBe(4)
    expect(ids(catalog)).toContain('deepseek-v5')
    const fails = logs.filter((l) => l.includes('keeping the previous catalog'))
    expect(fails.length).toBe(1)
    expect(logs.join('\n')).not.toContain(TOKEN)
  })

  it('超时：最多等 timeoutMs，退回写死的两个（码是 TIMEOUT）', async () => {
    const { fetch } = fakeListing('hang')
    const { catalog, logs } = catalogOf(fetch, { timeoutMs: 20 })
    const started = Date.now()
    await catalog.view()
    expect(Date.now() - started).toBeLessThan(2000)
    expect(catalog.resolve().source).toBe('builtin')
    expect(logs.at(-1)).toContain('TIMEOUT')
  })

  it('清单回 401：退回写死的两个，不碰登录（这里没有 rejectToken 可调）', async () => {
    const { fetch } = fakeListing({ status: 401, body: { error: 'nope' } })
    const { catalog, logs } = catalogOf(fetch)
    const view = await catalog.view()
    expect(view.signedIn).toBe(true)
    expect(ids(catalog)).toEqual(['deepseek-flash', 'deepseek-v4-pro'])
    expect(logs.at(-1)).toContain('HTTP_401')
  })

  it('响应不是 JSON / 没 data：退回写死的两个', async () => {
    const { catalog, logs } = catalogOf(fakeListing({ body: { models: [] } }).fetch)
    await catalog.view()
    expect(catalog.resolve().source).toBe('builtin')
    expect(logs.at(-1)).toContain('INVALID_RESPONSE')
  })

  it('没登录：不发请求、signedIn=false；换了账号（令牌变了）就清掉上一份重取', async () => {
    let token: string | undefined
    const { fetch, seen } = fakeListing((s) =>
      s.headers['x-dsh-auth-token'] === 'tok-A'
        ? { body: LISTING }
        : { body: { data: [row('deepseek-v4-pro')] } },
    )
    const { catalog } = catalogOf(fetch, { resolveToken: async () => token })
    expect((await catalog.view()).signedIn).toBe(false)
    expect(seen.length).toBe(0)

    token = 'tok-A'
    await catalog.view()
    expect(ids(catalog)).toContain('deepseek-v5')
    token = 'tok-B'
    await catalog.view()
    expect(ids(catalog)).toEqual(['deepseek-v4-pro'])
    expect(seen.length).toBe(2)

    token = undefined
    const out = await catalog.view()
    expect(out.signedIn).toBe(false)
    expect(out.listing).toBeUndefined()
  })

  it('版本号可以现取（宿主是懒加载的）', async () => {
    let version = '0.2.1-alpha.2'
    const { catalog } = catalogOf(fakeListing({ body: LISTING }).fetch, {
      clientVersion: () => version,
    })
    await catalog.view()
    expect(catalog.refusal('deepseek-v5')).toEqual({
      kind: 'upgrade-required',
      requiredVersion: '0.2.1-alpha.3',
    })
    version = '0.2.1-alpha.4'
    expect(catalog.refusal('deepseek-v5')).toBeUndefined()
  })
})

describe('WP367 (d) 推理口带上目录', () => {
  function fakeMessages(): { fetch: AccountFetch; bodies: string[] } {
    const bodies: string[] = []
    const fetch: AccountFetch = async (_url, init) => {
      bodies.push(init.body)
      return {
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: 'text', text: 'ok' }], usage: {} }),
        text: async () => '',
      }
    }
    return { fetch, bodies }
  }

  const LISTING = {
    data: [
      row('deepseek-flash', { input_modalities: ['text', 'image'], max_output_tokens: 1024 }),
      row('deepseek-v5', {
        client_requirements: { 'deepseek-harness': { min_version: '0.3.0' } },
      }),
    ],
  }

  it('listModels 照账号清单；没登录回空（官方 discoverModels 同款）', async () => {
    const messages = fakeMessages()
    const { catalog } = catalogOf(fakeListing({ body: LISTING }).fetch)
    const p = deepseekAccountProvider({ resolveToken: signedIn, fetch: messages.fetch, catalog })
    expect((await p.listModels?.())?.map((m) => m.id)).toEqual(['deepseek-flash'])

    const out = catalogOf(fakeListing({ body: LISTING }).fetch, {
      resolveToken: async () => undefined,
    })
    const q = deepseekAccountProvider({
      resolveToken: async () => undefined,
      fetch: messages.fetch,
      catalog: out.catalog,
    })
    expect(await q.listModels?.()).toEqual([])
    expect(messages.bodies).toEqual([])
  })

  it('清单点名但这一版不给用的模型：发请求前就失败，说要更新；令牌不进错误', async () => {
    const messages = fakeMessages()
    const { catalog } = catalogOf(fakeListing({ body: LISTING }).fetch)
    const p = deepseekAccountProvider({
      resolveToken: signedIn,
      fetch: messages.fetch,
      catalog,
      model: 'deepseek-v5',
    })
    const err = await p.complete({ messages: [{ role: 'user', content: 'x' }] }).catch((e) => e)
    expect(err).toBeInstanceOf(GatewayError)
    expect(err.message).toContain('要更新版的工坊才能用')
    expect(err.message).toContain('0.3.0')
    expect(err.details).toMatchObject({ reason: 'client_upgrade_required' })
    expect(JSON.stringify(err)).not.toContain(TOKEN)
    expect(messages.bodies).toEqual([])
  })

  it('清单没提到的模型照样放行；输出上限取清单声明与默认里小的那个', async () => {
    const messages = fakeMessages()
    const { catalog } = catalogOf(fakeListing({ body: LISTING }).fetch)
    const flash = deepseekAccountProvider({
      resolveToken: signedIn,
      fetch: messages.fetch,
      catalog,
    })
    await flash.complete({ messages: [{ role: 'user', content: 'x' }] })
    expect(JSON.parse(messages.bodies[0] ?? '{}').max_tokens).toBe(1024)

    const pro = deepseekAccountProvider({
      resolveToken: signedIn,
      fetch: messages.fetch,
      catalog,
      model: 'deepseek-v4-pro',
    })
    await pro.complete({ messages: [{ role: 'user', content: 'x' }] })
    expect(JSON.parse(messages.bodies[1] ?? '{}')).toMatchObject({
      model: 'deepseek-v4-pro',
      max_tokens: 8192,
    })
  })

  it('清单取不到：内置目录，不设门槛，推理照常', async () => {
    const messages = fakeMessages()
    const { catalog } = catalogOf(fakeListing('network').fetch)
    const p = deepseekAccountProvider({
      resolveToken: signedIn,
      fetch: messages.fetch,
      catalog,
      model: 'deepseek-v5',
    })
    await p.complete({ messages: [{ role: 'user', content: 'x' }] })
    expect(messages.bodies.length).toBe(1)
    expect((await p.listModels?.())?.map((m) => m.id)).toEqual([
      'deepseek-flash',
      'deepseek-v4-pro',
    ])
  })
})
