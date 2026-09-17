/**
 * WP74：职责页上那块内容日历**是同一个日历的嵌入**，不是第二份实现。
 *
 * 钉四条：
 *
 * 1. 画出来的是 `unified-calendar`（WP73 那份自己画的七列格子已经删了）；
 * 2. 只向服务端要 `social_post` 这一层（职责页不需要别人的会议与卡片到期）；
 * 3. **只看这条渠道**（56 §2：一条职责只管它自己那条渠道）；
 * 4. 撞车说明是服务端算的（`CalendarItem.notes`），点开那一条就看得到。
 */
import type { CalendarItem } from '@agentsws/contracts'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWithProviders } from './helpers'

const T0 = '2026-09-15T09:00:00.000Z'

const post = (over: Partial<CalendarItem> & { id: string }): CalendarItem => ({
  source: 'social_post',
  title: '新品预告',
  start: '2026-09-15T02:00:00.000Z',
  end: '2026-09-15T02:30:00.000Z',
  all_day: false,
  ref: { type: 'social_post', id: over.id.replace('cal_social_', '') },
  drag: 'reschedule',
  channel: 'discord',
  status: 'scheduled',
  ...over,
})

const items: CalendarItem[] = [
  post({ id: 'cal_social_sp_mine', notes: ['这个号 90 分钟内已经有一条了。'] }),
  // 另一条渠道的那一条：同一份数据里有，但这一块不该画它
  post({ id: 'cal_social_sp_other', channel: 'meta', title: 'Meta 那条' }),
]

// 带上真实签名：这一档要看第三个参数（图层）是什么
const getCalendar = vi.fn(async (_from: string, _to: string, _sources?: string) => ({
  items,
  from: T0,
  to: '2026-09-22T00:00:00.000Z',
}))
const getSocialAccounts = vi.fn(async () => ({
  rows: [{ id: 'sa_1', channel: 'discord', handle: 'desk', display_name: '桌面党' }],
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getCalendar: (...a: Parameters<typeof getCalendar>) => getCalendar(...a),
    getSocialAccounts: (...a: unknown[]) => getSocialAccounts(...(a as [])),
  }
})

const { SocialCalendar, socialChannelOfRole } = await import('@/components/social/social-calendar')

beforeEach(() => {
  getCalendar.mockClear()
  getSocialAccounts.mockClear()
})

describe('职责页的社媒周视图 = 统一日历的嵌入（WP74）', () => {
  it('职责 id → 渠道（`social.facebook-group` → `facebook_group`）', () => {
    expect(socialChannelOfRole('social.facebook-group')).toBe('facebook_group')
    expect(socialChannelOfRole('dtc.store')).toBeUndefined()
    expect(socialChannelOfRole(undefined)).toBeUndefined()
  })

  it('画的是同一个日历，且只向服务端要 social_post 这一层', async () => {
    renderWithProviders(<SocialCalendar assignment="asg_1" channel="discord" />)
    const card = await screen.findByTestId('social-calendar')
    expect(await screen.findByTestId('unified-calendar')).toBeDefined()
    // WP73 那份自己画的格子已经没有了
    expect(card.querySelectorAll('[data-testid="social-calendar-day"]')).toHaveLength(0)
    await waitFor(() => {
      expect(getCalendar).toHaveBeenCalled()
    })
    expect(getCalendar.mock.calls[0]?.[2]).toBe('social_post')
  })

  it('只看这条渠道：别的渠道那一条不画（56 §2）', async () => {
    renderWithProviders(<SocialCalendar assignment="asg_1" channel="discord" />)
    const host = await screen.findByTestId('calendar-host')
    await waitFor(() => {
      expect(host.querySelector('[data-event-id="cal_social_sp_mine"]')).not.toBeNull()
    })
    expect(host.querySelector('[data-event-id="cal_social_sp_other"]')).toBeNull()
  })

  it('撞车说明是服务端算的，点开那一条就看得到', async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 })
    renderWithProviders(<SocialCalendar assignment="asg_1" channel="discord" />)
    const host = await screen.findByTestId('calendar-host')
    const event = await waitFor(() => {
      const node = host.querySelector('[data-event-id="cal_social_sp_mine"]')
      if (node === null) throw new Error('那一条还没画出来')
      return node as HTMLElement
    })
    await user.click(event)
    const detail = await screen.findByTestId('calendar-event-card')
    expect(detail.getAttribute('data-source')).toBe('social_post')
    expect(detail.textContent).toContain('90 分钟内已经有一条了')
  })
})
