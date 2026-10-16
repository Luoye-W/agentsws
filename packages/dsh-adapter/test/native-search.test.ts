/**
 * WP355（决策 937）：ChatGPT 订阅自带的联网搜索——怎么问、怎么解析、令牌不经手。
 *
 * 对手方是 `fixtures/fake-openai.ts`（拦 `globalThis.fetch`，CI 一个包都不出网）：设备码登录一次，
 * 再经官方 pi-ai 打 `/codex/responses`，替身照 Codex 的样子回 `web_search_call` 块与带引用的回答。
 */
import {
  CompositeCredentials,
  envRefSource,
  type SubscriptionRecordSource,
} from '@agentsws/credentials-openconnector'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  codexSearchInput,
  createSubscriptionLogin,
  type SubscriptionLoginHandle,
  sourcesFromCodexOutput,
  withCodexWebSearch,
} from '../src/index.js'
import { type FakeOpenAi, installFakeOpenAi } from './fixtures/fake-openai.js'

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

/** Codex 回的样子（形状照 OpenAI Responses 的 `web_search_call` 与 `url_citation`；内容是编的）。 */
const SEARCH_CALL = {
  type: 'web_search_call',
  id: 'ws_1',
  status: 'completed',
  action: {
    type: 'search',
    query: 'site:reddit.com smart glasses',
    sources: [
      { type: 'url', url: 'https://www.reddit.com/r/SmartGlasses/comments/a1/compare/' },
      { type: 'url', url: 'https://www.reddit.com/r/augmentedreality/comments/b2/review/' },
    ],
  },
}
const LINE_1 = '- People compare 30+ smart glasses models side by side '
const LINE_2 = '- A long-term review of AR glasses for daily use '
const ANSWER_TEXT = `${LINE_1}(reddit.com)\n${LINE_2}(reddit.com)\nAlso see https://made-up.example.com/not-a-source`
const ANSWER = {
  type: 'message',
  id: 'msg_1',
  role: 'assistant',
  phase: 'final_answer',
  content: [
    {
      type: 'output_text',
      text: ANSWER_TEXT,
      annotations: [
        {
          type: 'url_citation',
          url: 'https://www.reddit.com/r/SmartGlasses/comments/a1/compare/?utm_source=openai',
          title: '30+ smartglasses models compared',
          start_index: LINE_1.length,
          end_index: LINE_1.length + 12,
        },
        {
          type: 'url_citation',
          url: 'https://www.reddit.com/r/augmentedreality/comments/b2/review/?utm_source=openai',
          title: 'Six months with AR glasses',
          start_index: LINE_1.length + 13 + LINE_2.length,
          end_index: LINE_1.length + 13 + LINE_2.length + 12,
        },
      ],
    },
  ],
}

describe('请求体与那一问', () => {
  it('加 web_search 工具（Codex CLI 的写法），别的字段一个不动；不认得的形状不改', () => {
    const body = { model: 'gpt-5.5', tools: [{ type: 'function', name: 'x' }], include: ['a'] }
    expect(withCodexWebSearch(body)).toEqual({
      model: 'gpt-5.5',
      tools: [
        { type: 'function', name: 'x' },
        { type: 'web_search', external_web_access: true },
      ],
      include: ['a'],
    })
    const full = withCodexWebSearch(
      { model: 'm' },
      { market: 'DE', tool: { externalWebAccess: null, userLocation: true, includeSources: true } },
    )
    expect(full).toEqual({
      model: 'm',
      tools: [{ type: 'web_search', user_location: { type: 'approximate', country: 'DE' } }],
      include: ['web_search_call.action.sources'],
    })
    expect(withCodexWebSearch('not a body')).toBeUndefined()
  })

  it('原样先搜这一句（site: 不改），带上搜索语言与市场', () => {
    const input = codexSearchInput('site:reddit.com smart glasses', 8, {
      language: 'de',
      market: 'DE',
    })
    expect(input).toContain('Search query: site:reddit.com smart glasses')
    expect(input).toContain('Search language: de; target market: DE.')
    expect(input).toContain('up to 8')
  })
})

describe('解析（社区插件 mapResponsesResponse + 我们补摘要）', () => {
  it('来源只认 web_search_call 与引用：标题、摘要、去掉 utm_source=openai、正文里自己写的网址不收', async () => {
    const sources = await sourcesFromCodexOutput([SEARCH_CALL, ANSWER], 10)
    expect(sources).toEqual([
      {
        url: 'https://www.reddit.com/r/SmartGlasses/comments/a1/compare/',
        title: '30+ smartglasses models compared',
        snippet: 'People compare 30+ smart glasses models side by side',
      },
      {
        url: 'https://www.reddit.com/r/augmentedreality/comments/b2/review/',
        title: 'Six months with AR glasses',
        snippet: 'A long-term review of AR glasses for daily use',
      },
    ])
    expect(JSON.stringify(sources)).not.toContain('made-up.example.com')
    expect(await sourcesFromCodexOutput([SEARCH_CALL, ANSWER], 1)).toHaveLength(1)
  })

  it('模型没搜、凭记忆答 → 报错（交给宿主退回 WP353 的链）', async () => {
    const noSearch = {
      ...ANSWER,
      content: [{ type: 'output_text', text: 'from memory', annotations: [] }],
    }
    await expect(sourcesFromCodexOutput([noSearch], 10)).rejects.toThrow(/without searching/)
  })
})

// ── 整条：设备码登录 → 官方 pi-ai 打 /codex/responses（带 web_search）→ 解析 ──────────

function memoryRecords(): SubscriptionRecordSource & { rows: Map<string, unknown> } {
  const rows = new Map<string, unknown>()
  return {
    rows,
    enabled: () => true,
    async read(provider) {
      const hit = rows.get(provider)
      return hit === undefined ? undefined : (JSON.parse(JSON.stringify(hit)) as unknown)
    },
    async write(provider, payload) {
      rows.set(provider, JSON.parse(JSON.stringify(payload)) as unknown)
    },
    async remove(provider) {
      rows.delete(provider)
    },
    async list() {
      return [...rows.keys()].sort()
    },
  }
}

const fakes: FakeOpenAi[] = []
const handles: SubscriptionLoginHandle[] = []
afterEach(async () => {
  for (const f of fakes.splice(0)) f.restore()
  for (const h of handles.splice(0)) await h.dispose()
})

async function signedIn(fake: FakeOpenAi): Promise<SubscriptionLoginHandle> {
  fakes.push(fake)
  const records = memoryRecords()
  const handle = await createSubscriptionLogin({
    credentials: class extends CompositeCredentials {
      constructor(ctx: Context) {
        super(ctx, { refs: envRefSource(), subscriptions: records })
      }
    },
  })
  handles.push(handle)
  const outcome = await handle.begin({
    provider: 'openai-codex',
    method: 'device',
    notify: () => undefined,
    ask: async () => {
      throw new Error('设备码流不该问任何问题')
    },
  })
  expect(outcome).toBe('authorized')
  return handle
}

describe('整条（替身 OpenAI，不出网）', () => {
  it('请求带 web_search 工具、结果按 url / title / snippet 交回、令牌不出现在结果里', async () => {
    const fake = installFakeOpenAi({ outputItems: () => [SEARCH_CALL, ANSWER] })
    const handle = await signedIn(fake)
    const got = await handle.nativeSearch?.('openai-codex', {
      query: 'site:reddit.com smart glasses',
      maxResults: 5,
      locale: { language: 'en', market: 'US' },
    })
    expect(got?.model).toBe('gpt-5.5')
    expect(got?.sources.map((s) => s.url)).toEqual([
      'https://www.reddit.com/r/SmartGlasses/comments/a1/compare/',
      'https://www.reddit.com/r/augmentedreality/comments/b2/review/',
    ])
    expect(got?.sources[0]?.snippet).toBe('People compare 30+ smart glasses models side by side')
    expect(got?.usage?.input_tokens).toBe(200)
    // 发出去的那一次：同一个 `/codex/responses`，工具里多了 web_search，问的是原句
    const body = fake.bodies.at(-1) as { tools?: unknown[]; input?: unknown; model?: string }
    expect(body.model).toBe('gpt-5.5')
    expect(body.tools).toContainEqual({ type: 'web_search', external_web_access: true })
    expect(JSON.stringify(body.input)).toContain('site:reddit.com smart glasses')
    // 令牌只在请求头（官方 pi-ai 自己加的），结果与请求体里都没有
    expect(fake.bearers.at(-1)).toBe(`Bearer ${fake.issued.at(-1)}`)
    for (const token of fake.issued) {
      expect(JSON.stringify(got)).not.toContain(token)
      expect(JSON.stringify(fake.bodies)).not.toContain(token)
    }
  })

  it('目录里没有的模型名退回默认；别家（Claude 订阅）没接自带搜索', async () => {
    const fake = installFakeOpenAi({ outputItems: () => [SEARCH_CALL, ANSWER] })
    const handle = await signedIn(fake)
    const got = await handle.nativeSearch?.('openai-codex', { query: 'x', model: 'no-such-model' })
    expect(got?.model).toBe('gpt-5.5')
    await expect(handle.nativeSearch?.('anthropic', { query: 'x' })).rejects.toMatchObject({
      code: 'WEB_PROVIDER_UNAVAILABLE',
    })
  })

  it('没登录 → WEB_PROVIDER_CREDENTIAL_MISSING，一次请求都不发', async () => {
    const fake = installFakeOpenAi({ outputItems: () => [SEARCH_CALL, ANSWER] })
    fakes.push(fake)
    const handle = await createSubscriptionLogin({
      credentials: class extends CompositeCredentials {
        constructor(ctx: Context) {
          super(ctx, { refs: envRefSource(), subscriptions: memoryRecords() })
        }
      },
    })
    handles.push(handle)
    await expect(handle.nativeSearch?.('openai-codex', { query: 'x' })).rejects.toMatchObject({
      code: 'WEB_PROVIDER_CREDENTIAL_MISSING',
    })
    expect(fake.responses).toBe(0)
  })

  it('Codex 回错 / 模型没搜 → 带机器码的错（宿主据此退回 WP353 的链）', async () => {
    const plain = { ...ANSWER, content: [{ type: 'output_text', text: 'hi', annotations: [] }] }
    const fake = installFakeOpenAi({ outputItems: () => [plain] })
    const handle = await signedIn(fake)
    await expect(handle.nativeSearch?.('openai-codex', { query: 'x' })).rejects.toMatchObject({
      code: 'WEB_PROVIDER_ERROR',
    })
  })
})
