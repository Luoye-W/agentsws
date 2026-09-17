/**
 * WP90（55 §9 Q8）：用 ChatGPT / Claude 的**订阅**登录。
 *
 * 六组，对应派工单的四件事：
 *
 * (a) **组合**：挂了官方 `dsh-llm-pi-ai` 之后，`openai-codex` / `anthropic` 与我们的
 *     `agentsws-gateway` 在同一棵树上按 provider 名并存；不走订阅的运行里一个都不挂。
 * (b) **登录**：设备码流跑到底 → 记录落进本机库 → 状态是脱敏的 → 登出销毁。
 * (c) **刷新**：到期前那一次刷新经官方 `modifyRecord` 回写，新令牌落库、旧的不再用。
 * (d) **公司档**：`enabled()` 为假时读一律"不存在"、写一律拒、登录直接失败。
 * (e) **运行**：一次带工具调用的运行真的走官方适配器；用量投影进我们的账、
 *     `cost_base` 恒为 0；预算超了就停。
 * (f) **零泄漏**：token 一个字节都不在事件、不在日志、不在任何状态返回值里。
 *
 * 对手方是 `fixtures/fake-openai.ts`——一个拦 `globalThis.fetch` 的替身
 * （设备码端点 + token 端点 + 刷新 + `/codex/responses`）。**CI 一个包都不出网**：
 * 替身不认识的请求当场抛。
 */

import type { RunEvent } from '@agentsws/contracts'
import { canonicalJson } from '@agentsws/core'
import {
  CompositeCredentials,
  envRefSource,
  type SubscriptionRecordSource,
} from '@agentsws/credentials-openconnector'
import { Context } from '@deepseek-ai/cordis'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createDshRuntime,
  createSubscriptionLogin,
  GATEWAY_PROVIDER,
  installSubscriptionLlm,
  isSubscriptionProvider,
  maskAccount,
  SUBSCRIPTION_FACTS,
  SUBSCRIPTION_PROVIDERS,
  SUBSCRIPTION_RISK_NOTE,
  type SubscriptionLoginHandle,
  subscriptionPiAiConfig,
  subscriptionProviderOf,
  subscriptionRecordKey,
  watchSubscriptionCalls,
} from '../src/index.js'
import { ACCOUNT_ID, type FakeOpenAi, installFakeOpenAi } from './fixtures/fake-openai.js'
import { baseOptions, collect, makeRequest, ORDER, typesOf } from './helpers.js'

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

const NO_ABORT = (): AbortSignal => new AbortController().signal

/**
 * 本机加密秘密库的**内存替身**：语义与 `apps/server` 那个 sqlite 库一致——
 * 一条一个 provider、值经 JSON 往返（那边是加密后落盘，这边是序列化），
 * `enabled()` 就是"个人档 + 本人 + 有密钥"那一条闸。
 */
function memoryRecords(enabled: () => boolean = () => true): SubscriptionRecordSource & {
  rows: Map<string, unknown>
} {
  const rows = new Map<string, unknown>()
  return {
    rows,
    enabled,
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

function credentialsPlugin(records: SubscriptionRecordSource): unknown {
  return class extends CompositeCredentials {
    constructor(ctx: Context) {
      super(ctx, { refs: envRefSource(), subscriptions: records })
    }
  }
}

const fakes: FakeOpenAi[] = []
const logins: SubscriptionLoginHandle[] = []
afterEach(async () => {
  for (const f of fakes.splice(0)) f.restore()
  for (const l of logins.splice(0)) await l.dispose()
})

function fakeOpenAi(...args: Parameters<typeof installFakeOpenAi>): FakeOpenAi {
  const f = installFakeOpenAi(...args)
  fakes.push(f)
  return f
}

async function loginHandle(records: SubscriptionRecordSource): Promise<SubscriptionLoginHandle> {
  const handle = await createSubscriptionLogin({ credentials: credentialsPlugin(records) })
  logins.push(handle)
  return handle
}

/** 走完一次设备码登录（替身第二次轮询就"点完了"）。 */
async function signIn(
  handle: SubscriptionLoginHandle,
): Promise<{ message: string; url?: string; code?: string }[]> {
  const notices: { message: string; url?: string; code?: string }[] = []
  const outcome = await handle.begin({
    provider: 'openai-codex',
    method: 'device',
    notify: (n) => notices.push(n),
    ask: async () => {
      throw new Error('设备码流不该问任何问题')
    },
  })
  expect(outcome).toBe('authorized')
  return notices
}

// ── (a) 组合 ───────────────────────────────────────────────────────────

describe('(a) 组合：两个订阅 provider 与网关按名字并存', () => {
  it('只开 openai-codex 与 anthropic 两个 provider，一个不多', () => {
    expect([...SUBSCRIPTION_PROVIDERS]).toEqual(['openai-codex', 'anthropic'])
    expect(Object.keys(subscriptionPiAiConfig().providers).sort()).toEqual([
      'anthropic',
      'openai-codex',
    ])
    // profile 全空：端点、协议、模型目录一律继承 pi-ai 的（我们不抄一份）
    for (const p of Object.values(subscriptionPiAiConfig().providers)) {
      expect(Object.keys(p)).toHaveLength(0)
    }
    expect(isSubscriptionProvider('openai-codex')).toBe(true)
    expect(isSubscriptionProvider('deepseek')).toBe(false)
    expect(subscriptionProviderOf('anthropic')).toBe('anthropic')
    expect(subscriptionProviderOf('stub')).toBeUndefined()
  })

  it('挂上官方插件后 ctx.llm 上三个 provider 并存，各占各的名字', async () => {
    const root = new Context()
    root.plugin(LlmRuntime)
    root.plugin(credentialsPlugin(memoryRecords()) as never, undefined as never)
    await installSubscriptionLlm(root)
    const ctx = await new Promise<Context>((resolve) => {
      root.plugin({ name: 't', inject: ['llm'], apply: (c: Context) => resolve(c) })
    })
    // 我们的网关适配器照挂，两边互不知道对方存在
    class Noop extends LlmAdapter {
      override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
        return { provider, id: model, name: model }
      }
      override async *stream(): AsyncIterable<StreamChunk> {
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    const release = ctx.llm.registerAdapter([GATEWAY_PROVIDER], new Noop())
    const ids = ctx.llm.listProviders().map((p) => p.id)
    expect(ids).toContain(GATEWAY_PROVIDER)
    expect(ids).toContain('openai-codex')
    expect(ids).toContain('anthropic')
    // 目录来自 pi-ai，不是我们抄的清单
    const models = await ctx.llm.listModels('anthropic')
    expect(models.length).toBeGreaterThan(0)
    expect(models.some((m) => m.id.startsWith('claude-'))).toBe(true)
    release()
    await root.fiber.dispose()
  })

  it('不走订阅的运行里连插件都不装（ctx.llm 上只有网关）', async () => {
    const root = new Context()
    root.plugin(LlmRuntime)
    const ctx = await new Promise<Context>((resolve) => {
      root.plugin({ name: 't', inject: ['llm'], apply: (c: Context) => resolve(c) })
    })
    expect(ctx.llm.listProviders().map((p) => p.id)).not.toContain('openai-codex')
    await root.fiber.dispose()
  })

  it('两张卡的方式是实测出来的：ChatGPT 有设备码，Claude 只有浏览器', () => {
    const chatgpt = SUBSCRIPTION_FACTS.find((f) => f.id === 'openai-codex')
    const claude = SUBSCRIPTION_FACTS.find((f) => f.id === 'anthropic')
    expect(chatgpt?.methods).toEqual(['device', 'browser'])
    expect(claude?.methods).toEqual(['browser'])
    expect(SUBSCRIPTION_RISK_NOTE).toContain('没有得到 OpenAI / Anthropic 的明文授权')
    expect(SUBSCRIPTION_RISK_NOTE).toContain('账号只属于你本人')
  })
})

// ── (b) 登录 ───────────────────────────────────────────────────────────

describe('(b) 设备码登录：记录进本机库，状态脱敏', () => {
  it('登录 → 用户码与验证页回给界面 → 记录落库 → 状态是脱敏的 → 登出销毁', async () => {
    const fake = fakeOpenAi()
    const records = memoryRecords()
    const handle = await loginHandle(records)

    expect(await handle.status('openai-codex')).toEqual({
      provider: 'openai-codex',
      signed_in: false,
    })

    const notices = await signIn(handle)
    // 设备码那一条：一个网址 + 一串码，两样一起给人
    const deviceNotice = notices.find((n) => n.code !== undefined)
    expect(deviceNotice?.code).toBe('ABCD-1234')
    expect(deviceNotice?.url).toBe('https://auth.openai.com/codex/device')

    // 记录真的落进了本机库，owner 是官方那个 scope
    expect([...records.rows.keys()]).toEqual(['openai-codex'])
    expect(String(subscriptionRecordKey('openai-codex'))).toBe(
      String(credentialKey('llm-pi-ai', 'openai-codex')),
    )

    const status = await handle.status('openai-codex')
    expect(status.signed_in).toBe(true)
    // 账号标识脱敏：头四位 + 尾四位，中间是省略号
    expect(status.account).toBe('acct…cdef')
    expect(status.account).not.toBe(ACCOUNT_ID)
    expect(typeof status.expires_at).toBe('string')

    await handle.signOut('openai-codex')
    expect(records.rows.size).toBe(0)
    expect(await handle.status('openai-codex')).toEqual({
      provider: 'openai-codex',
      signed_in: false,
    })
    // 一次真出网都没有（替身不认识的请求会当场抛）
    expect(fake.hits.every((h) => h.url.startsWith('https://auth.openai.com'))).toBe(true)
  })

  it('这家没有的登录方式当场说清楚，不去试', async () => {
    fakeOpenAi()
    const handle = await loginHandle(memoryRecords())
    await expect(
      handle.begin({
        provider: 'anthropic',
        method: 'device',
        notify: () => undefined,
        ask: async () => '',
      }),
    ).rejects.toThrow(/设备码/)
  })

  it('脱敏函数：短的只留两位，空的就没有', () => {
    expect(maskAccount(undefined)).toBeUndefined()
    expect(maskAccount('')).toBeUndefined()
    expect(maskAccount('abcd')).toBe('ab…')
    expect(maskAccount('0123456789')).toBe('0123…6789')
  })
})

// ── (c) 刷新 ───────────────────────────────────────────────────────────

describe('(c) 刷新：到期前那一次经官方 modifyRecord 回写', () => {
  it('令牌快过期时官方自己去换一把，新的落库、请求带的是新的', async () => {
    const fake = fakeOpenAi({
      reply: () => ({ text: '收到。' }),
    })
    const records = memoryRecords()
    const handle = await loginHandle(records)
    await signIn(handle)

    const first = records.rows.get('openai-codex') as { access: string; expires: number }
    expect(fake.issued).toHaveLength(1)
    expect(first.access).toBe(fake.issued[0])

    // 把到期时间推到"一分钟后"——官方的规矩是到期前 5 分钟就换
    await records.write('openai-codex', { ...first, expires: Date.now() + 60_000 })

    const { sink, events } = collect()
    const runtime = createDshRuntime({
      ...baseOptions(),
      mode: 'in-process',
      credentials: credentialsPlugin(records),
    })
    await runtime.run(subscriptionRequest(), sink, NO_ABORT())

    // 换过一把了：库里那一条变成新的，送出去的 Authorization 也是新的
    expect(fake.issued.length).toBeGreaterThan(1)
    const after = records.rows.get('openai-codex') as { access: string }
    expect(after.access).toBe(fake.issued.at(-1))
    expect(after.access).not.toBe(first.access)
    expect(fake.bearers.at(-1)).toBe(`Bearer ${fake.issued.at(-1)}`)
    // 刷新那一跳一个字都没进事件
    expect(canonicalJson(events)).not.toContain(after.access)
  })
})

// ── (d) 公司档 ─────────────────────────────────────────────────────────

describe('(d) 公司档 / 托管档：读不存在、写被拒', () => {
  it('enabled() 为假时记录读不到、登录跑不起来', async () => {
    fakeOpenAi()
    const records = memoryRecords(() => false)
    // 库里就算有一条（换过档的机器），这一档也一个字都读不到
    await records.write('openai-codex', { type: 'oauth', access: 'x', refresh: 'y', expires: 1 })
    const handle = await loginHandle(records)

    expect(await handle.status('openai-codex')).toEqual({
      provider: 'openai-codex',
      signed_in: false,
    })
    await expect(
      handle.begin({
        provider: 'openai-codex',
        method: 'device',
        notify: () => undefined,
        ask: async () => '',
      }),
    ).rejects.toThrow()
    // 那一条原样还在（被拒不等于被删）
    expect(records.rows.size).toBe(1)
  })
})

// ── (e) 运行 ───────────────────────────────────────────────────────────

/** 一条走订阅路由的 RunRequest（`runtime.model.provider` 就是路由开关）。 */
function subscriptionRequest(): ReturnType<typeof makeRequest> {
  const req = makeRequest()
  return {
    ...req,
    runtime: {
      ...req.runtime,
      model: { provider: 'openai-codex', model: 'gpt-5.4', region: 'global' as const },
    },
  }
}

describe('(e) 运行：一次带工具调用的运行走官方适配器', () => {
  it('模型经官方适配器说话、调工具；用量投影进我们的账、cost_base 恒为 0', async () => {
    let turn = 0
    const fake = fakeOpenAi({
      usage: { input_tokens: 200, output_tokens: 50, cached_tokens: 20 },
      reply: () => {
        turn += 1
        return turn === 1
          ? { toolCall: { name: 'get_order', arguments: JSON.stringify({ order_id: ORDER.id }) } }
          : { text: '订单在退货窗口内，我给您办退款。' }
      },
    })
    const records = memoryRecords()
    const handle = await loginHandle(records)
    await signIn(handle)

    const { sink, events } = collect()
    const runtime = createDshRuntime({
      ...baseOptions(),
      mode: 'in-process',
      credentials: credentialsPlugin(records),
    })
    const result = await runtime.run(subscriptionRequest(), sink, NO_ABORT())

    // 真的打到了 /codex/responses（不是我们的网关）
    expect(fake.responses).toBeGreaterThanOrEqual(2)
    const types = typesOf(events)
    expect(types).toContain('tool.call')
    expect(types).toContain('tool.result')
    expect(types).toContain('run.completed')
    // Model-visible ⟺ logged：这条路上照样有 model_request
    expect(events.some((e) => e.type === 'progress' && e.step === 'model_request')).toBe(true)

    // 用量投影：token 按官方报的算，**钱恒为 0**（订阅在月费里）
    expect(result.usage.input_tokens).toBeGreaterThan(0)
    expect(result.usage.output_tokens).toBeGreaterThan(0)
    expect(result.usage.cached_tokens).toBeGreaterThan(0)
    expect(result.usage.cost_base).toBe(0)
    const completed = events.find((e) => e.type === 'run.completed')
    expect(completed?.type === 'run.completed' && completed.usage.cost_base).toBe(0)
  })

  it('预算按 token 算：超了就发 budget.exhausted 并收掉这一轮', async () => {
    fakeOpenAi({
      usage: { input_tokens: 5_000, output_tokens: 5_000 },
      reply: () => ({
        toolCall: { name: 'get_order', arguments: JSON.stringify({ order_id: ORDER.id }) },
      }),
    })
    const records = memoryRecords()
    const handle = await loginHandle(records)
    await signIn(handle)

    const { sink, events } = collect()
    const runtime = createDshRuntime({
      ...baseOptions(),
      mode: 'in-process',
      credentials: credentialsPlugin(records),
    })
    const req = subscriptionRequest()
    const result = await runtime.run(
      { ...req, budget: { ...req.budget, max_tokens: 9_000 } },
      sink,
      NO_ABORT(),
    )
    expect(typesOf(events)).toContain('budget.exhausted')
    expect(result.status).toBe('budget_exhausted')
    expect(result.usage.cost_base).toBe(0)
  })
})

// ── (f) 零泄漏 ─────────────────────────────────────────────────────────

describe('(f) 零泄漏：token 不进事件、不进日志、不进状态', () => {
  it('整条事件流、运行结果、状态返回值里都查不到 access / refresh token', async () => {
    const fake = fakeOpenAi({ reply: () => ({ text: '好的。' }) })
    const records = memoryRecords()
    const handle = await loginHandle(records)
    const notices = await signIn(handle)

    const { sink, events } = collect()
    const runtime = createDshRuntime({
      ...baseOptions(),
      mode: 'in-process',
      credentials: credentialsPlugin(records),
    })
    const result = await runtime.run(subscriptionRequest(), sink, NO_ABORT())

    const stored = records.rows.get('openai-codex') as { access: string; refresh: string }
    const haystacks = [
      canonicalJson(events),
      canonicalJson(result),
      canonicalJson(await handle.status('openai-codex')),
      canonicalJson(notices),
    ]
    for (const hay of haystacks) {
      expect(hay).not.toContain(stored.access)
      expect(hay).not.toContain(stored.refresh)
      expect(hay).not.toContain(ACCOUNT_ID)
      for (const issued of fake.issued) expect(hay).not.toContain(issued)
    }
  })
})

// ── watchSubscriptionCalls 这道 seam 自己 ──────────────────────────────

describe('llm/stream waterfall：只管订阅那条路', () => {
  it('别人的请求原样放过去，订阅的才计账', async () => {
    const root = new Context()
    root.plugin(LlmRuntime)
    const ctx = await new Promise<Context>((resolve) => {
      root.plugin({ name: 't', inject: ['llm'], apply: (c: Context) => resolve(c) })
    })
    class Fake extends LlmAdapter {
      override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
        return { provider, id: model, name: model }
      }
      override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        yield { type: 'text-delta', index: 0, text: `hi from ${options.provider}` }
        yield { type: 'usage', usage: { inputTokens: 11, outputTokens: 7, cacheReadTokens: 3 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    const release = ctx.llm.registerAdapter(['openai-codex', GATEWAY_PROVIDER], new Fake())
    const seen: { messages: number }[] = []
    const billed: { input: number; output: number; cached: number; cost: number }[] = []
    const off = watchSubscriptionCalls(ctx, {
      provider: 'openai-codex',
      model: 'gpt-5.4',
      onRequest: ({ messages }) => seen.push({ messages: messages.length }),
      onCompletion: (c) =>
        billed.push({
          input: c.usage.input_tokens,
          output: c.usage.output_tokens,
          cached: c.usage.cached_tokens,
          cost: c.usage.cost_base,
        }),
    })

    const drain = async (provider: string): Promise<void> => {
      for await (const _ of ctx.llm.stream({
        provider,
        model: 'gpt-5.4',
        messages: [],
      } as never)) {
        // 只是把流走完
      }
    }
    await drain(GATEWAY_PROVIDER)
    expect(billed).toHaveLength(0)
    await drain('openai-codex')
    expect(seen).toHaveLength(1)
    expect(billed).toEqual([{ input: 11, output: 7, cached: 3, cost: 0 }])

    off()
    release()
    await root.fiber.dispose()
  })
})

export type { RunEvent }
