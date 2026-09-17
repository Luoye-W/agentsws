/**
 * WP87：思考模型的推理在 dsh 这条路上不能掉。
 *
 * 出处：realistic 档跑 `aftersales/boundary-first-time`（dsh-subprocess，deepseek-v4.1-flash）
 * 时，`<场景>.model.jsonl` 里每一轮的 `request.carried_reasoning` 都是 0，而回来的
 * `response.reasoning_chars` 是 764 / 363 / 76 / 1533 / 8041——模型在思考，我们一轮都没带回去。
 * `ChatMessage.reasoning` 的契约注释写着 DeepSeek thinking 模式多轮时不原样带回就 400
 * （09-14 真店实测）；百炼那一口容忍了，官方口不会。
 */
import type { Completion, ModelMeta } from '@agentsws/contracts'
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

const assistantWithCall = (id: string, name: string): Message =>
  ({
    role: 'assistant',
    content: [{ type: 'tool-call', id: id as ToolCallId, name, arguments: '{"order_id":"o1"}' }],
  }) as unknown as Message

const toolResult = (id: string, text: string): Message =>
  ({
    role: 'user',
    content: [
      { type: 'tool-result', toolCallId: id as ToolCallId, content: [{ type: 'text', text }] },
    ],
  }) as unknown as Message

describe('WP87 思考模型的 reasoning 在 dsh 这条路上原样带回', () => {
  it('没有记录时 assistant 消息不带 reasoning（老行为）', () => {
    const options = {
      system: 'you are support',
      messages: [assistantWithCall('c1', 'get_order'), toolResult('c1', '{"id":"o1"}')],
    } as unknown as GenerateOptions
    const messages = toChatMessages(options)
    const assistant = messages.find((m) => m.role === 'assistant')
    expect(assistant?.tool_calls?.[0]?.name).toBe('get_order')
    expect(assistant?.reasoning).toBeUndefined()
  })

  it('按 tool-call id 记过推理，下一轮就接回那条 assistant', () => {
    const options = {
      system: 'you are support',
      messages: [assistantWithCall('c1', 'get_order'), toolResult('c1', '{"id":"o1"}')],
    } as unknown as GenerateOptions
    const messages = toChatMessages(options, new Map([['c1', '先查订单再说退款']]))
    const assistant = messages.find((m) => m.role === 'assistant')
    expect(assistant?.reasoning).toBe('先查订单再说退款')
    // 工具结果照旧还原成 tool 角色（这条没被改坏）
    expect(messages.find((m) => m.role === 'tool')?.tool_call_id).toBe('c1')
  })

  it('适配器自己把每轮的 reasoning 存下来，第二轮的请求里就带着它', async () => {
    const seen: { reasoning?: string }[] = []
    let turn = 0
    const gateway = {
      async complete(req: { messages: { role: string; reasoning?: string }[] }): Promise<Completion> {
        const assistant = req.messages.find((m) => m.role === 'assistant')
        seen.push({ ...(assistant?.reasoning === undefined ? {} : { reasoning: assistant.reasoning }) })
        turn += 1
        return {
          text: '',
          ...(turn === 1
            ? { tool_calls: [{ id: 'call_a', name: 'get_order', input: { order_id: 'o1' } }] }
            : {}),
          reasoning: `第 ${turn} 轮的推理`,
          usage: { input_tokens: 10, output_tokens: 5, cached_tokens: 0, cost_base: 0 },
          model: { provider: 'deepseek', model: 'deepseek-v4.1-flash' },
          static_prefix_hash: 'h',
        }
      },
    }
    const adapter = new GatewayLlmAdapter({ gateway, meta: META })

    // 第一轮：没有历史
    for await (const _ of adapter.stream({
      system: 'you are support',
      messages: [],
    } as unknown as GenerateOptions)) {
      // 只要把流走完
    }
    // 第二轮：loop 把上一轮的 assistant 与工具结果放回历史里
    for await (const _ of adapter.stream({
      system: 'you are support',
      messages: [assistantWithCall('call_a', 'get_order'), toolResult('call_a', '{"id":"o1"}')],
    } as unknown as GenerateOptions)) {
      // 同上
    }

    expect(seen[0]?.reasoning).toBeUndefined()
    expect(seen[1]?.reasoning).toBe('第 1 轮的推理')
  })
})
