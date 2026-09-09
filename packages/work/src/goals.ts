/**
 * 目标进度（37 §2.3）：指标复用 29 的命名查询，所以首页数字块直接多一行
 * 「目标 / 进度 / 剩余天数」。
 *
 * 数字在服务端算，不经模型（29 原则 ③）：这里只做除法与日期减法，
 * 值从注入的 `QueryRunner` 里来——它就是 29 §2 那条「以本人身份在服务端执行命名查询」的管线。
 */
import type { Goal, GoalProgress, Iso8601 } from '@agentsws/contracts'
import { DAY_MS, ms, round2 } from './util.js'

/** 命名查询的执行器；查不到（数据源没连、无权）返回 undefined，进度就是 `no_data`。 */
export type QueryRunner = (goal: Goal) => { value: number; currency?: string } | undefined

/** 落后判据：进度比时间进度落后超过这么多百分点，就标 `behind`。 */
export const BEHIND_THRESHOLD_PCT = 10

/** 剩余天数：向上取整的「还剩几个整天」；已过期为负。 */
export function daysLeft(end: Iso8601, now: Iso8601): number {
  return Math.ceil((ms(end) - ms(now)) / DAY_MS)
}

/** 期间已过的比例 0–100（开始前是 0，结束后是 100）。 */
export function elapsedPct(period: Goal['period'], now: Iso8601): number {
  const start = ms(period.start)
  const end = ms(period.end)
  const span = end - start
  if (!(span > 0)) return 100
  const pct = ((ms(now) - start) / span) * 100
  return round2(Math.min(100, Math.max(0, pct)))
}

export function goalProgress(goal: Goal, run: QueryRunner, now: Iso8601): GoalProgress {
  const result = run(goal)
  const elapsed = elapsedPct(goal.period, now)
  const left = daysLeft(goal.period.end, now)
  const base: GoalProgress = {
    goal_id: goal.id,
    title: goal.title,
    level: goal.level,
    ...(goal.position_id === undefined ? {} : { position_id: goal.position_id }),
    format: goal.metric.format,
    target: goal.target,
    days_left: left,
    elapsed_pct: elapsed,
    status: 'no_data',
  }
  if (result === undefined) return base
  const progress =
    goal.target > 0 ? round2(Math.max(0, (result.value / goal.target) * 100)) : undefined
  return {
    ...base,
    ...(result.currency === undefined ? {} : { currency: result.currency }),
    value: result.value,
    ...(progress === undefined ? {} : { progress_pct: progress }),
    status:
      progress === undefined
        ? 'no_data'
        : progress + BEHIND_THRESHOLD_PCT < elapsed
          ? 'behind'
          : 'ok',
  }
}

export function goalProgressAll(
  goals: readonly Goal[],
  run: QueryRunner,
  now: Iso8601,
): GoalProgress[] {
  return goals.map((g) => goalProgress(g, run, now))
}

/** 三级目标树（公司 → 岗位 → 个人），给 `pages/goals.tsx` 直接渲染。 */
export interface GoalNode {
  goal: Goal
  progress: GoalProgress
  children: GoalNode[]
}

export function goalTree(goals: readonly Goal[], progress: readonly GoalProgress[]): GoalNode[] {
  const byId = new Map(progress.map((p) => [p.goal_id, p]))
  const nodes = new Map<string, GoalNode>()
  for (const g of goals) {
    const p = byId.get(g.id)
    if (p === undefined) continue
    nodes.set(g.id, { goal: g, progress: p, children: [] })
  }
  const roots: GoalNode[] = []
  for (const node of nodes.values()) {
    const parent = node.goal.parent_id === undefined ? undefined : nodes.get(node.goal.parent_id)
    if (parent === undefined) roots.push(node)
    else parent.children.push(node)
  }
  return roots
}
