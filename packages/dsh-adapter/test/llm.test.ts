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

// WP132（dsh 0.1.7-rc.1）：工具结果从"带 `tool-result` 块的 user 消息"升成一等的
// `role: 'tool'` 消息（`dsh-llm` 的 `ToolResultMessage`：`toolCallId` + 结果块本身）。
// 这里是上游消息形状的替身，随上游改；断言一条没动。
const toolResult = (id: string, text: string): Message =>
  ({
    role: 'tool',
    toolCallId: id as ToolCallId,
    source: { kind: 'tool', callId: id as ToolCallId },
    content: [{ type: 'text', text }],
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
      async complete(req: {
        messages: { role: string; reasoning?: string }[]
      }): Promise<Completion> {
        const assistant = req.messages.find((m) => m.role === 'assistant')
        seen.push({
          ...(assistant?.reasoning === undefined ? {} : { reasoning: assistant.reasoning }),
        })
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

/**
 * WP147：路由的图片能力声明与截图出线（`resolveModel` / `stream`）。
 * 能不能看图由宿主按 WP127 三步验证回答；没验证过的来源不声明——行为与以前逐字节相同。
 */
describe('WP147：看图声明与工具结果里的截图', () => {
  const gateway = {
    async complete(): Promise<Completion> {
      return {
        text: 'ok',
        usage: { input_tokens: 1, output_tokens: 1, cached_tokens: 0, cost_base: 0 },
        model: { provider: 'stub', model: 'stub-v1' },
        static_prefix_hash: 'p',
      }
    },
  }

  it('验证过能看图才声明 image；没声明时与以前一样什么都不写', async () => {
    const yes = new GatewayLlmAdapter({ gateway, meta: META, imageInput: true })
    expect((await yes.resolveModel('agentsws-gateway', 'm')).inputModalities).toEqual([
      'text',
      'image',
    ])
    const no = new GatewayLlmAdapter({ gateway, meta: META })
    expect(await no.resolveModel('agentsws-gateway', 'm')).toEqual({
      provider: 'agentsws-gateway',
      id: 'm',
      name: 'm',
    })
  })

  const ref = {
    attachmentId: 'sha256:0123456789abcdef',
    mediaType: 'image/png',
    bytes: 10,
    width: 3000,
    height: 1000,
  }
  const toolWithImage = (offloaded?: true): Message =>
    ({
      role: 'tool',
      toolCallId: 'call_a' as ToolCallId,
      content: [
        { type: 'text', text: 'tree_markdown' },
        { type: 'image', attachment: ref, ...(offloaded ? { offloaded } : {}) },
      ],
    }) as unknown as Message

  it('按官方规则缩放（总像素 2048×2048、不放大、1 MiB 目标）并以图片部件出线', async () => {
    const seen: unknown[] = []
    const targets: unknown[] = []
    const adapter = new GatewayLlmAdapter({
      gateway: {
        async complete(req) {
          seen.push(req.messages)
          return gateway.complete()
        },
      },
      meta: META,
      imageInput: true,
      attachments: () =>
        ({
          async readImageRequest(_r: unknown, target: { width: number; height: number }) {
            targets.push(target)
            return {
              attachment: ref,
              data: new Uint8Array([1, 2, 3]),
              mediaType: 'image/jpeg',
              bytes: 3,
              width: target.width,
              height: target.height,
            }
          },
        }) as never,
    })
    for await (const _ of adapter.stream({
      messages: [assistantWithCall('call_a', 'shot'), toolWithImage()],
    } as unknown as GenerateOptions)) {
      // 走完
    }
    expect(targets[0]).toMatchObject({ maxBytes: 1024 * 1024 })
    const t = targets[0] as { width: number; height: number }
    expect(t.width * t.height).toBeLessThanOrEqual(2048 * 2048)
    expect(t.width / t.height).toBeCloseTo(3, 1)
    const tool = (seen[0] as { role: string; content: unknown }[]).find((m) => m.role === 'tool')
    expect(tool?.content).toEqual([
      { type: 'text', text: 'tree_markdown' },
      expect.objectContaining({ type: 'text' }),
      { type: 'image', mime: 'image/jpeg', data: 'AQID' },
    ])
  })

  it('会话里已标 offloaded 的旧图换成官方占位；路由没声明看图时剩下的图换成「只收文字」那一句', async () => {
    const seen: unknown[] = []
    const adapter = new GatewayLlmAdapter({
      gateway: {
        async complete(req) {
          seen.push(req.messages)
          return gateway.complete()
        },
      },
      meta: META,
    })
    for await (const _ of adapter.stream({
      messages: [
        assistantWithCall('call_a', 'shot'),
        toolWithImage(true),
        assistantWithCall('call_b', 'shot'),
        { ...toolWithImage(), toolCallId: 'call_b' },
      ],
    } as unknown as GenerateOptions)) {
      // 走完
    }
    const text = JSON.stringify(seen)
    expect(text).toContain('image omitted to fit request image limits')
    expect(text).toContain('image omitted because this model accepts text only')
    expect(text).not.toContain('"type":"image"')
  })
})
