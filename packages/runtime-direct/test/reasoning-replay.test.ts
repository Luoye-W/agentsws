/**
 * WP143：Messages 口的思考块（含签名）在 direct-llm 这条路上原样带回下一轮。
 * 官方 `dsh-llm-deepseek`：「此前 assistant 轮次的推理内容会原样传回」。
 */
import type { ChatMessage, ReasoningReplay } from '@agentsws/contracts'
import { createModelGateway } from '@agentsws/model-gateway'
import { describe, expect, it } from 'vitest'
import { clock, harness, MODEL } from './helpers.js'

const REPLAY: ReasoningReplay = {
  kind: 'deepseek-messages',
  model: MODEL.model,
  blocks: [{ thinking: '先查订单', signature: 'sig-Ab/+==\u0000raw' }],
}

describe('WP143 direct-llm：思考块签名原样跟着 assistant 那一轮走', () => {
  it('第二轮请求里的 assistant 消息带着第一轮的 reasoning_replay，一个字节不改', async () => {
    const seen: ChatMessage[][] = []
    const c = clock()
    const gateway = createModelGateway({
      providers: [
        {
          ref: MODEL,
          async complete(req) {
            seen.push(req.messages)
            return seen.length === 1
              ? {
                  text: '',
                  tool_calls: [
                    { id: 'call_1', name: 'get_order', input: { order_id: 'ord_1001' } },
                  ],
                  reasoning: '先查订单',
                  reasoning_replay: REPLAY,
                  usage: { input_tokens: 1, output_tokens: 1, cached_tokens: 0 },
                }
              : { text: '好的', usage: { input_tokens: 1, output_tokens: 1, cached_tokens: 0 } }
          },
        },
      ],
      policy: {
        default: MODEL,
        data_residency: 'cn',
        prices: { 'stub/scripted-v1': { in: 1, out: 2, cached: 0.1 } },
      },
      clock: c,
      env: {},
      eventSink: () => {},
    })
    const h = harness({ script: [], gateway, clock: c, toolChoice: false })
    await h.run()
    expect(seen.length).toBeGreaterThanOrEqual(2)
    const assistant = seen[1]?.find((m) => m.role === 'assistant')
    expect(assistant?.reasoning).toBe('先查订单')
    expect(assistant?.reasoning_replay).toEqual(REPLAY)
    // 事件里没有签名（只在对话历史里流转）
    expect(JSON.stringify(h.events)).not.toContain('sig-Ab')
  })
})
