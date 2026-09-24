/**
 * WP147：工具结果里的截图（电脑操控 / 浏览器）怎么出线。
 *
 * - OpenAI 兼容口：`role: 'tool'` 只收文字——照官方 pi-ai，图挪进紧跟的一条 user 消息；
 * - Messages 口（DeepSeek 官方适配器同款）：`tool_result` 的 content 用块数组（文字 + 图片）；
 * - 没有图的对话两条线路都**逐字节不变**。
 */
import type { ChatMessage } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import type { FetchLike } from '../src/index.js'
import {
  openaiCompatibleProvider,
  TOOL_IMAGE_PLACEHOLDER,
  TOOL_IMAGES_LEAD,
  toMessagesRequest,
  toWireMessages,
} from '../src/index.js'

const PNG = 'iVBORw0KGgoAAAANSUhEUg=='

const history = (withImage: boolean): ChatMessage[] => [
  { role: 'system', content: 'persona' },
  { role: 'user', content: 'look at the window' },
  {
    role: 'assistant',
    content: '',
    tool_calls: [
      { id: 'c1', name: 'mcp__cua-driver-mcp__get_window_state', input: {} },
      { id: 'c2', name: 'orders.get', input: { id: 'o1' } },
    ],
  },
  {
    role: 'tool',
    tool_call_id: 'c1',
    name: 'mcp__cua-driver-mcp__get_window_state',
    content: withImage
      ? [
          { type: 'text', text: 'tree_markdown: AXWindow "Notes"' },
          { type: 'image', mime: 'image/png', data: PNG },
        ]
      : 'tree_markdown: AXWindow "Notes"',
  },
  { role: 'tool', tool_call_id: 'c2', name: 'orders.get', content: '{"id":"o1"}' },
]

describe('OpenAI 兼容口：工具结果里的图挪进紧跟的一条 user 消息', () => {
  it('tool 消息只留文字；这一串工具结果之后补一条 user 消息带图', () => {
    const wire = toWireMessages(history(true))
    expect(wire.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'tool', 'user'])
    expect(wire[3]).toMatchObject({ role: 'tool', content: 'tree_markdown: AXWindow "Notes"' })
    expect(wire[5]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: TOOL_IMAGES_LEAD },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } },
      ],
    })
  })

  it('只有图没有字的工具结果给一句占位', () => {
    const msgs = history(true)
    msgs[3] = {
      ...msgs[3],
      content: [{ type: 'image', mime: 'image/png', data: PNG }],
    } as ChatMessage
    expect(toWireMessages(msgs)[3]).toMatchObject({ content: TOOL_IMAGE_PLACEHOLDER })
  })

  it('没有图的对话与逐条翻译逐字节相同（不多一条消息）', async () => {
    const calls: string[] = []
    const fetch: FetchLike = async (_url, init) => {
      calls.push(String(init.body))
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: 'ok' } }], usage: {} }),
        text: async () => '',
      }
    }
    const provider = openaiCompatibleProvider({
      apiKey: () => 'test-not-real',
      model: 'm',
      fetch,
    })
    await provider.complete({ messages: history(false) })
    const sent = JSON.parse(calls[0] ?? '{}') as { messages: unknown[] }
    expect(sent.messages).toHaveLength(5)
    expect(JSON.stringify(sent)).not.toContain(TOOL_IMAGES_LEAD)
    await provider.complete({ messages: history(true) })
    const withImage = JSON.parse(calls[1] ?? '{}') as { messages: { role: string }[] }
    expect(withImage.messages.at(-1)?.role).toBe('user')
    expect(calls[1]).toContain(`data:image/png;base64,${PNG}`)
  })
})

describe('Messages 口：tool_result 的 content 用块数组', () => {
  it('有图：文字 + 图片块，图片来源同样可以走 Files 复用', () => {
    const req = toMessagesRequest(history(true), {
      imageSource: () => ({ type: 'file', file_id: 'file_1' }),
    })
    const user = req.messages.at(-1)
    expect(user?.role).toBe('user')
    expect(user?.content[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 'c1',
      content: [
        { type: 'text', text: 'tree_markdown: AXWindow "Notes"' },
        { type: 'image', source: { type: 'file', file_id: 'file_1' } },
      ],
    })
  })

  it('没有图：tool_result 的 content 仍是一段字符串', () => {
    const req = toMessagesRequest(history(false))
    expect(req.messages.at(-1)?.content[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 'c1',
      content: 'tree_markdown: AXWindow "Notes"',
    })
  })
})
