/**
 * WP511（决策 1546 / 1765「资料在右、决策在中」）助理「打开那一段」（工作台）：话题分隔线上的小结、回复下面的出处
 * 点了在第三栏开那一段当时的原话（亮那一句）；面板一页 50 句、能往后翻；附件只有名字与字数。全部替身，不联网。
 */
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  assistantSegmentAddress,
  parseAssistantSegmentAddress,
} from '@/components/free-chat/segment-address'
import { AssistantSegmentPanel } from '@/components/free-chat/segment-panel'
import { ensureBuiltinPanels } from '@/components/rail/builtin-panels'
import { RailStateProvider, useRailState } from '@/components/rail/rail-state'
import type { AssistantSegment, FreeChatMessage, FreeChatModels } from '@/lib/free-chat'
import { FreeChatPage } from '@/pages/free-chat'
import { renderWithProviders } from './helpers'

const MODELS: FreeChatModels = {
  choices: [{ id: 'deepseek/deepseek-flash', label: 'DeepSeek', official: false, vision: 'ok' }],
  default: 'deepseek/deepseek-flash',
  web_search: { available: true, max_searches: 5 },
  knowledge: { available: true },
}
const SESSION = { id: 'fchat_t', title: '助理', created_at: '', updated_at: '' }

const state = vi.hoisted(() => ({
  segments: [] as AssistantSegment[],
  messages: [] as FreeChatMessage[],
  pages: [] as { id: string; from: number }[],
}))

const msg = (id: string, role: 'user' | 'assistant', text: string, segment_id: string) => ({
  id,
  session_id: 'fchat_t',
  role,
  text,
  at: '2026-10-14T02:00:00.000Z',
  segment_id,
})

vi.mock('@/lib/free-chat', async () => {
  const actual = await vi.importActual<typeof import('@/lib/free-chat')>('@/lib/free-chat')
  return {
    ...actual,
    getFreeChatModels: async () => MODELS,
    getAssistantState: async () => ({ suggestions: [], targets: [] }),
    listAssistantMemory: async () => [],
    listFreeChatSessions: async () => [SESSION],
    getAssistantThread: async () => ({ session: SESSION, segments: state.segments }),
    listFreeChatMessages: async () => state.messages,
    getAssistantSegment: async (id: string, from = 1, limit = 50) => {
      state.pages.push({ id, from })
      const all = Array.from({ length: 60 }, (_, i) =>
        i === 0
          ? {
              ...msg('m1', 'user', '退货期限定 30 天', id),
              attachments: [{ name: '价目.csv', chars: 20 }],
            }
          : msg(`x${i + 1}`, i % 2 === 0 ? 'user' : 'assistant', `第 ${i + 1} 句`, id),
      )
      return {
        segment: state.segments.find((s) => s.id === id),
        n: 1,
        from,
        total: all.length,
        messages: all.slice(from - 1, from - 1 + limit),
      }
    },
  }
})

function RailProbe(): React.ReactNode {
  const rail = useRailState()
  return (
    <>
      <span data-testid="rail-open">{rail.open ?? '—'}</span>
      <span data-testid="rail-address">{rail.address ?? '—'}</span>
    </>
  )
}

beforeEach(() => {
  ensureBuiltinPanels()
  state.segments = [
    {
      id: 'seg_a',
      started_at: '2026-10-14T02:00:00.000Z',
      ended_at: '2026-10-14T02:01:00.000Z',
      reason: 'first',
      title: '退货口径',
      summary: '## 定了什么\n- 退货期限 30 天',
      current: false,
    },
    { id: 'seg_b', started_at: '2026-10-16T02:00:00.000Z', reason: 'day', current: true },
  ]
  state.messages = [
    msg('m1', 'user', '退货期限定 30 天', 'seg_a'),
    msg('m2', 'assistant', '好的，记下了。', 'seg_a'),
    msg('m3', 'user', '上周说的退货期限是多少', 'seg_b'),
    {
      ...msg('m4', 'assistant', '是 30 天。', 'seg_b'),
      recalled: [
        {
          segment_id: 'seg_a',
          message_id: 'm1',
          kind: 'message',
          at: '2026-10-14T02:00:00.000Z',
          snippet: '退货期限定 30 天',
          segment_n: 1,
          message_n: 1,
        },
      ],
    },
  ]
  state.pages = []
  Element.prototype.scrollIntoView = vi.fn()
})

describe('WP511 打开那一段（第三栏）', () => {
  it('地址来回认', () => {
    const a = assistantSegmentAddress('seg_a', 'm1')
    expect(a).toBe('agentsws://assistant-segment/seg_a/m1')
    expect(parseAssistantSegmentAddress(a)).toEqual({ segment_id: 'seg_a', message_id: 'm1' })
    expect(parseAssistantSegmentAddress(assistantSegmentAddress('seg_a'))).toEqual({
      segment_id: 'seg_a',
    })
    expect(parseAssistantSegmentAddress('agentsws://report/r1')).toBeUndefined()
  })

  it('小结那一行、出处点了：第三栏开到那一段（出处带那一句）', async () => {
    renderWithProviders(
      <RailStateProvider>
        <Routes>
          <Route path="/assistant/:id?" element={<FreeChatPage />} />
        </Routes>
        <RailProbe />
      </RailStateProvider>,
      '/assistant',
    )
    await userEvent.click(await screen.findByTestId('thread-topic-open'))
    expect(screen.getByTestId('rail-open').textContent).toBe('assistant-segment')
    expect(screen.getByTestId('rail-address').textContent).toBe(
      'agentsws://assistant-segment/seg_a',
    )
    await userEvent.click(screen.getByTestId('assistant-recalled-ref'))
    expect(screen.getByTestId('rail-address').textContent).toBe(
      'agentsws://assistant-segment/seg_a/m1',
    )
  })

  it('面板：段号与小结、亮那一句、附件只有名字；还有更多就往后翻', async () => {
    renderWithProviders(
      <AssistantSegmentPanel
        tier="position"
        pathname="/assistant"
        address={assistantSegmentAddress('seg_a', 'm1')}
      />,
    )
    expect((await screen.findByTestId('assistant-segment-title')).textContent).toContain('第 1 段')
    expect(screen.getByTestId('assistant-segment-title').textContent).toContain('退货口径')
    const lines = screen.getAllByTestId('assistant-segment-line')
    expect(lines).toHaveLength(50)
    expect(lines[0]?.getAttribute('data-lit')).toBe('true')
    expect(screen.getByTestId('assistant-segment-file').textContent).toContain('价目.csv')
    await userEvent.click(screen.getByTestId('assistant-segment-more'))
    await waitFor(() => expect(state.pages.at(-1)).toEqual({ id: 'seg_a', from: 51 }))
    expect(await screen.findByTestId('assistant-segment-earlier')).toBeTruthy()
  })
})
