/**
 * WP208（Luoye 09-30）：「定时任务」图标上的那个数。
 *
 * Luoye：「我设置了某个岗位 / 职责的三个定时任务，定时图标应该有个『3』。」
 *
 * - **数的是"在跑的"**：`active` / `running`；暂停的、等人点头的（`awaiting_approval`）不算；
 * - **范围跟着右栏**：职责层看这一条职责，岗位层看整个岗位（本人在这个岗位下的每一条分配）；
 * - **0 不显示**；悬停说「3 个定时任务在跑」。
 *
 * 面板（`panels/schedules-panel.tsx`）与徽标读同一份缓存（`SCHEDULES_KEY`），
 * 所以面板里改了（暂停 / 删掉）徽标跟着变，不会一边说 3、一边列出 2 条。
 */
import { useQuery } from '@tanstack/react-query'
import type { RailScope } from '@/components/rail/rail-scope'
import type { PanelBadge, RailPanelBodyProps } from '@/components/rail/registry'
import { AUTOMATION_HANDLER, getMySchedules, type ScheduledTaskRow } from '@/lib/api'
import { useApp } from '@/lib/app-context'

export const SCHEDULES_KEY = ['schedules', 'mine'] as const

/** 面板列得出来的那几种状态（完成 / 失败 / 取消的不列）。 */
export const LIVE_STATES: ReadonlySet<string> = new Set(['active', 'paused', 'running', 'pending'])

/** 面板里列的那几条：模型用官方「自动化任务」建的、还活着的。 */
export function isListedSchedule(row: ScheduledTaskRow): boolean {
  return row.handler === AUTOMATION_HANDLER && LIVE_STATES.has(row.state)
}

/** 在跑：暂停的、等批的不算。 */
export function isRunningSchedule(row: ScheduledTaskRow): boolean {
  return (
    isListedSchedule(row) &&
    (row.state === 'active' || row.state === 'running') &&
    row.params?.awaiting_approval !== true
  )
}

/**
 * 这一条挂在当前这一层下面吗。
 *
 * 先按分配认（同一条职责可能出现在两个岗位里——`dtc.support` 在客服也在独立站运营——
 * 只按职责 id 数会把别的岗位的也数进来）；行上没有分配时职责层退回按职责 id 认。
 */
export function scheduleInScope(row: ScheduledTaskRow, scope: RailScope): boolean {
  const mine = scope.assignments ?? (scope.assignment === undefined ? [] : [scope.assignment])
  if (row.assignment_id !== undefined && mine.length > 0) return mine.includes(row.assignment_id)
  return scope.tier === 'role' && row.role_id === scope.scope_id
}

export function runningSchedulesIn(rows: readonly ScheduledTaskRow[], scope: RailScope): number {
  return rows.filter((r) => isRunningSchedule(r) && scheduleInScope(r, scope)).length
}

/** 注册表 `useBadge` 那一格。定位不到岗位时不发请求、不画数。 */
export function useSchedulesBadge({ scope }: RailPanelBodyProps): PanelBadge | undefined {
  const { t } = useApp()
  const list = useQuery({
    queryKey: SCHEDULES_KEY,
    queryFn: getMySchedules,
    enabled: scope !== undefined,
    retry: false,
  })
  if (scope === undefined || list.data === undefined) return undefined
  const count = runningSchedulesIn(list.data, scope)
  return count === 0 ? undefined : { count, label: t('rail.schedules.badge', { count }) }
}
