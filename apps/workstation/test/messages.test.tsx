/**
 * WP113（63）：消息页的界面用例。
 *
 * 钉住的是文档里那几条硬约束：
 * - 左栏那一格是**消息**（不是目标），目标收进待办页的 tab，`/goals` 路由还在；
 * - **未读是一个点，不是一个红数字**（36 减字 / 图形化）；
 * - **远程图片默认不加载**：正文里的 `src` 在服务端就已经搬走了，界面上有一行
 *   "显示图片"；HTML 正文进 `sandbox` iframe（无脚本、无同源）；
 * - **「删除」打出去的是"移到垃圾箱"**——没有第二种去处；
 * - **客服 / 红人那条线程只读**：顶上一条状态带 + 去工作线程的链接，
 *   界面上**没有**"回复"那个按钮；
 * - 右栏那一格点一条建议 → **进编辑框**，不是发送。
 */
import type { MessageLabel, MessageRecord, MessageThreadSummary } from '@agentsws/contracts'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { MailAssistantView, MessageAccountView, MessageThreadView } from '@/lib/api'
import { renderWithProviders } from './helpers'

const T0 = '2026-09-18T01:00:00.000Z'
const ME = 'hello@shop.example'

const account: MessageAccountView = {
  address: ME,
  unread: 2,
  folders: [
    { path: 'INBOX', kind: 'inbox', account: ME, unread: 2, total: 12 },
    { path: 'kefuagents', kind: 'support', account: ME, unread: 0, total: 3 },
  ],
  backfill_floor: '2026-08-19T00:00:00.000Z',
}

const labels: MessageLabel[] = [
  { id: 'orders', name_zh: '订单与物流', name_en: 'Orders', color: 'blue', builtin: true },
  { id: 'suspicious', name_zh: '可疑', name_en: 'Suspicious', color: 'red', builtin: true },
]

const message = (over: Partial<MessageRecord> = {}): MessageRecord => ({
  id: 'msg_1',
  workspace_id: 'ws_1',
  source: 'email',
  account: ME,
  folder: 'INBOX',
  folder_kind: 'inbox',
  thread_id: '<t1@x>',
  message_id: '<m1@x>',
  references: [],
  headers: {},
  from: { email: 'ann@customer.example', name: 'Ann Lee' },
  to: [{ email: ME }],
  cc: [],
  bcc: [],
  subject: '包裹破了',
  snippet: '收到的时候箱子是瘪的',
  text: '收到的时候箱子是瘪的，想退款。',
  html: '<p>收到的时候箱子是瘪的</p><img data-ws-remote-src="https://track.example/p.gif" />',
  has_remote_images: true,
  attachments: [],
  date: T0,
  received_at: T0,
  flags: { read: false, starred: false, answered: false, draft: false },
  labels: ['orders'],
  route: 'inbox',
  ...over,
})

const summary = (over: Partial<MessageThreadSummary> = {}): MessageThreadSummary => ({
  thread_id: '<t1@x>',
  subject: '包裹破了',
  participants: [{ email: 'ann@customer.example', name: 'Ann Lee' }],
  last_at: T0,
  count: 2,
  unread: 1,
  starred: false,
  labels: ['orders'],
  route: 'inbox',
  folders: ['INBOX'],
  accounts: [ME],
  needs_reply: true,
  snippet: '收到的时候箱子是瘪的',
  last_message_id: 'msg_1',
  ...over,
})

const assistant: MailAssistantView = {
  message_id: 'msg_1',
  summary: '客户说包裹破损要退款',
  needs_reply: true,
  suggestions: [
    { id: 's1', kind: 'short', title: '简短回一句', text: '这就给你补发。', citations: [] },
    {
      id: 's2',
      kind: 'detailed',
      title: '详细说明',
      text: '很抱歉。我们今天安排补发。',
      citations: [{ source_id: 'k1', title: '退换货政策' }],
    },
  ],
  sender: { address: 'ann@customer.example', name: 'Ann Lee', history_count: 4, linked: [] },
  todos: [],
  model_available: true,
}

const listMessageAccounts = vi.fn(async () => ({ accounts: [account] }))
const listMessageLabels = vi.fn(async () => ({ labels }))
const listMessageThreads = vi.fn(async (_query?: string) => ({ threads: [summary()] }))
const threadView = vi.fn(
  async (): Promise<MessageThreadView> => ({
    thread_id: '<t1@x>',
    subject: '包裹破了',
    messages: [message()],
  }),
)
const setMessageFlags = vi.fn(async () => ({
  message: message({ flags: { read: true, starred: false, answered: false, draft: false } }),
}))
const moveMessage = vi.fn(async () => ({ message: message({ folder_kind: 'trash' }) }))
const showMessageImages = vi.fn(async () => ({ message: message({ has_remote_images: false }) }))
const sendMessage = vi.fn(async (_input?: unknown) => ({
  outbox_id: 'obx_1',
  message_id: '<sent@x>',
}))
const saveMessageDraft = vi.fn(async () => ({
  draft: {
    id: 'dft_1',
    workspace_id: 'ws_1',
    account: ME,
    to: [],
    cc: [],
    bcc: [],
    subject: '',
    text: '',
    attachments: [],
    updated_at: T0,
  },
}))
const getMailAssistant = vi.fn(async () => assistant)
const syncMessages = vi.fn(async () => ({
  accounts: 1,
  folders: 6,
  fetched: 0,
  triaged: 0,
  moved: 0,
  failed: [],
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    listMessageAccounts: () => listMessageAccounts(),
    listMessageLabels: () => listMessageLabels(),
    listMessageThreads: (...a: unknown[]) => listMessageThreads(...(a as [])),
    getMessageThread: (...a: unknown[]) => threadView(...(a as [])),
    setMessageFlags: (...a: unknown[]) => setMessageFlags(...(a as [])),
    moveMessage: (...a: unknown[]) => moveMessage(...(a as [])),
    showMessageImages: (...a: unknown[]) => showMessageImages(...(a as [])),
    sendMessage: (...a: unknown[]) => sendMessage(...(a as [])),
    saveMessageDraft: (...a: unknown[]) => saveMessageDraft(...(a as [])),
    getMailAssistant: (...a: unknown[]) => getMailAssistant(...(a as [])),
    syncMessages: () => syncMessages(),
    messageToTodo: async () => ({ todo: undefined }),
    backfillMessages: async () => ({ floor: T0 }),
    discardMessageDraft: async () => ({ deleted: true }),
  }
})

const { MessagesPage } = await import('@/pages/messages')
const { MailAssistantPanel, focusMessage, resetMessageFocus } = await import(
  '@/components/rail/panels/mail-assistant-panel'
)

describe('消息页（63 §8）', () => {
  it('会话列表：未读是一个点，不是一个红数字', async () => {
    renderWithProviders(<MessagesPage />)
    const row = await screen.findByTestId('messages-thread')
    expect(row.getAttribute('data-unread')).toBe('true')
    expect(screen.getByTestId('messages-unread-dot')).toBeDefined()
    // 整页找不到一个裸的未读计数
    expect(screen.queryByText('1 未读')).toBeNull()
  })

  it('打开一条会话就标已读；正文进 sandbox iframe，远程图片默认不加载', async () => {
    const user = userEvent.setup()
    renderWithProviders(<MessagesPage />)
    await user.click(await screen.findByTestId('messages-thread'))
    await waitFor(() => {
      expect(setMessageFlags).toHaveBeenCalledWith('msg_1', { read: true })
    })
    const frame = await screen.findByTestId('message-html')
    // 无脚本、无同源——净化那一层将来漏一条规则，这一层仍然兜得住
    expect(frame.getAttribute('sandbox')).toBe('')
    expect(frame.getAttribute('srcdoc')).toContain('data-ws-remote-src')
    // 判的是**属性边界**：`data-ws-remote-src=` 里也含 `src=` 那几个字
    expect(/(?:^|\s)src="https:/.test(frame.getAttribute('srcdoc') ?? '')).toBe(false)
    // 界面上有那一行"显示图片"
    expect(screen.getByTestId('messages-remote-images')).toBeDefined()
    await user.click(screen.getByTestId('messages-show-images'))
    await waitFor(() => {
      expect(showMessageImages).toHaveBeenCalledWith('msg_1', false)
    })
  })

  it('「删除」打出去的是"移到垃圾箱"——没有第二种去处（63 §7）', async () => {
    const user = userEvent.setup()
    renderWithProviders(<MessagesPage />)
    await user.click(await screen.findByTestId('messages-thread'))
    await user.click(await screen.findByTestId('messages-delete'))
    await waitFor(() => {
      expect(moveMessage).toHaveBeenCalledWith('msg_1', { to: 'trash' })
    })
  })

  it('回复框里收件人来自被回的那封，发送打的是 /v1/messages/send（不出卡）', async () => {
    const user = userEvent.setup()
    renderWithProviders(<MessagesPage />)
    await user.click(await screen.findByTestId('messages-thread'))
    await user.click(await screen.findByTestId('messages-reply'))
    const to = await screen.findByTestId('composer-to')
    expect((to as HTMLInputElement).value).toBe('ann@customer.example')
    await user.type(screen.getByTestId('composer-body'), '马上补发')
    await user.click(screen.getByTestId('composer-send'))
    await waitFor(() => {
      expect(sendMessage).toHaveBeenCalled()
    })
    expect(sendMessage.mock.calls[0]?.[0]).toMatchObject({
      to: [{ email: 'ann@customer.example' }],
      in_reply_to: '<m1@x>',
    })
  })

  it('客服那条线程只读：有状态带与去工作线程的链接，没有「回复」按钮（63 §9）', async () => {
    // 打开一条会话会顺手标已读，那一下的 invalidate 会让这个查询再取一次——
    // 所以这里用 `mockResolvedValue` 而不是 `…Once`（用 Once 的话第二次回的是默认值）
    threadView.mockResolvedValue({
      thread_id: '<t1@x>',
      subject: '包裹破了',
      messages: [message({ route: 'support', folder: 'kefuagents', folder_kind: 'support' })],
      agent_status: {
        route: 'support',
        state: 'working',
        href: '/matters/mat_1',
        takeover_matter_id: 'mat_1',
      },
    })
    const user = userEvent.setup()
    renderWithProviders(<MessagesPage />)
    await user.click(await screen.findByTestId('messages-thread'))
    const band = await screen.findByTestId('messages-agent-band')
    expect(band.getAttribute('data-state')).toBe('working')
    expect(screen.getByTestId('messages-agent-link').getAttribute('href')).toBe('/matters/mat_1')
    expect(screen.getByTestId('messages-readonly')).toBeDefined()
    // 人与 Agent 撞车是这套东西最难解释的一种错——所以这里干脆没有那个按钮
    expect(screen.queryByTestId('messages-reply')).toBeNull()
    threadView.mockReset()
    threadView.mockImplementation(async () => ({
      thread_id: '<t1@x>',
      subject: '包裹破了',
      messages: [message()],
    }))
  })

  it('一只邮箱都没连：照实说，并指向连接页（不新增凭据入口）', async () => {
    listMessageAccounts.mockResolvedValueOnce({ accounts: [] })
    renderWithProviders(<MessagesPage />)
    expect(await screen.findByTestId('messages-no-mailbox')).toBeDefined()
    expect(screen.getByTestId('messages-connect').getAttribute('href')).toContain('/connections')
  })

  it('搜索与文件夹切换都打到同一条列表接口上', async () => {
    const user = userEvent.setup()
    renderWithProviders(<MessagesPage />)
    await screen.findByTestId('messages-thread')
    await user.click(screen.getByTestId('messages-search'))
    await user.keyboard('包裹')
    await waitFor(() => {
      expect(listMessageThreads.mock.calls.at(-1)?.[0]).toContain('q=')
    })
    await user.click(screen.getAllByTestId('messages-folder')[6] as HTMLElement)
    await waitFor(() => {
      expect(listMessageThreads.mock.calls.at(-1)?.[0]).toContain('folder_kind=trash')
    })
  })
})

describe('第三栏 mail-assistant（63 §8）', () => {
  it('没打开信时照实说；打开之后出摘要与建议，点一条派出"进编辑框"的事件', async () => {
    resetMessageFocus()
    const user = userEvent.setup()
    const first = renderWithProviders(<MailAssistantPanel />)
    expect(screen.getByTestId('rail-mail-empty')).toBeDefined()
    first.unmount()

    // 阅读区打开一封信时调的就是这一句（那份内存真源不落本机）
    focusMessage('msg_1')
    renderWithProviders(<MailAssistantPanel />)
    expect(await screen.findByTestId('rail-mail-assistant')).toBeDefined()
    expect(screen.getByText('客户说包裹破损要退款')).toBeDefined()
    const cards = screen.getAllByTestId('rail-mail-suggestion')
    // 三条要有差别：短 / 详 / 婉拒，不是同义改写
    expect(new Set(cards.map((c) => c.getAttribute('data-kind'))).size).toBe(cards.length)

    const seen: string[] = []
    const onUse = (e: Event): void => {
      seen.push((e as CustomEvent<string>).detail)
    }
    window.addEventListener('agentsws:use-suggestion', onUse)
    await user.click(cards[0] as HTMLElement)
    window.removeEventListener('agentsws:use-suggestion', onUse)
    // 点了是"进编辑框"，不是发出去
    expect(seen).toEqual(['这就给你补发。'])
    expect(sendMessage).not.toHaveBeenCalled()
    resetMessageFocus()
  })
})
