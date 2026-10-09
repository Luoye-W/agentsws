/**
 * WP188「随便聊」服务端：流式、停止、切模型、联网开关只在开时挂搜索工具、公司资料、重新生成、
 * 只有本人看得见。全部替身模型（真网关 + 脚本 provider），不联网。
 */
import type { FreeChatFrame, FreeChatMessageView } from '@agentsws/api'
import type { ChatMessage, ModelProvider, ModelRef } from '@agentsws/contracts'
import { createModelGateway, type ModelGatewayEvent } from '@agentsws/model-gateway'
import { describe, expect, it } from 'vitest'
import { chatCredits, createFreeChatPort, type FreeChatOptions } from '../src/free-chat.js'
import { createFreeChatStore } from '../src/free-chat-store.js'
import type { ModelChatChoice } from '../src/models.js'

const clock = { now: () => '2026-09-29T08:00:00.000Z' }
const actor = { workspace_id: 'ws_1', person_id: 'per_me', assignment_id: 'asg_me' }

interface Seen {
  provider: string
  tools: string[]
  messages: ChatMessage[]
}

/** 脚本 provider：按顺序回；`tool` 那一步回一个 web_search 调用；正文一个字一个字流出来。 */
function scripted(
  ref: ModelRef,
  seen: Seen[],
  script: (string | { search: string })[] = [],
): ModelProvider {
  let i = 0
  return {
    ref,
    capabilities: { vision: true, image_generation: false },
    async complete(req) {
      seen.push({
        provider: ref.provider,
        tools: (req.tools ?? []).map((t) => t.name),
        messages: req.messages,
      })
      const step = script[i] ?? `我是 ${ref.provider} 的回答。`
      i += 1
      const usage = { input_tokens: 10, output_tokens: 5, cached_tokens: 0 }
      if (typeof step !== 'string')
        return {
          text: '',
          tool_calls: [{ id: `call_${i}`, name: 'web_search', input: { query: step.search } }],
          usage,
        }
      for (const ch of step) {
        if (req.signal?.aborted === true)
          throw Object.assign(new Error('aborted'), { name: 'AbortError' })
        req.on_delta?.(ch)
        await new Promise((r) => setTimeout(r, 0))
      }
      return { text: step, usage }
    },
  }
}

function setup(over: Partial<FreeChatOptions> & { script?: (string | { search: string })[] } = {}) {
  const seen: Seen[] = []
  const events: ModelGatewayEvent[] = []
  const a = scripted({ provider: 'deepseek', model: 'deepseek-flash' }, seen, over.script)
  const b = scripted({ provider: 'agentsws', model: 'deepseek-pro' }, seen, over.script)
  const gateway = createModelGateway({
    providers: [a, b],
    policy: {
      default: a.ref,
      prices: {
        'deepseek/deepseek-flash': { in: 0, out: 0, cached: 0 },
        'agentsws/deepseek-pro': { in: 0, out: 0, cached: 0 },
      },
    },
    clock,
    eventSink: (e) => events.push(e),
    env: {},
  })
  const choices: ModelChatChoice[] = [
    {
      id: 'deepseek/deepseek-flash',
      label: 'DeepSeek 官方（deepseek-flash）',
      official: false,
      vision: 'ok',
    },
    {
      id: 'agentsws/deepseek-pro',
      label: 'Agents 工坊（用积分）（deepseek-pro）',
      official: true,
      vision: 'no',
    },
  ]
  const searched: string[] = []
  let n = 0
  const port = createFreeChatPort({
    clock,
    store: createFreeChatStore(),
    gateway: async () => gateway,
    models: async () => ({
      chatChoices: () => choices,
      defaultRef: () => a.ref,
      configured: () => true,
    }),
    roleOf: () => 'common.owner',
    humanize: (e) => (e instanceof Error ? e.message : String(e)),
    newId: (p) => {
      n += 1
      return `${p}_${n}`
    },
    credits: () => 0.42,
    web: {
      status: async () => ({ available: true }),
      search: async (query) => {
        searched.push(query)
        return {
          sources: [{ url: 'https://example.com/weather', title: '天气预报', snippet: '晴' }],
        }
      },
    },
    knowledge: async () => [
      { fact_card_id: 'fc_1', text: '退货期限是 30 天', source: '售后手册.pdf' },
    ],
    ...over,
  })
  return { port, seen, events, searched }
}

async function say(
  port: ReturnType<typeof setup>['port'],
  session_id: string,
  input: Partial<Parameters<ReturnType<typeof setup>['port']['turn']>[1]> = {},
  signal = new AbortController().signal,
  onFrame?: (f: FreeChatFrame) => void,
): Promise<{ frames: FreeChatFrame[]; done?: FreeChatMessageView }> {
  const frames: FreeChatFrame[] = []
  await port.turn(
    actor,
    { session_id, text: '你好', ...input },
    (f) => {
      frames.push(f)
      onFrame?.(f)
    },
    signal,
  )
  const done = frames.find((f) => f.type === 'done')
  return { frames, ...(done?.type === 'done' ? { done: done.message } : {}) }
}

describe('WP188 随便聊：一轮流式对话', () => {
  it('start → 一段段 delta → done；存下两条话；会话名换成第一句话；网关记 free_chat', async () => {
    const { port, events } = setup()
    const s = await port.create(actor, {})
    expect(s.title).toBe('新对话')
    const { frames, done } = await say(port, s.id, { text: '今天该做点什么？' })
    expect(frames[0]?.type).toBe('start')
    const deltas = frames.filter((f) => f.type === 'delta')
    expect(deltas.length).toBeGreaterThan(3)
    expect(done?.text).toBe('我是 deepseek 的回答。')
    expect(done?.model?.id).toBe('deepseek/deepseek-flash')
    expect(done?.usage).toEqual({ input_tokens: 10, output_tokens: 5 })
    const saved = await port.messages(actor, s.id)
    expect(saved.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect((await port.sessions(actor))[0]?.title).toBe('今天该做点什么？')
    const usage = events.filter((e) => e.type === 'model.usage')
    expect(usage.map((e) => (e.payload as { purpose: string }).purpose)).toEqual(['free_chat'])
  })

  it('停：已经答出来的那部分存成"停了"的一条', async () => {
    const { port } = setup()
    const s = await port.create(actor, {})
    const controller = new AbortController()
    let count = 0
    const { done } = await say(port, s.id, {}, controller.signal, (f) => {
      if (f.type === 'delta') {
        count += 1
        if (count === 3) controller.abort()
      }
    })
    expect(done?.stopped).toBe(true)
    expect(done?.text.length).toBe(3)
    const saved = await port.messages(actor, s.id)
    expect(saved.at(-1)?.stopped).toBe(true)
  })

  it('stop 接口也停得下来（客户端断不开连接时的兜底）', async () => {
    const { port } = setup()
    const s = await port.create(actor, {})
    let stopped = false
    const { done } = await say(port, s.id, {}, undefined, (f) => {
      if (f.type === 'delta' && !stopped) {
        stopped = true
        void port.stop(actor, s.id)
      }
    })
    expect(done?.stopped).toBe(true)
  })

  it('切模型：选哪条就打哪条；官方积分那条带积分估数', async () => {
    const { port, seen } = setup()
    const s = await port.create(actor, {})
    const { done } = await say(port, s.id, { model: 'agentsws/deepseek-pro' })
    expect(seen.at(-1)?.provider).toBe('agentsws')
    expect(done?.model).toEqual({
      id: 'agentsws/deepseek-pro',
      label: 'Agents 工坊（用积分）（deepseek-pro）',
      official: true,
    })
    expect(done?.usage?.credits).toBe(0.42)
  })

  it('看不了图的模型收到图：说人话，不打模型', async () => {
    const { port, seen } = setup()
    const s = await port.create(actor, {})
    const { done } = await say(port, s.id, {
      model: 'agentsws/deepseek-pro',
      images: [{ mime: 'image/png', data: 'aGVsbG8=' }],
    })
    expect(done?.error).toContain('看不了图')
    expect(seen).toHaveLength(0)
  })

  it('重新生成：删掉上一条回复，按最后那句用户的话再答一次', async () => {
    const { port } = setup()
    const s = await port.create(actor, {})
    await say(port, s.id, { text: '第一句' })
    await port.turn(
      actor,
      { session_id: s.id, regenerate: true, model: 'agentsws/deepseek-pro' },
      () => undefined,
      new AbortController().signal,
    )
    const saved = await port.messages(actor, s.id)
    expect(saved.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(saved[1]?.model?.id).toBe('agentsws/deepseek-pro')
  })

  it('别人的会话：看不到、说不进去、删不掉', async () => {
    const { port } = setup()
    const s = await port.create(actor, {})
    const other = { ...actor, person_id: 'per_other' }
    await expect(port.messages(other, s.id)).rejects.toThrow('没有这条对话')
    await expect(port.remove(other, s.id)).rejects.toThrow('没有这条对话')
    expect(await port.sessions(other)).toEqual([])
  })
})

describe('WP188 随便聊：联网搜索与公司资料', () => {
  it('联网开关关着：模型手上一个工具都没有', async () => {
    const { port, seen } = setup()
    const s = await port.create(actor, {})
    await say(port, s.id, { web_search: false })
    expect(seen[0]?.tools).toEqual([])
  })

  it('开着：只挂 web_search；搜到的来源带回界面、存进回复', async () => {
    const { port, seen, searched } = setup({
      script: [{ search: '上海天气' }, '晴，见 [天气预报](https://example.com/weather)'],
    })
    const s = await port.create(actor, {})
    const { frames, done } = await say(port, s.id, { web_search: true })
    expect(seen[0]?.tools).toEqual(['web_search'])
    expect(searched).toEqual(['上海天气'])
    expect(frames.some((f) => f.type === 'searching')).toBe(true)
    expect(done?.sources).toEqual([{ url: 'https://example.com/weather', title: '天气预报' }])
    // 搜索结果以外部数据的样子还给模型
    const tool = seen[1]?.messages.find((m) => m.role === 'tool')
    expect(String(tool?.content)).toContain('<external_data>')
  })

  it('搜不了（没凭据 / 设置里关了）：说一句，照常不联网回答', async () => {
    const { port, seen } = setup({
      web: {
        status: async () => ({ available: false, reason: '联网搜索要先登录 DeepSeek 账号' }),
        search: async () => ({ sources: [] }),
      },
    })
    const s = await port.create(actor, {})
    const { frames, done } = await say(port, s.id, { web_search: true })
    expect(frames.find((f) => f.type === 'notice')).toBeDefined()
    expect(seen[0]?.tools).toEqual([])
    expect(done?.error).toBeUndefined()
  })

  it('用公司资料回答：查到的资料进系统提示，回复带出处', async () => {
    const { port, seen } = setup()
    const s = await port.create(actor, {})
    const { done } = await say(port, s.id, { knowledge: true, text: '退货期限多久？' })
    const system = seen[0]?.messages[0]
    expect(String(system?.content)).toContain('[1] 退货期限是 30 天')
    expect(done?.citations).toEqual([
      { n: 1, fact_card_id: 'fc_1', text: '退货期限是 30 天', source: '售后手册.pdf' },
    ])
    expect(seen[0]?.tools).toEqual([])
  })
})

describe('WP188 积分估数', () => {
  it('认得出的模型按它的单价，认不出按兜底价；没有价目就不编', () => {
    const pricing = {
      entries: [
        {
          capability: 'ai.chat',
          unit: '1k_tokens',
          credits_per_unit: 0.3,
          label_zh: 'AI 对话',
          label_en: 'AI chat',
          models: [{ model: 'deepseek-flash', in: 0.01, out: 0.02 }],
        },
      ],
    }
    expect(chatCredits(pricing, 'deepseek-flash', { input_tokens: 1000, output_tokens: 500 })).toBe(
      0.02,
    )
    expect(chatCredits(pricing, 'unknown', { input_tokens: 1000, output_tokens: 1000 })).toBe(0.6)
    expect(
      chatCredits(undefined, 'deepseek-flash', { input_tokens: 1, output_tokens: 1 }),
    ).toBeUndefined()
  })
})
