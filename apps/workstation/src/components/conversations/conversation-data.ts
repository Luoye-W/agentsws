/**
 * WP372（决策 1001 / 1004）：右侧面板「对话」——取数与分组。
 *
 * 对话就是左栏原来挂在职责下面的那一串事项（`/v1/work/rail`，WP207）。左栏只剩岗位与职责之后，
 * 这一串搬到右侧面板：职责层列这条职责的、岗位层按职责分组列全部。
 *
 * 和左栏原来**同一个查询键**（`RAIL_KEY`）：事项 / 卡片 / 运行的事件一来照样重取（`lib/realtime.ts`）。
 */
import { useQuery } from '@tanstack/react-query'
import type { RailScope } from '@/components/rail/rail-scope'
import { getPositions } from '@/lib/api'
import { getWorkRail, RAIL_KEY, type RailDuty, type RailMatter } from '@/lib/work-archive'

/** 一次向服务端要几条（与左栏原来那一份同一个数，缓存共用）。 */
export const CONV_FETCH = 20

export interface ConvDuty extends RailDuty {
  /** 职责名（岗位层按职责分组时的小标题）。 */
  name: string
  /** 本人在这条职责上的分配（开新对话用）。 */
  assignment?: string
}

/** 这一层的对话：职责层一组（那条职责），岗位层按职责分组（顺序 = 岗位里职责的顺序）。 */
export function useScopeConversations(scope: RailScope | undefined): {
  duties: ConvDuty[]
  ready: boolean
} {
  const rail = useQuery({
    queryKey: RAIL_KEY,
    queryFn: () => getWorkRail(CONV_FETCH),
    enabled: scope !== undefined,
    retry: false,
    staleTime: 30_000,
    refetchInterval: 60_000,
  })
  // 职责名在岗位那一份里（外壳早就取过，这里只读缓存）
  const positions = useQuery({
    queryKey: ['positions'],
    queryFn: getPositions,
    enabled: scope !== undefined,
    staleTime: 60_000,
  })
  if (scope === undefined) return { duties: [], ready: true }
  const position_id = scope.tier === 'role' ? scope.parent?.scope_id : scope.scope_id
  const instance = positions.data?.instances?.find((p) => p.position_id === position_id)
  const fromRail = rail.data?.positions.find((p) => p.position_id === position_id)?.duties ?? []
  const held = (instance?.roles ?? []).filter((r) => r.my_assignment_id !== undefined)
  // 有岗位那一份就按它的职责顺序；没有（老服务进程）就按服务端给的顺序
  const ordered: ConvDuty[] =
    held.length > 0
      ? held.map((r) => {
          const d = fromRail.find((x) => x.role_id === r.role_id)
          return {
            role_id: r.role_id,
            matters: d?.matters ?? [],
            more: d?.more ?? 0,
            archived: d?.archived ?? 0,
            name: r.role_name,
            ...(r.my_assignment_id === undefined ? {} : { assignment: r.my_assignment_id }),
          }
        })
      : fromRail.map((d) => ({ ...d, name: d.role_id }))
  const duties = scope.tier === 'role' ? ordered.filter((d) => d.role_id === scope.scope_id) : ordered
  return { duties, ready: !rail.isPending }
}

/** 要你处理的排最上面（等你看 → 在做 → 其余），同一档按最近活动。 */
export function byAttention(a: RailMatter, b: RailMatter): number {
  const rank = (m: RailMatter): number =>
    m.state === 'awaiting' || m.state === 'ready' ? 0 : m.state === 'running' ? 1 : 2
  const d = rank(a) - rank(b)
  return d !== 0 ? d : b.last_activity.localeCompare(a.last_activity)
}

export type TimeGroup = 'today' | 'week' | 'earlier'

/** 本周从周一算（本地时间）。 */
function startOfWeek(now: Date): Date {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const back = (d.getDay() + 6) % 7
  d.setDate(d.getDate() - back)
  return d
}

/** 按「今天 / 本周 / 更早」分组（组内按最近活动，空组不出）。 */
export function groupByTime(
  matters: readonly RailMatter[],
  now: Date = new Date(),
): { group: TimeGroup; matters: RailMatter[] }[] {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const week = startOfWeek(now).getTime()
  const of = (m: RailMatter): TimeGroup => {
    const at = Date.parse(m.last_activity)
    if (Number.isNaN(at)) return 'earlier'
    if (at >= today) return 'today'
    if (at >= week) return 'week'
    return 'earlier'
  }
  const sorted = [...matters].sort((a, b) => b.last_activity.localeCompare(a.last_activity))
  return (['today', 'week', 'earlier'] as const)
    .map((group) => ({ group, matters: sorted.filter((m) => of(m) === group) }))
    .filter((g) => g.matters.length > 0)
}

/** 标题里有没有这几个字（不分大小写；空查询 = 全要）。 */
export function matchesQuery(m: RailMatter, q: string): boolean {
  const needle = q.trim().toLowerCase()
  return needle === '' || m.title.toLowerCase().includes(needle)
}
