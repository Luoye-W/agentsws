/**
 * WP230（10-05 真模型 deepseek-chat 实测）：模型把「[calling …]」当文字吐出来。
 *
 * 1. 回放历史时 assistant 的 content 只留模型自己说的话，不再写 `[calling 名字 参数]`；
 * 2. 模型吐伪调用文字 → 追加提示重试一次 → 第二次正常就正常收尾，仍异常就报格式异常；
 * 3. 只带工具调用、没说话的 assistant 消息过 DeepSeek 口不 400（替身按真 provider 的规矩校验）。
 */
import type { ChatMessage } from '@agentsws/contracts'
import type { FetchLike } from '@agentsws/model-gateway'
import { createModelGateway, openaiCompatibleProvider } from '@agentsws/model-gateway'
import { TOOL_CALL_TEXT_FAILURE, TOOL_CALL_TEXT_NUDGE } from '@agentsws/stand-ins'
import { describe, expect, it } from 'vitest'
import type { ScriptedTurn } from '../src/index.js'
import { clock, eventsOf, harness, makeRequest } from './helpers.js'

const FAKE = '[calling search_policies {"query":"return window"}]'

/** 记下每一轮真送进网关的消息（脚本 provider 的函数形态能看到）。 */
function recording(turns: readonly ScriptedTurn[]): {
  seen: ChatMessage[][]
  script: (input: { messages: ChatMessage[]; turn: number }) => ScriptedTurn
} {
  const seen: ChatMessage[][] = []
  return {
    seen,
    script: ({ messages, turn }) => {
      seen.push(messages)
      return turns[turn] ?? { text: '' }
    },
  }
}

const answerRequest = () =>
  makeRequest({
    expectations: { outputs: ['answer'], must_stage_if_change_requested: false },
  })

describe('WP230 direct-llm：回放历史不写 [calling …]', () => {
  it('有工具调用的 assistant 轮次：content 只留模型的话（没说话就是空串），调用只在 tool_calls 里', async () => {
    const rec = recording([
      { tool_calls: [{ id: 'c1', name: 'get_order', input: { order_id: 'ord_1001' } }] },
      {
        text: '再看一下政策。',
        tool_calls: [{ id: 'c2', name: 'search_policies', input: { query: 'return window' } }],
      },
      { text: 'You can return it within 14 days.' },
    ])
    const h = harness({ script: rec.script, toolChoice: false })
    const result = await h.run(answerRequest())
    expect(result.status).toBe('completed')
    const last = rec.seen.at(-1) ?? []
    const assistants = last.filter((m) => m.role === 'assistant')
    expect(assistants).toHaveLength(2)
    expect(assistants[0]?.content).toBe('')
    expect(assistants[0]?.tool_calls?.[0]?.name).toBe('get_order')
    expect(assistants[1]?.content).toBe('再看一下政策。')
    expect(assistants[1]?.tool_calls?.[0]?.name).toBe('search_policies')
    for (const msgs of rec.seen) {
      expect(JSON.stringify(msgs)).not.toContain('[calling')
    }
  })
})

describe('WP230 direct-llm：伪调用文字兜底', () => {
  it('第一次吐假调用 → 追加提示重试 → 第二次正常：正常收尾，假文字不进答案', async () => {
    const rec = recording([
      { tool_calls: [{ id: 'c1', name: 'get_order', input: { order_id: 'ord_1001' } }] },
      { text: FAKE },
      { text: 'Hi Anna, you can return it within 14 days.' },
    ])
    const h = harness({ script: rec.script, toolChoice: false })
    const result = await h.run(answerRequest())
    expect(result.status).toBe('completed')
    expect(result.outputs).toContainEqual({
      kind: 'answer',
      text: 'Hi Anna, you can return it within 14 days.',
    })
    // 重试那一轮：模型看得见自己上一轮写了什么，紧跟一句提示
    const retry = rec.seen[2] ?? []
    expect(retry.at(-2)).toMatchObject({ role: 'assistant', content: FAKE })
    expect(retry.at(-1)).toEqual({ role: 'user', content: TOOL_CALL_TEXT_NUDGE })
    // 留痕：一条 progress；假文字不进 text.delta
    expect(eventsOf(h.events, 'progress').filter((e) => e.step === 'tool_call_text')).toHaveLength(
      1,
    )
    expect(eventsOf(h.events, 'text.delta').map((e) => e.text)).not.toContain(FAKE)
    expect(result.summary).not.toContain('calling')
  })

  it('重试一次还是假调用：报「模型输出格式异常」，不把假文字当答案、不出卡', async () => {
    const rec = recording([
      { tool_calls: [{ id: 'c1', name: 'get_order', input: { order_id: 'ord_1001' } }] },
      { text: FAKE },
      { text: '<tool_call>{"name":"search_policies"}</tool_call>' },
      { text: 'should never be asked' },
    ])
    const h = harness({ script: rec.script, toolChoice: false })
    const result = await h.run(answerRequest())
    expect(rec.seen).toHaveLength(3)
    expect(result.status).toBe('failed')
    expect(result.summary).toBe(`这次没跑完：${TOOL_CALL_TEXT_FAILURE}。`)
    expect(result.outputs.some((o) => o.kind === 'answer')).toBe(false)
    expect(h.drafts).toHaveLength(0)
    expect(h.staged).toHaveLength(0)
    const failed = eventsOf(h.events, 'run.failed')
    expect(failed).toHaveLength(1)
    expect(failed[0]?.error.message).toBe(TOOL_CALL_TEXT_FAILURE)
    expect(eventsOf(h.events, 'run.completed')).toHaveLength(0)
    expect(JSON.stringify(eventsOf(h.events, 'text.delta'))).not.toContain('calling')
  })

  it('有真工具调用的那一轮，文字里碰巧有伪格式也不拦（照常执行调用）', async () => {
    const rec = recording([
      {
        text: FAKE,
        tool_calls: [{ id: 'c1', name: 'get_order', input: { order_id: 'ord_1001' } }],
      },
      { text: 'Done.' },
    ])
    const h = harness({ script: rec.script, toolChoice: false })
    const result = await h.run(answerRequest())
    expect(result.status).toBe('completed')
    expect(eventsOf(h.events, 'progress').some((e) => e.step === 'tool_call_text')).toBe(false)
  })
})

// ── DeepSeek 口替身：按真 provider 的规矩校验请求，不合规就 400 ─────────────
const KEY_ENV = 'AGENTSWS_TEST_DEEPSEEK_KEY'
const DEEPSEEK = { provider: 'deepseek', model: 'deepseek-chat', region: 'cn' } as const

interface WireMsg {
  role: string
  content?: unknown
  tool_calls?: { id: string; type: string; function: { name: string; arguments: string } }[]
  tool_call_id?: string
}

/**
 * DeepSeek `/chat/completions` 对历史消息的校验（照官方文档与 09-14 真店实测的 400）：
 * - assistant 必须带 `content` 字段，值是字符串或 null；没话说（null / 空串）时必须有 `tool_calls`；
 * - `tool_calls[].function.arguments` 必须是 JSON 字符串；
 * - tool 消息必须回应前面 assistant 的某个 tool_call id；
 * - 带 tool_calls 的 assistant 之后，每个 id 都要有 tool 消息回应，才能出现别的角色。
 */
function deepseekViolation(messages: WireMsg[]): string | undefined {
  let pending = new Set<string>()
  for (const [i, m] of messages.entries()) {
    if (m.role !== 'tool' && pending.size > 0) {
      return `messages[${i}]: An assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'`
    }
    if (m.role === 'assistant') {
      if (!('content' in m)) return `messages[${i}]: missing field \`content\``
      if (m.content !== null && typeof m.content !== 'string') {
        return `messages[${i}]: content must be string or null`
      }
      const calls = m.tool_calls ?? []
      if ((m.content === null || m.content === '') && calls.length === 0) {
        return `messages[${i}]: Invalid assistant message: content or tool_calls must be set`
      }
      for (const c of calls) {
        try {
          JSON.parse(c.function.arguments)
        } catch {
          return `messages[${i}]: tool_calls arguments must be JSON`
        }
      }
      pending = new Set(calls.map((c) => c.id))
      continue
    }
    if (m.role === 'tool') {
      if (m.tool_call_id === undefined || !pending.has(m.tool_call_id)) {
        return `messages[${i}]: Messages with role 'tool' must be a response to a preceding message with 'tool_calls'`
      }
      pending.delete(m.tool_call_id)
      continue
    }
    if (typeof m.content !== 'string' && !Array.isArray(m.content)) {
      return `messages[${i}]: content must be string`
    }
  }
  return undefined
}

function strictDeepseekFetch(replies: readonly Record<string, unknown>[]): {
  fetch: FetchLike
  bodies: { messages: WireMsg[] }[]
} {
  const bodies: { messages: WireMsg[] }[] = []
  const fetch: FetchLike = async (_url, init) => {
    const body = JSON.parse(String(init.body ?? '{}')) as { messages: WireMsg[] }
    bodies.push(body)
    const violation = deepseekViolation(body.messages)
    const payload =
      violation === undefined
        ? {
            choices: [{ message: replies[bodies.length - 1] ?? { content: '' } }],
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          }
        : { error: { message: violation, type: 'invalid_request_error' } }
    return {
      ok: violation === undefined,
      status: violation === undefined ? 200 : 400,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    }
  }
  return { fetch, bodies }
}

describe('WP230 DeepSeek 口：只带工具调用的 assistant（content 为空）不 400', () => {
  it('替身本身是严的：没话说又没工具调用的 assistant 当场 400', () => {
    expect(deepseekViolation([{ role: 'assistant', content: '' }])).toMatch(/content or tool_calls/)
    expect(deepseekViolation([{ role: 'tool', tool_call_id: 'x', content: '{}' }])).toMatch(
      /must be a response/,
    )
  })

  it('direct-llm 整条跑过严格替身：第二轮历史里 assistant 是 content:null + tool_calls', async () => {
    const c = clock()
    const { fetch, bodies } = strictDeepseekFetch([
      {
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'get_order', arguments: '{"order_id":"ord_1001"}' },
          },
        ],
      },
      { content: 'Hi Anna, you can return it within 14 days.' },
    ])
    const gateway = createModelGateway({
      providers: [
        openaiCompatibleProvider({
          apiKeyEnv: KEY_ENV,
          model: DEEPSEEK.model,
          region: DEEPSEEK.region,
          env: { [KEY_ENV]: 'test-value-not-a-real-credential' },
          fetch,
        }),
      ],
      policy: {
        default: DEEPSEEK,
        prices: { 'deepseek/deepseek-chat': { in: 1, out: 2, cached: 0.1 } },
      },
      clock: c,
      env: {},
      eventSink: () => {},
    })
    const h = harness({ script: [], gateway, clock: c, toolChoice: false })
    const result = await h.run(answerRequest())
    expect(eventsOf(h.events, 'run.failed')).toHaveLength(0)
    expect(result.status).toBe('completed')
    expect(bodies).toHaveLength(2)
    const assistant = bodies[1]?.messages.find((m) => m.role === 'assistant')
    expect(assistant?.content).toBeNull()
    expect(assistant?.tool_calls?.[0]?.function.name).toBe('get_order')
    expect(JSON.stringify(bodies)).not.toContain('[calling')
  })
})
