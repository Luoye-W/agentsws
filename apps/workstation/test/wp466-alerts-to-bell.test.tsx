/**
 * WP466（决策 1311）：原首页告警区的几样在铃铛里——「告警」一类、紧急档红色（没读时排最上、带「紧急」），
 * 点一条标已读、跳到对应的岗位 / 事项 / 设置页；设置 → 通知多一行「告警」。
 */
import type { InboxNotification, NotificationPrefs } from '@agentsws/contracts'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWithProviders } from './helpers'

const NOW = Date.parse('2026-10-22T08:00:00.000Z')

const alert = (over: Partial<InboxNotification>): InboxNotification => ({
  id: 'ntf_a',
  workspace_id: 'ws_1',
  person_id: 'per_me',
  category: 'alert',
  text: '目标市场按店铺后台改了：加上了 英国',
  href: '/settings#company',
  key: 'alert:markets_store|1',
  count: 1,
  created_at: '2026-10-22T07:00:00.000Z',
  updated_at: '2026-10-22T07:00:00.000Z',
  system: false,
  ...over,
})

const state: { items: InboxNotification[]; read: string[][]; prefs: NotificationPrefs } = {
  items: [],
  read: [],
  prefs: {
    team: { inbox: true, system: true },
    task: { inbox: true, system: false },
    connection: { inbox: true, system: true },
    credits: { inbox: true, system: true },
    update: { inbox: true, system: false },
    outbound: { inbox: true, system: true },
    alert: { inbox: true, system: true },
  },
}

vi.mock('@/lib/api-notifications', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/api-notifications')>('@/lib/api-notifications')
  return {
    ...actual,
    // 服务端排好了序（没读的紧急档在最上），这里原样给
    listNotifications: async (view: 'unread' | 'all' = 'unread') => {
      const unread = state.items.filter((n) => n.read_at === undefined)
      return { items: view === 'all' ? state.items : unread, unread: unread.length }
    },
    markNotificationsRead: async (ids: string[]) => {
      state.read.push(ids)
      for (const n of state.items) if (ids.includes(n.id)) n.read_at = '2026-10-22T08:00:00.000Z'
      return { unread: state.items.filter((n) => n.read_at === undefined).length }
    },
    markAllNotificationsRead: async () => ({ unread: 0 }),
    getNotificationPrefs: async () => state.prefs,
    putNotificationPrefs: async () => state.prefs,
  }
})

const { NotificationBell } = await import('@/components/notifications/notification-bell')
const { NotificationPrefsCard } = await import('@/components/notifications/notification-prefs')

function Where(): React.ReactNode {
  const loc = useLocation()
  return <span data-testid="where">{loc.pathname + loc.search + loc.hash}</span>
}

/** 原首页告警区出过的几种：每种一条、各自的去处。 */
const KINDS: { name: string; n: InboxNotification }[] = [
  {
    name: '改版回归·严重（WP448）',
    n: alert({
      id: 'ntf_drift',
      text: '改版回归：主题发布之后 2 处严重问题',
      href: '/matters/m_site_fix',
      key: 'alert:seo_drift|run_1',
      urgent: true,
      system: true,
    }),
  },
  {
    name: '店铺日报异常',
    n: alert({
      id: 'ntf_store',
      text: '昨天销售额比前 7 天均值掉了 90%',
      href: '/positions/asg_store/duties/dtc.store',
      key: 'alert:store_anomaly|2026-10-21|sales_drop',
      urgent: true,
      system: true,
    }),
  },
  {
    name: '广告改动等你确认',
    n: alert({
      id: 'ntf_ads',
      text: '平台预览好了，等你确认提交：改广告',
      href: '/positions/asg_g/duties/ads.google',
      key: 'alert:ads_change|chg_1|waiting_confirm',
      urgent: true,
      system: true,
    }),
  },
  { name: '目标市场校正', n: alert({}) },
  {
    name: '退役模型换了',
    n: alert({
      id: 'ntf_model',
      text: 'ChatGPT 订阅的 gpt-5.4 停用了，已换成 gpt-5.5',
      href: '/settings?tab=models',
      key: 'alert:retired_model|1',
    }),
  },
]

beforeEach(() => {
  state.items = KINDS.map((k) => ({ ...k.n }))
  state.read = []
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('告警在铃铛里', () => {
  it('每种一条；紧急的红色图标、红点、带「紧急」；普通告警没有', async () => {
    renderWithProviders(<NotificationBell />)
    expect((await screen.findByTestId('notify-badge')).textContent).toBe(String(KINDS.length))
    fireEvent.click(screen.getByTestId('notify-bell'))
    const rows = await screen.findAllByTestId('notify-item')
    expect(rows).toHaveLength(KINDS.length)
    expect(rows.every((r) => r.getAttribute('data-category') === 'alert')).toBe(true)
    expect(rows.map((r) => r.getAttribute('data-urgent'))).toEqual([
      'true',
      'true',
      'true',
      'false',
      'false',
    ])
    const urgent = rows[0] as HTMLElement
    expect(within(urgent).getByTestId('notify-item-urgent').textContent).toBe('紧急')
    expect(urgent.querySelector('.text-ws-bad')).not.toBeNull()
    expect(urgent.querySelector('.bg-ws-bad')).not.toBeNull()
    const plain = rows[3] as HTMLElement
    expect(within(plain).queryByTestId('notify-item-urgent')).toBeNull()
    expect(plain.querySelector('.bg-ws-bad')).toBeNull()
  })

  for (const { name, n } of KINDS)
    it(`点「${name}」：标已读、跳到它的去处`, async () => {
      renderWithProviders(
        <>
          <NotificationBell />
          <Where />
        </>,
      )
      fireEvent.click(await screen.findByTestId('notify-bell'))
      const rows = await screen.findAllByTestId('notify-item')
      const row = rows.find((r) => r.textContent?.includes(n.text))
      expect(row, name).toBeDefined()
      fireEvent.click(row as HTMLElement)
      await waitFor(() => {
        expect(screen.getByTestId('where').textContent).toBe(n.href)
      })
      expect(state.read).toEqual([[n.id]])
    })

  it('设置 → 通知多一行「告警」，两列开关', async () => {
    renderWithProviders(<NotificationPrefsCard />)
    const row = await screen.findByTestId('notify-pref-alert')
    expect(row.textContent).toContain('告警')
    expect(screen.getByTestId('notify-pref-alert-inbox').getAttribute('aria-checked')).toBe('true')
    expect(screen.getByTestId('notify-pref-alert-system').getAttribute('aria-checked')).toBe('true')
  })
})
