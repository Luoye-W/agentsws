/**
 * WP362（决策 938）：用 ChatGPT 订阅跑补全——模型网关那一跳。
 *
 * 对手方是 `fixtures/fake-openai.ts`（拦 `globalThis.fetch`，CI 一个包都不出网）：设备码登录一次，
 * 再经官方 pi-ai 打 `/codex/responses`；替身回正文 / 工具调用 / 401 / 429。
 */
import type { ChatMessage } from '@agentsws/contracts'
import {
  CompositeCredentials,
  envRefSource,
  type SubscriptionRecordSource,
} from '@agentsws/credentials-openconnector'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createSubscriptionLogin,
  type SubscriptionLoginHandle,
  subscriptionCatalog,
  subscriptionErrorKind,
  toPiContext,
} from '../src/index.js'
import { type FakeOpenAi, installFakeOpenAi } from './fixtures/fake-openai.js'

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

function memoryRecords(): SubscriptionRecordSource {
  const rows = new Map<string, unknown>()
  return {
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

async function loginTree(): Promise<SubscriptionLoginHandle> {
  const records = memoryRecords()
  const handle = await createSubscriptionLogin({
    credentials: class extends CompositeCredentials {
      constructor(ctx: Context) {
        super(ctx, { refs: envRefSource(), subscriptions: records })
      }
    },
  })
  handles.push(handle)
  return handle
}

async function signedIn(fake: FakeOpenAi): Promise<SubscriptionLoginHandle> {
  fakes.push(fake)
  const handle = await loginTree()
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

const CONVO: ChatMessage[] = [
  { role: 'system', content: '你是店主助理。' },
  { role: 'system', content: '[brand:b1]\n品牌：INMO' },
  { role: 'user', content: '看看这单' },
  {
    role: 'assistant',
    content: '',
    tool_calls: [{ id: 'call_a', name: 'read_order', input: { order_id: 'o1' } }],
  },
  { role: 'tool', tool_call_id: 'call_a', content: '{"status":"shipped"}' },
  { role: 'system', content: '提醒：别重复查。' },
  {
    role: 'user',
    content: [
      { type: 'text', text: '这张图呢' },
      { type: 'image', mime: 'image/png', data: 'iVBORw0KGgo=' },
    ],
  },
]

describe('翻译成 pi-ai 的 Context', () => {
  it('开头的 system → systemPrompt；中途的 system 原样；工具调用 / 结果 / 图片都对得上', () => {
    const ctx = toPiContext(CONVO, [
      { name: 'read_order', description: '读订单', input_schema: { type: 'object' } },
    ], 'gpt-5.5', 1)
    expect(ctx.systemPrompt).toBe('你是店主助理。\n\n[brand:b1]\n品牌：INMO')
    expect(ctx.messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'toolResult',
      'system',
      'user',
    ])
    expect(ctx.messages[1]).toMatchObject({
      content: [{ type: 'toolCall', id: 'call_a', name: 'read_order', arguments: { order_id: 'o1' } }],
      stopReason: 'toolUse',
    })
    // 工具名缺了从上一条 assistant 里补
    expect(ctx.messages[2]).toMatchObject({ toolCallId: 'call_a', toolName: 'read_order' })
    expect(ctx.messages[4]).toMatchObject({
      content: [
        { type: 'text', text: '这张图呢' },
        { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
      ],
    })
    expect(ctx.tools).toEqual([
      { name: 'read_order', description: '读订单', parameters: { type: 'object' } },
    ])
  })

  it('报错分档只看状态码与关键词', () => {
    expect(subscriptionErrorKind('401 Unauthorized')).toBe('expired')
    expect(subscriptionErrorKind('OAuth token refresh failed')).toBe('expired')
    expect(subscriptionErrorKind('429 You have hit your usage limit')).toBe('rate_limited')
    expect(subscriptionErrorKind('500 upstream')).toBe('other')
  })

  it('目录来自 pi-ai（gpt-5.5 收图），别家回空', async () => {
    const list = await subscriptionCatalog('openai-codex')
    expect(list.find((m) => m.id === 'gpt-5.5')).toMatchObject({ vision: true })
    expect(await subscriptionCatalog('anthropic')).toEqual([])
  })
})

describe('整条（替身 OpenAI，不出网）', () => {
  it('正文一段一段流出来、token 照报；请求体里有工具、没有令牌；结果里也没有令牌', async () => {
    const fake = installFakeOpenAi({ reply: () => ({ text: '已经发货了。' }) })
    const handle = await signedIn(fake)
    const deltas: string[] = []
    const got = await handle.complete?.('openai-codex', {
      model: 'gpt-5.5',
      messages: CONVO,
      tools: [{ name: 'read_order', description: '读订单', input_schema: { type: 'object' } }],
      on_delta: (t) => deltas.push(t),
    })
    expect(got?.text).toBe('已经发货了。')
    expect(deltas.join('')).toBe('已经发货了。')
    expect(got?.usage).toEqual({ input_tokens: 120, output_tokens: 34, cached_tokens: 10 })
    const body = fake.bodies.at(-1) as { model?: string; tools?: { name?: string }[] }
    expect(body.model).toBe('gpt-5.5')
    expect(body.tools?.map((t) => t.name)).toContain('read_order')
    expect(fake.bearers.at(-1)).toBe(`Bearer ${fake.issued.at(-1)}`)
    for (const token of fake.issued) {
      expect(JSON.stringify(got)).not.toContain(token)
      expect(JSON.stringify(fake.bodies)).not.toContain(token)
    }
  })

  it('模型要调工具 → tool_calls 原样交回', async () => {
    const fake = installFakeOpenAi({
      reply: () => ({ toolCall: { name: 'read_order', arguments: '{"order_id":"o9"}' } }),
    })
    const handle = await signedIn(fake)
    const got = await handle.complete?.('openai-codex', {
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: '查 o9' }],
      tools: [{ name: 'read_order', description: '读订单', input_schema: { type: 'object' } }],
    })
    expect(got?.tool_calls).toEqual([
      { id: expect.any(String), name: 'read_order', input: { order_id: 'o9' } },
    ])
  })

  it('没登录 → sign_in，一次请求都不发', async () => {
    const fake = installFakeOpenAi()
    fakes.push(fake)
    const handle = await loginTree()
    await expect(
      handle.complete?.('openai-codex', { model: 'gpt-5.5', messages: [{ role: 'user', content: 'x' }] }),
    ).rejects.toMatchObject({ kind: 'sign_in' })
    expect(fake.responses).toBe(0)
  })

  it('401 → expired；429 → rate_limited；报错里没有令牌', async () => {
    let status = 401
    const fake = installFakeOpenAi({
      fail: () => ({ status, message: status === 401 ? 'token expired' : 'usage limit reached' }),
    })
    const handle = await signedIn(fake)
    const ask = () =>
      handle.complete?.('openai-codex', {
        model: 'gpt-5.5',
        messages: [{ role: 'user', content: 'x' }],
      })
    const expired = await ask()?.catch((e: unknown) => e)
    expect(expired).toMatchObject({ kind: 'expired' })
    status = 429
    const limited = await ask()?.catch((e: unknown) => e)
    expect(limited).toMatchObject({ kind: 'rate_limited' })
    for (const token of fake.issued) {
      expect(String((expired as Error).message)).not.toContain(token)
      expect(String((limited as Error).message)).not.toContain(token)
    }
  })

  it('Claude 订阅还不能跑活（第一版只接 ChatGPT）', async () => {
    const fake = installFakeOpenAi()
    const handle = await signedIn(fake)
    await expect(
      handle.complete?.('anthropic', { model: 'claude-sonnet-4-5', messages: [] }),
    ).rejects.toMatchObject({ kind: 'other' })
  })
})
