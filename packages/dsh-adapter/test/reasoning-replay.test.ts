/**
 * WP143：Messages 口的思考块（含签名）在 dsh 这条路上原样带回下一轮（与 WP87 的 reasoning 同一条路）。
 */
import type { Completion, ModelMeta, ReasoningReplay } from '@agentsws/contracts'
import type { GenerateOptions, Message, ToolCallId } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { GatewayLlmAdapter, toChatMessages } from '../src/llm.js'

const META: ModelMeta = {
  workspace_id: 'ws_test',
  assignment_id: 'asg_test',
  role_id: 'role_test',
  run_id: 'run_test',
  purpose: 'run',
}

const REPLAY: ReasoningReplay = {
  kind: 'deepseek-messages',
  model: 'deepseek-flash',
  blocks: [
    { thinking: '先查订单', signature: 'sig-1+/=' },
    { thinking: '再看政策', signature: 'sig-2' },
  ],
}

const assistantWithCall = (id: string): Message =>
  ({
    role: 'assistant',
    content: [{ type: 'tool-call', id: id as ToolCallId, name: 'get_order', arguments: '{}' }],
  }) as unknown as Message

const toolResult = (id: string): Message =>
  ({
    role: 'tool',
    toolCallId: id as ToolCallId,
    source: { kind: 'tool', callId: id as ToolCallId },
    content: [{ type: 'text', text: '{"id":"o1"}' }],
  }) as unknown as Message

describe('WP143 dsh 路：思考块签名原样回传', () => {
  it('toChatMessages 按 tool-call id 接回 reasoning_replay', () => {
    const options = {
      messages: [assistantWithCall('c1'), toolResult('c1')],
    } as unknown as GenerateOptions
    const messages = toChatMessages(options, undefined, new Map([['c1', REPLAY]]))
    expect(messages.find((m) => m.role === 'assistant')?.reasoning_replay).toEqual(REPLAY)
  })

  it('适配器记下第一轮的 replay，第二轮请求原样带着', async () => {
    const seen: (ReasoningReplay | undefined)[] = []
    let turn = 0
    const gateway = {
      async complete(req: {
        messages: { role: string; reasoning_replay?: ReasoningReplay }[]
      }): Promise<Completion> {
        seen.push(req.messages.find((m) => m.role === 'assistant')?.reasoning_replay)
        turn += 1
        return {
          text: '',
          ...(turn === 1 ? { tool_calls: [{ id: 'call_a', name: 'get_order', input: {} }] } : {}),
          reasoning: '先查订单再看政策',
          reasoning_replay: REPLAY,
          usage: { input_tokens: 1, output_tokens: 1, cached_tokens: 0, cost_base: 0 },
          model: { provider: 'deepseek-account', model: 'deepseek-flash' },
          static_prefix_hash: 'h',
        }
      },
    }
    const adapter = new GatewayLlmAdapter({ gateway, meta: META })
    for await (const _ of adapter.stream({ messages: [] } as unknown as GenerateOptions)) {
      // 走完
    }
    for await (const _ of adapter.stream({
      messages: [assistantWithCall('call_a'), toolResult('call_a')],
    } as unknown as GenerateOptions)) {
      // 走完
    }
    expect(seen[0]).toBeUndefined()
    expect(seen[1]).toEqual(REPLAY)
  })
})
