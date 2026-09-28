/**
 * WP181：右栏「定时任务」（官方「自动化任务」的任务页借形）。
 *
 * - 列模型用官方工具建的那几条：名字 + 频率人话 + 下一次；等批的标「等你批」；
 * - 在事项页上，这件事的排前面；
 * - 点开是「重复 + 时间 + 周几」，改了才出保存条，保存提交的是官方工具的参数形状；
 * - 删之前要确认；没有任务时一句话，没装插件时指去设置。
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScheduledTaskRow } from '@/lib/api'
import { renderWithProviders } from './helpers'

const daily: ScheduledTaskRow = {
  id: 'sched_auto_1',
  title: '看昨天的订单',
  handler: 'automation.reminder',
  created_by: 'agent',
  trigger: {
    kind: 'rule',
    rule: { kind: 'daily', time: '09:00:00.000', timeZone: 'Asia/Shanghai' },
  },
  state: 'active',
  fire_count: 0,
  next_fire_at: '2026-09-30T01:00:00.000Z',
  origin: { conversation_id: 'mat_2' },
  params: { official: { prompt: '提醒我看昨天的订单' } },
}
const weekly: ScheduledTaskRow = {
  ...daily,
  id: 'sched_auto_2',
  title: '周报发给老板',
  trigger: {
    kind: 'rule',
    rule: { kind: 'weekly', time: '10:30:00.000', timeZone: 'Asia/Shanghai', weekdays: [1, 3] },
  },
  state: 'paused',
  origin: { conversation_id: 'mat_1' },
  params: { awaiting_approval: true },
}
const system: ScheduledTaskRow = {
  id: 'sched_seo_daily',
  title: '每天早上读一遍 Search Console',
  handler: 'seo.daily_read',
  trigger: { kind: 'cron', expr: '0 8 * * *', tz: '+08:00' },
  state: 'active',
  fire_count: 0,
}

const state: { rows: ScheduledTaskRow[]; installed: boolean } = { rows: [], installed: true }
const patched: { id: string; rule: Record<string, unknown> }[] = []
const deleted: string[] = []

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getMySchedules: async () => state.rows,
    getOfficialPlugins: async () => ({
      plugins: [
        {
          name: '@deepseek-ai/dsh-experimental-schedule-bundle',
          state: state.installed ? 'installed' : 'available',
        },
      ],
    }),
    patchScheduleRule: async (id: string, rule: Record<string, unknown>) => {
      patched.push({ id, rule })
      return daily
    },
    deleteSchedule: async (id: string) => {
      deleted.push(id)
      return daily
    },
    toggleSchedule: async () => daily,
  }
})

const { SchedulesPanel } = await import('@/components/rail/panels/schedules-panel')

beforeEach(() => {
  patched.length = 0
  deleted.length = 0
  state.installed = true
  state.rows = [daily, weekly, system]
})

describe('右栏：定时任务', () => {
  it('只列官方工具建的；频率说人话；等批的标出来；这件事的排前面', async () => {
    renderWithProviders(<SchedulesPanel tier="position" pathname="/matters/mat_1" />)
    const rows = await screen.findAllByTestId('rail-schedule-row')
    expect(rows).toHaveLength(2)
    expect(rows[0]?.textContent).toContain('周报发给老板')
    expect(rows[0]?.getAttribute('data-state')).toBe('awaiting')
    expect(rows[0]?.textContent).toContain('等你批')
    expect(rows[1]?.textContent).toContain('每天 09:00')
    expect(screen.queryByText('每天早上读一遍 Search Console')).toBeNull()
    expect(screen.getByText('这件事的')).toBeDefined()
  })

  it('点开改成工作日 10:00：改了才出保存条，提交官方参数形状（时区照旧）', async () => {
    const user = userEvent.setup()
    state.rows = [daily]
    renderWithProviders(<SchedulesPanel tier="position" pathname="/" />)
    await user.click(await screen.findByText('看昨天的订单'))
    expect(screen.queryByTestId('rail-schedule-savebar')).toBeNull()
    await user.click(screen.getByTestId('rail-schedule-repeat-workdays'))
    fireEvent.change(screen.getByTestId('rail-schedule-time'), { target: { value: '10:00' } })
    await user.click(
      within(screen.getByTestId('rail-schedule-savebar')).getByTestId('rail-schedule-save'),
    )
    await waitFor(() => {
      expect(patched).toEqual([
        {
          id: 'sched_auto_1',
          rule: {
            weekly: { time: '10:00:00', weekdays: [1, 2, 3, 4, 5], time_zone: 'Asia/Shanghai' },
          },
        },
      ])
    })
  })

  it('删之前要确认', async () => {
    const user = userEvent.setup()
    state.rows = [daily]
    renderWithProviders(<SchedulesPanel tier="position" pathname="/" />)
    await user.click(await screen.findByText('看昨天的订单'))
    await user.click(screen.getByLabelText('删除'))
    expect(deleted).toEqual([])
    await user.click(screen.getByTestId('rail-schedule-delete-confirm'))
    await waitFor(() => {
      expect(deleted).toEqual(['sched_auto_1'])
    })
  })

  it('没有任务：一句话；没装插件就指去设置', async () => {
    state.rows = [system]
    state.installed = false
    renderWithProviders(<SchedulesPanel tier="position" pathname="/" />)
    const empty = await screen.findByTestId('rail-schedules-empty')
    await waitFor(() => {
      expect(empty.textContent).toContain('官方插件')
    })
  })
})
