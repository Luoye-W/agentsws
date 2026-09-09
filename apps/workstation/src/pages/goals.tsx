/**
 * 目标（37 §2.3）：三级目标树（公司 → 岗位 → 个人）+ 进度。
 *
 * 指标复用 29 的命名查询，**数字全在服务端算**——这一页只画树、条、天数。
 */
import type { Goal, GoalProgress } from '@agentsws/contracts'
import { useQuery } from '@tanstack/react-query'
import { Skeleton } from '@/components/ui/skeleton'
import { listGoals } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { daysLeftLabel } from '@/lib/work'

interface Node {
  goal: Goal
  progress: GoalProgress | undefined
  children: Node[]
}

/** 目标树；父不在结果里的（无权 / 已归档）自己当根，不丢。 */
export function buildTree(goals: readonly Goal[], progress: readonly GoalProgress[]): Node[] {
  const byId = new Map(progress.map((p) => [p.goal_id, p]))
  const nodes = new Map<string, Node>(
    goals.map((g) => [g.id, { goal: g, progress: byId.get(g.id), children: [] }]),
  )
  const roots: Node[] = []
  for (const node of nodes.values()) {
    const parent = node.goal.parent_id === undefined ? undefined : nodes.get(node.goal.parent_id)
    if (parent === undefined) roots.push(node)
    else parent.children.push(node)
  }
  return roots
}

function GoalNodeView({ node, depth }: { node: Node; depth: number }): React.ReactNode {
  const { t } = useApp()
  const p = node.progress
  const pct = p?.progress_pct ?? 0
  return (
    <li data-testid="goal-node" data-depth={depth} data-goal={node.goal.id}>
      <div className="rounded-lg border p-3">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-sm font-medium">{node.goal.title}</span>
          <span className="shrink-0 text-[11px] text-muted-foreground">
            {t(`goals.level.${node.goal.level}`)}
          </span>
        </div>
        <div className="mt-1 flex flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground">
          <span className="text-xl font-semibold tabular-nums text-foreground">
            {p?.value === undefined ? '—' : p.value.toLocaleString()}
          </span>
          <span>
            / {node.goal.target.toLocaleString()} · {t('goal.progress')} {pct}%
          </span>
          <span>{p === undefined ? t('goal.no_data') : daysLeftLabel(p.days_left, t)}</span>
          {p?.status === 'behind' ? (
            <span className="rounded border border-destructive/30 bg-destructive/10 px-1.5 py-0.5 text-destructive">
              {t('goal.behind')}
            </span>
          ) : null}
        </div>
        <div className="mt-2 h-1.5 w-full rounded-full bg-muted" aria-hidden>
          <div
            className={
              p?.status === 'behind'
                ? 'h-1.5 rounded-full bg-destructive/60'
                : 'h-1.5 rounded-full bg-primary/70'
            }
            style={{ width: `${Math.min(100, pct)}%` }}
          />
        </div>
      </div>
      {node.children.length === 0 ? null : (
        <ul className="mt-2 flex flex-col gap-2 border-l pl-4">
          {node.children.map((child) => (
            <GoalNodeView key={child.goal.id} node={child} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  )
}

export function GoalsPage(): React.ReactNode {
  const { t } = useApp()
  const goals = useQuery({ queryKey: ['goals'], queryFn: listGoals })

  if (goals.isPending) return <Skeleton className="h-64 w-full" />
  if (goals.error !== null)
    return (
      <p role="alert" className="text-sm text-destructive">
        {t('error.generic')}：{goals.error.message}
      </p>
    )

  const tree = buildTree(goals.data.goals, goals.data.progress)

  return (
    <div className="flex max-w-3xl flex-col gap-4" data-testid="goals-page">
      <h1 className="text-base font-semibold">{t('goals.title')}</h1>
      {tree.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('goals.empty')}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {tree.map((node) => (
            <GoalNodeView key={node.goal.id} node={node} depth={0} />
          ))}
        </ul>
      )}
    </div>
  )
}
