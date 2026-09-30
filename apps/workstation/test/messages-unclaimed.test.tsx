/**
 * WP212（docs/88 §4.1）：消息页默认视图「没人接的」。
 *
 * 钉住的是：
 * - 默认就是「没人接的」，顶上一行「已交给岗位 N」+「卡片流里 N 张等你批 →」（只报数）；
 * - 每条：AI 摘要、类型胶囊（拿不准写把握，点开改判，勾「记住」）、三个建议（AI 挑的是主按钮）；
 * - 「交给 X」打出去的是 confirm-route 推广到岗位；没开的岗位在 ▾ 里是灰的；
 * - 「只是通知」成捆、整捆「知道了」；
 * - AI 助手是兜底助手：岗位在办的信不请求建议；
 * - 卡片那头「看原件 →」落到「全部」这条会话。
 */
import type { MessageOverview, MessageRecord, MessageThreadSummary } from '@agentsws/contracts'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { MessageAccountView, MessageThreadView } from '@/lib/api'
import { draftCard } from './fixtures'
import { renderWithProviders } from './helpers'

const T0 = '2026-09-30T01:00:00.000Z'
const ME = 'support@shop.example'

const account: MessageAccountView = {
  address: ME,
  unread: 1,
  folders: [{ path: 'INBOX', kind: 'inbox', account: ME, unread: 1, total: 5 }],
  backfill_floor: '2026-09-01T00:00:00.000Z',
}

const row = (over: Partial<MessageThreadSummary> = {}): MessageThreadSummary => ({
  thread_id: '<t1@x>',
  subject: 'Interview request',
  participants: [{ email: 'clara@review.example', name: 'Clara Hoffmann' }],
  last_at: T0,
  count: 1,
  unread: 1,
  starred: false,
  labels: [],
  route: 'inbox',
  folders: ['INBOX'],
  accounts: [ME],
  needs_reply: true,
  snippet: 'Could we talk for 20 minutes on Thursday?',
  last_message_id: 'msg_1',
  claim: 'unclaimed',
  claim_message_id: 'msg_1',
  kind: 'media',
  kind_confidence: 0.91,
  kind_by: 'model',
  summary: '想周四采访你 20 分钟，谈便携储能趋势',
  suggest: { action: 'hand', position: 'pr' },
  ...over,
})

const overview: MessageOverview = {
  unclaimed: 2,
  notice: 3,
  handed: 4,
  handed_by_position: [{ position_id: 'customer-care', count: 4 }],
  cards_waiting: 2,
  notice_groups: [
    { kind: 'billing_system', count: 2, senders: ['Stripe', 'ShipFast'] },
    { kind: 'suspicious', count: 1, senders: ['Shopify Security'] },
  ],
  positions: [
    {
      id: 'customer-care',
      name_zh: '客服',
      name_en: 'Customer Care',
      open: true,
      route: 'support',
    },
    { id: 'pr', name_zh: '公共关系', name_en: 'PR', open: true },
    { id: 'social-media', name_zh: '社媒运营', name_en: 'Social', open: false },
  ],
  taught: {
    rules: 3,
    saved: 12,
    recent: [
      {
        id: 'c1',
        message_id: 'm0',
        sender_domain: 'shipfast.example',
        field: 'kind',
        from: 'personal_other',
        to: 'billing_system',
        remembered: true,
        by: 'p_me',
        at: T0,
      },
    ],
  },
}

const unsure = row({
  thread_id: '<t2@x>',
  claim_message_id: 'msg_2',
  last_message_id: 'msg_2',
  participants: [{ email: 'tom@buyer.example', name: 'Tom Becker' }],
  kind: 'after_sales',
  kind_confidence: 0.52,
  summary: '说订单一直没到，想退款；没写订单号',
  suggest: { action: 'hand', position: 'customer-care' },
  priority: 'high',
})

const message = (over: Partial<MessageRecord> = {}): MessageRecord => ({
  id: 'msg_1',
  workspace_id: 'ws_1',
  source: 'email',
  account: ME,
  folder: 'INBOX',
  folder_kind: 'inbox',
  thread_id: '<t1@x>',
  references: [],
  headers: {},
  from: { email: 'clara@review.example', name: 'Clara Hoffmann' },
  to: [{ email: ME }],
  cc: [],
  bcc: [],
  subject: 'Interview request',
  snippet: 'Could we talk',
  text: 'Could we talk for 20 minutes on Thursday?',
  has_remote_images: false,
  attachments: [],
  date: T0,
  received_at: T0,
  flags: { read: true, starred: false, answered: false, draft: false },
  labels: [],
  route: 'inbox',
  triage: {
    route: 'inbox',
    labels: [],
    needs_reply: true,
    priority: 'normal',
    summary: '想周四采访你',
    confidence: 0.91,
    by: 'model',
    reasons: [],
    at: T0,
    kind: 'media',
  },
  ...over,
})

const listMessageThreads = vi.fn(async (query?: string) => ({
  threads: query?.includes('claim=unclaimed')
    ? [row(), unsure]
    : query?.includes('claim=notice')
      ? []
      : [
          row({
            claim: 'handed',
            handed_to: 'pr',
            open_card_count: 1,
            card_link: '/matters/mat_1',
          }),
        ],
}))
const handMessageToPosition = vi.fn(async (_id: string, position: string, _remember: boolean) => ({
  message: message(),
  handed_off: position !== 'nope',
  position_id: position,
}))
const setMessageKind = vi.fn(async (_id: string, _kind: string, _remember: boolean) => ({
  message: message(),
}))
const claimMessage = vi.fn(async (_id: string, _as: string) => ({ message: message() }))
const ackMessageNotices = vi.fn(async (_input: unknown) => ({ acked: 2, writeback: 'written' }))
const getMailAssistant = vi.fn(async () => ({
  message_id: 'msg_1',
  summary: '',
  needs_reply: false,
  suggestions: [],
  sender: { address: 'x@y', history_count: 0, linked: [] },
  todos: [],
  model_available: true,
}))
const threadView = vi.fn(
  async (): Promise<MessageThreadView> => ({
    thread_id: '<t1@x>',
    subject: 'Interview request',
    messages: [message()],
    claim: 'handed',
    handed_to: 'pr',
    open_card_count: 1,
    card_link: '/matters/mat_1',
  }),
)

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    listMessageAccounts: async () => ({ accounts: [account] }),
    listMessageLabels: async () => ({ labels: [] }),
    listMessageThreads: (q?: string) => listMessageThreads(q),
    getMessageOverview: async () => overview,
    getMessageThread: () => threadView(),
    getMailAssistant: () => getMailAssistant(),
    setMessageFlags: async () => ({ message: message() }),
    handMessageToPosition: (id: string, p: string, r: boolean) => handMessageToPosition(id, p, r),
    setMessageKind: (id: string, k: string, r: boolean) => setMessageKind(id, k, r),
    claimMessage: (id: string, as: string) => claimMessage(id, as),
    ackMessageNotices: (input: unknown) => ackMessageNotices(input),
  }
})

const { MessagesPage } = await import('@/pages/messages')
const { DeckCardView } = await import('@/components/deck/deck-card')

describe('消息页默认「没人接的」（WP212）', () => {
  it('顶上一行只报数；每条 AI 摘要 + 类型 + 原文一句 + 三个建议，AI 挑的是主按钮', async () => {
    renderWithProviders(<MessagesPage />, '/messages')
    const cards = await screen.findAllByTestId('unclaimed-card')
    expect(cards).toHaveLength(2)
    // 按急不急：要紧的在前
    expect(cards[0]?.getAttribute('data-thread')).toBe('<t2@x>')
    expect(screen.getByTestId('messages-headline').textContent).toContain('2 件没人接')
    const strip = screen.getByTestId('messages-handed')
    expect(strip.textContent).toContain('已交给岗位')
    expect(strip.textContent).toContain('客服')
    expect(screen.getByTestId('messages-cards-link').textContent).toContain('卡片流里 2 张等你批')
    const first = cards[0] as HTMLElement
    expect(within(first).getByTestId('unclaimed-summary').textContent).toContain('没写订单号')
    // 拿不准写把握
    expect(within(first).getByTestId('kind-chip').textContent).toContain('像是售后 · 把握 52%')
    expect(within(first).getByTestId('hand-actions').getAttribute('data-primary')).toBe('hand')
    expect(within(first).getByTestId('hand-primary').textContent).toBe('交给客服')
    // 把握够的不写把握
    expect(within(cards[1] as HTMLElement).getByTestId('kind-chip').textContent).toBe('媒体')
    // 你教过它：看得见
    expect(screen.getByTestId('messages-taught').textContent).toContain('少问你 12 次')
  })

  it('「交给 X」打出去的是推广到岗位的 confirm-route，默认勾「以后都这样」', async () => {
    const user = userEvent.setup()
    renderWithProviders(<MessagesPage />, '/messages')
    const card = (await screen.findAllByTestId('unclaimed-card'))[1] as HTMLElement
    await user.click(within(card).getByTestId('hand-primary'))
    await waitFor(() => {
      expect(handMessageToPosition).toHaveBeenCalledWith('msg_1', 'pr', true)
    })
    expect((await screen.findByTestId('messages-notice')).textContent).toContain('已交给公共关系')
  })

  it('▾ 里换岗位：AI 建议的在最上面；没开的岗位是灰的、点不了', async () => {
    const user = userEvent.setup()
    renderWithProviders(<MessagesPage />, '/messages')
    const card = (await screen.findAllByTestId('unclaimed-card'))[1] as HTMLElement
    await user.click(within(card).getByTestId('hand-more'))
    const menu = await screen.findByTestId('hand-menu')
    const options = within(menu).getAllByTestId('hand-option')
    expect(options[0]?.getAttribute('data-position')).toBe('pr')
    expect(options[0]?.textContent).toContain('AI 建议 · 媒体')
    const closed = options.find((o) => o.getAttribute('data-position') === 'social-media')
    expect(closed?.hasAttribute('disabled')).toBe(true)
    expect(menu.textContent).toContain('这里不再催')
    await user.click(
      options.find((o) => o.getAttribute('data-position') === 'customer-care') as HTMLElement,
    )
    await waitFor(() => {
      expect(handMessageToPosition).toHaveBeenCalledWith('msg_1', 'customer-care', true)
    })
  })

  it('改判：点类型胶囊 → 选一个 → 带「记住」', async () => {
    const user = userEvent.setup()
    renderWithProviders(<MessagesPage />, '/messages')
    const card = (await screen.findAllByTestId('unclaimed-card'))[1] as HTMLElement
    await user.click(within(card).getByTestId('kind-chip'))
    const pop = await screen.findByTestId('kind-popover')
    expect(within(pop).getByTestId('kind-popover-head').textContent).toBe('把握 91% · 模型')
    await user.click(
      within(pop)
        .getAllByTestId('kind-option')
        .find((o) => o.getAttribute('data-kind') === 'partnership') as HTMLElement,
    )
    await waitFor(() => {
      expect(setMessageKind).toHaveBeenCalledWith('msg_1', 'partnership', true)
    })
  })

  it('「只是通知」一下 + 撤销；通知成捆整捆「知道了」', async () => {
    const user = userEvent.setup()
    renderWithProviders(<MessagesPage />, '/messages')
    const card = (await screen.findAllByTestId('unclaimed-card'))[1] as HTMLElement
    await user.click(within(card).getByTestId('hand-notice'))
    await waitFor(() => {
      expect(claimMessage).toHaveBeenCalledWith('msg_1', 'notice')
    })
    await user.click(await screen.findByTestId('messages-undo'))
    await waitFor(() => {
      expect(claimMessage).toHaveBeenCalledWith('msg_1', 'none')
    })
    const groups = screen.getAllByTestId('notice-group')
    expect(groups.map((g) => g.getAttribute('data-kind'))).toEqual(['billing_system', 'suspicious'])
    await user.click(within(groups[0] as HTMLElement).getByTestId('notice-ack'))
    await waitFor(() => {
      expect(ackMessageNotices).toHaveBeenCalledWith({ kind: 'billing_system' })
    })
  })

  it('→ 看原件：切到「全部」打开这条；岗位在办的挂「在办 · 有卡等你 →」，AI 助手不请求建议', async () => {
    const user = userEvent.setup()
    getMailAssistant.mockClear()
    renderWithProviders(<MessagesPage />, '/messages')
    const card = (await screen.findAllByTestId('unclaimed-card'))[1] as HTMLElement
    await user.click(within(card).getByTestId('ws-go'))
    expect((await screen.findByTestId('messages-page')).getAttribute('data-view')).toBe('all')
    const band = await screen.findByTestId('messages-claim-band')
    expect(band.textContent).toContain('公共关系在办')
    expect(within(band).getByTestId('messages-cards-waiting').getAttribute('href')).toBe(
      '/matters/mat_1',
    )
    expect(await screen.findByTestId('mail-ai-handed')).toBeDefined()
    expect(screen.getByTestId('mail-ai').getAttribute('data-claim')).toBe('handed')
    expect(getMailAssistant).not.toHaveBeenCalled()
    // 「全部」列表上一行的归属小标签
    expect((await screen.findByTestId('messages-claim-tag')).textContent).toContain('有 1 张卡等你')
  })

  it('卡片那头：来自消息往来的卡有「看原件 →」，落到「全部」这条会话', () => {
    renderWithProviders(
      <DeckCardView
        card={draftCard({ original: { thread_id: '<t1@x>' } })}
        mode="zh_summary"
        onDecide={() => {}}
        onOpen={() => {}}
      />,
    )
    expect(screen.getByTestId('deck-original-link').getAttribute('href')).toBe(
      `/messages?view=all&thread=${encodeURIComponent('<t1@x>')}`,
    )
  })
})
