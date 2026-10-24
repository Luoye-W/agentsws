/**
 * WP510（决策 1515）：同事 / 公司模式的收件箱——工作台这一层。
 *
 * 钉住的是：
 * - ① 个人：没有「给我的 / 全部」、没有「分工」、没有「刚处理」、行上没有「在看 / 给谁」，也不跳心跳；
 * - ② / ③：别人开着的那一行出「林峰在看」；「给我的 / 全部」带件数、点「全部」按 scope=all 取；
 *   别人的写「给林峰」、负责人不在转来的写「林峰不在，转给你」；
 * - 「刚处理」写同事的名字；一张一张里同事处理掉的那张，「刚才」写他、不给撤回；
 * - 「分工」：点名字勾上负责人（改一项）。
 */
import type { InboxPresenceView, TeamInboxPatch, TeamInboxView } from '@agentsws/contracts'
import type { InboxItem, InboxView } from '@agentsws/deck'
import { inboxCounts } from '@agentsws/deck'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetInboxOpen, resetInboxTeamState } from '@/components/inbox/inbox-model'
import { AppProvider } from '@/lib/app-context'
import { renderWithProviders } from './helpers'
import { inboxItems, inboxView } from './inbox-fixtures'

const LIN = { person_id: 'per_lin', name: '林峰' }
const ME = { person_id: 'per_1', name: '王岚' }

const state = vi.hoisted(() => ({
  view: undefined as InboxView | undefined,
  all: undefined as InboxView | undefined,
  viewers: {} as InboxPresenceView['viewers'],
}))
const getInbox = vi.fn(async (opts?: { scope?: 'all' }) =>
  opts?.scope === 'all' ? (state.all ?? state.view) : state.view,
)
const inboxPresence = vi.fn(async (_item: string | null) => ({ viewers: state.viewers }))
const setInboxTeam = vi.fn(async (_patch: TeamInboxPatch) => teamView())

function teamView(): TeamInboxView {
  return {
    mode: 'peers',
    me: ME.person_id,
    can_edit: true,
    settings: { away_days: 3, fallback: 'admins' },
    mailboxes: [{ account: 'hello@nordvolt.example', owners: [] }],
    members: [
      { ...ME, admin: true, away: false },
      { ...LIN, admin: false, away: false },
    ],
  }
}

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getInbox: (opts?: { scope?: 'all' }) => getInbox(opts),
    inboxPresence: (item: string | null) => inboxPresence(item),
    getInboxTeam: async () => teamView(),
    setInboxTeam: (patch: TeamInboxPatch) => setInboxTeam(patch),
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
    listMessageFollowUps: async () => ({ rows: [] }),
  }
})

const { InboxPage } = await import('@/pages/inbox')

/** ② 的那一份：一封信是林峰不在、转给我的；「刚处理」里林峰批了一张。 */
function teamInbox(items: InboxItem[] = inboxItems()): InboxView {
  const marked = items.map((i) =>
    i.id === 'mail:<t_sam@x>'
      ? { ...i, owners: [ME], mine: true, fallback_from: [LIN] }
      : { ...i, mine: true },
  )
  const view = inboxView(marked)
  return {
    ...view,
    team: {
      mode: 'peers',
      scope: 'mine',
      mine: marked.length,
      all: marked.length + 1,
      handled: [
        {
          card_id: 'ap_gone',
          title: '回信 · Clara',
          by: LIN,
          self: false,
          action: 'approve',
          at: '2026-10-22T09:00:00.000Z',
        },
      ],
    },
  }
}

beforeEach(() => {
  resetInboxOpen()
  resetInboxTeamState()
  state.view = inboxView()
  state.all = undefined
  state.viewers = {}
  getInbox.mockClear()
  inboxPresence.mockClear()
  setInboxTeam.mockClear()
})

const row = (id: string): HTMLElement => {
  const hit = screen.queryAllByTestId('inbox-row').find((r) => r.getAttribute('data-id') === id)
  if (hit === undefined) throw new Error(`没有 ${id}`)
  return hit
}

describe('WP510 ① 个人：一个字都不多', () => {
  it('没有给我的 / 全部、分工、刚处理、在看 / 给谁；不跳心跳', async () => {
    state.viewers = { 'card:ap_reply': [LIN] }
    renderWithProviders(<InboxPage />, '/inbox?mode=list')
    await screen.findAllByTestId('inbox-row')
    expect(screen.queryByTestId('inbox-scope')).toBeNull()
    expect(screen.queryByTestId('inbox-team-button')).toBeNull()
    expect(screen.queryByTestId('inbox-handled')).toBeNull()
    expect(screen.queryByTestId('inbox-viewing')).toBeNull()
    expect(screen.queryByTestId('inbox-owner')).toBeNull()
    expect(inboxPresence).not.toHaveBeenCalled()
    expect(getInbox).toHaveBeenCalledWith(undefined)
  })
})

describe('WP510 ② / ③', () => {
  it('同事开着的那一行出「林峰在看」；转来的写「林峰不在，转给你」；刚处理写他的名字', async () => {
    state.view = teamInbox()
    state.viewers = { 'card:ap_reply': [LIN] }
    renderWithProviders(<InboxPage />, '/inbox?mode=list')
    await screen.findAllByTestId('inbox-row')
    await waitFor(() => {
      expect(within(row('card:ap_reply')).getByTestId('inbox-viewing').textContent).toContain(
        '林峰在看',
      )
    })
    expect(inboxPresence).toHaveBeenCalledWith(null)
    expect(within(row('mail:<t_sam@x>')).getByTestId('inbox-owner').textContent).toBe(
      '林峰不在，转给你',
    )
    expect(screen.getByTestId('inbox-handled').textContent).toContain('林峰批了「回信 · Clara」')
    // 打开一件：心跳带上这一件
    fireEvent.click(row('card:ap_price'))
    await waitFor(() => {
      expect(inboxPresence).toHaveBeenCalledWith('card:ap_price')
    })
  })

  it('给我的 / 全部带件数；点「全部」按 scope=all 取，别人的写「给林峰」', async () => {
    state.view = teamInbox()
    const extra: InboxItem = {
      ...(inboxItems()[0] as InboxItem),
      id: 'card:ap_lin',
      mine: false,
      owners: [LIN],
      primary: 'open',
    }
    const all = teamInbox([...inboxItems(), extra])
    state.all = {
      ...all,
      items: all.items.map((i) => (i.id === 'card:ap_lin' ? extra : i)),
      counts: inboxCounts(all.items),
      ...(all.team === undefined ? {} : { team: { ...all.team, scope: 'all' } }),
    }
    renderWithProviders(<InboxPage />, '/inbox?mode=list')
    await screen.findAllByTestId('inbox-row')
    expect(screen.getByTestId('inbox-scope-mine').textContent).toContain('6')
    expect(screen.getByTestId('inbox-scope-all').textContent).toContain('7')
    fireEvent.click(screen.getByTestId('inbox-scope-all'))
    await waitFor(() => {
      expect(getInbox).toHaveBeenCalledWith({ scope: 'all' })
    })
    await waitFor(() => {
      expect(within(row('card:ap_lin')).getByTestId('inbox-owner').textContent).toBe('给林峰')
    })
  })

  it('一张一张：同事处理掉了当前那张，「刚才」写他、不给撤回', async () => {
    state.view = teamInbox()
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
    render(
      <QueryClientProvider client={client}>
        <AppProvider initialTheme="light" initialLang="zh" initialPosition="asg_1">
          <MemoryRouter initialEntries={['/inbox']}>
            <InboxPage />
          </MemoryRouter>
        </AppProvider>
      </QueryClientProvider>,
    )
    const card = await screen.findByTestId('inbox-focus-card')
    expect(card.getAttribute('data-id')).toBe('card:ap_reply')
    // 林峰批了那一张：下一次取的时候它不在了，「刚处理」里有他
    const next = teamInbox(inboxItems().filter((i) => i.id !== 'card:ap_reply'))
    state.view = {
      ...next,
      ...(next.team === undefined
        ? {}
        : {
            team: {
              ...next.team,
              handled: [
                {
                  card_id: 'ap_reply',
                  title: '回信 · Tom Becker',
                  by: LIN,
                  self: false,
                  action: 'approve',
                  at: '2026-10-22T09:20:00.000Z',
                },
              ],
            },
          }),
    }
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['inbox'] })
    })
    await waitFor(() => {
      expect(screen.getByTestId('inbox-focus-recent').textContent).toContain(
        '林峰批了「回信 · Tom Becker」',
      )
    })
    expect(screen.queryByTestId('inbox-focus-undo')).toBeNull()
  })

  it('分工：点名字勾上这只邮箱的负责人', async () => {
    state.view = teamInbox()
    renderWithProviders(<InboxPage />, '/inbox?mode=list')
    fireEvent.click(await screen.findByTestId('inbox-team-button'))
    const box = await screen.findByTestId('inbox-team-mailbox')
    const lin = within(box)
      .getAllByTestId('inbox-team-owner')
      .find((b) => b.getAttribute('data-person') === LIN.person_id)
    if (lin === undefined) throw new Error('没有林峰')
    fireEvent.click(lin)
    await waitFor(() => {
      expect(setInboxTeam).toHaveBeenCalledWith({
        mailbox: { account: 'hello@nordvolt.example', owners: [LIN.person_id] },
      })
    })
    expect(screen.getByTestId('inbox-team-away').textContent).toContain('发起人')
  })
})
