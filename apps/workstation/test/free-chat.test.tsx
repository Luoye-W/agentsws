/**
 * WP188「随便聊」工作台：空态、模型下拉（含「Agents 工坊（用积分）」）、一轮流式对话、
 * 停止、联网开关只在开时带上、交给岗位去做、看不了图的模型不让贴图。全部替身，不联网。
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ModelPicker } from '@/components/free-chat/model-picker'
import { type Handoff, PaletteProvider } from '@/components/palette-context'
import type {
  FreeChatFrame,
  FreeChatMessage,
  FreeChatModels,
  FreeChatSession,
} from '@/lib/free-chat'
import { groupOf } from '@/lib/free-chat'
import { FreeChatPage, handoffOf } from '@/pages/free-chat'
import { renderWithProviders } from './helpers'

const T0 = '2026-09-29T08:00:00.000Z'

const MODELS: FreeChatModels = {
  choices: [
    {
      id: 'deepseek/deepseek-flash',
      label: 'DeepSeek 官方 · 官方 API 接口连接',
      official: false,
      vision: 'ok',
    },
    { id: 'agentsws/deepseek-flash', label: 'Agents 工坊（用积分）', official: true, vision: 'no' },
  ],
  default: 'deepseek/deepseek-flash',
  web_search: { available: true, max_searches: 5 },
  knowledge: { available: true },
}

const state = {
  models: MODELS,
  sessions: [] as FreeChatSession[],
  messages: {} as Record<string, FreeChatMessage[]>,
  calls: [] as { session_id: string; input: Record<string, unknown> }[],
  stops: [] as string[],
  /** 流到一半停住，等测试放行（测"停"那条）。 */
  hold: undefined as Promise<void> | undefined,
}

vi.mock('@/lib/free-chat', async () => {
  const actual = await vi.importActual<typeof import('@/lib/free-chat')>('@/lib/free-chat')
  return {
    ...actual,
    getFreeChatModels: async () => state.models,
    listFreeChatSessions: async () => state.sessions,
    listFreeChatMessages: async (id: string) => state.messages[id] ?? [],
    createFreeChatSession: async () => {
      const s = { id: 'fchat_1', title: '新对话', created_at: T0, updated_at: T0 }
      state.sessions = [s]
      return s
    },
    stopFreeChat: async (id: string) => {
      state.stops.push(id)
      return { stopped: true }
    },
    streamFreeChat: async (
      session_id: string,
      input: Record<string, unknown>,
      onFrame: (f: FreeChatFrame) => void,
    ) => {
      state.calls.push({ session_id, input })
      const user: FreeChatMessage = {
        id: 'fmsg_u',
        session_id,
        role: 'user',
        text: String(input.text ?? ''),
        at: T0,
      }
      onFrame({ type: 'start', user, message_id: 'fmsg_a' })
      onFrame({ type: 'delta', text: '你好，' })
      if (input.web_search === true) {
        onFrame({ type: 'searching', query: '今日汇率' })
        onFrame({ type: 'sources', sources: [{ url: 'https://example.com/fx', title: '汇率' }] })
      }
      if (state.hold !== undefined) await state.hold
      onFrame({ type: 'delta', text: '我在。' })
      const message: FreeChatMessage = {
        id: 'fmsg_a',
        session_id,
        role: 'assistant',
        text: '你好，我在。',
        at: T0,
        model: { id: 'agentsws/deepseek-flash', label: 'Agents 工坊（用积分）', official: true },
        usage: { input_tokens: 20, output_tokens: 6, credits: 0.01 },
        ...(input.web_search === true
          ? { sources: [{ url: 'https://example.com/fx', title: '汇率' }] }
          : {}),
      }
      state.messages[session_id] = [user, message]
      onFrame({
        type: 'done',
        message,
        session: { id: session_id, title: user.text, created_at: T0, updated_at: T0 },
      })
    },
  }
})

const opened: (Handoff | undefined)[] = []

/** 点开模型下拉（单独渲染下拉本身）。 */
function openPicker(): HTMLElement[] {
  renderWithProviders(
    <ModelPicker
      choices={MODELS.choices}
      value="deepseek/deepseek-flash"
      onChange={() => undefined}
    />,
  )
  fireEvent.click(screen.getByTestId('free-chat-model'))
  return screen.getAllByTestId('free-chat-model-option')
}

function renderPage(route = '/free-chat'): void {
  renderWithProviders(
    <PaletteProvider value={{ open: (h) => opened.push(h) }}>
      <Routes>
        <Route path="/free-chat/:id?" element={<FreeChatPage />} />
      </Routes>
    </PaletteProvider>,
    route,
  )
}

beforeEach(() => {
  state.models = MODELS
  state.sessions = []
  state.messages = {}
  state.calls = []
  state.stops = []
  state.hold = undefined
  opened.length = 0
})

describe('WP188 随便聊：空态与模型下拉', () => {
  it('空态：一句「想随便问点什么？」+ 输入框；下拉默认是设置里的默认模型', async () => {
    renderPage()
    expect((await screen.findByTestId('free-chat-empty')).textContent).toContain('想随便问点什么？')
    expect(screen.getByTestId('free-chat-input')).toBeDefined()
    await waitFor(() => {
      expect(screen.getByTestId('free-chat-model').dataset.model).toBe('deepseek/deepseek-flash')
    })
  })

  it('下拉里有「Agents 工坊（用积分）」，戴我们的品牌标记', () => {
    const options = openPicker()
    const cloud = options.find((o) => o.dataset.model === 'agentsws/deepseek-flash')
    expect(cloud?.textContent).toContain('Agents 工坊（用积分）')
    expect(cloud?.textContent).toContain('按积分扣')
    // 我们的品牌标记（不是字母圆圈）
    expect(cloud?.querySelector('svg rect')).not.toBeNull()
  })

  it('没接任何模型：下拉换成「还没接模型，去设置」', async () => {
    state.models = { ...MODELS, choices: [] }
    renderPage()
    expect((await screen.findByTestId('free-chat-no-model')).textContent).toContain('还没接模型')
  })
})

describe('WP188 随便聊：一轮对话', () => {
  it('发一句：新建会话、流式出字，回复下面标模型与花费', async () => {
    renderPage()
    const input = await screen.findByTestId('free-chat-input')
    await userEvent.type(input, '在吗{Enter}')
    const reply = await screen.findByTestId('free-chat-reply')
    await waitFor(() => {
      expect(reply.textContent).toContain('你好，我在。')
    })
    expect(state.calls[0]?.session_id).toBe('fchat_1')
    expect(state.calls[0]?.input).toMatchObject({
      text: '在吗',
      web_search: false,
      knowledge: false,
    })
    const cost = await screen.findByTestId('free-chat-cost')
    expect(cost.textContent).toContain('Agents 工坊（用积分）')
    expect(cost.textContent).toContain('约 0.01 积分')
  })

  it('联网开关默认关；打开之后才带上，来源画出来', async () => {
    renderPage()
    const toggle = await screen.findByTestId('free-chat-web-toggle')
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    await userEvent.click(toggle)
    await userEvent.type(screen.getByTestId('free-chat-input'), '今天汇率{Enter}')
    await waitFor(() => {
      expect(state.calls[0]?.input.web_search).toBe(true)
    })
    const sources = await screen.findByTestId('free-chat-sources')
    expect(within(sources).getByTestId('free-chat-source').getAttribute('href')).toBe(
      'https://example.com/fx',
    )
  })

  it('答的时候发送键变成停止键，点了请服务端停', async () => {
    let release: () => void = () => undefined
    state.hold = new Promise((r) => {
      release = r
    })
    renderPage()
    await userEvent.type(await screen.findByTestId('free-chat-input'), '讲个长故事{Enter}')
    const stop = await screen.findByTestId('free-chat-stop')
    await userEvent.click(stop)
    expect(state.stops).toEqual(['fchat_1'])
    release()
    await screen.findByTestId('free-chat-send')
  })

  it('「交给岗位去做」带着这一问一答打开 ⌘K', async () => {
    state.sessions = [{ id: 'fchat_9', title: '退货', created_at: T0, updated_at: T0 }]
    state.messages.fchat_9 = [
      { id: 'u1', session_id: 'fchat_9', role: 'user', text: '帮我想一封退货邮件', at: T0 },
      { id: 'a1', session_id: 'fchat_9', role: 'assistant', text: '好的，草稿如下……', at: T0 },
    ]
    renderPage('/free-chat/fchat_9')
    await userEvent.click(await screen.findByTestId('free-chat-handoff'))
    expect(opened[0]?.title).toBe('帮我想一封退货邮件')
    expect(opened[0]?.summary).toContain('好的，草稿如下')
  })

  it('选了看不了图的模型：贴图按钮是灰的', async () => {
    // 默认就是看不了图的那一条（下拉怎么选见上面那条用例）
    state.models = { ...MODELS, default: 'agentsws/deepseek-flash' }
    renderPage()
    await waitFor(() => {
      expect((screen.getByTestId('free-chat-attach') as HTMLButtonElement).disabled).toBe(true)
    })
  })
})

describe('WP188 小工具', () => {
  it('按日期分组：今天 / 昨天 / 7 天内 / 更早', () => {
    const now = new Date('2026-09-29T12:00:00')
    expect(groupOf('2026-09-29T01:00:00', now)).toBe('today')
    expect(groupOf('2026-09-28T23:00:00', now)).toBe('yesterday')
    expect(groupOf('2026-09-25T10:00:00', now)).toBe('week')
    expect(groupOf('2026-08-01T10:00:00', now)).toBe('older')
  })

  it('交过去的标题是用户那句话，上下文不超过 2000 字', () => {
    const user = { id: 'u', session_id: 's', role: 'user' as const, text: 'a'.repeat(300), at: T0 }
    const reply = {
      id: 'a',
      session_id: 's',
      role: 'assistant' as const,
      text: 'b'.repeat(5000),
      at: T0,
    }
    const h = handoffOf(user, reply)
    expect(h.title.length).toBeLessThanOrEqual(120)
    expect(h.summary.length).toBeLessThanOrEqual(2000)
  })
})
