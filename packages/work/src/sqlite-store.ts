/**
 * `WorkStore` 的 SQLite 档。接口与 {@link MemoryWorkStore} 逐字一致——
 * 同一份契约一致性套件对两档各跑一遍，两档之间的任何漂移都会在那里露出来。
 *
 * 纪律：
 * - 所有 SQL 参数化，没有一处字符串拼值
 * - `better-sqlite3` 同步 API —— `WorkStore` 全同步，天然对上
 * - 时间经注入的 Clock（只有迁移记时间；行里的时间戳都来自调用方写进 JSON 的字段）
 * - 只用自己这张库里的表，不共享其他包的表（35 §2）
 * - **筛选与排序复用内存档那几个纯函数**：SQL 只做粗过滤（workspace + 索引列），
 *   细判定与排序走同一份代码，两档不可能漂移
 */
import type {
  Clock,
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
import type { Database as Db } from 'better-sqlite3'
import Database from 'better-sqlite3'
import { migrate, schemaVersion, WORK_MIGRATIONS } from './migrations.js'
import { matchGoal, matchMatter, matchTodo } from './store.js'
import { ms } from './util.js'

export interface SqliteWorkStoreOptions {
  /** 缺省 `:memory:`（测试与一次性任务） */
  dbPath?: string
  clock?: Clock
}

interface JsonRow {
  json: string
}

const parse = <T>(row: JsonRow | undefined): T | undefined =>
  row === undefined ? undefined : (JSON.parse(row.json) as T)

const parseAll = <T>(rows: JsonRow[]): T[] => rows.map((r) => JSON.parse(r.json) as T)

/** SQLite 不认 undefined，可空列一律转 null。 */
const orNull = <T>(v: T | undefined): T | null => (v === undefined ? null : v)

export class SqliteWorkStore implements WorkStore {
  readonly db: Db
  private closed = false

  constructor(options: SqliteWorkStoreOptions = {}) {
    this.db = new Database(options.dbPath ?? ':memory:')
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    const at = options.clock?.now() ?? '1970-01-01T00:00:00.000Z'
    migrate(this.db, WORK_MIGRATIONS, at)
  }

  /** 已应用的最高迁移版本（诊断与测试用）。 */
  schemaVersion(): number {
    return schemaVersion(this.db)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.db.close()
  }

  // ── 事项
  putMatter(matter: Matter): void {
    this.db
      .prepare(
        `INSERT INTO matters (id, workspace_id, position_id, kind, status, goal_id, last_activity, json)
         VALUES (@id, @workspace_id, @position_id, @kind, @status, @goal_id, @last_activity, @json)
         ON CONFLICT(id) DO UPDATE SET
           workspace_id = excluded.workspace_id, position_id = excluded.position_id,
           kind = excluded.kind, status = excluded.status, goal_id = excluded.goal_id,
           last_activity = excluded.last_activity, json = excluded.json`,
      )
      .run({
        id: matter.id,
        workspace_id: matter.workspace_id,
        position_id: orNull(matter.position_id),
        kind: matter.kind,
        status: matter.status,
        goal_id: orNull(matter.goal_id),
        last_activity: ms(matter.context.last_activity),
        json: JSON.stringify(matter),
      })
  }

  getMatter(id: MatterId): Matter | undefined {
    return parse<Matter>(
      this.db.prepare<[string], JsonRow>('SELECT json FROM matters WHERE id = ?').get(id),
    )
  }

  listMatters(filter: MatterFilter): Matter[] {
    const rows = this.db
      .prepare<[string], JsonRow>(
        'SELECT json FROM matters WHERE workspace_id = ? ORDER BY last_activity DESC, id DESC',
      )
      .all(filter.workspace_id)
    const out = parseAll<Matter>(rows).filter((m) => matchMatter(m, filter))
    return filter.limit === undefined ? out : out.slice(0, filter.limit)
  }

  appendMatterEvent(event: MatterEvent): void {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO matter_events (id, matter_id, at_ms, json) VALUES (?, ?, ?, ?)',
      )
      .run(event.id, event.matter_id, ms(event.at), JSON.stringify(event))
  }

  listMatterEvents(
    matter_id: MatterId,
    options: { limit?: number; before?: Iso8601 } = {},
  ): MatterEvent[] {
    const before = options.before === undefined ? Number.POSITIVE_INFINITY : ms(options.before)
    const rows =
      options.before === undefined
        ? this.db
            .prepare<[string], JsonRow>(
              'SELECT json FROM matter_events WHERE matter_id = ? ORDER BY at_ms ASC, rowid ASC',
            )
            .all(matter_id)
        : this.db
            .prepare<[string, number], JsonRow>(
              'SELECT json FROM matter_events WHERE matter_id = ? AND at_ms < ? ORDER BY at_ms ASC, rowid ASC',
            )
            .all(matter_id, before)
    const all = parseAll<MatterEvent>(rows)
    const limit = options.limit
    return limit === undefined ? all : all.slice(Math.max(0, all.length - limit))
  }

  countMatterEvents(matter_id: MatterId): number {
    const row = this.db
      .prepare<[string], { n: number }>(
        'SELECT COUNT(*) AS n FROM matter_events WHERE matter_id = ?',
      )
      .get(matter_id)
    return row?.n ?? 0
  }

  // ── 目标
  putGoal(goal: Goal): void {
    this.db
      .prepare(
        `INSERT INTO goals (id, workspace_id, level, parent_id, position_id, owner, status, created_ms, json)
         VALUES (@id, @workspace_id, @level, @parent_id, @position_id, @owner, @status, @created_ms, @json)
         ON CONFLICT(id) DO UPDATE SET
           workspace_id = excluded.workspace_id, level = excluded.level, parent_id = excluded.parent_id,
           position_id = excluded.position_id, owner = excluded.owner, status = excluded.status,
           created_ms = excluded.created_ms, json = excluded.json`,
      )
      .run({
        id: goal.id,
        workspace_id: goal.workspace_id,
        level: goal.level,
        parent_id: orNull(goal.parent_id),
        position_id: orNull(goal.position_id),
        owner: goal.owner,
        status: goal.status,
        created_ms: ms(goal.created_at),
        json: JSON.stringify(goal),
      })
  }

  getGoal(id: GoalId): Goal | undefined {
    return parse<Goal>(
      this.db.prepare<[string], JsonRow>('SELECT json FROM goals WHERE id = ?').get(id),
    )
  }

  listGoals(filter: GoalFilter): Goal[] {
    const rows = this.db
      .prepare<[string], JsonRow>(
        'SELECT json FROM goals WHERE workspace_id = ? ORDER BY created_ms ASC, id ASC',
      )
      .all(filter.workspace_id)
    return parseAll<Goal>(rows).filter((g) => matchGoal(g, filter))
  }

  // ── 待办
  putTodo(todo: Todo): void {
    this.db
      .prepare(
        `INSERT INTO todos (id, workspace_id, owner, position_id, matter_id, goal_id, parent_id,
                            horizon, status, scheduled_ms, due_ms, created_ms, json)
         VALUES (@id, @workspace_id, @owner, @position_id, @matter_id, @goal_id, @parent_id,
                 @horizon, @status, @scheduled_ms, @due_ms, @created_ms, @json)
         ON CONFLICT(id) DO UPDATE SET
           workspace_id = excluded.workspace_id, owner = excluded.owner,
           position_id = excluded.position_id, matter_id = excluded.matter_id,
           goal_id = excluded.goal_id, parent_id = excluded.parent_id,
           horizon = excluded.horizon, status = excluded.status,
           scheduled_ms = excluded.scheduled_ms, due_ms = excluded.due_ms,
           created_ms = excluded.created_ms, json = excluded.json`,
      )
      .run({
        id: todo.id,
        workspace_id: todo.workspace_id,
        owner: todo.owner,
        position_id: orNull(todo.position_id),
        matter_id: orNull(todo.matter_id),
        goal_id: orNull(todo.goal_id),
        parent_id: orNull(todo.parent_id),
        horizon: todo.horizon,
        status: todo.status,
        scheduled_ms: todo.scheduled === undefined ? null : ms(todo.scheduled.start),
        due_ms: todo.due === undefined ? null : ms(todo.due),
        created_ms: ms(todo.created_at),
        json: JSON.stringify(todo),
      })
  }

  getTodo(id: TodoId): Todo | undefined {
    return parse<Todo>(
      this.db.prepare<[string], JsonRow>('SELECT json FROM todos WHERE id = ?').get(id),
    )
  }

  listTodos(filter: TodoFilter): Todo[] {
    const rows = this.db
      .prepare<[string], JsonRow>(
        'SELECT json FROM todos WHERE workspace_id = ? ORDER BY created_ms ASC, id ASC',
      )
      .all(filter.workspace_id)
    const out = parseAll<Todo>(rows).filter((t) => matchTodo(t, filter))
    return filter.limit === undefined ? out : out.slice(0, filter.limit)
  }

  // ── 计划与复盘
  putPlan(plan: DailyPlan): void {
    this.db
      .prepare(
        `INSERT INTO plans (id, workspace_id, person_id, date, json)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           workspace_id = excluded.workspace_id, person_id = excluded.person_id,
           date = excluded.date, json = excluded.json`,
      )
      .run(plan.id, plan.workspace_id, plan.person_id, plan.date, JSON.stringify(plan))
  }

  getPlan(id: DailyPlanId): DailyPlan | undefined {
    return parse<DailyPlan>(
      this.db.prepare<[string], JsonRow>('SELECT json FROM plans WHERE id = ?').get(id),
    )
  }

  findPlan(workspace_id: WorkspaceId, person_id: PersonId, date: string): DailyPlan | undefined {
    return parse<DailyPlan>(
      this.db
        .prepare<[string, string, string], JsonRow>(
          'SELECT json FROM plans WHERE workspace_id = ? AND person_id = ? AND date = ?',
        )
        .get(workspace_id, person_id, date),
    )
  }

  putReview(review: Review): void {
    this.db
      .prepare(
        `INSERT INTO reviews (id, workspace_id, person_id, kind, created_ms, json)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           workspace_id = excluded.workspace_id, person_id = excluded.person_id,
           kind = excluded.kind, created_ms = excluded.created_ms, json = excluded.json`,
      )
      .run(
        review.id,
        review.workspace_id,
        review.person_id,
        review.period.kind,
        ms(review.created_at),
        JSON.stringify(review),
      )
  }

  getReview(id: ReviewId): Review | undefined {
    return parse<Review>(
      this.db.prepare<[string], JsonRow>('SELECT json FROM reviews WHERE id = ?').get(id),
    )
  }

  listReviews(filter: {
    workspace_id: WorkspaceId
    person_id?: PersonId
    kind?: ReviewPeriodKind
    limit?: number
  }): Review[] {
    const rows = this.db
      .prepare<[string], JsonRow>(
        'SELECT json FROM reviews WHERE workspace_id = ? ORDER BY created_ms DESC, id DESC',
      )
      .all(filter.workspace_id)
    const out = parseAll<Review>(rows).filter((r) => {
      if (filter.person_id !== undefined && r.person_id !== filter.person_id) return false
      if (filter.kind !== undefined && r.period.kind !== filter.kind) return false
      return true
    })
    return filter.limit === undefined ? out : out.slice(0, filter.limit)
  }
}

export function createSqliteWorkStore(options: SqliteWorkStoreOptions = {}): SqliteWorkStore {
  return new SqliteWorkStore(options)
}
