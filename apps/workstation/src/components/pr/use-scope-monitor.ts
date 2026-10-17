/**
 * WP386：右栏这一层里有没有「信息监控」——有就给它的监控源状态（连接卡的红点、计划卡那一行读它）。
 * 职责层就是那条职责；岗位层在这个岗位里找本人担的那条。
 */
import { useQuery } from '@tanstack/react-query'
import type { RailScope } from '@/components/rail/rail-scope'
import { getPositions } from '@/lib/api'
import {
  getPrWatch,
  monitorAssignmentOf,
  PR_MONITORING_ROLE,
  PR_WATCH_KEY,
  type PrWatchView,
} from '@/lib/pr-watch-api'

export function useScopeMonitor(
  scope: RailScope | undefined,
): { assignment: string; view?: PrWatchView } | undefined {
  const positions = useQuery({
    queryKey: ['positions'],
    queryFn: getPositions,
    staleTime: 60_000,
    enabled: scope?.tier === 'position',
  })
  const assignment =
    scope === undefined
      ? undefined
      : scope.tier === 'role'
        ? scope.scope_id === PR_MONITORING_ROLE
          ? scope.assignment
          : undefined
        : monitorAssignmentOf(positions.data?.instances, scope.scope_id)
  const q = useQuery({
    queryKey: [...PR_WATCH_KEY, assignment ?? ''],
    queryFn: () => getPrWatch(assignment as string),
    enabled: assignment !== undefined,
    retry: false,
    staleTime: 30_000,
  })
  if (assignment === undefined) return undefined
  return { assignment, ...(q.data === undefined ? {} : { view: q.data }) }
}
