/**
 * WP473（docs/116 §3 / §4 / §6 D）：缓存看得见、算得准。
 *
 * | 组 | 钉什么 |
 * |---|---|
 * | 功能标签 | 显式给的优先；没给按 purpose / run_id 前缀认；记进 `records()` 与 `model.usage` |
 * | 指纹 | 显式断点时只算断点之前；断点之后怎么变指纹都不变；越界拒；只发一条用户消息 = 0 |
 * | 写缓存 | Anthropic 系写缓存那部分按输入价 1.25 倍；没报写缓存的照旧 |
 * | 命中数 | 个别中转放在顶层 `usage.cached_tokens` 也认 |
 * | 分组键 | 只发哈希、不含工作区 / 职责 / 人名原文；同组同键、换组换键；OpenAI 本家带进 `prompt_cache_key` |
 */
import type { ModelMeta } from '@agentsws/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FetchLike, ModelUsagePayload } from '../src/index.js'
import {
  CACHE_WRITE_MULTIPLIER,
  costOf,
  createModelGateway,
  featureOf,
  loadOfficialRoutes,
  openaiCompatibleProvider,
  piRouteProvider,
  promptCacheKeyOf,
  staticPrefixHash,
  staticPrefixLength,
  stubProvider,
} from '../src/index.js'
import {
  type FakeOpenAi,
  GOOD_KEY,
  redirectFetch,
  startFakeOpenAi,
} from './fixtures/fake-openai.js'
import { fixedClock, meta, policy, recorder, systemPrompt, userPrompt } from './helpers.js'

describe('WP473 功能标签（用量页把「运行」拆开）', () => {
  const of = (run_id: string, over: Partial<ModelMeta> = {}) =>
    featureOf({ purpose: 'run', run_id: run_id as never, ...over })

  it('按 run_id 前缀认：岗位运行 / 客服聊天窗 / 邮件自动回 / SEO / B2B / 广告 / 社媒 / 其它', () => {
    expect(of('run_k3x9a1')).toBe('position_run')
    expect(of('run_chat_ses_1_2026-10-22T08:00:00Z')).toBe('support_chat')
    expect(of('run_chat_teach_ses_1_1')).toBe('support_chat')
    expect(of('run_email_auto_mat_1_3')).toBe('email_auto_reply')
    expect(of('run_seo_c12')).toBe('seo')
    expect(of('run_geo_2026-W43')).toBe('seo')
    expect(of('run_b2b_inquiry_d1')).toBe('b2b')
    expect(of('run_b2bsales_r1')).toBe('b2b')
    expect(of('adcopy_headline_abc')).toBe('ads')
    expect(of('run_ads_a1')).toBe('ads')
    expect(of('run_reddit_r1')).toBe('social')
    expect(of('reddit_watch_7')).toBe('social')
    expect(of('social_tag_review_3')).toBe('social')
    expect(of('matter_title_x')).toBe('other')
    expect(of('run_message_triage')).toBe('other')
    expect(of('')).toBe('other')
  })

  it('助理：purpose free_chat 或段小结 fchat_；显式给的永远优先', () => {
    expect(featureOf({ purpose: 'free_chat', run_id: 'whatever' as never })).toBe('assistant')
    expect(of('fchat_segment_sum1')).toBe('assistant')
    expect(of('run_chat_ses_1', { feature: 'b2b' })).toBe('b2b')
  })

  it('网关把功能记进 records() 与 model.usage', async () => {
    const rec = recorder()
    const gw = createModelGateway({
      providers: [stubProvider({ seed: 3 })],
      policy: policy(),
      clock: fixedClock(),
      eventSink: rec.sink,
      env: {},
    })
    await gw.complete({
      messages: [systemPrompt('p'), userPrompt('q')],
      meta: meta({ run_id: 'run_chat_ses_9_1' as never }),
    })
    await gw.complete({
      messages: [systemPrompt('p'), userPrompt('q')],
      meta: meta({ run_id: 'run_abc123' as never }),
    })
    await gw.complete({
      messages: [userPrompt('q')],
      meta: meta({ run_id: 'run_x' as never, feature: 'seo' }),
    })
    expect(gw.records().map((r) => r.feature)).toEqual(['support_chat', 'position_run', 'seo'])
    const payloads = rec.ofType('model.usage').map((e) => e.payload as ModelUsagePayload)
    expect(payloads.map((p) => p.feature)).toEqual(['support_chat', 'position_run', 'seo'])
  })
})

describe('WP473 前缀指纹：调用方给断点就按断点算', () => {
  const persona = systemPrompt('固定的岗位说明')
  const skills = systemPrompt('# skills\n- a')
  const state = (n: number) => systemPrompt(`[position_state:ps]\n待定 ${n} 张`)

  it('断点之前一样 → 指纹一样；断点之后的系统消息怎么变都不影响', () => {
    const a = [persona, skills, state(1), userPrompt('q1')]
    const b = [persona, skills, state(7), userPrompt('q2')]
    expect(staticPrefixLength(a, [2])).toBe(2)
    expect(staticPrefixHash(a, [], [2])).toBe(staticPrefixHash(b, [], [2]))
    // 不给断点 = 开头连续的系统消息（把每次都变的状态也算进去，指纹就每次都变）
    expect(staticPrefixHash(a)).not.toBe(staticPrefixHash(b))
    // 断点之前变了就必然不同
    expect(staticPrefixHash([systemPrompt('改过的说明'), skills], [], [2])).not.toBe(
      staticPrefixHash(a, [], [2]),
    )
  })

  it('越界的断点拒；只发一条用户消息 = 0', () => {
    expect(() => staticPrefixLength([persona], [2])).toThrow(/out of range/)
    expect(() => staticPrefixLength([persona], [-1])).toThrow(/out of range/)
    expect(staticPrefixLength([userPrompt('只有这一条')])).toBe(0)
    expect(staticPrefixLength([userPrompt('只有这一条')], [0])).toBe(0)
  })

  it('网关记进 model.usage 的指纹按请求里的 cache_breakpoints 算', async () => {
    const rec = recorder()
    const gw = createModelGateway({
      providers: [stubProvider({ seed: 1 })],
      policy: policy(),
      clock: fixedClock(),
      eventSink: rec.sink,
      env: {},
    })
    for (const n of [1, 2]) {
      await gw.complete({
        messages: [persona, skills, state(n), userPrompt(`q${n}`)],
        cache_breakpoints: [2],
        meta: meta(),
      })
    }
    const [first, second] = rec
      .ofType('model.usage')
      .map((e) => (e.payload as ModelUsagePayload).static_prefix_hash)
    expect(first).toBe(second)
    expect(first).toBe(staticPrefixHash([persona, skills, state(1)], [], [2]))
  })
})

describe('WP473 写缓存按 1.25 倍、顶层命中数也认', () => {
  const price = { in: 1_000, out: 2_000, cached: 100 }

  it('写缓存那部分按输入价 × 1.25；命中按 cached；其余按 in', () => {
    expect(CACHE_WRITE_MULTIPLIER).toBe(1.25)
    const cost = costOf(price, {
      input_tokens: 1_000,
      output_tokens: 100,
      cached_tokens: 300,
      cache_write_tokens: 200,
    })
    expect(cost).toBeCloseTo((500 * 1_000 + 200 * 1_250 + 300 * 100 + 100 * 2_000) / 1e6, 12)
    // 没报写缓存的：与以前一样
    expect(
      costOf(price, { input_tokens: 1_000, output_tokens: 0, cached_tokens: 300 }),
    ).toBeCloseTo((700 * 1_000 + 300 * 100) / 1e6, 12)
    // 报多了也不超过输入
    expect(
      costOf(price, {
        input_tokens: 100,
        output_tokens: 0,
        cached_tokens: 0,
        cache_write_tokens: 999,
      }),
    ).toBeCloseTo((100 * 1_250) / 1e6, 12)
  })

  it('个别中转把命中数放在顶层 usage.cached_tokens', async () => {
    const fetch: FetchLike = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 100, completion_tokens: 5, cached_tokens: 64 },
      }),
      text: async () => '',
    })
    const provider = openaiCompatibleProvider({
      apiKeyEnv: 'AGENTSWS_TEST_KEY',
      env: { AGENTSWS_TEST_KEY: 'test-value-not-a-real-credential' },
      model: 'deepseek-chat',
      fetch,
    })
    const out = await provider.complete({ messages: [userPrompt('q')] })
    expect(out.usage.cached_tokens).toBe(64)
  })
})

describe('WP473 缓存分组键（OpenAI 系 prompt_cache_key / 订阅会话标识）', () => {
  const base = {
    workspace_id: 'ws_luoye@example.com' as never,
    role_id: 'support.aftersales' as never,
  }

  it('只发哈希：不含工作区、职责、段或人名原文；同组同键、换组换键', () => {
    const key = promptCacheKeyOf(base)
    expect(key).toMatch(/^aw_[0-9a-f]{32}$/)
    expect(key).not.toContain('luoye')
    expect(key).not.toContain('example')
    expect(key).not.toContain('aftersales')
    expect(promptCacheKeyOf({ ...base })).toBe(key)
    expect(promptCacheKeyOf({ ...base, role_id: 'seo.content' as never })).not.toBe(key)
    const seg = promptCacheKeyOf({ ...base, cache_scope: 'assistant_segment:seg_张三' })
    expect(seg).toMatch(/^aw_[0-9a-f]{32}$/)
    expect(seg).not.toContain('张三')
    expect(seg).not.toBe(key)
    expect(promptCacheKeyOf(undefined)).toBeUndefined()
  })

  describe('OpenAI 本家（官方 pi-ai 路）', () => {
    let fake: FakeOpenAi
    beforeAll(async () => {
      fake = await startFakeOpenAi()
      await loadOfficialRoutes()
    })
    afterAll(async () => {
      await fake.close()
    })

    it('请求里带 prompt_cache_key = 分组键', async () => {
      const baseUrl = 'https://api.openai.com/v1'
      const fetch = redirectFetch(new URL(baseUrl).origin, fake.url)
      const provider = piRouteProvider({
        baseUrl,
        model: 'gpt-5.5',
        provider: 'mine',
        apiKey: () => GOOD_KEY,
        fetch,
        fallback: openaiCompatibleProvider({
          baseUrl,
          model: 'gpt-5.5',
          provider: 'mine',
          apiKey: () => GOOD_KEY,
          fetch: fetch as never,
        }),
      })
      const m = meta({ role_id: 'support.aftersales' as never })
      await provider.complete({ messages: [userPrompt('你好')], meta: m })
      const body = fake.requests.at(-1)?.body ?? {}
      expect(body.prompt_cache_key).toBe(promptCacheKeyOf(m))
    })
  })
})
