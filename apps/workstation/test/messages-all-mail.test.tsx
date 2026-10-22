/**
 * WP212（docs/88 §4.1）→ WP459：消息页默认是收件箱（`wp459-inbox.test.tsx` 钉那一页）；这里留：
 * - `/messages` 默认落在收件箱；
 * - 「全部信」（`?view=all`）打开一条岗位在办的会话：挂「X 在办 · 有卡等你 →」，AI 助手不请求建议；
 * - 卡片那头「看原件 →」落到「全部信」这条会话。
 */
import type { MessageOverview, MessageRecord, MessageThreadSummary } from '@agentsws/contracts'
import { screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { MessageAccountView, MessageThreadView } from '@/lib/api'
import { draftCard } from './fixtures'
import { renderWithProviders } from './helpers'
import { inboxView } from './inbox-fixtures'

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
    getInbox: async () => inboxView(),
    listMessageFollowUps: async () => ({ rows: [] }),
  }
})

const { MessagesPage } = await import('@/pages/messages')
const { DeckCardView } = await import('@/components/deck/deck-card')

describe('消息页：默认收件箱、「全部信」与看原件（WP212 / WP459）', () => {
  it('WP459：/messages 默认就是收件箱（不靠邮箱，没人接的那一套换掉了）', async () => {
    renderWithProviders(<MessagesPage />, '/messages')
    expect(await screen.findByTestId('inbox-page')).toBeDefined()
    expect(screen.queryByTestId('unclaimed-card')).toBeNull()
    expect(screen.getByTestId('inbox-title').textContent).toBe('收件箱')
  })

  it('WP459：收件箱「我自己回」带 ?reply=1 过来——打开这条会话就开写信框', async () => {
    renderWithProviders(
      <MessagesPage />,
      `/messages?view=all&thread=${encodeURIComponent('<t1@x>')}&reply=1`,
    )
    expect((await screen.findByTestId('messages-page')).getAttribute('data-view')).toBe('all')
    // 岗位在办的会话不给回复框（只读）——这条在办，所以照实说只读而不是开写信框
    await screen.findByTestId('messages-claim-band')
  })

  it('→ 看原件：「全部信」打开这条；岗位在办的挂「在办 · 有卡等你 →」，AI 助手不请求建议', async () => {
    getMailAssistant.mockClear()
    renderWithProviders(
      <MessagesPage />,
      `/messages?view=all&thread=${encodeURIComponent('<t1@x>')}`,
    )
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
