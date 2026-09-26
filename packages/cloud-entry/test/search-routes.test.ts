/**
 * WP155：`/v1/data/search/*`——官方数据接口的钱与口径（不联网，上游全是录好的替身）。
 *
 * 每个用例锁一条「反过来做会出事」的规矩（docs/81 §4，与 docs/75 §2 同一套）：
 * - 先预扣再取数，余额不够 402、上游一下都不打；
 * - 失败 / 超时整笔释放，一分不扣；
 * - 命中缓存照收同价，我方成本记 0；
 * - 搜到 0 条（也没有 AI 概览）不收钱；
 * - AI 问答每个平台一次，只收成功的；
 * - 没开通 501 一分不扣；错误信息里没有服务商名、没有 key。
 */
import { buildPricing, MemoryWalletStore, Wallet } from '@agentsws/metering'
import { describe, expect, it } from 'vitest'
import { createEntryApp } from '../src/routes.js'
import { MemorySearchCache } from '../src/search/cache.js'
import type { SearchFetch } from '../src/search/provider.js'
import type { EntryDeps, FetchLike } from '../src/types.js'
import { abortError, fakeFetch, fixture } from './search-fakes.js'

const NOW = '2026-09-26T08:00:00.000Z'
const SEARCH_KEY = 'svc-login:not-a-real-password'
const TOKENS: Record<
  string,
  { account_id: string; org_id: string; workspace_id: string; scopes: string[] }
> = {
  wst_data: {
    account_id: 'acc_1',
    org_id: 'org_1',
    workspace_id: 'ws_1',
    scopes: ['data', 'wallet:read'],
  },
  wst_no_data: { account_id: 'acc_2', org_id: 'org_1', workspace_id: 'ws_1', scopes: ['ai'] },
}

function harness(fetch: SearchFetch, over: Partial<EntryDeps> = {}) {
  let seq = 0
  let now = NOW
  const store = new MemoryWalletStore()
  const wallet = new Wallet({ store, now: () => now, newId: (p) => `${p}_${++seq}` })
  wallet.topup({ org_id: 'org_1', credits: 10, kind: 'purchased' })
  const app = createEntryApp({
    verifier: async (t) => TOKENS[t],
    wallet,
    pricing: buildPricing(),
    upstream: {
      ai: { base_url: 'https://upstream.invalid/v1', api_key: () => 'x' },
      search: { provider: 'dataforseo', api_key: () => SEARCH_KEY },
    },
    searchCache: new MemorySearchCache(),
    now: () => now,
    newRequestId: () => `req_${++seq}`,
    fetch: fetch as unknown as FetchLike,
    ...over,
  })
  const post = (path: string, body: unknown, token = 'wst_data') =>
    app.fetch(
      new Request(`http://entry${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    )
  const get = (path: string, token = 'wst_data') =>
    app.fetch(new Request(`http://entry${path}`, { headers: { Authorization: `Bearer ${token}` } }))
  return {
    wallet,
    store,
    post,
    get,
    later: (ms: number) => {
      now = new Date(Date.parse(now) + ms).toISOString()
    },
  }
}

const Q = { query: 'best portable charger', engine: 'google', country: 'us', language: 'en' }
const PROBE = {
  question: 'best portable charger for iphone',
  platforms: ['chatgpt', 'perplexity', 'copilot'],
  country: 'us',
  language: 'en',
  brand: { name: 'Voltbrick', domains: ['voltbrick.com'] },
  competitors: [{ name: 'Anker', domains: ['anker.com'] }, { name: 'Belkin' }, { name: 'Mophie' }],
}
const available = (w: Wallet) => w.balance('org_1').available

describe('状态口（不收钱）', () => {
  it('开通了：能查的引擎 / 平台 / 单价；没开通：如实说；缺 data 权限 403', async () => {
    const h = harness(fakeFetch([]).fetch)
    const s = (await (await h.get('/v1/data/search/status')).json()) as Record<string, unknown>
    expect(s).toMatchObject({
      configured: true,
      route: 'official',
      engines: ['google', 'bing'],
      prices: { serp: 0.2, ai_answer: 0.4 },
    })
    expect(s.platforms).not.toContain('copilot')
    expect(JSON.stringify(s)).not.toMatch(/dataforseo/i)
    const off = harness(fakeFetch([]).fetch, { upstream: { ai: { base_url: 'x', api_key: 'x' } } })
    expect(await (await off.get('/v1/data/search/status')).json()).toMatchObject({
      configured: false,
      route: 'none',
    })
    expect((await h.get('/v1/data/search/status', 'wst_no_data')).status).toBe(403)
  })
})

describe('SERP 一次', () => {
  it('预扣 → 取数 → 结算 0.2；source 写 official；计量事件带我方成本', async () => {
    const f = fakeFetch([
      ['/serp/google/organic/live/advanced', { body: fixture('dataforseo-google-serp') }],
    ])
    const h = harness(f.fetch)
    const res = await h.post('/v1/data/search/serp', Q)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body).toMatchObject({ source: 'official', credits: 0.2, cached: false, fetched_at: NOW })
    expect((body.items as unknown[]).length).toBe(5)
    expect(available(h.wallet)).toBeCloseTo(9.8, 6)
    const ev = h.store.events({ org_id: 'org_1' }).at(-1)
    expect(ev).toMatchObject({
      capability: 'data.search.serp',
      quantity: 1,
      credits: 0.2,
      provider: 'dataforseo',
    })
    expect(ev?.cost_micros).toBeGreaterThan(0)
  })

  it('命中缓存：照收同价、我方成本 0、上游只打一次', async () => {
    const f = fakeFetch([['/serp/', { body: fixture('dataforseo-google-serp') }]])
    const h = harness(f.fetch)
    await h.post('/v1/data/search/serp', Q)
    h.later(60_000)
    const again = (await (
      await h.post('/v1/data/search/serp', { ...Q, query: 'Best Portable Charger ' })
    ).json()) as Record<string, unknown>
    expect(again).toMatchObject({ credits: 0.2, cached: true, fetched_at: NOW })
    expect(f.calls).toHaveLength(1)
    expect(available(h.wallet)).toBeCloseTo(9.6, 6)
    expect(h.store.events({ org_id: 'org_1' }).at(-1)?.cost_micros).toBe(0)
  })

  it('上游失败 / 超时：整笔释放一分不扣；信息里没有服务商名与 key', async () => {
    for (const reply of [
      { status: 500, body: { status_message: `boom ${SEARCH_KEY}` } },
      abortError,
    ] as const) {
      const h = harness(fakeFetch([['/serp/', reply]]).fetch)
      const res = await h.post('/v1/data/search/serp', Q)
      expect([502, 504]).toContain(res.status)
      const text = await res.text()
      expect(text).toMatch(/没有扣积分/)
      expect(text).not.toMatch(/dataforseo/i)
      expect(text).not.toContain(SEARCH_KEY)
      expect(h.wallet.balance('org_1')).toMatchObject({ available: 10, reserved: 0 })
    }
  })

  it('搜到 0 条（也没有 AI 概览）不收钱', async () => {
    const empty = { status_code: 20000, tasks: [{ status_code: 20000, result: [{ items: [] }] }] }
    const h = harness(fakeFetch([['/serp/', { body: empty }]]).fetch)
    const body = (await (await h.post('/v1/data/search/serp', Q)).json()) as Record<string, unknown>
    expect(body.credits).toBe(0)
    expect(available(h.wallet)).toBe(10)
  })

  it('余额不够 402，上游一下都不打；没开通 501 一分不扣；参数不对 400', async () => {
    const f = fakeFetch([['/serp/', { body: fixture('dataforseo-google-serp') }]])
    const poor = harness(f.fetch)
    poor.wallet.topup({ org_id: 'org_2', credits: 1, kind: 'purchased' })
    const broke = harness(f.fetch, {
      verifier: async () => ({
        account_id: 'a',
        org_id: 'org_empty',
        workspace_id: 'w',
        scopes: ['data'],
      }),
    })
    expect((await broke.post('/v1/data/search/serp', Q)).status).toBe(402)
    expect(f.calls).toHaveLength(0)
    const off = harness(f.fetch, {
      upstream: {
        ai: { base_url: 'x', api_key: 'x' },
        search: { provider: 'dataforseo', api_key: () => undefined },
      },
    })
    expect((await off.post('/v1/data/search/serp', Q)).status).toBe(501)
    expect(available(off.wallet)).toBe(10)
    expect((await poor.post('/v1/data/search/serp', { ...Q, country: 'usa' })).status).toBe(400)
  })
})

describe('AI 问答（每个平台一次，只收成功的）', () => {
  it('ChatGPT + Perplexity 成功、Copilot 官方探测不了：预扣 2 次、结算 2 次；判出提没提到我们与竞品', async () => {
    const f = fakeFetch([
      ['/chat_gpt/llm_scraper/', { body: fixture('dataforseo-chatgpt-scraper') }],
      ['/perplexity/llm_responses/', { body: fixture('dataforseo-perplexity') }],
    ])
    const h = harness(f.fetch)
    const res = await h.post('/v1/data/search/ai-answers', PROBE)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      results: Record<string, unknown>[]
      skipped: Record<string, unknown>[]
      credits: number
    }
    expect(body.credits).toBe(0.8)
    expect(body.skipped).toEqual([
      expect.objectContaining({ platform: 'copilot', code: 'unsupported' }),
    ])
    const chatgpt = body.results.find((r) => r.platform === 'chatgpt')
    expect(chatgpt).toMatchObject({
      brand_mentioned: false,
      our_domain_cited: false,
      competitors_mentioned: ['Anker', 'Belkin'],
      source: 'official',
      credits: 0.4,
    })
    const pplx = body.results.find((r) => r.platform === 'perplexity')
    expect(pplx).toMatchObject({
      brand_mentioned: true,
      our_domain_cited: true,
      competitors_mentioned: ['Anker'],
    })
    expect(available(h.wallet)).toBeCloseTo(9.2, 6)
    expect(h.store.events({ org_id: 'org_1' }).at(-1)).toMatchObject({
      capability: 'data.search.ai_answer',
      quantity: 2,
      credits: 0.8,
    })
  })

  it('一个平台失败、一个空回答：都不收；一个都没成就整笔释放并报错', async () => {
    const nullText = structuredClone(fixture('dataforseo-perplexity')) as {
      tasks: { result: { items: { sections: { text: unknown }[] }[] }[] }[]
    }
    const sec = nullText.tasks[0]?.result[0]?.items[0]?.sections[0]
    if (sec !== undefined) sec.text = null
    const h = harness(
      fakeFetch([
        ['/chat_gpt/', { status: 500, body: {} }],
        ['/perplexity/', { body: nullText }],
        ['/gemini/', { body: fixture('dataforseo-chatgpt-scraper') }],
      ]).fetch,
    )
    const ok = (await (
      await h.post('/v1/data/search/ai-answers', {
        ...PROBE,
        platforms: ['chatgpt', 'perplexity', 'gemini'],
      })
    ).json()) as {
      results: unknown[]
      skipped: { platform: string }[]
      credits: number
    }
    expect(ok.results).toHaveLength(1)
    expect(ok.skipped.map((s) => s.platform).sort()).toEqual(['chatgpt', 'perplexity'])
    expect(ok.credits).toBe(0.4)
    expect(available(h.wallet)).toBeCloseTo(9.6, 6)

    const none = harness(fakeFetch([['/chat_gpt/', abortError]]).fetch)
    const res = await none.post('/v1/data/search/ai-answers', { ...PROBE, platforms: ['chatgpt'] })
    expect(res.status).toBe(504)
    expect(none.wallet.balance('org_1')).toMatchObject({ available: 10, reserved: 0 })
  })

  it('命中缓存照收同价；只选了官方探测不了的平台 400 不收', async () => {
    const f = fakeFetch([['/chat_gpt/', { body: fixture('dataforseo-chatgpt-scraper') }]])
    const h = harness(f.fetch)
    await h.post('/v1/data/search/ai-answers', { ...PROBE, platforms: ['chatgpt'] })
    const again = (await (
      await h.post('/v1/data/search/ai-answers', { ...PROBE, platforms: ['chatgpt'] })
    ).json()) as {
      results: { cached: boolean; credits: number }[]
    }
    expect(again.results[0]).toMatchObject({ cached: true, credits: 0.4 })
    expect(f.calls).toHaveLength(1)
    expect(available(h.wallet)).toBeCloseTo(9.2, 6)
    expect(h.store.events({ org_id: 'org_1' }).at(-1)?.cost_micros).toBe(0)
    expect(
      (await h.post('/v1/data/search/ai-answers', { ...PROBE, platforms: ['copilot'] })).status,
    ).toBe(400)
    expect(available(h.wallet)).toBeCloseTo(9.2, 6)
  })
})
