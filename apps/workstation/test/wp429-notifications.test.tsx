/**
 * WP429 站内通知（界面）：顶栏铃铛 + 未读红点、通知面板（未读 / 全部、点一条标已读并跳过去、全部已读）、
 * 系统通知（新来的、类别开了「系统」的才弹；正看着那一页的直接已读）、设置 → 通知的「站内 / 系统」开关。
 */
import type { InboxNotification, NotificationPrefs } from '@agentsws/contracts'
import { focusManager } from '@tanstack/react-query'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWithProviders } from './helpers'

const NOW = Date.parse('2026-10-19T08:00:00.000Z')

const note = (over: Partial<InboxNotification>): InboxNotification => ({
  id: 'ntf_1',
  workspace_id: 'ws_1',
  person_id: 'per_me',
  category: 'team',
  text: '陈晓回你了：退款单核对完了',
  href: '/assistant?peers=1',
  key: 'secretary:1',
  count: 1,
  created_at: '2026-10-19T07:55:00.000Z',
  updated_at: '2026-10-19T07:55:00.000Z',
  system: true,
  ...over,
})

const state: {
  items: InboxNotification[]
  prefs: NotificationPrefs
  read: string[][]
  readAll: number
  puts: unknown[]
} = {
  items: [],
  prefs: {
    team: { inbox: true, system: true },
    task: { inbox: true, system: false },
    connection: { inbox: true, system: true },
    // WP432：等你发
    outbound: { inbox: true, system: true },
    credits: { inbox: true, system: true },
    update: { inbox: true, system: false },
    // WP441：消息
    messages: { inbox: true, system: false },
    // WP466：告警（原首页告警区）
    alert: { inbox: true, system: true },
    feedback: { inbox: true, system: false },
  },
  read: [],
  readAll: 0,
  puts: [],
}

vi.mock('@/lib/api-notifications', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/api-notifications')>('@/lib/api-notifications')
  return {
    ...actual,
    listNotifications: async (view: 'unread' | 'all' = 'unread') => {
      const unread = state.items.filter((n) => n.read_at === undefined)
      return { items: view === 'all' ? state.items : unread, unread: unread.length }
    },
    markNotificationsRead: async (ids: string[]) => {
      state.read.push(ids)
      for (const n of state.items) if (ids.includes(n.id)) n.read_at = '2026-10-19T08:00:00.000Z'
      return { unread: state.items.filter((n) => n.read_at === undefined).length }
    },
    markAllNotificationsRead: async () => {
      state.readAll += 1
      for (const n of state.items) n.read_at = '2026-10-19T08:00:00.000Z'
      return { unread: 0 }
    },
    getNotificationPrefs: async () => state.prefs,
    putNotificationPrefs: async (patch: Record<string, { inbox?: boolean; system?: boolean }>) => {
      state.puts.push(patch)
      for (const [k, v] of Object.entries(patch)) {
        const cat = k as keyof NotificationPrefs
        state.prefs = { ...state.prefs, [cat]: { ...state.prefs[cat], ...v } }
        if (v.inbox === false) state.prefs[cat].system = false
      }
      return state.prefs
    },
  }
})

const { NotificationBell, agoText, badgeText } = await import(
  '@/components/notifications/notification-bell'
)
const { NotificationPrefsCard } = await import('@/components/notifications/notification-prefs')
const { isSamePage } = await import('@/components/notifications/use-system-notify')

function Where(): React.ReactNode {
  return <span data-testid="where">{useLocation().pathname + useLocation().search}</span>
}

beforeEach(() => {
  state.items = []
  state.read = []
  state.readAll = 0
  state.puts = []
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
})

afterEach(() => {
  vi.restoreAllMocks()
  focusManager.setFocused(undefined)
  ;(window as unknown as { agentsws?: unknown }).agentsws = undefined
})

describe('铃铛与面板', () => {
  it('没有未读：只有铃铛，没有红点；打开是空的样子', async () => {
    renderWithProviders(<NotificationBell />)
    const bell = await screen.findByTestId('notify-bell')
    expect(screen.queryByTestId('notify-badge')).toBeNull()
    fireEvent.click(bell)
    expect(await screen.findByTestId('notify-empty')).toBeTruthy()
    expect(screen.getByTestId('notify-empty').textContent).toContain('没有新通知')
  })

  it('未读数红点；面板里一行字 + 时间，合并过的带 ×N；点一条标已读并跳到那件事', async () => {
    state.items = [
      note({}),
      note({
        id: 'ntf_2',
        category: 'connection',
        text: 'Shopify 连接断了，要重新连一下',
        href: '/settings/connections',
        key: 'conn:1',
        count: 3,
        updated_at: '2026-10-19T05:00:00.000Z',
      }),
    ]
    renderWithProviders(
      <>
        <NotificationBell />
        <Where />
      </>,
    )
    expect((await screen.findByTestId('notify-badge')).textContent).toBe('2')
    expect(screen.getByTestId('notify-bell').getAttribute('aria-label')).toBe('通知（2 条未读）')
    fireEvent.click(screen.getByTestId('notify-bell'))
    const rows = await screen.findAllByTestId('notify-item')
    expect(rows.map((r) => r.getAttribute('data-category'))).toEqual(['team', 'connection'])
    expect(rows[0]?.textContent).toContain('5 分钟前')
    expect(rows[1]?.textContent).toContain('3 小时前')
    expect(within(rows[1] as HTMLElement).getByTestId('notify-item-count').textContent).toBe('×3')
    fireEvent.click(rows[1] as HTMLElement)
    await waitFor(() => {
      expect(screen.getByTestId('where').textContent).toBe('/settings/connections')
    })
    expect(state.read).toEqual([['ntf_2']])
    expect(screen.queryByTestId('notify-panel')).toBeNull()
    await waitFor(() => {
      expect(screen.getByTestId('notify-badge').textContent).toBe('1')
    })
  })

  it('「全部」里也有读过的；全部已读之后红点没了；齿轮到设置 → 通知', async () => {
    state.items = [
      note({}),
      note({ id: 'ntf_old', text: '老的', read_at: '2026-10-18T01:00:00.000Z' }),
    ]
    renderWithProviders(
      <>
        <NotificationBell />
        <Where />
      </>,
    )
    fireEvent.click(await screen.findByTestId('notify-bell'))
    expect(await screen.findAllByTestId('notify-item')).toHaveLength(1)
    fireEvent.click(screen.getByTestId('notify-view-all'))
    await waitFor(() => {
      expect(screen.getAllByTestId('notify-item')).toHaveLength(2)
    })
    expect(screen.getAllByTestId('notify-item')[1]?.getAttribute('data-unread')).toBe('false')
    fireEvent.click(screen.getByTestId('notify-read-all'))
    await waitFor(() => {
      expect(screen.queryByTestId('notify-badge')).toBeNull()
    })
    expect(state.readAll).toBe(1)
    fireEvent.click(screen.getByTestId('notify-settings'))
    expect(screen.getByTestId('where').textContent).toBe('/settings/notifications')
  })

  it('时间与红点的写法', () => {
    const t = (k: string, v?: Record<string, string | number>) => `${k}:${v?.n ?? ''}`
    expect(agoText('2026-10-19T07:59:50.000Z', NOW, t)).toBe('notify.ago.now:')
    expect(agoText('2026-10-18T07:00:00.000Z', NOW, t)).toBe('notify.ago.yesterday:')
    expect(agoText('2026-10-15T07:00:00.000Z', NOW, t)).toBe('notify.ago.day:4')
    expect(badgeText(120)).toBe('99+')
    expect(isSamePage('/assistant?peers=1', '/assistant')).toBe(true)
    expect(isSamePage('/matters/m1', '/matters/m2')).toBe(false)
  })
})

describe('系统通知（桌面版）', () => {
  it('打开时已有的不弹；之后新来的、类别开了「系统」的才弹，带上地址；点了系统通知跳过去', async () => {
    const notify = vi.fn(async () => true)
    let clicked: ((path: string) => void) | undefined
    ;(window as unknown as { agentsws: unknown }).agentsws = {
      notify,
      onNotificationClick: (l: (path: string) => void) => {
        clicked = l
        return () => undefined
      },
    }
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    state.items = [note({ id: 'ntf_before' })]
    const { container } = renderWithProviders(
      <>
        <NotificationBell />
        <Where />
      </>,
    )
    await screen.findByTestId('notify-badge')
    expect(notify).not.toHaveBeenCalled()

    state.items = [
      note({
        id: 'ntf_task',
        category: 'task',
        text: '「选品」跑完了',
        system: false,
        href: '/matters/m1',
      }),
      note({
        id: 'ntf_conn',
        category: 'connection',
        text: 'Shopify 连接断了，要重新连一下',
        href: '/settings/connections',
        system: true,
      }),
      ...state.items,
    ]
    // 切回窗口时会再问一次
    await act(async () => {
      focusManager.setFocused(false)
      focusManager.setFocused(true)
    })
    await waitFor(() => {
      expect(notify).toHaveBeenCalledTimes(1)
    })
    expect(notify).toHaveBeenCalledWith({
      title: 'Agents 工坊',
      body: 'Shopify 连接断了，要重新连一下',
      path: '/settings/connections',
    })
    act(() => {
      clicked?.('/settings/connections')
    })
    await waitFor(() => {
      expect(screen.getByTestId('where').textContent).toBe('/settings/connections')
    })
    expect(container).toBeTruthy()
  })

  it('正看着那一页时来的那条：直接算已读、不弹', async () => {
    const notify = vi.fn(async () => true)
    ;(window as unknown as { agentsws: unknown }).agentsws = { notify }
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    renderWithProviders(<NotificationBell />, '/matters/m1')
    await screen.findByTestId('notify-bell')
    await waitFor(() => {
      expect(screen.queryByTestId('notify-badge')).toBeNull()
    })
    state.items = [
      note({
        id: 'ntf_here',
        category: 'task',
        text: '「选品」没跑成',
        href: '/matters/m1',
        system: true,
      }),
    ]
    await act(async () => {
      focusManager.setFocused(false)
      focusManager.setFocused(true)
    })
    await waitFor(() => {
      expect(state.read).toEqual([['ntf_here']])
    })
    expect(notify).not.toHaveBeenCalled()
  })
})

describe('设置 → 通知：每类「站内 / 系统」', () => {
  it('五类各一行、两列开关；关掉站内，系统那一格也关、点不动', async () => {
    renderWithProviders(<NotificationPrefsCard />)
    await screen.findByTestId('settings-notify-prefs')
    for (const cat of ['team', 'task', 'connection', 'credits', 'update'])
      expect(screen.getByTestId(`notify-pref-${cat}`)).toBeTruthy()
    const sys = screen.getByTestId('notify-pref-team-system')
    expect(sys.getAttribute('aria-checked')).toBe('true')
    expect(screen.getByTestId('notify-pref-task-system').getAttribute('aria-checked')).toBe('false')
    fireEvent.click(screen.getByTestId('notify-pref-team-inbox'))
    await waitFor(() => {
      expect(screen.getByTestId('notify-pref-team-system').getAttribute('aria-checked')).toBe(
        'false',
      )
    })
    expect(screen.getByTestId('notify-pref-team-system').hasAttribute('disabled')).toBe(true)
    expect(state.puts).toEqual([{ team: { inbox: false } }])
    fireEvent.click(screen.getByTestId('notify-pref-task-system'))
    await waitFor(() => {
      expect(state.puts).toEqual([{ team: { inbox: false } }, { task: { system: true } }])
    })
  })
})
