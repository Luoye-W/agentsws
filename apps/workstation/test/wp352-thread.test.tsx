/**
 * WP352（决策 931）助理一条长对话（工作台）：没有会话列表；换了一天画日期、换了话题画一条淡线 + 上一个话题的
 * 一行小结；顶部搜索命中点了跳到那条并亮一下；「换个话题」切段；翻旧账的出处点了跳过去；带会话 id 的老地址
 * 回到 `/assistant`；流式时「换话题」记号不露出来。全部替身，不联网。
 */
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes, useLocation } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssistantSegment, FreeChatMessage, FreeChatModels } from '@/lib/free-chat'
import { hideRememberTags } from '@/lib/free-chat'
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
  topics: 0,
  searched: [] as string[],
}))

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
    newAssistantTopic: async () => {
      state.topics += 1
      state.segments = [
        ...state.segments.map((s) => ({ ...s, current: false })),
        { id: 'seg_new', started_at: '2026-10-16T09:00:00.000Z', reason: 'manual', current: true },
      ]
      return { session: SESSION, segments: state.segments }
    },
    searchAssistantHistory: async (q: string) => {
      state.searched.push(q)
      return [
        {
          segment_id: 'seg_a',
          message_id: 'm1',
          kind: 'message',
          at: '2026-10-14T02:00:00.000Z',
          role: 'user',
          title: '退货口径',
          snippet: '退货期限定 30 天',
        },
      ]
    },
  }
})

const msg = (
  id: string,
  role: 'user' | 'assistant',
  text: string,
  at: string,
  segment_id: string,
  extra: Partial<FreeChatMessage> = {},
): FreeChatMessage => ({ id, session_id: SESSION.id, role, text, at, segment_id, ...extra })

function Where(): React.ReactNode {
  const loc = useLocation()
  return <p data-testid="where">{`${loc.pathname}${loc.search}`}</p>
}

function renderPage(route = '/assistant'): void {
  renderWithProviders(
    <>
      <Routes>
        <Route path="/assistant/:id?" element={<FreeChatPage />} />
      </Routes>
      <Where />
    </>,
    route,
  )
}

beforeEach(() => {
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
    msg('m1', 'user', '退货期限定 30 天', '2026-10-14T02:00:00.000Z', 'seg_a'),
    msg('m2', 'assistant', '好的，记下了。', '2026-10-14T02:01:00.000Z', 'seg_a'),
    msg('m3', 'user', '上周说的退货期限是多少', '2026-10-16T02:00:00.000Z', 'seg_b'),
    msg('m4', 'assistant', '是 30 天。', '2026-10-16T02:00:05.000Z', 'seg_b', {
      recalled: [
        {
          segment_id: 'seg_a',
          message_id: 'm1',
          kind: 'message',
          at: '2026-10-14T02:00:00.000Z',
          snippet: '退货期限定 30 天',
        },
      ],
    }),
  ]
  state.topics = 0
  state.searched = []
  Element.prototype.scrollIntoView = vi.fn()
})

describe('WP352 一条长对话', () => {
  it('没有会话列表；换了一天画日期；换了话题一条线 + 上一个话题的一行小结', async () => {
    renderPage()
    await screen.findByText('是 30 天。')
    expect(screen.queryByTestId('free-chat-session-list')).toBeNull()
    expect(screen.queryByText('新对话')).toBeNull()
    expect(screen.getAllByTestId('thread-day')).toHaveLength(2)
    const topics = screen.getAllByTestId('thread-topic')
    expect(topics).toHaveLength(1)
    expect(topics[0]?.textContent).toBe('退货口径')
    expect(topics[0]?.getAttribute('title')).toContain('退货期限 30 天')
  })

  it('搜索：输两个字就搜，点命中跳到那条并亮一下', async () => {
    renderPage()
    await userEvent.click(await screen.findByTestId('assistant-search'))
    await userEvent.type(screen.getByTestId('assistant-search-input'), '退货')
    const hit = await screen.findByTestId('assistant-search-hit')
    expect(hit.textContent).toContain('退货口径')
    expect(state.searched.at(-1)).toBe('退货')
    await userEvent.click(hit)
    await waitFor(() => {
      expect(document.querySelector('[data-msg="m1"]')?.className).toContain('ring-2')
    })
    await waitFor(() => {
      expect(Element.prototype.scrollIntoView).toHaveBeenCalled()
    })
  })

  it('翻旧账的出处点了跳过去', async () => {
    renderPage()
    const ref = await screen.findByTestId('assistant-recalled-ref')
    expect(ref.textContent).toContain('出处')
    await userEvent.click(ref)
    await waitFor(() => {
      expect(document.querySelector('[data-msg="m1"]')?.className).toContain('ring-2')
    })
  })

  it('换个话题：切一段，末尾先画一条线；新段空着时不再出这个钮', async () => {
    renderPage()
    await userEvent.click(await screen.findByTestId('assistant-new-topic'))
    await waitFor(() => {
      expect(state.topics).toBe(1)
      expect(screen.getAllByTestId('thread-topic')).toHaveLength(2)
    })
    expect(screen.queryByTestId('assistant-new-topic')).toBeNull()
  })

  it('带会话 id 的老地址回到 /assistant', async () => {
    renderPage('/assistant/fchat_old?memory=x')
    await waitFor(() => {
      expect(screen.getByTestId('where').textContent).toBe('/assistant?memory=x')
    })
  })

  it('流式时「换话题」记号（含流到一半）不露出来', () => {
    expect(hideRememberTags('<new-topic/>好的')).toBe('好的')
    expect(hideRememberTags('<new-to')).toBe('')
    expect(hideRememberTags('好的<remember>x</remember>')).toBe('好的')
    expect(hideRememberTags('<b>粗</b>')).toBe('<b>粗</b>')
  })
})
