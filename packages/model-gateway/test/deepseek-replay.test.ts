/**
 * WP143：Messages 口的思考块**原样回传**（WP134 报告 §6 第 2 条那个洞）。
 *
 * 官方 `dsh-llm-deepseek@0.1.7-rc.1`：「此前 assistant 轮次的推理内容会原样传回，无论该轮次是否调用了
 * 工具」「回放元数据保留模型与思考签名」「无效的回放元数据……省略签名，不丢弃文本」。
 * 多轮替身：假 Messages 口每轮回一个带签名的思考块，下一轮检查请求里是不是一字不差带回来了。
 */
import type { ChatMessage, Completion } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  type AccountFetch,
  createModelGateway,
  deepseekAccountProvider,
  toMessagesRequest,
} from '../src/index.js'
import { fixedClock, meta, policy, recorder } from './helpers.js'

/** 签名故意带上 base64 的特殊字符与一个很长的尾巴：原样就是原样。 */
const sig = (turn: number) => `EqQBCgIYAhIM${turn}+/==${'x'.repeat(300)}`

type Block = { type: string; thinking?: string; signature?: string; id?: string }

function fakeThinkingMessages() {
  const bodies: { messages: { role: string; content: Block[] }[] }[] = []
  let turn = 0
  const fetch: AccountFetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body))
    turn += 1
    const last = turn >= 3
    return {
      ok: true,
      status: 200,
      json: async () => ({
        content: [
          { type: 'thinking', thinking: `第 ${turn} 轮想法`, signature: sig(turn) },
          { type: 'text', text: last ? '办完了' : `第 ${turn} 轮去查` },
          ...(last
            ? []
            : [{ type: 'tool_use', id: `call_${turn}`, name: 'orders__get', input: {} }]),
        ],
        usage: { input_tokens: 5, output_tokens: 5 },
      }),
      text: async () => '',
    }
  }
  return { fetch, bodies }
}

/** 照运行时的做法把一轮补全接回历史（runtime-direct 与 dsh-adapter 都是这样接的）。 */
const append = (
  history: ChatMessage[],
  out: Completion | Omit<Completion, 'model' | 'static_prefix_hash'>,
) => {
  history.push({
    role: 'assistant',
    content: out.text,
    ...(out.tool_calls === undefined ? {} : { tool_calls: out.tool_calls }),
    ...(out.reasoning === undefined ? {} : { reasoning: out.reasoning }),
    ...(out.reasoning_replay === undefined ? {} : { reasoning_replay: out.reasoning_replay }),
  })
  for (const c of out.tool_calls ?? []) {
    history.push({ role: 'tool', tool_call_id: c.id, name: c.name, content: '{"ok":true}' })
  }
}

describe('WP143 推理块多轮原样回传', () => {
  it('三轮：每一轮请求里，之前每个 assistant 轮次的思考块与签名都一字不差', async () => {
    const { fetch, bodies } = fakeThinkingMessages()
    const p = deepseekAccountProvider({
      resolveToken: async () => 'tok',
      fetch,
      provider: 'deepseek-account',
    })
    const gateway = createModelGateway({
      providers: [p],
      policy: policy({
        default: p.ref,
        prices: { 'deepseek-account/deepseek-flash': { in: 0, out: 0, cached: 0 } },
      }),
      clock: fixedClock(),
      eventSink: recorder().sink,
      env: {},
    })
    const tools = [{ name: 'orders.get', description: 'd', input_schema: { type: 'object' } }]
    const history: ChatMessage[] = [{ role: 'user', content: '查单' }]
    for (let i = 0; i < 3; i++) {
      const out = await gateway.complete({ messages: [...history], tools, meta: meta() })
      // 网关把 replay 透传出来（不是只在 provider 里）
      expect(out.reasoning_replay?.blocks[0]?.signature).toBe(sig(i + 1))
      append(history, out)
    }
    const third = bodies[2]?.messages ?? []
    const assistants = third.filter((m) => m.role === 'assistant')
    expect(assistants).toHaveLength(2)
    for (const [i, m] of assistants.entries()) {
      expect(m.content[0]).toEqual({
        type: 'thinking',
        thinking: `第 ${i + 1} 轮想法`,
        signature: sig(i + 1),
      })
      expect(m.content.map((b) => b.type)).toEqual(['thinking', 'text', 'tool_use'])
    }
    // tool_result 紧跟在对应的 assistant 后面（Messages 要求）
    expect(third.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user'])
  })

  it('换了模型：只回传思考原文，不带签名（签名跨模型不可移植）', () => {
    const history: ChatMessage[] = [
      { role: 'user', content: 'x' },
      {
        role: 'assistant',
        content: '好',
        reasoning: '想',
        reasoning_replay: {
          kind: 'deepseek-messages',
          model: 'deepseek-v4-pro',
          blocks: [{ thinking: '想', signature: 'sig' }],
        },
      },
      { role: 'user', content: 'y' },
    ]
    const same = toMessagesRequest(history, { model: 'deepseek-v4-pro' })
    expect(same.messages[1]?.content[0]).toEqual({
      type: 'thinking',
      thinking: '想',
      signature: 'sig',
    })
    const other = toMessagesRequest(history, { model: 'deepseek-flash' })
    expect(other.messages[1]?.content[0]).toEqual({ type: 'thinking', thinking: '想' })
  })

  it('只有推理原文（历史来自别的 provider）：一块不带签名的思考；什么都没有就不发', () => {
    const wire = toMessagesRequest([
      { role: 'user', content: 'x' },
      { role: 'assistant', content: 'a', reasoning: '别家的推理' },
      { role: 'user', content: 'y' },
      { role: 'assistant', content: 'b' },
    ])
    expect(wire.messages[1]?.content).toEqual([
      { type: 'thinking', thinking: '别家的推理' },
      { type: 'text', text: 'a' },
    ])
    expect(wire.messages[3]?.content).toEqual([{ type: 'text', text: 'b' }])
  })
})
