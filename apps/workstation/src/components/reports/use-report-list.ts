/**
 * WP438：这一层（岗位 / 职责）固定的报表——看板「报表」卡、卡头摘要、「全部报表」共用一份请求。
 * 岗位层 = 这个岗位全部固定的；职责层 = 固定在这条职责上的（决策 1334：职责层只放和它有关的那一两份）。
 */
import { useQuery } from '@tanstack/react-query'
import type { RailScope } from '@/components/rail/rail-scope'
import { listReports, REPORTS_QUERY, type ReportList } from '@/lib/reports-api'

export interface ReportScope {
  position: string
  duty?: string
  assignment?: string
}

export function reportScopeOf(scope: RailScope | undefined): ReportScope | undefined {
  if (scope === undefined) return undefined
  if (scope.tier === 'position')
    return {
      position: scope.scope_id,
      ...(scope.assignment === undefined ? {} : { assignment: scope.assignment }),
    }
  const parent = scope.parent?.scope_id
  if (parent === undefined) return undefined
  return {
    position: parent,
    duty: scope.scope_id,
    ...(scope.assignment === undefined ? {} : { assignment: scope.assignment }),
  }
}

export function useReportList(
  scope: RailScope | undefined,
  enabled = true,
): { list: ReportList | undefined; ready: boolean; where: ReportScope | undefined } {
  const where = reportScopeOf(scope)
  const q = useQuery({
    queryKey: [...REPORTS_QUERY, 'list', where?.position ?? '', where?.duty ?? ''],
    queryFn: () => listReports(where as ReportScope),
    enabled: enabled && where !== undefined,
    retry: false,
    staleTime: 60_000,
  })
  return { list: q.data, ready: !q.isPending || where === undefined, where }
}
