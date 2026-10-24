/**
 * WP450：「编辑日历」卡的**轻的那一半**（卡片列判出不出、卡头那个数、用哪条分配取数）——注册表启动时就读，
 * 不拉整个面板（`seo-plan-panel.tsx`）。
 */
import { useQuery } from '@tanstack/react-query'
import type { CardStatus, RailPanelBodyProps } from '@/components/rail/registry'
import { getSeoCalendar, SEO_CALENDAR_KEY, type SeoCalendarView } from '@/lib/seo-plan-api'

export const SEO_PLAN_PANEL = 'seo-plan'

/** 日历、外链体检、llms.txt 归这两条职责（SEO 与 GEO 出规划，内容与博客按日历写）。 */
const SEO_PLAN_ROLES = ['dtc.seo', 'dtc.content']

/** 这一页的岗位里有没有这两条职责之一（卡片列「编辑日历」卡只在这种岗位出）。 */
export function hasSeoPlanRole(props: Pick<RailPanelBodyProps, 'scope'>): boolean {
  return (props.scope?.roles ?? []).some((r) => SEO_PLAN_ROLES.includes(r.role_id))
}

/** 用哪条分配取数（SEO 与 GEO 那条优先，没有用内容与博客）。 */
export function seoPlanAssignment(props: Pick<RailPanelBodyProps, 'scope'>): string | undefined {
  const roles = props.scope?.roles ?? []
  return (
    roles.find((r) => r.role_id === 'dtc.seo')?.assignment ??
    roles.find((r) => r.role_id === 'dtc.content')?.assignment
  )
}

export function useSeoCalendar(assignment: string | undefined, enabled = true) {
  return useQuery({
    queryKey: [SEO_CALENDAR_KEY, assignment ?? ''],
    queryFn: () => getSeoCalendar(assignment),
    enabled: enabled && assignment !== undefined,
  })
}

/** 往后 7 天要写的篇数（今天起，还没发的）。 */
export function upcomingCount(view: SeoCalendarView | undefined): number {
  if (view === undefined) return 0
  const until = new Date(Date.parse(`${view.today}T00:00:00Z`) + 7 * 86_400_000)
    .toISOString()
    .slice(0, 10)
  return view.entries.filter(
    (e) =>
      e.status !== 'published' && e.status !== 'skipped' && e.date >= view.today && e.date < until,
  ).length
}

/** 卡头那个灰色计数（往后 7 天要写几篇）；有一组等批时亮一个点。 */
export function useSeoPlanStatus(
  props: RailPanelBodyProps,
  _detail: boolean,
): CardStatus | undefined {
  const cal = useSeoCalendar(seoPlanAssignment(props))
  if (cal.data === undefined) return undefined
  const pending = cal.data.pending?.length ?? 0
  return {
    count: upcomingCount(cal.data),
    ...(pending > 0 ? { dot: 'attention' as const } : {}),
  }
}
