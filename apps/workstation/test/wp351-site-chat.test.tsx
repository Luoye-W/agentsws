/**
 * WP351（Luoye 10-16 追加，决策 906 第 4 条修订）：「聊天窗」拆成两处、左栏不再有它。
 *
 * - 访客的对话 = 「消息」里和邮箱并列的来源「网站聊天」：未读小圆点；顶上「客服 AI 在处理」、
 *   右边去工作线程；没有回复框，只有「教 AI」（对客直发入口数 = 0 仍由 no-direct-reply 钉着）；
 * - 挂件设置 = 「消息渠道」页里的渠道「网站聊天窗」；
 * - 老地址 `/chat-window` 跳到消息里那个来源；⌘K 两处都搜得到；左栏没有「聊天窗」。
 * - 两条分配照旧（WP139）：会话用网站在线客服那条、设置用所有者那条。
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { Route, Routes, useLocation } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Assignment, ChatSessionView, Me } from '@/lib/api'
import { renderWithProviders } from './helpers'

const OWNER: Assignment = { id: 'asg_owner', role_id: 'common.owner', ranges: [] }
const CHAT: Assignment = {
  id: 'asg_chat',
  role_id: 'dtc.live-chat',
  ranges: [{ kind: 'store', id: 'shop_1' }],
} as Assignment

const T1 = '2026-10-16T03:00:00.000Z'
const SESSION: ChatSessionView = {
  id: 'cs_1',
  source: 'widget',
  external_session_id: 'v_abc',
  visitor_display: 'Visitor from Berlin',
  status: 'open',
  takeover: false,
  thread_external_id: 'th_1',
  created_at: T1,
  updated_at: T1,
}

const MAILBOX = {
  address: 'hello@shop.example',
  unread: 0,
  folders: [{ path: 'INBOX', kind: 'inbox', account: 'hello@shop.example', unread: 0, total: 0 }],
  backfill_floor: T1,
}

const mocks = vi.hoisted(() => ({
  assignments: [] as Assignment[],
  accounts: [] as unknown[],
  sessionsAsg: [] as (string | undefined)[],
  settingsAsg: [] as (string | undefined)[],
}))

function me(assignments: Assignment[]): Me {
  return {
    person: { id: 'per_1', email: 'li@example.com', name: '李' },
    workspace: { id: 'ws_1', name: '诺伏特' },
    assignments,
  } as unknown as Me
}

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    ensureSession: async () => me(mocks.assignments),
    getMessageOverview: async () => ({
      unclaimed: 0,
      notice: 0,
      handed: 0,
      handed_by_position: [],
      cards_waiting: 0,
      notice_groups: [],
      positions: [],
      taught: { rules: 0, saved: 0, recent: [] },
    }),
    listMessageAccounts: async () => ({ accounts: mocks.accounts }),
    listMessageLabels: async () => ({ labels: [] }),
    listMessageThreads: async () => ({ threads: [] }),
    listChatSessions: async (_limit: number, asg?: string) => {
      mocks.sessionsAsg.push(asg)
      return [SESSION]
    },
    getChatMessages: async () => ({
      session: SESSION,
      messages: [{ id: 'm1', role: 'visitor', text: 'Does it ship to Germany?', at: T1 }],
    }),
    getChatWidgetSettings: async (asg?: string) => {
      mocks.settingsAsg.push(asg)
      return { allowed_origins: [] }
    },
    getChatRelaySettings: async () => ({
      has_pairing_token: false,
      has_message_key: false,
      configured: false,
    }),
    getChatRelayStatus: async () => ({ state: 'offline', online: false }),
    getChatRelayHosted: async () => ({
      available: false,
      linked: false,
      subscription: { status: 'none' },
    }),
    getImStatus: async () => ({ can_manage: true }),
  }
})

const { MessagesPage } = await import('@/pages/messages')
const { ChatWindowPage } = await import('@/pages/chat-window')
const { ImChannelsPage } = await import('@/pages/im-channels')
const { AppShell } = await import('@/components/app-shell')

beforeEach(() => {
  mocks.assignments = [OWNER, CHAT]
  mocks.accounts = [MAILBOX]
  mocks.sessionsAsg = []
  mocks.settingsAsg = []
  // jsdom 的 localStorage 没有 clear：铺一个干净的（「看到哪一刻」记在这里）
  const box = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => box.get(k) ?? null,
    setItem: (k: string, v: string) => {
      box.set(k, v)
    },
    removeItem: (k: string) => {
      box.delete(k)
    },
  })
})

function Where(): React.ReactNode {
  const { pathname, search } = useLocation()
  return <span data-testid="where">{`${pathname}${search}`}</span>
}

describe('「消息」里的来源「网站聊天」', () => {
  it('和邮箱文件夹并列，有没看过的就一个小圆点；点进去看过就灭', async () => {
    renderWithProviders(<MessagesPage />, '/messages?view=all')
    const item = await screen.findByTestId('messages-source-site-chat')
    expect(item.textContent).toContain('网站聊天')
    await screen.findByTestId('messages-site-chat-dot')
    fireEvent.click(item)
    const conv = await screen.findByTestId('chat-conversation')
    expect(within(conv).getByTestId('site-chat-unread')).toBeDefined()
    fireEvent.click(conv)
    await screen.findByTestId('chat-conversation-view')
    await waitFor(() => {
      expect(screen.queryByTestId('messages-site-chat-dot')).toBeNull()
    })
    // 会话用网站在线客服那条分配（WP139）
    expect(mocks.sessionsAsg).toContain('asg_chat')
  })

  it('打开一段：顶上「客服 AI 在处理」+ 去工作线程；没有回复框，只有教 AI', async () => {
    renderWithProviders(<MessagesPage />, '/messages?view=all&source=chat')
    fireEvent.click(await screen.findByTestId('chat-conversation'))
    const band = await screen.findByTestId('site-chat-band')
    expect(band.textContent).toContain('客服 AI 在处理')
    expect(within(band).getByTestId('site-chat-work-link').getAttribute('href')).toBe(
      '/positions/asg_chat/duties/dtc.live-chat',
    )
    expect(screen.getByTestId('chat-teach-input')).toBeDefined()
    expect(screen.queryByTestId('messages-reply')).toBeNull()
    expect(screen.queryByTestId('messages-compose-send')).toBeNull()
  })

  it('名下没有网站在线客服：没有这个来源', async () => {
    mocks.assignments = [OWNER]
    renderWithProviders(<MessagesPage />, '/messages?view=all')
    await screen.findAllByTestId('messages-folder')
    await waitFor(() => {
      expect(screen.queryByTestId('messages-source-site-chat')).toBeNull()
    })
  })

  it('一只邮箱都没连：网站聊天照样看得到（没连邮箱的页面上有钮过去）', async () => {
    mocks.accounts = []
    renderWithProviders(<MessagesPage />, '/messages')
    await screen.findByTestId('messages-no-mailbox')
    fireEvent.click(await screen.findByTestId('messages-source-site-chat'))
    expect(await screen.findByTestId('chat-conversation')).toBeDefined()
  })

  it('老地址 /chat-window 跳到消息里那个来源', async () => {
    renderWithProviders(
      <Routes>
        <Route path="/chat-window" element={<ChatWindowPage />} />
        <Route path="/messages" element={<Where />} />
      </Routes>,
      '/chat-window',
    )
    expect((await screen.findByTestId('where')).textContent).toBe('/messages?view=all&source=chat')
  })
})

describe('「消息渠道」里的「网站聊天窗」', () => {
  it('名下有网站在线客服：挂件设置在这里（外观 / 嵌入代码 / 转发方式），用所有者那条分配', async () => {
    renderWithProviders(<ImChannelsPage />, '/im-channels')
    const block = await screen.findByTestId('im-site-chat')
    expect(block.textContent).toContain('网站聊天窗')
    expect(await within(block).findByTestId('chat-embed-code')).toBeDefined()
    expect(mocks.settingsAsg).toContain('asg_owner')
  })

  it('没有就不出', async () => {
    mocks.assignments = [OWNER]
    renderWithProviders(<ImChannelsPage />, '/im-channels')
    await screen.findByText('微信（你自己的）')
    expect(screen.queryByTestId('im-site-chat')).toBeNull()
  })
})

describe('左栏与 ⌘K', () => {
  const shell = (): void => {
    renderWithProviders(
      <AppShell
        positions={[]}
        cards={[]}
        tileLibrary={[]}
        me={me(mocks.assignments)}
        onAddTile={() => {}}
      >
        <div>主区</div>
      </AppShell>,
    )
  }

  it('左栏不再有「聊天窗」；网站聊天有没看过的，「消息」那格亮点', async () => {
    shell()
    expect(screen.queryByTestId('nav-chat-window')).toBeNull()
    await screen.findByTestId('nav-messages-dot')
  })

  it('⌘K 两处都搜得到：网站聊天、网站聊天窗', async () => {
    shell()
    fireEvent.keyDown(document, { key: 'k', metaKey: true })
    await waitFor(() => {
      const to = screen.getAllByTestId('command-page').map((el) => el.getAttribute('data-to'))
      expect(to).toContain('/messages?view=all&source=chat')
      expect(to).toContain('/im-channels#site-chat')
    })
  })
})
