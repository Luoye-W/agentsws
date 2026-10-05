/**
 * WP227（Luoye 10-05 #13，docs/88 §2.2）：营销信在「全部」的会话列表里折成一捆、挂「营销」小标签；
 * **只在界面上折，不动邮箱**（折 / 展开都不发任何挪信、标记请求）。判定沿用 WP212 的类型
 * （`kind = marketing`），老记录没有类型时看「营销订阅」标签。
 */
import type { MessageThreadSummary } from '@agentsws/contracts'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { foldsAsMarketing, isMarketing, splitMarketing } from '@/components/messages/marketing'
import type { MessageAccountView } from '@/lib/api'
import { renderWithProviders } from './helpers'

const T0 = '2026-10-05T01:00:00.000Z'
const ME = 'hello@shop.example'

const account: MessageAccountView = {
  address: ME,
  unread: 0,
  folders: [{ path: 'INBOX', kind: 'inbox', account: ME, unread: 0, total: 5 }],
  backfill_floor: '2026-09-01T00:00:00.000Z',
}

const row = (id: string, over: Partial<MessageThreadSummary> = {}): MessageThreadSummary => ({
  thread_id: id,
  subject: `主题 ${id}`,
  participants: [{ email: `${id}@sender.example`, name: `发件人 ${id}` }],
  last_at: T0,
  count: 1,
  unread: 0,
  starred: false,
  labels: [],
  route: 'inbox',
  folders: ['INBOX'],
  accounts: [ME],
  needs_reply: false,
  snippet: '…',
  last_message_id: `msg_${id}`,
  ...over,
})

const threads = [
  row('a', { kind: 'customer_question', needs_reply: true }),
  row('p1', { kind: 'marketing', claim: 'notice' }),
  row('b', { kind: 'logistics' }),
  // 老记录：没有类型，只有「营销订阅」标签
  row('p2', { labels: ['newsletters'] }),
  // 可疑的营销信不折（要人看见），但照样挂标签
  row('p3', { kind: 'marketing', labels: ['suspicious'] }),
]

const listMessageThreads = vi.fn(async (_q?: string) => ({ threads }))
const moveMessage = vi.fn(async () => ({}))
const setMessageFlags = vi.fn(async () => ({}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
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
    listMessageAccounts: async () => ({ accounts: [account] }),
    listMessageLabels: async () => ({ labels: [] }),
    listMessageThreads: (...a: unknown[]) => listMessageThreads(...(a as [])),
    getMessageThread: async (id: string) => ({ thread_id: id, subject: '', messages: [] }),
    moveMessage: (...a: unknown[]) => moveMessage(...(a as [])),
    setMessageFlags: (...a: unknown[]) => setMessageFlags(...(a as [])),
    getMailAssistant: async () => undefined,
  }
})

const { MessagesPage } = await import('@/pages/messages')

const ids = (): string[] =>
  screen.getAllByTestId('messages-thread').map((el) => el.getAttribute('data-thread') ?? '')

describe('营销信判定（沿用现有分类）', () => {
  it('类型是「垃圾与营销」，或老记录挂着「营销订阅」标签', () => {
    expect(isMarketing({ kind: 'marketing', labels: [] })).toBe(true)
    expect(isMarketing({ labels: ['newsletters'] })).toBe(true)
    // 有类型就以类型为准（标签是 WP212 之前的老口径）
    expect(isMarketing({ kind: 'logistics', labels: ['newsletters'] })).toBe(false)
    expect(isMarketing({ kind: 'customer_question', labels: [] })).toBe(false)
    expect(isMarketing({ labels: [] })).toBe(false)
  })

  it('可疑、要回（没人接）、星标的不折；其余营销信折进那一捆，顺序不变', () => {
    const base = { kind: 'marketing' as const, labels: [], starred: false }
    expect(foldsAsMarketing(base)).toBe(true)
    expect(foldsAsMarketing({ ...base, labels: ['suspicious'] })).toBe(false)
    expect(foldsAsMarketing({ ...base, claim: 'unclaimed' })).toBe(false)
    expect(foldsAsMarketing({ ...base, starred: true })).toBe(false)
    const { listed, folded } = splitMarketing(threads)
    expect(listed.map((r) => r.thread_id)).toEqual(['a', 'b', 'p3'])
    expect(folded.map((r) => r.thread_id)).toEqual(['p1', 'p2'])
  })
})

describe('消息页「全部」：营销信折成一捆 + 「营销」标签（WP227）', () => {
  it('默认折着：列表里只剩非营销的和不折的；那一捆写着「营销」和封数', async () => {
    renderWithProviders(<MessagesPage />, '/messages?view=all')
    await screen.findAllByTestId('messages-thread')
    expect(ids()).toEqual(['a', 'b', 'p3'])
    const fold = screen.getByTestId('messages-promo-fold')
    expect(fold.getAttribute('aria-expanded')).toBe('false')
    expect(fold.textContent).toContain('营销')
    expect(within(fold).getByTestId('messages-promo-count').textContent).toBe('2')
    // 说明进 tooltip，不铺在界面上
    expect(fold.getAttribute('data-hint')).toContain('邮箱里一封不动')
    // 不折的那封可疑营销信照样挂标签
    const p3 = screen.getAllByTestId('messages-thread').find((el) => el.dataset.thread === 'p3')
    expect(p3 && within(p3).getByTestId('messages-promo-tag').textContent).toBe('营销')
  })

  it('点开那一捆：营销信排在后面、每封都有「营销」标签；折 / 展开都不动邮箱', async () => {
    const user = userEvent.setup()
    renderWithProviders(<MessagesPage />, '/messages?view=all')
    await user.click(await screen.findByTestId('messages-promo-fold'))
    expect(ids()).toEqual(['a', 'b', 'p3', 'p1', 'p2'])
    expect(screen.getByTestId('messages-promo-fold').getAttribute('aria-expanded')).toBe('true')
    const tagged = screen
      .getAllByTestId('messages-thread')
      .filter((el) => within(el).queryByTestId('messages-promo-tag') !== null)
      .map((el) => el.dataset.thread)
    expect(tagged).toEqual(['p3', 'p1', 'p2'])
    // 再点一下收起
    await user.click(screen.getByTestId('messages-promo-fold'))
    expect(ids()).toEqual(['a', 'b', 'p3'])
    expect(moveMessage).not.toHaveBeenCalled()
    expect(setMessageFlags).not.toHaveBeenCalled()
  })

  it('键盘 j 只在看得见的几行之间走（折着的营销信跳过）', async () => {
    renderWithProviders(<MessagesPage />, '/messages?view=all')
    await screen.findAllByTestId('messages-thread')
    for (let i = 0; i < 5; i++) fireEvent.keyDown(window, { key: 'j' })
    await waitFor(() => {
      const sel = screen
        .getAllByTestId('messages-thread')
        .find((el) => el.dataset.selected === 'true')
      expect(sel?.dataset.thread).toBe('p3')
    })
  })

  it('卡片那头「看原件 →」落到一封折着的营销信：替人展开', async () => {
    renderWithProviders(<MessagesPage />, '/messages?view=all&thread=p2')
    await waitFor(() => {
      expect(screen.getByTestId('messages-promo-fold').getAttribute('aria-expanded')).toBe('true')
    })
    expect(ids()).toContain('p2')
  })

  it('搜索时不折（人在找东西），标签照挂', async () => {
    const user = userEvent.setup()
    renderWithProviders(<MessagesPage />, '/messages?view=all')
    await screen.findAllByTestId('messages-thread')
    await user.type(screen.getByTestId('messages-search'), '主题')
    await waitFor(() => {
      expect(ids()).toEqual(['a', 'p1', 'b', 'p2', 'p3'])
    })
    expect(screen.queryByTestId('messages-promo-fold')).toBeNull()
    expect(screen.getAllByTestId('messages-promo-tag')).toHaveLength(3)
  })
})
