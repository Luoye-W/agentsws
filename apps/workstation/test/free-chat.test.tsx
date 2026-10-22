/**
 * WP188「随便聊」工作台：空态、模型下拉（含「Agents 工坊（用积分）」）、一轮流式对话、
 * 停止、联网开关只在开时带上、看不了图的模型不让贴图。全部替身，不联网。
 * WP343：改名「我的助理」（地址 `/assistant`）；「交给岗位去做」按钮去掉，换成回复下面「已交给 X」那一行。
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
import { FreeChatPage } from '@/pages/free-chat'
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
    getAssistantState: async () => ({ suggestions: [], targets: [] }),
    listAssistantMemory: async () => [],
    listFreeChatSessions: async () => state.sessions,
    // WP352：只有一条长对话
    getAssistantThread: async () => ({
      session: state.sessions[0] ?? {
        id: 'fchat_1',
        title: '助理',
        created_at: T0,
        updated_at: T0,
      },
      segments: [],
    }),
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
  fireEvent.click(screen.getByTestId('model-pick'))
  return screen.getAllByTestId('model-pick-option')
}

function renderPage(route = '/assistant'): void {
  renderWithProviders(
    <PaletteProvider value={{ open: (h) => opened.push(h) }}>
      <Routes>
        <Route path="/assistant/:id?" element={<FreeChatPage />} />
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
  it('空态：标题「有什么要我做的？」+ 输入框（那一整句并进占位字，WP456-T8）；下拉默认是设置里的默认模型', async () => {
    renderPage()
    expect((await screen.findByTestId('free-chat-empty')).textContent).toContain('有什么要我做的？')
    expect(screen.queryByTestId('assistant-intro')).toBeNull()
    expect(screen.getByTestId('free-chat-input').getAttribute('placeholder')).toContain(
      '直接交代一件事',
    )
    // WP195：空态的标记是待机
    expect(
      screen.getByTestId('free-chat-empty').querySelector('svg')?.getAttribute('data-motion'),
    ).toBe('idle')
    expect(screen.getByTestId('free-chat-input')).toBeDefined()
    await waitFor(() => {
      expect(screen.getByTestId('free-chat-model').dataset.model).toBe('deepseek/deepseek-flash')
    })
  })

  it('下拉里有「Agents 工坊（积分）」那一组，组标题戴我们的品牌标记（WP362：按来源分组）', () => {
    const options = openPicker()
    const cloud = options.find((o) => o.dataset.model === 'agentsws/deepseek-flash')
    expect(cloud?.textContent).toContain('deepseek-flash')
    const group = cloud?.closest('[data-testid="model-pick-group"]') as HTMLElement
    expect(group.dataset.group).toBe('workshop')
    expect(group.textContent).toContain('Agents 工坊（积分）')
    // 我们的品牌标记（不是字母圆圈）
    expect(group.querySelector('svg rect')).not.toBeNull()
  })

  it('没接任何模型：输入框里的 AI 钮换成「还没接 AI」，点了开第三栏接模型卡（WP342 / 857）', async () => {
    state.models = { ...MODELS, choices: [] }
    renderPage()
    const none = await screen.findByTestId('free-chat-model-none')
    expect(none.textContent).toContain('还没接 AI')
    // 857：点了在第三栏开「接模型」连接卡（WP334），不是跳设置页的链接
    expect(none.tagName).toBe('BUTTON')
    expect(none.getAttribute('data-connect')).toBe('model')
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

  it('联网开关默认关（在「+」里，WP456-T8）；打开之后框里一颗小标、才带上，来源画出来', async () => {
    renderPage()
    await screen.findByTestId('free-chat-input')
    expect(screen.queryByTestId('assistant-toggle-chip')).toBeNull()
    await userEvent.click(screen.getByTestId('matter-attach'))
    const toggle = await screen.findByTestId('composer-plus-web')
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    await userEvent.click(toggle)
    const chip = await screen.findByTestId('assistant-toggle-chip')
    expect(chip.dataset.kind).toBe('web')
    expect(chip.textContent).toContain('联网搜索')
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
    const stop = await screen.findByTestId('matter-stop')
    await userEvent.click(stop)
    expect(state.stops).toEqual(['fchat_1'])
    release()
    await screen.findByTestId('matter-send')
  })

  it('WP343：「交给岗位去做」按钮没有了；交出去的事回复下面一行「已交给 X · Y」，点了进那件事', async () => {
    state.sessions = [{ id: 'fchat_9', title: '新帖', created_at: T0, updated_at: T0 }]
    state.messages.fchat_9 = [
      { id: 'u1', session_id: 'fchat_9', role: 'user', text: '让 Reddit 运营查新帖', at: T0 },
      {
        id: 'a1',
        session_id: 'fchat_9',
        role: 'assistant',
        text: '好的，交给了 Reddit 运营。',
        at: T0,
        dispatches: [
          {
            matter_id: 'mat_7',
            title: '查新帖',
            position_id: 'reddit-ops',
            position_name: 'Reddit 运营',
            duty_name: '官方版块',
            at: T0,
          },
        ],
      },
      {
        id: 'a2',
        session_id: 'fchat_9',
        role: 'assistant',
        text: '**Reddit 运营 · 官方版块** 做完了：查到 3 条新帖',
        at: T0,
        report: {
          matter_id: 'mat_7',
          kind: 'done',
          position_name: 'Reddit 运营',
          duty_name: '官方版块',
        },
      },
    ]
    renderPage()
    const link = await screen.findByTestId('assistant-dispatch-link')
    expect(link.textContent).toBe('已交给 Reddit 运营 · 官方版块')
    expect(link.getAttribute('href')).toBe('/matters/mat_7')
    expect(screen.queryByTestId('free-chat-handoff')).toBeNull()
    const report = screen.getByTestId('assistant-report')
    expect(report.dataset.kind).toBe('done')
    expect(report.textContent).toContain('查到 3 条新帖')
    expect(within(report).getByTestId('assistant-report-open').getAttribute('href')).toBe(
      '/matters/mat_7',
    )
    expect(opened).toEqual([])
  })

  it('WP456-T8（§3.7）：输入框是岗位页那一个完整对话框（贴底居中）；右上是图标钮 + tooltip', async () => {
    renderPage()
    const dock = await screen.findByTestId('composer-dock')
    expect(dock.dataset.variant).toBe('full')
    expect(within(dock).getByTestId('matter-say')).toBeDefined()
    expect(within(dock).getByTestId('free-chat-input')).toBeDefined()
    // 框外不再有「联网搜索」「用公司资料回答」两颗描边小标
    expect(screen.queryByTestId('free-chat-web-toggle')).toBeNull()
    expect(screen.queryByTestId('free-chat-knowledge-toggle')).toBeNull()
    const memory = screen.getByTestId('assistant-memory')
    expect(memory.textContent).toBe('')
    expect(memory.getAttribute('title')).toBe('记忆')
    // 「+」里：附资料、加图、联网、公司资料
    await userEvent.click(screen.getByTestId('matter-attach'))
    const menu = await screen.findByTestId('composer-plus-menu')
    for (const id of [
      'composer-plus-doc',
      'composer-plus-image',
      'composer-plus-web',
      'composer-plus-knowledge',
    ])
      expect(within(menu).getByTestId(id)).toBeDefined()
  })

  it('选了看不了图的模型：「+」里的加图是灰的', async () => {
    // 默认就是看不了图的那一条（下拉怎么选见上面那条用例）
    state.models = { ...MODELS, default: 'agentsws/deepseek-flash' }
    renderPage()
    await waitFor(() => {
      expect(screen.getByTestId('free-chat-model').dataset.model).toBe('agentsws/deepseek-flash')
    })
    await userEvent.click(screen.getByTestId('matter-attach'))
    const item = await screen.findByTestId('composer-plus-image')
    expect(item.getAttribute('aria-disabled')).toBe('true')
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
})
