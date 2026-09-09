/**
 * `WorkStore` 的内存档。接口与 {@link SqliteWorkStore} 逐字一致——
 * 同一份契约一致性套件对两档各跑一遍（照 `TxnStore` 的做法）。
 *
 * 存的是深拷贝：调用方拿到的对象改不动内部状态。
 */
import type {
  DailyPlan,
  DailyPlanId,
  Goal,
  GoalFilter,
  GoalId,
  Iso8601,
  Matter,
  MatterEvent,
  MatterFilter,
  MatterId,
  PersonId,
  Review,
  ReviewId,
  ReviewPeriodKind,
  Todo,
  TodoFilter,
  TodoId,
  WorkStore,
  WorkspaceId,
} from '@agentsws/contracts'
import { clone, ms } from './util.js'

/** 两档共用的筛选判定，保证行为逐字一致。 */
export function matchMatter(m: Matter, f: MatterFilter): boolean {
  if (m.workspace_id !== f.workspace_id) return false
  if (f.position_id !== undefined && m.position_id !== f.position_id) return false
  if (f.kind !== undefined && m.kind !== f.kind) return false
  if (f.status !== undefined && !f.status.includes(m.status)) return false
  if (f.goal_id !== undefined && m.goal_id !== f.goal_id) return false
  if (f.participant !== undefined && !m.context.participants.includes(f.participant)) return false
  return true
}

export function matchGoal(g: Goal, f: GoalFilter): boolean {
  if (g.workspace_id !== f.workspace_id) return false
  if (f.level !== undefined && g.level !== f.level) return false
  if (f.position_id !== undefined && g.position_id !== f.position_id) return false
  if (f.owner !== undefined && g.owner !== f.owner) return false
  if (f.parent_id !== undefined && g.parent_id !== f.parent_id) return false
  if (f.status !== undefined && !f.status.includes(g.status)) return false
  return true
}

export function matchTodo(t: Todo, f: TodoFilter): boolean {
  if (t.workspace_id !== f.workspace_id) return false
  if (f.owner !== undefined && t.owner !== f.owner) return false
  if (f.position_id !== undefined && t.position_id !== f.position_id) return false
  if (f.matter_id !== undefined && t.matter_id !== f.matter_id) return false
  if (f.goal_id !== undefined && t.goal_id !== f.goal_id) return false
  if (f.parent_id !== undefined && t.parent_id !== f.parent_id) return false
  if (f.horizon !== undefined && !f.horizon.includes(t.horizon)) return false
  if (f.status !== undefined && !f.status.includes(t.status)) return false
  if (f.scheduled_only === true && t.scheduled === undefined) return false
  if (f.from !== undefined || f.to !== undefined) {
    const at = t.scheduled?.start ?? t.due
    if (at === undefined) return false
    const point = ms(at)
    if (f.from !== undefined && point < ms(f.from)) return false
    if (f.to !== undefined && point >= ms(f.to)) return false
  }
  return true
}

/** 事项按最近活动倒序；目标 / 待办按创建时间正序——两档必须同一条规则。 */
const byLastActivityDesc = (a: Matter, b: Matter): number =>
  ms(b.context.last_activity) - ms(a.context.last_activity) || (a.id < b.id ? 1 : -1)

const byCreatedAsc = (a: { created_at: Iso8601; id: string }, b: typeof a): number =>
  ms(a.created_at) - ms(b.created_at) || (a.id < b.id ? -1 : 1)

/**
 * 时间线只按时间排；同一时刻按**写入顺序**（Array.sort 稳定，SQLite 用 rowid）——
 * 时间线是 append-only 的，同一刻发生的两件事该保持先后，不该按 id 字典序乱掉。
 */
const byEventAtAsc = (a: MatterEvent, b: MatterEvent): number => ms(a.at) - ms(b.at)

export class MemoryWorkStore implements WorkStore {
  private matters = new Map<MatterId, Matter>()
  private events = new Map<MatterId, MatterEvent[]>()
  private goals = new Map<GoalId, Goal>()
  private todos = new Map<TodoId, Todo>()
  private plans = new Map<DailyPlanId, DailyPlan>()
  private reviews = new Map<ReviewId, Review>()

  // ── 事项
  putMatter(matter: Matter): void {
    this.matters.set(matter.id, clone(matter))
  }
  getMatter(id: MatterId): Matter | undefined {
    const m = this.matters.get(id)
    return m === undefined ? undefined : clone(m)
  }
  listMatters(filter: MatterFilter): Matter[] {
    const out = [...this.matters.values()].filter((m) => matchMatter(m, filter))
    out.sort(byLastActivityDesc)
    return (filter.limit === undefined ? out : out.slice(0, filter.limit)).map(clone)
  }
  appendMatterEvent(event: MatterEvent): void {
    const list = this.events.get(event.matter_id) ?? []
    list.push(clone(event))
    this.events.set(event.matter_id, list)
  }
  listMatterEvents(
    matter_id: MatterId,
    options: { limit?: number; before?: Iso8601 } = {},
  ): MatterEvent[] {
    const all = [...(this.events.get(matter_id) ?? [])].sort(byEventAtAsc)
    const filtered =
      options.before === undefined
        ? all
        : all.filter((e) => ms(e.at) < ms(options.before as string))
    const limit = options.limit
    return (
      limit === undefined ? filtered : filtered.slice(Math.max(0, filtered.length - limit))
    ).map(clone)
  }
  countMatterEvents(matter_id: MatterId): number {
    return this.events.get(matter_id)?.length ?? 0
  }

  // ── 目标
  putGoal(goal: Goal): void {
    this.goals.set(goal.id, clone(goal))
  }
  getGoal(id: GoalId): Goal | undefined {
    const g = this.goals.get(id)
    return g === undefined ? undefined : clone(g)
  }
  listGoals(filter: GoalFilter): Goal[] {
    const out = [...this.goals.values()].filter((g) => matchGoal(g, filter))
    out.sort(byCreatedAsc)
    return out.map(clone)
  }

  // ── 待办
  putTodo(todo: Todo): void {
    this.todos.set(todo.id, clone(todo))
  }
  getTodo(id: TodoId): Todo | undefined {
    const t = this.todos.get(id)
    return t === undefined ? undefined : clone(t)
  }
  listTodos(filter: TodoFilter): Todo[] {
    const out = [...this.todos.values()].filter((t) => matchTodo(t, filter))
    out.sort(byCreatedAsc)
    return (filter.limit === undefined ? out : out.slice(0, filter.limit)).map(clone)
  }

  // ── 计划与复盘
  putPlan(plan: DailyPlan): void {
    this.plans.set(plan.id, clone(plan))
  }
  getPlan(id: DailyPlanId): DailyPlan | undefined {
    const p = this.plans.get(id)
    return p === undefined ? undefined : clone(p)
  }
  findPlan(workspace_id: WorkspaceId, person_id: PersonId, date: string): DailyPlan | undefined {
    for (const p of this.plans.values()) {
      if (p.workspace_id === workspace_id && p.person_id === person_id && p.date === date)
        return clone(p)
    }
    return undefined
  }
  putReview(review: Review): void {
    this.reviews.set(review.id, clone(review))
  }
  getReview(id: ReviewId): Review | undefined {
    const r = this.reviews.get(id)
    return r === undefined ? undefined : clone(r)
  }
  listReviews(filter: {
    workspace_id: WorkspaceId
    person_id?: PersonId
    kind?: ReviewPeriodKind
    limit?: number
  }): Review[] {
    const out = [...this.reviews.values()].filter((r) => {
      if (r.workspace_id !== filter.workspace_id) return false
      if (filter.person_id !== undefined && r.person_id !== filter.person_id) return false
      if (filter.kind !== undefined && r.period.kind !== filter.kind) return false
      return true
    })
    // 复盘按时间倒序：最新的在前
    out.sort((a, b) => ms(b.created_at) - ms(a.created_at) || (a.id < b.id ? 1 : -1))
    return (filter.limit === undefined ? out : out.slice(0, filter.limit)).map(clone)
  }
}
