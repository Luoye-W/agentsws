/**
 * WP204：消息页上每个能点的东西，点了都有回音（一个按钮一条）。
 *
 * 规矩（docs/briefs/WP204）：点了要么立刻看得见变化，要么冒一句话；失败说人话、不吞；
 * 删除先问、能撤销的给撤销；影子模式（只看不动）下会动邮箱的动作置灰并说为什么；
 * 「显示图片」只对这一封，走本机代取（界面上看到的是 data:）。
 */
import type { MessageRecord, MessageThreadSummary, MessageWriteback } from '@agentsws/contracts'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MessageAccountView, MessageThreadView } from '@/lib/api'
import { ApiClientError } from '@/lib/api'
import { renderWithProviders } from './helpers'

const T0 = '2026-09-30T01:00:00.000Z'
const ME = 'hello@shop.example'

const account: MessageAccountView = {
  address: ME,
  unread: 1,
  folders: [{ path: 'INBOX', kind: 'inbox', account: ME, unread: 1, total: 3 }],
  backfill_floor: '2026-08-31T00:00:00.000Z',
}

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
  to: [{ email: ME }, { email: 'bob@customer.example' }],
  cc: [{ email: 'cc@customer.example' }],
  bcc: [],
  subject: '包裹破了',
  snippet: '箱子是瘪的',
  text: '箱子是瘪的',
  html: '<p>箱子是瘪的</p><img data-ws-remote-src="https://cdn.example/a.png" />',
  has_remote_images: true,
  attachments: [{ id: 'att_1', name: '外箱.jpg', mime: 'image/jpeg', size: 10, ref: 'raw://1' }],
  date: T0,
  received_at: T0,
  flags: { read: false, starred: false, answered: false, draft: false },
  labels: [],
  route: 'inbox',
  ...over,
})

const summary = (over: Partial<MessageThreadSummary> = {}): MessageThreadSummary => ({
  thread_id: '<t1@x>',
  subject: '包裹破了',
  participants: [{ email: 'ann@customer.example', name: 'Ann Lee' }],
  last_at: T0,
  count: 3,
  unread: 1,
  starred: false,
  labels: [],
  route: 'inbox',
  folders: ['INBOX'],
  accounts: [ME],
  needs_reply: true,
  snippet: '箱子是瘪的',
  last_message_id: 'msg_1',
  ...over,
})

/** 一条会话：两封在收件箱、一封是自己发的（在「已发送」，归档 / 删除不该动它）。 */
const view = (over: Partial<MessageRecord> = {}): MessageThreadView => ({
  thread_id: '<t1@x>',
  subject: '包裹破了',
  messages: [
    message({ id: 'msg_0', message_id: '<m0@x>', has_remote_images: false, html: '<p>早</p>' }),
    message({ id: 'msg_sent', folder: 'Sent', folder_kind: 'sent', has_remote_images: false }),
    message(over),
  ],
})

const api = {
  listMessageAccounts: vi.fn(async () => ({ accounts: [account] })),
  listMessageThreads: vi.fn(async (_q?: string) => ({
    threads: [
      summary(),
      summary({ thread_id: '<t2@x>', subject: '发票', last_message_id: 'msg_2', unread: 0 }),
    ],
  })),
  getMessageThread: vi.fn(async (_id?: string) => view()),
  setMessageFlags: vi.fn(
    async (
      _id: string,
      _i: unknown,
    ): Promise<{ message: MessageRecord; writeback: MessageWriteback }> => ({
      message: message(),
      writeback: 'written',
    }),
  ),
  moveMessage: vi.fn(
    async (
      _id: string,
      _i: unknown,
    ): Promise<{ message: MessageRecord; writeback: MessageWriteback }> => ({
      message: message(),
      writeback: 'written',
    }),
  ),
  showMessageImages: vi.fn(async (_id: string, _always: boolean) => ({
    message: message({
      html: '<p>箱子是瘪的</p><img src="data:image/png;base64,AAAA" />',
      has_remote_images: false,
    }),
    images: { shown: 1, failed: 0 },
  })),
  sendMessage: vi.fn(async (_i: unknown) => ({ outbox_id: 'obx_1', message_id: '<s@x>' })),
  syncMessages: vi.fn(async () => ({
    accounts: 1,
    folders: 6,
    fetched: 3,
    triaged: 3,
    moved: 0,
    failed: [] as string[],
  })),
  backfillMessages: vi.fn(async (_i: unknown) => ({ floor: '2026-08-01T00:00:00.000Z' })),
  downloadMessageAttachment: vi.fn(async (_id: string, _a: string, _n: string) => undefined),
}

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    listMessageAccounts: () => api.listMessageAccounts(),
    listMessageLabels: async () => ({ labels: [] }),
    listMessageThreads: (q?: string) => api.listMessageThreads(q),
    getMessageThread: (id?: string) => api.getMessageThread(id),
    setMessageFlags: (id: string, i: unknown) => api.setMessageFlags(id, i),
    moveMessage: (id: string, i: unknown) => api.moveMessage(id, i),
    showMessageImages: (id: string, a: boolean) => api.showMessageImages(id, a),
    sendMessage: (i: unknown) => api.sendMessage(i),
    syncMessages: () => api.syncMessages(),
    backfillMessages: (i: unknown) => api.backfillMessages(i),
    downloadMessageAttachment: (id: string, a: string, n: string) =>
      api.downloadMessageAttachment(id, a, n),
    saveMessageDraft: async () => ({ draft: { id: 'dft_1' } }),
    discardMessageDraft: async () => ({ deleted: true }),
    getMailAssistant: async () => ({ suggestions: [] }),
  }
})

const { MessagesPage } = await import('@/pages/messages')

const openFirst = async (): Promise<ReturnType<typeof userEvent.setup>> => {
  const user = userEvent.setup()
  renderWithProviders(<MessagesPage />)
  await user.click((await screen.findAllByTestId('messages-thread'))[0] as HTMLElement)
  await screen.findAllByTestId('messages-message')
  return user
}

const notice = async (): Promise<HTMLElement> => screen.findByTestId('messages-notice')

beforeEach(() => {
  vi.clearAllMocks()
})

describe('WP204：阅读区的按钮', () => {
  it('显示图片：只对这一封生效，正文里出现代取回来的 data: 图，那一行提示消失', async () => {
    const user = await openFirst()
    await user.click(screen.getByTestId('messages-show-images'))
    await waitFor(() => {
      expect(api.showMessageImages).toHaveBeenCalledWith('msg_1', false)
    })
    await waitFor(() => {
      expect(screen.queryByTestId('messages-remote-images')).toBeNull()
    })
    const frames = screen.getAllByTestId('message-html')
    const last = frames.at(-1)?.getAttribute('srcdoc') ?? ''
    expect(last).toContain('src="data:image/png;base64,')
    // 同一条会话里别的信不受影响
    expect(frames[0]?.getAttribute('srcdoc')).not.toContain('data:image')
  })

  it('显示图片：有取不到的说一句（仍然挡着）；请求失败也说人话', async () => {
    api.showMessageImages.mockResolvedValueOnce({
      message: message(),
      images: { shown: 0, failed: 2 },
    })
    const user = await openFirst()
    await user.click(screen.getByTestId('messages-show-images'))
    expect((await notice()).textContent).toContain('图片一张都没取到')
    api.showMessageImages.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await user.click(screen.getByTestId('messages-show-images'))
    await waitFor(() => {
      expect(screen.getByTestId('messages-notice').getAttribute('data-tone')).toBe('error')
    })
  })

  it('回复：收件人是被回的那封的发件人；没发出去时写信框留着、框里说为什么', async () => {
    api.sendMessage.mockRejectedValueOnce(
      new ApiClientError(503, {
        code: 'halted',
        message: '出站已急停（AGENTSWS_HALT=outbound 或对账未完成），这封信没有发出',
        trace_id: 't',
      }),
    )
    const user = await openFirst()
    await user.click(screen.getByTestId('messages-reply'))
    expect((screen.getByTestId('composer-to') as HTMLInputElement).value).toBe(
      'ann@customer.example',
    )
    await user.type(screen.getByTestId('composer-body'), '马上补发')
    await user.click(screen.getByTestId('composer-send'))
    expect((await screen.findByTestId('composer-error')).textContent).toContain('出站已急停')
    expect(screen.getByTestId('composer')).toBeDefined()
    // 再按一次：发出去了——框关掉，底下一句"已交给发件队列"
    await user.click(screen.getByTestId('composer-send'))
    expect((await notice()).textContent).toContain('已交给发件队列')
    expect(screen.queryByTestId('composer')).toBeNull()
  })

  it('全部回复：抄送带上其他人，不把自己（这只邮箱）抄进去', async () => {
    const user = await openFirst()
    await user.click(screen.getByTestId('messages-reply-all'))
    const cc = (screen.getByTestId('composer-cc') as HTMLInputElement).value
    expect(cc).toContain('bob@customer.example')
    expect(cc).toContain('cc@customer.example')
    expect(cc).not.toContain(ME)
  })

  it('转发：收件人空着、主题 Fwd:，发出去不带 In-Reply-To（原信不会被标成已回）', async () => {
    const user = await openFirst()
    await user.click(screen.getByTestId('messages-forward'))
    expect(screen.getByTestId('composer').getAttribute('data-mode')).toBe('forward')
    expect((screen.getByTestId('composer-to') as HTMLInputElement).value).toBe('')
    expect((screen.getByTestId('composer-subject') as HTMLInputElement).value).toBe('Fwd: 包裹破了')
    await user.type(screen.getByTestId('composer-to'), 'ops@shop.example')
    await user.click(screen.getByTestId('composer-send'))
    await waitFor(() => {
      expect(api.sendMessage).toHaveBeenCalled()
    })
    expect(api.sendMessage.mock.calls[0]?.[0]).not.toHaveProperty('in_reply_to')
  })

  it('归档：挪整条会话里收件箱的那几封（不动已发送那封），离开这条，带撤销', async () => {
    const user = await openFirst()
    await user.click(screen.getByTestId('messages-archive'))
    await waitFor(() => {
      expect(api.moveMessage).toHaveBeenCalledTimes(2)
    })
    expect(api.moveMessage.mock.calls.map((c) => c[0])).toEqual(['msg_0', 'msg_1'])
    expect(api.moveMessage.mock.calls[0]?.[1]).toEqual({ to: 'archive' })
    expect((await notice()).textContent).toContain('已归档')
    // 阅读区离开了那条会话
    expect(screen.queryAllByTestId('messages-message')).toHaveLength(0)
    await user.click(screen.getByTestId('messages-undo'))
    await waitFor(() => {
      expect(api.moveMessage).toHaveBeenCalledTimes(4)
    })
    expect(api.moveMessage.mock.calls.slice(2).map((c) => c[1])).toEqual([
      { to: 'inbox' },
      { to: 'inbox' },
    ])
    expect((await notice()).textContent).toContain('已撤销')
  })

  it('删除：先问一句（取消就什么都不发），确认后移到垃圾箱、可撤销', async () => {
    const user = await openFirst()
    await user.click(screen.getByTestId('messages-delete'))
    expect(screen.getByTestId('messages-delete-confirm').textContent).toContain('移到垃圾箱？')
    await user.click(screen.getByTestId('messages-delete-no'))
    expect(api.moveMessage).not.toHaveBeenCalled()
    await user.click(screen.getByTestId('messages-delete'))
    await user.click(screen.getByTestId('messages-delete-yes'))
    await waitFor(() => {
      expect(api.moveMessage).toHaveBeenCalledWith('msg_1', { to: 'trash' })
    })
    const n = await notice()
    expect(n.textContent).toContain('已移到垃圾箱')
    expect(screen.getByTestId('messages-undo')).toBeDefined()
  })

  it('删除失败：说人话、不吞（以前点了没反应）', async () => {
    api.moveMessage.mockRejectedValueOnce(
      new ApiClientError(404, {
        code: 'not_found',
        message: '这封信不在了（可能刚被别处挪走），刷新一下列表。',
        trace_id: 't',
      }),
    )
    const user = await openFirst()
    await user.click(screen.getByTestId('messages-delete'))
    await user.click(screen.getByTestId('messages-delete-yes'))
    const n = await notice()
    expect(n.getAttribute('role')).toBe('alert')
    expect(n.textContent).toContain('这封信不在了')
  })

  it('垃圾箱里的信：没有「删除」（不永久删），给「移回收件箱」', async () => {
    api.getMessageThread.mockResolvedValue({
      thread_id: '<t1@x>',
      subject: '包裹破了',
      messages: [message({ folder: 'Trash', folder_kind: 'trash' })],
    })
    const user = await openFirst()
    expect(screen.queryByTestId('messages-delete')).toBeNull()
    expect(screen.queryByTestId('messages-archive')).toBeNull()
    await user.click(screen.getByTestId('messages-restore'))
    await waitFor(() => {
      expect(api.moveMessage).toHaveBeenCalledWith('msg_1', { to: 'inbox' })
    })
    expect((await notice()).textContent).toContain('已移回收件箱')
    api.getMessageThread.mockImplementation(async () => view())
  })

  it('星标：打出去的是反着的那一个；邮箱服务器没答应时说一句', async () => {
    api.setMessageFlags.mockImplementation(async (_id, input) => ({
      message: message(),
      writeback: (input as { starred?: boolean }).starred === undefined ? 'written' : 'failed',
    }))
    const user = await openFirst()
    const stars = screen.getAllByTestId('messages-star')
    await user.click(stars.at(-1) as HTMLElement)
    await waitFor(() => {
      expect(api.setMessageFlags).toHaveBeenCalledWith('msg_1', { starred: true })
    })
    expect((await notice()).textContent).toContain('邮箱服务器没答应')
    api.setMessageFlags.mockImplementation(async () => ({
      message: message(),
      writeback: 'written',
    }))
  })

  it('附件：点了下载；取不到时说人话', async () => {
    api.downloadMessageAttachment.mockRejectedValueOnce(
      new ApiClientError(404, {
        code: 'not_found',
        message: '这个附件取不到了（原件可能已过保留期）',
        trace_id: 't',
      }),
    )
    const user = await openFirst()
    const att = screen.getAllByTestId('messages-attachment').at(-1) as HTMLElement
    await user.click(att)
    await waitFor(() => {
      expect(api.downloadMessageAttachment).toHaveBeenCalledWith('msg_1', 'att_1', '外箱.jpg')
    })
    expect((await notice()).textContent).toContain('附件取不到了')
  })
})

describe('WP204：列表、侧栏与键盘', () => {
  it('刷新：收到几封说几封；没新信说已是最新；有邮箱没收成说是哪只；失败说人话', async () => {
    const user = userEvent.setup()
    renderWithProviders(<MessagesPage />)
    await screen.findAllByTestId('messages-thread')
    await user.click(screen.getByTestId('messages-sync'))
    expect((await notice()).textContent).toContain('收到 3 封新信')
    api.syncMessages.mockResolvedValueOnce({
      accounts: 1,
      folders: 6,
      fetched: 0,
      triaged: 0,
      moved: 0,
      failed: [],
    })
    await user.click(screen.getByTestId('messages-sync'))
    await waitFor(() => {
      expect(screen.getByTestId('messages-notice').textContent).toContain('已是最新')
    })
    api.syncMessages.mockResolvedValueOnce({
      accounts: 1,
      folders: 6,
      fetched: 0,
      triaged: 0,
      moved: 0,
      failed: [`${ME}/INBOX`],
    })
    await user.click(screen.getByTestId('messages-sync'))
    await waitFor(() => {
      expect(screen.getByTestId('messages-notice').textContent).toContain(`${ME}/INBOX`)
    })
    api.syncMessages.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await user.click(screen.getByTestId('messages-sync'))
    await waitFor(() => {
      expect(screen.getByTestId('messages-notice').getAttribute('role')).toBe('alert')
    })
  })

  it('搜索：跨全部文件夹（不带 folder_kind），标一句"在全部文件夹里搜"；点文件夹退出搜索', async () => {
    const user = userEvent.setup()
    renderWithProviders(<MessagesPage />)
    await screen.findAllByTestId('messages-thread')
    await user.type(screen.getByTestId('messages-search'), '发票')
    await waitFor(() => {
      expect(api.listMessageThreads.mock.calls.at(-1)?.[0]).toContain('q=')
    })
    expect(api.listMessageThreads.mock.calls.at(-1)?.[0]).not.toContain('folder_kind')
    expect(screen.getByTestId('messages-search-all')).toBeDefined()
    const inbox = screen
      .getAllByTestId('messages-folder')
      .find((b) => b.getAttribute('data-folder') === 'inbox') as HTMLElement
    await user.click(inbox)
    expect((screen.getByTestId('messages-search') as HTMLInputElement).value).toBe('')
    await waitFor(() => {
      expect(api.listMessageThreads.mock.calls.at(-1)?.[0]).toBe('?folder_kind=inbox')
    })
  })

  it('列表项切换：点第二条打开第二条；已读的不再标一次', async () => {
    const user = userEvent.setup()
    renderWithProviders(<MessagesPage />)
    const rows = await screen.findAllByTestId('messages-thread')
    await user.click(rows[1] as HTMLElement)
    await waitFor(() => {
      expect(api.getMessageThread).toHaveBeenCalledWith('<t2@x>')
    })
    expect(api.setMessageFlags).not.toHaveBeenCalled()
    expect(rows[1]?.getAttribute('data-selected')).toBe('true')
  })

  it('再往前取：说取到了哪一天', async () => {
    const user = userEvent.setup()
    renderWithProviders(<MessagesPage />)
    await screen.findAllByTestId('messages-thread')
    await user.click(screen.getByTestId('messages-backfill'))
    expect((await notice()).textContent).toContain('已往前取到')
  })

  it('键盘：j 打开第一条（不再跳过）、e 归档、r 回复（写信框开着时不重开）、/ 聚焦搜索', async () => {
    renderWithProviders(<MessagesPage />)
    await screen.findAllByTestId('messages-thread')
    fireEvent.keyDown(window, { key: 'j' })
    await waitFor(() => {
      expect(api.getMessageThread).toHaveBeenCalledWith('<t1@x>')
    })
    await screen.findAllByTestId('messages-message')
    fireEvent.keyDown(window, { key: 'r' })
    const body = (await screen.findByTestId('composer-body')) as HTMLTextAreaElement
    fireEvent.change(body, { target: { value: '写了一半' } })
    body.blur()
    fireEvent.keyDown(window, { key: 'a' })
    expect(screen.getByTestId('composer').getAttribute('data-mode')).toBe('reply')
    expect((screen.getByTestId('composer-body') as HTMLTextAreaElement).value).toBe('写了一半')
    fireEvent.click(screen.getByTestId('composer-close'))
    fireEvent.keyDown(window, { key: 'e' })
    await waitFor(() => {
      expect(api.moveMessage).toHaveBeenCalledWith('msg_1', { to: 'archive' })
    })
    fireEvent.keyDown(window, { key: '/' })
    expect(document.activeElement).toBe(screen.getByTestId('messages-search'))
  })

  it('影子模式（只看不动）：归档 / 删除置灰、问号里说为什么，左栏挂「只看不动」；按 e 也只说一句不挪', async () => {
    api.listMessageAccounts.mockResolvedValue({ accounts: [{ ...account, shadow_mode: true }] })
    const user = await openFirst()
    expect((screen.getByTestId('messages-archive') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('messages-delete') as HTMLButtonElement).disabled).toBe(true)
    const hint = screen.getByTestId('messages-shadow-hint').getAttribute('data-hint') ?? ''
    expect(hint).toContain('影子模式')
    expect(screen.getByTestId('messages-shadow').textContent).toContain('只看不动')
    fireEvent.keyDown(window, { key: 'e' })
    expect((await notice()).textContent).toContain('影子模式')
    expect(api.moveMessage).not.toHaveBeenCalled()
    // 星标照样能点（只在本机标）
    await user.click(screen.getAllByTestId('messages-star').at(-1) as HTMLElement)
    await waitFor(() => {
      expect(api.setMessageFlags).toHaveBeenCalledWith('msg_1', { starred: true })
    })
    api.listMessageAccounts.mockImplementation(async () => ({ accounts: [account] }))
  })
})

describe('WP204：正文框的高度', () => {
  it('不再停在浏览器缺省的 150px：按正文与图片粗估，夹在 120–900', async () => {
    const { estimateHeight } = await import('@/components/messages/message-body')
    expect(estimateHeight('<p>hi</p>')).toBeGreaterThanOrEqual(120)
    const withBanner = estimateHeight('<p><img height="300" /></p><p>正文</p>')
    expect(withBanner).toBeGreaterThan(estimateHeight('<p>正文</p>') + 250)
    expect(estimateHeight('<p>x</p>'.repeat(500))).toBe(900)
  })
})
