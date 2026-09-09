/**
 * 工作模型的服务层：把存储、`horizon` 推导、委托、卡片回填、事项摘要、日历、计划与复盘
 * 接成一件东西。
 *
 * 三条边界（37 §2.2b C7）：
 * - **事项是唯一的上下文容器**；待办与卡片都只是指向事项的指针。
 * - **承诺人永远是人**：委托只是「让哪个 Agent 在这个事项里接着做」，起 Run 的动作由宿主
 *   注入的 {@link StartRun} 干，本包不依赖运行时。
 * - **计划只是建议**：`draftDailyPlan` 不写待办，`adoptPlan` 才写。
 *
 * 时间全部经注入的 Clock，id 经注入的 seed，没有一处 `Date.now()` / `Math.random()`。
 */
import type {
  ApprovalItem,
  AssignmentId,
  CalendarItem,
  CalendarRange,
  Clock,
  DailyPlan,
  DailyPlanId,
  DailyPlanSuggestion,
  Goal,
  GoalFilter,
  GoalId,
  GoalProgress,
  Iso8601,
  Matter,
  MatterEvent,
  MatterEventKind,
  MatterFilter,
  MatterId,
  MatterView,
  ObjectRef,
  PersonId,
  PositionId,
  Review,
  ReviewDraft,
  ReviewPeriodKind,
  RunId,
  RunResult,
  StartRun,
  Todo,
  TodoFilter,
  TodoHorizon,
  TodoId,
  TodoSource,
  TodoStatus,
  WorkStore,
  WorkspaceId,
} from '@agentsws/contracts'
import { buildCalendar, type CalendarInput, type ScheduledTaskLike } from './calendar.js'
import { notFound, WorkError } from './errors.js'
import { goalProgress, goalProgressAll, type QueryRunner } from './goals.js'
import { isOpen, resolveHorizon } from './horizon.js'
import { type DailyPlanInput, draftDailyPlan } from './plan.js'
import { MemoryWorkStore } from './store.js'
import { DAY_MS, localDay, makeIdFactory, ms, startOfDay, uniq } from './util.js'

/** 进入事项时只加载最近这么多条时间线（37 §2.2b「上下文怎么自动加载」）。 */
export const TIMELINE_PAGE = 20

/** 关闭事项时未完待办怎么办：一并关闭 / 保留（37 §2.2b 最后一条）。 */
export type UnfinishedPolicy = 'close_all' | 'keep'

/** 卡片回填要的最小投影；本包不该认识整个 `ApprovalItem`。 */
export interface CardRef {
  id: string
  kind: string
  state: string
  title: string
  matter_id?: MatterId
  todo_id?: TodoId
  run_id?: RunId
}

export function cardRefOf(item: ApprovalItem): CardRef {
  const matter_id = item.subject.matter_id ?? item.subject.work_item_id
  return {
    id: item.id,
    kind: item.kind,
    state: item.state,
    title: item.title,
    ...(matter_id === undefined ? {} : { matter_id }),
    ...(item.subject.todo_id === undefined ? {} : { todo_id: item.subject.todo_id }),
    ...(item.evidence.run_id === undefined ? {} : { run_id: item.evidence.run_id }),
  }
}

export interface WorkOptions {
  workspace_id: WorkspaceId
  clock: Clock
  /** 不给就是内存档 */
  store?: WorkStore
  /** seed 化的随机；不给用一个固定序列（本包的 id 只要唯一，不要求不可预测） */
  random?: () => number
  /** 工作区时区偏移（分钟），日界线按它切；默认 +8 */
  tz_offset_minutes?: number
  /** 委托与「在事项里说话」都要起 Run；不给这两条路回 not_implemented */
  startRun?: StartRun
  /** 事项摘要怎么写（24 记忆纪律）；不给就直接用运行的 summary */
  summarize?: (input: { matter: Matter; run_summary: string }) => string
}

/**
 * 输入 DTO 的可选字段一律显式带 `| undefined`：它们从 HTTP（zod 解析结果）来，
 * `exactOptionalPropertyTypes` 下「键在但值是 undefined」是常态。存储里的形状仍然严格。
 */
export interface CreateMatterInput {
  kind: Matter['kind']
  title: string
  position_id?: PositionId | undefined
  goal_id?: GoalId | undefined
  summary?: string | undefined
  pinned?: ObjectRef[] | undefined
  participants?: PersonId[] | undefined
  status?: Matter['status'] | undefined
}

export interface CreateTodoInput {
  title: string
  owner: PersonId
  note?: string | undefined
  position_id?: PositionId | undefined
  goal_id?: GoalId | undefined
  parent_id?: TodoId | undefined
  matter_id?: MatterId | undefined
  anchor?: { matter_event_id: string } | undefined
  due?: Iso8601 | undefined
  scheduled?: { start: Iso8601; end: Iso8601 } | undefined
  horizon?: TodoHorizon | undefined
  source?: TodoSource | undefined
  origin?: Todo['origin'] | undefined
}

export interface UpdateTodoInput {
  title?: string | undefined
  note?: string | undefined
  due?: Iso8601 | null | undefined
  scheduled?: { start: Iso8601; end: Iso8601 } | null | undefined
  horizon?: TodoHorizon | undefined
  status?: TodoStatus | undefined
  goal_id?: GoalId | null | undefined
  position_id?: PositionId | null | undefined
}

export interface CreateGoalInput {
  level: Goal['level']
  title: string
  owner: PersonId
  metric: Goal['metric']
  target: number
  period: Goal['period']
  parent_id?: GoalId | undefined
  position_id?: PositionId | undefined
  status?: Goal['status'] | undefined
}

export interface CalendarSources {
  meetings?: readonly CalendarItem[]
  tasks?: readonly ScheduledTaskLike[]
  cards?: readonly ApprovalItem[]
}

/** 一个固定序列的伪随机（只用来生成 id；调用方通常会注入 kernel 的 seeded random）。 */
function defaultRandom(): () => number {
  let s = 0x2f6e2b1
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    return s / 0x7fffffff
  }
}

export class Work {
  readonly store: WorkStore
  readonly workspace_id: WorkspaceId
  readonly tz_offset_minutes: number
  private readonly clock: Clock
  private readonly newId: (prefix: string) => string
  private readonly startRunFn: StartRun | undefined
  private readonly summarize: (input: { matter: Matter; run_summary: string }) => string

  constructor(options: WorkOptions) {
    this.store = options.store ?? new MemoryWorkStore()
    this.workspace_id = options.workspace_id
    this.clock = options.clock
    this.tz_offset_minutes = options.tz_offset_minutes ?? 480
    this.newId = makeIdFactory(options.random ?? defaultRandom(), () => options.clock.now())
    this.startRunFn = options.startRun
    this.summarize = options.summarize ?? ((i) => i.run_summary)
  }

  now(): Iso8601 {
    return this.clock.now()
  }

  /** 工作区时区下的今天（`YYYY-MM-DD`）——每日计划一天一条就是按它去重。 */
  todayDate(): string {
    return localDay(this.now(), this.tz_offset_minutes)
  }

  // ── 事项 ────────────────────────────────────────────────────────────

  createMatter(input: CreateMatterInput): Matter {
    const at = this.now()
    const matter: Matter = {
      id: this.newId('mat'),
      schema_version: 1,
      workspace_id: this.workspace_id,
      kind: input.kind,
      title: input.title,
      status: input.status ?? 'open',
      ...(input.position_id === undefined ? {} : { position_id: input.position_id }),
      ...(input.goal_id === undefined ? {} : { goal_id: input.goal_id }),
      context: {
        summary: input.summary ?? '',
        pinned: input.pinned ?? [],
        participants: input.participants ?? [],
        last_activity: at,
      },
      created_at: at,
      updated_at: at,
    }
    this.store.putMatter(matter)
    return matter
  }

  getMatter(id: MatterId): Matter | undefined {
    return this.store.getMatter(id)
  }

  requireMatter(id: MatterId): Matter {
    const m = this.store.getMatter(id)
    if (m === undefined) throw notFound('事项', id)
    return m
  }

  listMatters(filter: Omit<MatterFilter, 'workspace_id'> = {}): Matter[] {
    return this.store.listMatters({ workspace_id: this.workspace_id, ...filter })
  }

  /** 进入事项的一屏：摘要 + 固定记录展示名 + 最近 N 条时间线 + 未完待办 + 未决的卡。 */
  matterView(
    id: MatterId,
    options: { limit?: number; label?: (ref: ObjectRef) => string | undefined } = {},
  ): MatterView {
    const matter = this.requireMatter(id)
    const limit = options.limit ?? TIMELINE_PAGE
    const timeline = this.store.listMatterEvents(id, { limit })
    const todos = this.store.listTodos({ workspace_id: this.workspace_id, matter_id: id })
    const open_card_ids = uniq(todos.flatMap((t) => t.cards))
    return {
      matter,
      timeline,
      has_more: this.store.countMatterEvents(id) > timeline.length,
      todos,
      open_card_ids,
      pinned_labels: matter.context.pinned.map((ref) => ({
        ref,
        label: options.label?.(ref) ?? `${ref.type}:${ref.id}`,
      })),
    }
  }

  appendEvent(
    matter_id: MatterId,
    input: {
      kind: MatterEventKind
      text: string
      actor: MatterEvent['actor']
      ref?: ObjectRef
      run_id?: RunId
      approval_item_id?: string
      todo_id?: TodoId
      at?: Iso8601
    },
  ): MatterEvent {
    const matter = this.requireMatter(matter_id)
    const at = input.at ?? this.now()
    const event: MatterEvent = {
      id: this.newId('mev'),
      matter_id,
      at,
      kind: input.kind,
      text: input.text,
      actor: input.actor,
      ...(input.ref === undefined ? {} : { ref: input.ref }),
      ...(input.run_id === undefined ? {} : { run_id: input.run_id }),
      ...(input.approval_item_id === undefined ? {} : { approval_item_id: input.approval_item_id }),
      ...(input.todo_id === undefined ? {} : { todo_id: input.todo_id }),
    }
    this.store.appendMatterEvent(event)
    this.store.putMatter({
      ...matter,
      updated_at: at,
      context: { ...matter.context, last_activity: at },
    })
    return event
  }

  /**
   * 37 §2.2b：事项页里允许对话（对话入口的第四处，有事项边界、有岗位角色）。
   * 人说一句 → 记时间线 → 起 Run（`work_item = matter`，17 §1）。
   */
  async say(
    matter_id: MatterId,
    input: { person_id: PersonId; assignment_id: AssignmentId; text: string },
  ): Promise<{ event: MatterEvent; run_id?: RunId }> {
    const matter = this.requireMatter(matter_id)
    const event = this.appendEvent(matter_id, {
      kind: 'human_message',
      text: input.text,
      actor: { kind: 'person', id: input.person_id },
    })
    if (this.startRunFn === undefined) return { event }
    const { run_id } = await this.startRunFn({
      matter,
      brief: input.text,
      actor: { person_id: input.person_id, assignment_id: input.assignment_id },
    })
    this.appendEvent(matter_id, {
      kind: 'run',
      text: 'Agent 接着这个事项跑了一次',
      actor: { kind: 'agent', id: input.assignment_id },
      run_id,
    })
    return { event, run_id }
  }

  /** 事项摘要由运行结束事件触发（24 记忆纪律：摘要是「到哪了」，不是流水账）。 */
  updateSummary(
    matter_id: MatterId,
    input: { run_summary: string; session_ref?: RunResult['session_ref']; run_id?: RunId },
  ): Matter {
    const matter = this.requireMatter(matter_id)
    const at = this.now()
    const next: Matter = {
      ...matter,
      updated_at: at,
      context: {
        ...matter.context,
        summary: this.summarize({ matter, run_summary: input.run_summary }),
        last_activity: at,
        ...(input.session_ref === undefined ? {} : { session_ref: input.session_ref }),
      },
    }
    this.store.putMatter(next)
    return next
  }

  /** 固定记录（pinned）：加 / 去。 */
  pin(matter_id: MatterId, ref: ObjectRef): Matter {
    const matter = this.requireMatter(matter_id)
    const key = `${ref.type}:${ref.id}`
    if (matter.context.pinned.some((p) => `${p.type}:${p.id}` === key)) return matter
    const next: Matter = {
      ...matter,
      updated_at: this.now(),
      context: { ...matter.context, pinned: [...matter.context.pinned, ref] },
    }
    this.store.putMatter(next)
    return next
  }

  /**
   * 关闭事项：未完待办**不自动关**，弹一次「一并关闭 / 保留」——这个选择由调用方传进来。
   */
  closeMatter(
    id: MatterId,
    options: { unfinished: UnfinishedPolicy; by?: PersonId },
  ): { matter: Matter; closed_todo_ids: TodoId[]; kept_todo_ids: TodoId[] } {
    const matter = this.requireMatter(id)
    const at = this.now()
    const open = this.store
      .listTodos({ workspace_id: this.workspace_id, matter_id: id })
      .filter(isOpen)
    const closed_todo_ids: TodoId[] = []
    if (options.unfinished === 'close_all') {
      for (const todo of open) {
        this.store.putTodo({
          ...todo,
          status: 'dropped',
          updated_at: at,
          closed_at: at,
        })
        closed_todo_ids.push(todo.id)
      }
    }
    const next: Matter = {
      ...matter,
      status: 'closed',
      updated_at: at,
      closed_at: at,
      context: { ...matter.context, last_activity: at },
    }
    this.store.putMatter(next)
    this.store.appendMatterEvent({
      id: this.newId('mev'),
      matter_id: id,
      at,
      kind: 'status',
      text:
        options.unfinished === 'close_all'
          ? `事项关闭，${closed_todo_ids.length} 条未完待办一并关掉`
          : `事项关闭，${open.length} 条未完待办保留在待办箱`,
      actor: { kind: 'person', id: options.by ?? 'system' },
    })
    return {
      matter: next,
      closed_todo_ids,
      kept_todo_ids: options.unfinished === 'keep' ? open.map((t) => t.id) : [],
    }
  }

  // ── 待办 ────────────────────────────────────────────────────────────

  createTodo(input: CreateTodoInput): Todo {
    const at = this.now()
    if (input.matter_id !== undefined) this.requireMatter(input.matter_id)
    const todo: Todo = {
      id: this.newId('td'),
      schema_version: 1,
      workspace_id: this.workspace_id,
      title: input.title,
      owner: input.owner,
      horizon: resolveHorizon(input, at, this.tz_offset_minutes),
      source: input.source ?? 'manual',
      status: 'open',
      cards: [],
      runs: [],
      created_at: at,
      updated_at: at,
      ...(input.note === undefined ? {} : { note: input.note }),
      ...(input.position_id === undefined ? {} : { position_id: input.position_id }),
      ...(input.goal_id === undefined ? {} : { goal_id: input.goal_id }),
      ...(input.parent_id === undefined ? {} : { parent_id: input.parent_id }),
      ...(input.matter_id === undefined ? {} : { matter_id: input.matter_id }),
      ...(input.anchor === undefined ? {} : { anchor: input.anchor }),
      ...(input.due === undefined ? {} : { due: input.due }),
      ...(input.scheduled === undefined ? {} : { scheduled: input.scheduled }),
      ...(input.origin === undefined ? {} : { origin: input.origin }),
    }
    this.store.putTodo(todo)
    if (todo.matter_id !== undefined) {
      this.appendEvent(todo.matter_id, {
        kind: 'todo',
        text: `建了一条待办：${todo.title}`,
        actor: { kind: 'person', id: todo.owner },
        todo_id: todo.id,
      })
    }
    return todo
  }

  getTodo(id: TodoId): Todo | undefined {
    return this.store.getTodo(id)
  }

  requireTodo(id: TodoId): Todo {
    const t = this.store.getTodo(id)
    if (t === undefined) throw notFound('待办', id)
    return t
  }

  listTodos(filter: Omit<TodoFilter, 'workspace_id'> = {}): Todo[] {
    return this.store.listTodos({ workspace_id: this.workspace_id, ...filter })
  }

  /** 待办箱三段：backlog / 本周 / 今天（只算未完的）。 */
  inbox(owner?: PersonId): { backlog: Todo[]; week: Todo[]; today: Todo[] } {
    const all = this.listTodos({
      ...(owner === undefined ? {} : { owner }),
      status: ['open', 'doing', 'blocked'],
    })
    return {
      backlog: all.filter((t) => t.horizon === 'backlog'),
      week: all.filter((t) => t.horizon === 'week'),
      today: all.filter((t) => t.horizon === 'today'),
    }
  }

  updateTodo(id: TodoId, patch: UpdateTodoInput): Todo {
    const todo = this.requireTodo(id)
    const at = this.now()
    const due = patch.due === null ? undefined : (patch.due ?? todo.due)
    const scheduled = patch.scheduled === null ? undefined : (patch.scheduled ?? todo.scheduled)
    const goal_id = patch.goal_id === null ? undefined : (patch.goal_id ?? todo.goal_id)
    const position_id =
      patch.position_id === null ? undefined : (patch.position_id ?? todo.position_id)
    const status = patch.status ?? todo.status
    const closing = status === 'done' || status === 'dropped'
    const next: Todo = {
      ...todo,
      title: patch.title ?? todo.title,
      status,
      horizon: resolveHorizon(
        {
          ...(due === undefined ? {} : { due }),
          ...(scheduled === undefined ? {} : { scheduled }),
          ...(patch.horizon === undefined ? {} : { horizon: patch.horizon }),
        },
        at,
        this.tz_offset_minutes,
      ),
      updated_at: at,
    }
    // exactOptionalPropertyTypes：可空字段要么有值要么整个键不在
    if (patch.note !== undefined) next.note = patch.note
    if (due === undefined) delete next.due
    else next.due = due
    if (scheduled === undefined) delete next.scheduled
    else next.scheduled = scheduled
    if (goal_id === undefined) delete next.goal_id
    else next.goal_id = goal_id
    if (position_id === undefined) delete next.position_id
    else next.position_id = position_id
    if (closing) next.closed_at = at
    else delete next.closed_at
    this.store.putTodo(next)
    if (next.matter_id !== undefined && todo.status !== status) {
      this.appendEvent(next.matter_id, {
        kind: 'todo',
        text: `待办「${next.title}」→ ${status}`,
        actor: { kind: 'person', id: next.owner },
        todo_id: next.id,
      })
    }
    return next
  }

  /** 打勾 = 完成（37 §2.2b：打勾 / 关闭 / 删除都不进现场）。 */
  complete(id: TodoId): Todo {
    return this.updateTodo(id, { status: 'done' })
  }

  /** 关闭 / 删除：都落成 `dropped`（事件日志留痕，不真删）。 */
  drop(id: TodoId): Todo {
    return this.updateTodo(id, { status: 'dropped' })
  }

  /** 排期 = 写 `Todo.scheduled`（把待办拖到日历某天就是它，37 C3）。 */
  schedule(id: TodoId, slot: { start: Iso8601; end: Iso8601 } | null): Todo {
    return this.updateTodo(id, { scheduled: slot })
  }

  /**
   * 长期拆短期：父子，不是两种对象（37 §2.2）。
   * 子项继承父的目标 / 岗位 / 事项；父项自己留在待办箱。
   */
  splitTodo(
    parent_id: TodoId,
    children: readonly (Pick<CreateTodoInput, 'title'> & Partial<CreateTodoInput>)[],
  ): { parent: Todo; children: Todo[] } {
    const parent = this.requireTodo(parent_id)
    if (children.length === 0) throw new WorkError('invalid_input', '拆分至少要给一条子待办')
    const made = children.map((child) =>
      this.createTodo({
        owner: parent.owner,
        source: 'plan',
        ...(parent.goal_id === undefined ? {} : { goal_id: parent.goal_id }),
        ...(parent.position_id === undefined ? {} : { position_id: parent.position_id }),
        ...(parent.matter_id === undefined ? {} : { matter_id: parent.matter_id }),
        ...child,
        title: child.title,
        parent_id,
      }),
    )
    return { parent: this.requireTodo(parent_id), children: made }
  }

  /**
   * 委托给 Agent = 「让 Agent 在这个事项里继续做」：起 Run（`work_item = matter`），
   * 回来的卡挂在事项上并回填到待办的 `cards`（37 §2.2b）。
   *
   * 没有事项的待办也能委托——那就现开一个 `adhoc` 事项，因为**上下文必须有家**。
   */
  async delegate(
    id: TodoId,
    input: { assignment_id: AssignmentId; brief?: string; by: PersonId },
  ): Promise<Todo> {
    const todo = this.requireTodo(id)
    if (this.startRunFn === undefined)
      throw new WorkError('not_implemented', '这个进程没有装配运行时（startRun），委托跑不起来')
    const at = this.now()
    let matter_id = todo.matter_id
    if (matter_id === undefined) {
      const matter = this.createMatter({
        kind: 'adhoc',
        title: todo.title,
        participants: [todo.owner],
        ...(todo.position_id === undefined ? {} : { position_id: todo.position_id }),
      })
      matter_id = matter.id
    }
    const matter = this.requireMatter(matter_id)
    const brief = input.brief ?? todo.note ?? todo.title
    const { run_id } = await this.startRunFn({
      matter,
      brief,
      actor: { person_id: input.by, assignment_id: input.assignment_id },
      todo_id: todo.id,
    })
    const next: Todo = {
      ...todo,
      matter_id,
      status: 'doing',
      delegate: { assignment_id: input.assignment_id, brief, run_id, state: 'running', at },
      runs: uniq([...todo.runs, run_id]),
      updated_at: at,
    }
    this.store.putTodo(next)
    this.appendEvent(matter_id, {
      kind: 'run',
      text: `把「${todo.title}」交给 Agent 做`,
      actor: { kind: 'person', id: input.by },
      run_id,
      todo_id: todo.id,
    })
    return next
  }

  /** 撤销委托 = 取消 Run（真正的取消由宿主做，这里只改状态）。 */
  undelegate(id: TodoId): Todo {
    const todo = this.requireTodo(id)
    if (todo.delegate === undefined) return todo
    const next: Todo = {
      ...todo,
      delegate: { ...todo.delegate, state: 'cancelled' },
      status: todo.status === 'doing' ? 'open' : todo.status,
      updated_at: this.now(),
    }
    this.store.putTodo(next)
    return next
  }

  /**
   * 卡片回填：订阅 `proposal.created` / `approval.*` 事件，把挂着 `matter_id` 的卡
   * 挂回对应的待办（37 §2.2 交点一「人看待办能看到 AI 做到哪、卡着几张要我定」）。
   *
   * 匹配顺序：`subject.todo_id` 精确匹配 → 同事项里 `runs` 含这次 run 的待办 → 只记事项时间线。
   */
  onCard(ref: CardRef): { todo?: Todo; matter?: Matter } {
    let todo: Todo | undefined
    if (ref.todo_id !== undefined) todo = this.store.getTodo(ref.todo_id)
    if (todo === undefined && ref.matter_id !== undefined && ref.run_id !== undefined) {
      todo = this.store
        .listTodos({ workspace_id: this.workspace_id, matter_id: ref.matter_id })
        .find((t) => t.runs.includes(ref.run_id as RunId))
    }
    const at = this.now()
    if (todo !== undefined && !todo.cards.includes(ref.id)) {
      todo = { ...todo, cards: [...todo.cards, ref.id], updated_at: at }
      this.store.putTodo(todo)
    }
    const matter_id = ref.matter_id ?? todo?.matter_id
    if (matter_id === undefined || this.store.getMatter(matter_id) === undefined)
      return todo === undefined ? {} : { todo }
    this.appendEvent(matter_id, {
      kind: 'card',
      text: ref.title,
      actor: { kind: 'agent', id: ref.run_id ?? 'agent' },
      approval_item_id: ref.id,
      ...(ref.run_id === undefined ? {} : { run_id: ref.run_id }),
      ...(todo === undefined ? {} : { todo_id: todo.id }),
    })
    return {
      ...(todo === undefined ? {} : { todo: this.requireTodo(todo.id) }),
      matter: this.requireMatter(matter_id),
    }
  }

  /** 运行结束：更新事项摘要与委托状态（宿主在 `run.completed` 上调它）。 */
  onRunCompleted(input: {
    matter_id: MatterId
    run_id: RunId
    summary: string
    session_ref?: RunResult['session_ref']
  }): Matter {
    const matter = this.updateSummary(input.matter_id, {
      run_summary: input.summary,
      run_id: input.run_id,
      ...(input.session_ref === undefined ? {} : { session_ref: input.session_ref }),
    })
    for (const todo of this.store.listTodos({
      workspace_id: this.workspace_id,
      matter_id: input.matter_id,
    })) {
      if (todo.delegate?.run_id !== input.run_id) continue
      this.store.putTodo({
        ...todo,
        delegate: { ...todo.delegate, state: 'done' },
        updated_at: this.now(),
      })
    }
    return matter
  }

  // ── 目标 ────────────────────────────────────────────────────────────

  createGoal(input: CreateGoalInput): Goal {
    const at = this.now()
    const goal: Goal = {
      id: this.newId('goal'),
      schema_version: 1,
      workspace_id: this.workspace_id,
      level: input.level,
      owner: input.owner,
      title: input.title,
      metric: input.metric,
      target: input.target,
      period: input.period,
      status: input.status ?? 'active',
      created_at: at,
      updated_at: at,
      ...(input.parent_id === undefined ? {} : { parent_id: input.parent_id }),
      ...(input.position_id === undefined ? {} : { position_id: input.position_id }),
    }
    this.store.putGoal(goal)
    return goal
  }

  getGoal(id: GoalId): Goal | undefined {
    return this.store.getGoal(id)
  }

  listGoals(filter: Omit<GoalFilter, 'workspace_id'> = {}): Goal[] {
    return this.store.listGoals({ workspace_id: this.workspace_id, ...filter })
  }

  progress(run: QueryRunner, filter: Omit<GoalFilter, 'workspace_id'> = {}): GoalProgress[] {
    return goalProgressAll(this.listGoals(filter), run, this.now())
  }

  progressOf(goal_id: GoalId, run: QueryRunner): GoalProgress {
    const goal = this.store.getGoal(goal_id)
    if (goal === undefined) throw notFound('目标', goal_id)
    return goalProgress(goal, run, this.now())
  }

  // ── 日历 ────────────────────────────────────────────────────────────

  calendar(range: CalendarRange, actor: { person_id?: PersonId }, sources: CalendarSources = {}) {
    const todos = this.listTodos({
      ...(actor.person_id === undefined ? {} : { owner: actor.person_id }),
      status: ['open', 'doing', 'blocked'],
    })
    const input: CalendarInput = {
      range,
      todos,
      ...(sources.meetings === undefined ? {} : { meetings: sources.meetings }),
      ...(sources.tasks === undefined ? {} : { tasks: sources.tasks }),
      ...(sources.cards === undefined ? {} : { cards: sources.cards }),
    }
    return buildCalendar(input)
  }

  /** 「今天」= 工作区时区下的今天；首页第二段与每日计划都用它。 */
  todayRange(): CalendarRange {
    const day = startOfDay(ms(this.now()), this.tz_offset_minutes)
    return { from: new Date(day).toISOString(), to: new Date(day + DAY_MS).toISOString() }
  }

  // ── 每日计划 ────────────────────────────────────────────────────────

  /**
   * 今天的计划。一天一条：已经有就返回已有的（不重复问），没有就按当下情况拟一版。
   * **只写 `DailyPlan` 这条记录，不写任何待办**——采纳才写（37 C6）。
   */
  todayPlan(input: {
    person_id: PersonId
    goals: readonly GoalProgress[]
    today_meetings?: readonly CalendarItem[]
    cards_waiting?: number
    delegate_to?: AssignmentId
    /** 强制重拟（比如目标刚改过） */
    refresh?: boolean
  }): DailyPlan {
    const now = this.now()
    const date = localDay(now, this.tz_offset_minutes)
    const existing = this.store.findPlan(this.workspace_id, input.person_id, date)
    if (existing !== undefined && input.refresh !== true) return existing
    const inbox = this.inbox(input.person_id)
    const yesterday = this.store.listReviews({
      workspace_id: this.workspace_id,
      person_id: input.person_id,
      kind: 'day',
      limit: 1,
    })[0]
    const draftInput: DailyPlanInput = {
      now,
      person_id: input.person_id,
      tz_offset_minutes: this.tz_offset_minutes,
      goals: input.goals,
      todos: inbox,
      today_meetings: input.today_meetings ?? [],
      cards_waiting: input.cards_waiting ?? 0,
      ...(yesterday === undefined ? {} : { yesterday_review: yesterday }),
      // 没装运行时就不给「交给 Agent」的建议——不建议系统做不到的事
      ...(input.delegate_to === undefined || this.startRunFn === undefined
        ? {}
        : { delegate_to: input.delegate_to }),
    }
    const draft = draftDailyPlan(draftInput)
    const plan: DailyPlan = {
      ...draft,
      id: existing?.id ?? this.newId('plan'),
      schema_version: 1,
      workspace_id: this.workspace_id,
      state: 'drafted',
      created_todo_ids: [],
      created_at: existing?.created_at ?? now,
      updated_at: now,
      ...(existing?.approval_item_id === undefined
        ? {}
        : { approval_item_id: existing.approval_item_id }),
    }
    this.store.putPlan(plan)
    return plan
  }

  getPlan(id: DailyPlanId): DailyPlan | undefined {
    return this.store.getPlan(id)
  }

  linkPlanApproval(id: DailyPlanId, approval_item_id: string): DailyPlan {
    const plan = this.store.getPlan(id)
    if (plan === undefined) throw notFound('每日计划', id)
    const next: DailyPlan = { ...plan, approval_item_id, updated_at: this.now() }
    this.store.putPlan(next)
    return next
  }

  /**
   * 采纳（或调整后采纳）：**这一步才写待办**。
   * `selected_ids` 不给就按建议自带的 `selected`；给了就是「调整」——勾选清单的结果。
   */
  async adoptPlan(
    id: DailyPlanId,
    input: { by: PersonId; selected_ids?: readonly string[] } = { by: 'system' },
  ): Promise<{ plan: DailyPlan; todos: Todo[] }> {
    const plan = this.store.getPlan(id)
    if (plan === undefined) throw notFound('每日计划', id)
    const adjusted = input.selected_ids !== undefined
    const chosen = new Set(
      input.selected_ids ?? plan.suggestions.filter((s) => s.selected).map((s) => s.id),
    )
    const todos: Todo[] = []
    for (const s of plan.suggestions) {
      if (!chosen.has(s.id)) continue
      const made = await this.applySuggestion(s, { by: input.by, plan_id: plan.id })
      if (made !== undefined) todos.push(made)
    }
    const next: DailyPlan = {
      ...plan,
      state: adjusted ? 'adjusted' : 'adopted',
      created_todo_ids: todos.map((t) => t.id),
      updated_at: this.now(),
    }
    this.store.putPlan(next)
    return { plan: next, todos }
  }

  /** 稍后：计划留着，什么都不写。 */
  deferPlan(id: DailyPlanId): DailyPlan {
    const plan = this.store.getPlan(id)
    if (plan === undefined) throw notFound('每日计划', id)
    const next: DailyPlan = { ...plan, state: 'later', updated_at: this.now() }
    this.store.putPlan(next)
    return next
  }

  private async applySuggestion(
    s: DailyPlanSuggestion,
    ctx: { by: PersonId; plan_id: DailyPlanId },
  ): Promise<Todo | undefined> {
    if (s.kind === 'create' || s.todo_id === undefined) {
      return this.createTodo({
        title: s.title,
        owner: ctx.by,
        source: 'plan',
        horizon: s.horizon ?? 'today',
        ...(s.goal_id === undefined ? {} : { goal_id: s.goal_id }),
        ...(s.matter_id === undefined ? {} : { matter_id: s.matter_id }),
        ...(s.scheduled === undefined ? {} : { scheduled: s.scheduled }),
      })
    }
    if (this.store.getTodo(s.todo_id) === undefined) return undefined
    if (s.kind === 'promote') return this.updateTodo(s.todo_id, { horizon: s.horizon ?? 'today' })
    if (s.kind === 'schedule')
      return s.scheduled === undefined ? undefined : this.schedule(s.todo_id, s.scheduled)
    // delegate
    if (s.assignment_id === undefined || this.startRunFn === undefined) return undefined
    return this.delegate(s.todo_id, {
      assignment_id: s.assignment_id,
      by: ctx.by,
      ...(s.brief === undefined ? {} : { brief: s.brief }),
    })
  }

  // ── 复盘 ────────────────────────────────────────────────────────────

  saveReview(draft: ReviewDraft, approval_item_id?: string): Review {
    const review: Review = {
      ...draft,
      id: this.newId('rev'),
      schema_version: 1,
      workspace_id: this.workspace_id,
      created_at: this.now(),
      ...(approval_item_id === undefined ? {} : { approval_item_id }),
    }
    this.store.putReview(review)
    return review
  }

  listReviews(filter: { person_id?: PersonId; kind?: ReviewPeriodKind; limit?: number } = {}) {
    return this.store.listReviews({ workspace_id: this.workspace_id, ...filter })
  }

  latestReview(person_id: PersonId, kind: ReviewPeriodKind = 'day'): Review | undefined {
    return this.store.listReviews({
      workspace_id: this.workspace_id,
      person_id,
      kind,
      limit: 1,
    })[0]
  }
}

export function createWork(options: WorkOptions): Work {
  return new Work(options)
}
