/**
 * WP343（决策 334 / 859）「我的助理」工作台：
 * - 个人模式不出「替我答同事」，同事 / 公司模式出（点开是谁问过我 / 约时间 / 我的公开资料）；
 * - 快捷问题随状态变化、开始对话后收起；「帮我建一个岗位」点了去建岗位、不发话；
 * - 输入框 `@` 选岗位 → 这句话带着 target 发出去，气泡上标「@ 谁」；
 * - 老地址 `/free-chat`、`/secretary` 跳过来；
 * - 「记住了」小提醒点助理层那条 → 回到助理页、「记忆」打开并亮那条。
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mentionOptions, mentionQuery } from '@/components/free-chat/assistant-bits'
import { memoryNoticePath } from '@/components/work/memory-notice'
import type {
  AssistantState,
  FreeChatFrame,
  FreeChatMessage,
  FreeChatModels,
} from '@/lib/free-chat'
import { awaitingReport, FreeChatPage, LegacyFreeChatRedirect } from '@/pages/free-chat'
import { renderWithProviders } from './helpers'
import { COMPANY_ORG, SOLO_ORG } from './mode-words'

const T0 = '2026-10-15T08:00:00.000Z'

const MODELS: FreeChatModels = {
  choices: [{ id: 'deepseek/deepseek-flash', label: 'DeepSeek', official: false, vision: 'ok' }],
  default: 'deepseek/deepseek-flash',
  web_search: { available: true, max_searches: 5 },
  knowledge: { available: true },
}

const state = vi.hoisted(() => ({
  orgs: [] as unknown[],
  assistant: { suggestions: [], targets: [] } as AssistantState,
  calls: [] as Record<string, unknown>[],
  memory: [] as { id: string; text: string; at: string; written_by: 'ai' | 'person' }[],
  messages: [] as FreeChatMessage[],
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    listOrganizations: async () => state.orgs,
    getMyProfile: async () => ({
      person_id: 'p_1',
      name: '王',
      positions: [],
      ranges: [],
      skills: [],
      contact_policy: {},
      availability: {},
      disclosure: {},
      updated_at: T0,
    }),
    listPeople: async () => [],
    listAskedMe: async () => [],
    listMyMeets: async () => [],
  }
})

vi.mock('@/lib/free-chat', async () => {
  const actual = await vi.importActual<typeof import('@/lib/free-chat')>('@/lib/free-chat')
  return {
    ...actual,
    getFreeChatModels: async () => MODELS,
    getAssistantState: async () => state.assistant,
    listAssistantMemory: async () => state.memory,
    listFreeChatSessions: async () => [],
    // WP352：只有一条长对话
    getAssistantThread: async () => ({
      session: { id: 'fchat_1', title: '助理', created_at: T0, updated_at: T0 },
      segments: [],
    }),
    listFreeChatMessages: async () => state.messages,
    createFreeChatSession: async () => ({
      id: 'fchat_1',
      title: '新对话',
      created_at: T0,
      updated_at: T0,
    }),
    streamFreeChat: async (
      session_id: string,
      input: Record<string, unknown>,
      onFrame: (f: FreeChatFrame) => void,
    ) => {
      state.calls.push(input)
      const user: FreeChatMessage = {
        id: 'u',
        session_id,
        role: 'user',
        text: String(input.text ?? ''),
        at: T0,
        ...(input.target === undefined ? {} : { to: (input.target as { label: string }).label }),
      }
      onFrame({ type: 'start', user, message_id: 'a' })
      const message: FreeChatMessage = {
        id: 'a',
        session_id,
        role: 'assistant',
        text: '好的',
        at: T0,
      }
      state.messages = [user, message]
      onFrame({
        type: 'done',
        message,
        session: { id: session_id, title: user.text, created_at: T0, updated_at: T0 },
      })
    },
  }
})

const TARGETS: AssistantState['targets'] = [
  {
    position_id: 'reddit-ops',
    name: 'Reddit 运营',
    duties: [
      { role_id: 'social.reddit', name: '自家版运营' },
      { role_id: 'pr.reddit', name: '外部露出' },
    ],
  },
  {
    position_id: 'customer-care',
    name: '客服',
    duties: [{ role_id: 'dtc.support', name: '售后' }],
  },
]

function Where(): React.ReactNode {
  const loc = useLocation()
  return <span data-testid="where">{`${loc.pathname}${loc.search}`}</span>
}

function renderPage(route = '/assistant'): void {
  renderWithProviders(
    <>
      <Routes>
        <Route path="/assistant/:id?" element={<FreeChatPage />} />
        <Route path="/free-chat/:id?" element={<LegacyFreeChatRedirect />} />
        <Route path="/secretary" element={<Navigate replace to="/assistant?peers=1" />} />
        <Route path="/org" element={<p>org</p>} />
      </Routes>
      <Where />
    </>,
    route,
  )
}

beforeEach(() => {
  state.orgs = []
  state.assistant = { suggestions: [], targets: TARGETS }
  state.calls = []
  state.memory = []
  state.messages = []
})

describe('WP343「替我答同事」只在同事 / 公司模式出', () => {
  it('个人模式：没有', async () => {
    state.orgs = [SOLO_ORG]
    renderPage()
    await screen.findByTestId('free-chat-empty')
    await waitFor(() => {
      expect(screen.getByTestId('assistant-memory')).toBeTruthy()
    })
    expect(screen.queryByTestId('assistant-peers')).toBeNull()
  })

  it('公司模式：右上角有，点开是谁问过我 / 约时间 / 我的公开资料 / 问同事', async () => {
    state.orgs = [COMPANY_ORG]
    renderPage()
    await userEvent.click(await screen.findByTestId('assistant-peers'))
    const sheet = await screen.findByTestId('assistant-peers-sheet')
    const tabs = within(sheet)
      .getAllByRole('tab')
      .map((t) => t.textContent)
    expect(tabs).toEqual(['谁问过我', '约时间', '我的公开资料', '问同事'])
    expect(within(sheet).queryByTestId('route-panel')).toBeNull()
  })

  it('老地址 /secretary → 助理页并打开「替我答同事」', async () => {
    state.orgs = [COMPANY_ORG]
    renderPage('/secretary')
    expect(await screen.findByTestId('assistant-peers-sheet')).toBeTruthy()
    expect(screen.getByTestId('where').textContent).toBe('/assistant?peers=1')
  })
})

describe('WP343 快捷问题', () => {
  it('随状态变：有卡 / 有岗位时那几句；点了就发出去，开始对话后收起', async () => {
    state.assistant = {
      targets: TARGETS,
      suggestions: [
        { kind: 'cards', text: '今天有什么要我处理的？' },
        { kind: 'position', text: 'Reddit 运营今天做了什么？' },
        { kind: 'dispatch', text: '让客服回一下今天的工单' },
      ],
    }
    renderPage()
    const items = await screen.findAllByTestId('assistant-suggestion')
    expect(items.map((i) => i.textContent)).toEqual([
      '今天有什么要我处理的？',
      'Reddit 运营今天做了什么？',
      '让客服回一下今天的工单',
    ])
    await userEvent.click(items[0] as HTMLElement)
    await waitFor(() => {
      expect(state.calls[0]?.text).toBe('今天有什么要我处理的？')
    })
    await waitFor(() => {
      expect(screen.queryByTestId('assistant-suggestions')).toBeNull()
    })
  })

  it('没有岗位：「帮我建一个岗位」点了去建岗位、不发话', async () => {
    state.assistant = {
      targets: [],
      suggestions: [
        { kind: 'create_position', text: '帮我建一个岗位', href: '/org?tab=positions' },
      ],
    }
    renderPage()
    await userEvent.click(await screen.findByTestId('assistant-suggestion'))
    expect(screen.getByTestId('where').textContent).toBe('/org?tab=positions')
    expect(state.calls).toEqual([])
  })
})

describe('WP343 输入框 @', () => {
  it('打 @ 出岗位与职责，选一个 → 胶囊；发出去带 target，气泡上标「@ 谁」', async () => {
    renderPage()
    const input = await screen.findByTestId('free-chat-input')
    await userEvent.type(input, '@自家')
    const menu = await screen.findByTestId('assistant-mention-menu')
    const options = within(menu).getAllByTestId('assistant-mention-option')
    expect(options.map((o) => o.textContent)).toEqual(['Reddit 运营 · 自家版运营'])
    fireEvent.mouseDown(options[0] as HTMLElement)
    expect(screen.getByTestId('assistant-mention-chip').textContent).toContain(
      'Reddit 运营 · 自家版运营',
    )
    await userEvent.type(input, '查一下今天的新帖{Enter}')
    await waitFor(() => {
      expect(state.calls[0]).toMatchObject({
        text: '查一下今天的新帖',
        target: {
          position_id: 'reddit-ops',
          role_id: 'social.reddit',
          label: 'Reddit 运营 · 自家版运营',
        },
      })
    })
    expect((await screen.findByTestId('free-chat-user-to')).textContent).toContain(
      'Reddit 运营 · 自家版运营',
    )
  })

  it('什么时候算在打 @：行首或空白之后、到光标之间没有空白', () => {
    expect(mentionQuery('@客', 2)).toBe('客')
    expect(mentionQuery('让 @', 3)).toBe('')
    expect(mentionQuery('a@b', 3)).toBeUndefined()
    expect(mentionQuery('@客 服', 5)).toBeUndefined()
    expect(mentionOptions(TARGETS, '').map((o) => o.label)).toEqual([
      'Reddit 运营',
      'Reddit 运营 · 自家版运营',
      'Reddit 运营 · 外部露出',
      '客服',
      '客服 · 售后',
    ])
  })
})

describe('WP343 老地址、回报轮询、记忆', () => {
  it('/free-chat/:id → /assistant（WP352：只有一条对话，不带会话 id）', async () => {
    renderPage('/free-chat/fchat_9?x=1')
    await waitFor(() => {
      expect(screen.getByTestId('where').textContent).toBe('/assistant?x=1')
    })
  })

  it('交出去的事还没报「做完 / 没做成」就接着问；要拍板那一句不算报完', () => {
    const d = {
      matter_id: 'm1',
      title: 't',
      position_id: 'p',
      position_name: 'P',
      at: T0,
    }
    const base = { session_id: 's', at: T0, text: '' }
    const sent: FreeChatMessage = { ...base, id: 'a', role: 'assistant', dispatches: [d] }
    expect(awaitingReport([sent])).toBe(true)
    const decide: FreeChatMessage = {
      ...base,
      id: 'r1',
      role: 'assistant',
      report: { matter_id: 'm1', kind: 'decide', position_name: 'P' },
    }
    expect(awaitingReport([sent, decide])).toBe(true)
    const done: FreeChatMessage = {
      ...base,
      id: 'r2',
      role: 'assistant',
      report: { matter_id: 'm1', kind: 'done', position_name: 'P' },
    }
    expect(awaitingReport([sent, decide, done])).toBe(false)
  })

  it('「记住了」点助理层那条 → /assistant?memory=…，「记忆」打开并亮那条', async () => {
    expect(
      memoryNoticePath(
        [
          {
            id: 'c1',
            at: T0,
            kind: 'added',
            entry_id: 'amem_1',
            tier: 'personal',
            scope_id: 'p_1',
            text: '回 Reddit 一律用英文',
            by: 'p_1',
            written_by: 'ai',
          },
        ],
        [],
        null,
      ),
    ).toBe('/assistant?memory=amem_1')
    state.memory = [{ id: 'amem_1', text: '回 Reddit 一律用英文', at: T0, written_by: 'ai' }]
    renderPage('/assistant?memory=amem_1')
    const row = await screen.findByTestId('assistant-memory-row')
    expect(row.dataset.lit).toBe('true')
    expect(row.textContent).toContain('AI 记的')
  })
})
