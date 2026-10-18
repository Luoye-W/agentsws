/**
 * WP388：设置 → 通知「周报时间」——周复盘、SEO 周报每周几、几点出（和经营一页纸同一个选择）。
 * 默认周一 16:30 出上周；改了就改本人在这个品牌里的那几条（时区照旧）；一条都没有整张不出。
 */
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ScheduledTaskRow } from '@/lib/api'
import { renderWithProviders } from './helpers'

const row = (id: string, handler: string, params?: Record<string, unknown>): ScheduledTaskRow => ({
  id,
  handler,
  trigger: { kind: 'cron', expr: '30 16 * * 1', tz: 'Asia/Shanghai' },
  state: 'active',
  fire_count: 0,
  ...(params === undefined ? {} : { params }),
})

let rows: ScheduledTaskRow[] = []
const patched: { id: string; body: unknown }[] = []

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getMyWeeklyReportSchedules: async () => ({
      review_week: rows.filter((r) => r.handler === 'work.review' && r.params?.kind === 'week'),
      seo_weekly: rows.filter((r) => r.handler === 'seo.weekly_review'),
    }),
    setWeeklyCron: async (r: ScheduledTaskRow, input: { weekday: number; time: string }) => {
      const [hh, mm] = input.time.split(':').map(Number)
      const expr = `${mm} ${hh} * * ${input.weekday}`
      patched.push({ id: r.id, body: { expr, tz: r.trigger.tz } })
      rows = rows.map((x) => (x.id === r.id ? { ...x, trigger: { ...x.trigger, expr } } : x))
      return r
    },
  }
})

const { WeeklyReportsCard, weeklyOf } = await import('@/components/settings/weekly-reports-card')

describe('WP388 设置 → 周报时间', () => {
  it('两份都在：各一行，默认周一 16:30 出上周；周复盘改周五 → 两个岗位那两条都改、时区照旧', async () => {
    rows = [
      row('sched_review_week_asg_1', 'work.review', { kind: 'week' }),
      row('sched_review_week_asg_2', 'work.review', { kind: 'week' }),
      row('sched_review_day_asg_1', 'work.review', { kind: 'day' }),
      row('sched_seo_weekly', 'seo.weekly_review'),
    ]
    renderWithProviders(<WeeklyReportsCard assignment="asg_1" />)
    const day = (await screen.findByTestId(
      'settings-weekly-review_week-weekday',
    )) as HTMLSelectElement
    expect(day.value).toBe('1')
    expect((screen.getByTestId('settings-weekly-seo_weekly-time') as HTMLInputElement).value).toBe(
      '16:30',
    )
    expect(screen.getByTestId('settings-weekly-review_week-covers').textContent).toBe('出上周')
    fireEvent.change(day, { target: { value: '5' } })
    await waitFor(() => {
      expect(patched.map((p) => p.id)).toEqual([
        'sched_review_week_asg_1',
        'sched_review_week_asg_2',
      ])
    })
    expect(patched[0]?.body).toEqual({ expr: '30 16 * * 5', tz: 'Asia/Shanghai' })
  })

  it('一条都没有：整张不出；不是简单周定时的那一份不出', async () => {
    rows = []
    const { container } = renderWithProviders(<WeeklyReportsCard assignment="asg_1" />)
    await waitFor(() => {
      expect(container.querySelector('[data-testid="settings-weekly-reports"]')).toBeNull()
    })
    expect(
      weeklyOf({ ...row('x', 'seo.weekly_review'), trigger: { kind: 'cron', expr: '0 8 * * *' } }),
    ).toBeUndefined()
    expect(weeklyOf(row('x', 'seo.weekly_review'))).toEqual({ weekday: 1, time: '16:30' })
  })
})
