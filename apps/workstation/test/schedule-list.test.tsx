/**
 * 25 §3「人看得见管得了」的界面用例：岗位页「记录」Tab 下的定时任务列表。
 * 只测两件事——**看得见**（标题 / 触发器 / 下次什么时候）与**管得了**（暂停 / 恢复）。
 */
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScheduledTaskRow } from '@/lib/api'
import { renderWithProviders } from './helpers'

const rows: ScheduledTaskRow[] = [
  {
    id: 'sched_daily_plan_asg_1',
    title: '每天早上拟一版今天的安排',
    handler: 'work.daily_plan',
    trigger: { kind: 'cron', expr: '0 8 * * *', tz: '+08:00' },
    state: 'active',
    fire_count: 3,
    next_fire_at: '2026-09-11T00:00:00.000Z',
  },
  {
    id: 'sched_meetings_poll',
    title: '每 15 分钟看一眼会议记录来源',
    handler: 'meetings.poll',
    trigger: { kind: 'interval', every_ms: 900_000 },
    state: 'paused',
    fire_count: 0,
  },
]

const getSchedules = vi.fn(async () => rows)
const patchSchedule = vi.fn(async () => rows[0] as ScheduledTaskRow)

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getSchedules: (...a: unknown[]) => getSchedules(...(a as [])),
    patchSchedule: (...a: unknown[]) => patchSchedule(...(a as [])),
  }
})

const { ScheduleList, triggerText } = await import('@/components/schedule-list')

describe('定时任务列表（25 §3）', () => {
  beforeEach(() => {
    getSchedules.mockClear()
    patchSchedule.mockClear()
  })

  it('看得见：标题、触发器、下次什么时候、跑过几次', async () => {
    renderWithProviders(<ScheduleList positionId="asg_1" />)
    const list = await screen.findByTestId('schedule-list')
    expect(list.textContent).toContain('定时任务')
    const items = screen.getAllByTestId('schedule-row')
    expect(items).toHaveLength(2)
    expect(items[0]?.textContent).toContain('每天早上拟一版今天的安排')
    expect(items[0]?.textContent).toContain('cron 0 8 * * *')
    expect(items[0]?.textContent).toContain('跑过 3 次')
    // 暂停的那条打上标记
    expect(items[1]?.getAttribute('data-state')).toBe('paused')
    expect(items[1]?.textContent).toContain('已暂停')
    expect(items[1]?.textContent).toContain('每 15 分钟')
    // 只经 /v1，且带的是这个岗位
    expect(getSchedules).toHaveBeenCalledWith('asg_1')
  })

  it('管得了：点暂停发 PATCH action=pause，点恢复发 resume', async () => {
    const user = userEvent.setup()
    renderWithProviders(<ScheduleList positionId="asg_1" />)
    await screen.findByTestId('schedule-list')
    await user.click(screen.getByRole('button', { name: '暂停' }))
    await waitFor(() => {
      expect(patchSchedule).toHaveBeenCalledWith(
        'sched_daily_plan_asg_1',
        { action: 'pause' },
        'asg_1',
      )
    })
    await user.click(screen.getByRole('button', { name: '恢复' }))
    await waitFor(() => {
      expect(patchSchedule).toHaveBeenCalledWith(
        'sched_meetings_poll',
        { action: 'resume' },
        'asg_1',
      )
    })
  })

  it('一条都没有时给一句话，不出空表格', async () => {
    getSchedules.mockResolvedValueOnce([])
    renderWithProviders(<ScheduleList positionId="asg_1" />)
    const list = await screen.findByTestId('schedule-list')
    expect(list.textContent).toContain('这个岗位没有定时任务')
    expect(screen.queryAllByTestId('schedule-row')).toHaveLength(0)
  })

  it('triggerText：cron 原样给（不翻译成自然语言，会翻错）', () => {
    expect(triggerText({ kind: 'cron', expr: '0 6 * * 1', tz: 'Asia/Shanghai' })).toBe(
      'cron 0 6 * * 1（Asia/Shanghai）',
    )
    expect(triggerText({ kind: 'interval', every_ms: 3_600_000 })).toBe('每 60 分钟')
    expect(triggerText({ kind: 'once', at: '2026-09-11T00:00:00.000Z' })).toContain('一次：')
    expect(triggerText({ kind: 'after_event' })).toBe('after_event')
  })
})
