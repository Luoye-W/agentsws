/**
 * 契约 #19「工作模型」（37 §2–§2.4、§4.3）。
 *
 * 四种东西性质不同，词在这里定死：
 * - **事项** {@link Matter}：**唯一的上下文容器**，就是散落在 17 §1 `RunRequest.work_item`、
 *   14 `subject.work_item_id`、21 事件里的那个 work_item 的正式形态。一件事的对话、记录、
 *   文件、运行、卡片、待办、会议都挂在它上面。
 * - **待办** {@link Todo}：人的承诺，指向事项某处的一条**指针**（`matter_id` + `anchor`）。
 *   它自己不装上下文——上下文在事项里。
 * - **卡片** = 14 的审批项：事项里 Agent 回头问人的一句话，也只是指向事项的指针。
 * - **日历** {@link CalendarItem}：时间索引的**视图 + 排期面**，不是对象；
 *   **一个日历，多图层**（WP74）：七类来源合并成一份，开关在界面上（{@link CalendarSource}）。
 *
 * 加上 {@link Goal}（目标，指标复用 29 命名查询）、{@link DailyPlan}（早上的建议）、
 * {@link Review}（晚上的复盘），就是 37 §2.4 的每日循环。
 *
 * 纪律：
 * - 时间一律 ISO8601，由调用方经 Clock 给；本文件不产生时间。
 * - 数字（进度、完成率、战报四格）在服务端算，不经模型（29 原则 ③）。
 * - 计划只是**建议**：采纳之后才写待办（37 C6）。
 */

import type {
  AssignmentId,
  Iso8601,
  MaybePromise,
  ObjectRef,
  PersonId,
  PositionId,
  PositionTemplateId,
  RoleId,
  RunId,
  WorkspaceId,
} from './common.js'
import type { RunResult } from './run.js'

export type MatterId = string
export type GoalId = string
export type TodoId = string
export type DailyPlanId = string
export type ReviewId = string
export type MatterEventId = string

// ── 事项（37 §2.2b）────────────────────────────────────────────────────

/**
 * `conversation` 客户对话线程 / `project` 目标下的长活 / `meeting` 会议跟进 /
 * `incident` 告警处置 / `adhoc` 临时。
 */
export type MatterKind = 'conversation' | 'project' | 'meeting' | 'incident' | 'adhoc'
export type MatterStatus = 'open' | 'waiting' | 'closed'

/**
 * WP69（54 §2）：这件事**从哪儿开的**。
 *
 * - `position`（主）：交给一个岗位，岗位内路由挑职责（{@link Matter.role_id} 由路由填、可换）；
 * - `role`（次）：直接指定一条职责的规则来做，跳过路由。
 *
 * 缺省（老事项没有这个字段）按 `role` 读——存量事项本来就是带着 `X-Assignment` 开的。
 */
export type MatterEntry = 'position' | 'role'

/** 时间线上的一条：人消息、Agent 运行、卡片、待办变化、会议——一条线，不分栏。 */
export type MatterEventKind =
  | 'human_message'
  | 'agent_message'
  | 'run'
  | 'card'
  | 'todo'
  | 'meeting'
  | 'note'
  | 'status'

export interface MatterEvent {
  id: MatterEventId
  matter_id: MatterId
  at: Iso8601
  kind: MatterEventKind
  /** 一句人话；`human_message` / `agent_message` 时就是消息正文 */
  text: string
  actor: { kind: 'person' | 'agent' | 'system'; id: string }
  /** 出处：订单 / 客户 / 事实卡 / 文件…… */
  ref?: ObjectRef
  run_id?: RunId
  approval_item_id?: string
  todo_id?: TodoId
}

export interface MatterContext {
  /** Agent 维护的「到哪了」，每次运行结束后更新（24 记忆纪律） */
  summary: string
  /** 固定记录：订单、客户、事实卡、文件 */
  pinned: ObjectRef[]
  participants: PersonId[]
  /** 运行时会话（dsh 有会话文件；direct 无）→ 续跑 */
  session_ref?: RunResult['session_ref']
  last_activity: Iso8601
}

export interface Matter {
  id: MatterId
  schema_version: 1
  workspace_id: WorkspaceId
  position_id?: PositionId
  kind: MatterKind
  title: string
  status: MatterStatus
  /** WP69（54 §2）：从岗位开的还是从职责开的；缺省按 `role` 读。 */
  entry?: MatterEntry
  /**
   * WP69：现在归哪条职责做。岗位入口由岗位内路由填，`POST /v1/matters/:id/reroute` 可换；
   * 职责入口就是那条职责。换职责只影响**之后**起的 Run，旧 Run 不动。
   */
  role_id?: RoleId
  /**
   * WP69（54 §1）：这件事挂在哪个**岗位**下（`web-ops` / `customer-care`…）。
   *
   * 与 {@link Matter.position_id} 不是一回事：那一条是"用谁的哪条分配在做"
   * （= Assignment，权限与额度从它来），这一条是"它属于哪个岗位"（岗位层上下文与
   * 记忆从它来）。一条职责挂在多个岗位里时没有它就说不清是哪个岗位，所以单独记。
   */
  position_template_id?: PositionTemplateId
  goal_id?: GoalId
  context: MatterContext
  created_at: Iso8601
  updated_at: Iso8601
  closed_at?: Iso8601
}

/**
 * 进入事项时的一屏（37 §2.2b「上下文怎么自动加载」）：
 * 只有摘要 + 固定记录的展示名 + 最近 N 条时间线 + 这里未完的待办与未决的卡。
 * 记录本身按需展开（29 的 enrichment，以本人身份查）。
 */
export interface MatterView {
  matter: Matter
  timeline: MatterEvent[]
  /** 还有更早的时间线没加载 */
  has_more: boolean
  todos: Todo[]
  /** 挂在这个事项上、还没决定的卡片 id */
  open_card_ids: string[]
  /** `pinned` 的展示名（服务端补；前端不猜、也不查库） */
  pinned_labels: { ref: ObjectRef; label: string }[]
}

// ── 目标（37 §2.3）─────────────────────────────────────────────────────

export type GoalLevel = 'company' | 'position' | 'person'
export type GoalStatus = 'active' | 'achieved' | 'missed' | 'archived'
export type GoalPeriodKind = 'week' | 'month' | 'quarter'
/** 与 29 数字块同一套格式名（deck 的 `TileFormat`；契约不依赖 deck，故在此重声明）。 */
export type MetricFormat = 'money' | 'count' | 'percent' | 'ratio'

export interface Goal {
  id: GoalId
  schema_version: 1
  workspace_id: WorkspaceId
  level: GoalLevel
  parent_id?: GoalId
  position_id?: PositionId
  owner: PersonId
  title: string
  /** 指标复用 29 的命名查询：`query` 是 `NamedQuery.name` */
  metric: { query: string; format: MetricFormat; params?: Record<string, unknown> }
  target: number
  period: { kind: GoalPeriodKind; start: Iso8601; end: Iso8601 }
  status: GoalStatus
  created_at: Iso8601
  updated_at: Iso8601
}

/** 首页数字块直接多的那一行「目标 / 进度 / 剩余天数」。数在服务端算。 */
export interface GoalProgress {
  goal_id: GoalId
  title: string
  level: GoalLevel
  position_id?: PositionId
  format: MetricFormat
  currency?: string
  target: number
  /** 命名查询算出来的当期值；查询不可用（数据源没连）时缺省 */
  value?: number
  /** 0–100；`target <= 0` 或无值时缺省 */
  progress_pct?: number
  /** 到 `period.end` 还剩几天（不足一天算 0，已过期为负） */
  days_left: number
  /** 期间已过的比例 0–100，用来判断「落后」 */
  elapsed_pct: number
  status: 'ok' | 'behind' | 'no_data'
}

// ── 待办（37 §2.2）─────────────────────────────────────────────────────

/** 由 `due` / `scheduled` 推出，也可手动（见 `WorkStore` 实现的 `deriveHorizon`）。 */
export type TodoHorizon = 'backlog' | 'week' | 'today'
export type TodoStatus = 'open' | 'doing' | 'blocked' | 'done' | 'dropped'
export type TodoSource = 'manual' | 'meeting' | 'review' | 'plan' | 'card' | 'alert'
export type DelegateState = 'pending' | 'running' | 'done' | 'cancelled'

/** 交给哪个 Agent 做、怎么做。一填，系统按 25 起一个 Run。 */
export interface TodoDelegate {
  assignment_id: AssignmentId
  brief: string
  run_id?: RunId
  state: DelegateState
  at: Iso8601
}

export interface Todo {
  id: TodoId
  schema_version: 1
  workspace_id: WorkspaceId
  position_id?: PositionId
  goal_id?: GoalId
  /** 长期待办拆成短期待办：父子，不是两种对象 */
  parent_id?: TodoId
  title: string
  note?: string
  /** 承诺人永远是人 */
  owner: PersonId
  delegate?: TodoDelegate
  horizon: TodoHorizon
  /** 截止 → 短期 */
  due?: Iso8601
  /** 排期 → 上日历 */
  scheduled?: { start: Iso8601; end: Iso8601 }
  source: TodoSource
  status: TodoStatus
  /** 上下文的家；可空 = 纯个人待办（「买咖啡」） */
  matter_id?: MatterId
  /** 点它回到事项时间线的哪一处 */
  anchor?: { matter_event_id: MatterEventId }
  /** 委托给 Agent 后回来的卡（`ApprovalItem.id`） */
  cards: string[]
  runs: RunId[]
  origin?: { meeting_id?: string; card_id?: string; review_id?: string; alert_id?: string }
  created_at: Iso8601
  updated_at: Iso8601
  closed_at?: Iso8601
}

// ── 日历（37 §2 表 + C3）───────────────────────────────────────────────

/**
 * 日历的来源（= 图层）。WP74：**一个日历，多图层**——不是"再开一个日历"。
 *
 * 前四条是 37 §2 表里那四类：会议、有排期的待办、定时任务（25）、卡片到期（叠层可关）。
 * 后三条是 WP74 加的，加的理由都一样：它们**本来就有时间**，却只在各自那一页里能看到，
 * 于是"这周四晚上到底堆了多少事"没有任何一屏答得出来。
 *
 * - `social_post` 社媒排期（56 §2 的 `SocialPost.scheduled_at`）
 * - `kol_deliverable` 红人交付物到期（`Deliverable.due_at`）
 * - `standby` 在线值守的续期日（`StandbyWorkspace.period_end`）
 *
 * **只加不删**：老的四条一个字没动，不传 {@link CalendarRange.sources} 时的行为与以前逐条相同。
 */
export type CalendarSource =
  | 'meeting'
  | 'todo'
  | 'scheduled_task'
  | 'card_due'
  | 'social_post'
  | 'kol_deliverable'
  | 'standby'

/** 全部图层，按界面上从上到下的顺序（图层开关那一列照这个排）。 */
export const CALENDAR_SOURCES: readonly CalendarSource[] = [
  'todo',
  'meeting',
  'social_post',
  'kol_deliverable',
  'scheduled_task',
  'card_due',
  'standby',
] as const

/**
 * 这一条**能不能拖**，以及拖了之后走哪条路（WP74）。
 *
 * 判据在服务端给，不在界面上猜：界面只认这三个词。
 * - `reschedule` 拖了直接改（待办排期、社媒排期）
 * - `propose` 拖了**不改**，出一张"改时间"卡请对方点头（会议走秘书那条约时间）
 * - `readonly` 拖不动，回弹并说为什么（交付物、值守、卡片到期、定时任务）
 */
export type CalendarDragMode = 'reschedule' | 'propose' | 'readonly'

export interface CalendarItem {
  id: string
  source: CalendarSource
  title: string
  start: Iso8601
  /** 不占时段的项（只有 due 的待办、卡片到期）没有 end */
  end?: Iso8601
  /** true = 挂在那天的「到期」栏，不占时段 */
  all_day: boolean
  ref: ObjectRef
  position_id?: PositionId
  matter_id?: MatterId
  /** 各来源自己的状态（待办 status、审批项 state……），只用于着色 */
  status?: string
  /** 社媒排期的渠道（`meta` / `tiktok`…）：同一图层里按渠道分色用，别的来源没有这一格 */
  channel?: string
  /**
   * 服务端算好的提示行（社媒排期的撞车说明就走这里）。
   *
   * 界面**一条判据都不自己写**（WP73 纪律 1）：格子上那个 ⚠ 与它的说明来自这里，
   * 否则迟早与卡面上那句话对不上。
   */
  notes?: string[]
  /** 拖拽语义（WP74）。缺省按 `readonly` 读——不知道怎么改的东西不该被拖动。 */
  drag?: CalendarDragMode
}

export interface CalendarRange {
  /** [from, to)，闭开区间 */
  from: Iso8601
  to: Iso8601
  /** 关掉「卡片到期」叠层 */
  include_card_due?: boolean
  /**
   * 只要这几个图层（WP74）。**不传 = 全部**——老调用方一个字不用改。
   *
   * 传空数组与不传不是一回事：空数组 = 一个图层都不开 = 一条都不回。
   */
  sources?: readonly CalendarSource[]
}

// ── 每日计划（37 §2.4 早上）────────────────────────────────────────────

/**
 * 一条建议。**它只是建议**：采纳之后才写待办（37 C6）。
 * `kind` 决定采纳时做什么：把 backlog 的挑到今天 / 委托给 Agent / 排到某个时段 / 新建一条。
 */
export type PlanSuggestionKind = 'promote' | 'delegate' | 'schedule' | 'create'

export interface DailyPlanSuggestion {
  id: string
  kind: PlanSuggestionKind
  title: string
  /** 为什么建议它（目标落后 / 今天到期 / 昨天复盘提到…） */
  reason: string
  todo_id?: TodoId
  goal_id?: GoalId
  matter_id?: MatterId
  horizon?: TodoHorizon
  scheduled?: { start: Iso8601; end: Iso8601 }
  assignment_id?: AssignmentId
  brief?: string
  /** 「调整」时可勾选清单里的默认勾选状态 */
  selected: boolean
}

export interface DailyPlanBasis {
  goals: GoalProgress[]
  /** 今天的会议数 */
  meetings: number
  /** 今天到期的待办数 */
  due_todos: number
  /** 待我定的卡片数 */
  cards_waiting: number
  yesterday_review_id?: ReviewId
}

export type DailyPlanState = 'drafted' | 'adopted' | 'adjusted' | 'later'
export type DailyPlanOptionId = 'adopt' | 'adjust' | 'later'

/** `daily_plan` 审批项的 payload（选择题：采纳 / 调整 / 稍后）。 */
export interface DailyPlanDraft {
  /** 工作区时区下的 `YYYY-MM-DD` */
  date: string
  person_id: PersonId
  basis: DailyPlanBasis
  suggestions: DailyPlanSuggestion[]
  options: { id: DailyPlanOptionId; label: string }[]
}

export interface DailyPlan extends DailyPlanDraft {
  id: DailyPlanId
  schema_version: 1
  workspace_id: WorkspaceId
  state: DailyPlanState
  approval_item_id?: string
  /** 采纳 / 调整后真写下去的待办 */
  created_todo_ids: TodoId[]
  created_at: Iso8601
  updated_at: Iso8601
}

// ── 复盘（37 §2.4 晚上）────────────────────────────────────────────────

export type ReviewPeriodKind = 'day' | 'week' | 'month'

/** 战报四格（36 §1 空态 = 今日战报）。数字来自事件日志与审批项，不经模型。 */
export interface BattleReport {
  ai_handled: number
  you_handled: number
  auto_sent: number
  blocked: number
}

/** `review` 审批项的 payload。 */
export interface ReviewDraft {
  person_id: PersonId
  period: { kind: ReviewPeriodKind; start: Iso8601; end: Iso8601 }
  goals: GoalProgress[]
  cards: BattleReport
  todos: { done: number; total: number; completion_pct: number }
  meetings: { count: number; outputs: number }
  /** Agent 学到的（24 lesson），只带 id 与一句话 */
  lessons: { id: string; text: string }[]
  /** 一句话一条的异常与亮点 */
  highlights: string[]
  /** 产物是明天 `daily_plan` 的草案（37 §2.4） */
  next_plan_draft: DailyPlanDraft
}

export interface Review extends ReviewDraft {
  id: ReviewId
  schema_version: 1
  workspace_id: WorkspaceId
  approval_item_id?: string
  created_at: Iso8601
}

// ── 存储契约 ───────────────────────────────────────────────────────────

export interface MatterFilter {
  workspace_id: WorkspaceId
  position_id?: PositionId
  kind?: MatterKind
  status?: MatterStatus[]
  goal_id?: GoalId
  /** 参与者里有这个人 */
  participant?: PersonId
  limit?: number
}

export interface TodoFilter {
  workspace_id: WorkspaceId
  owner?: PersonId
  position_id?: PositionId
  matter_id?: MatterId
  goal_id?: GoalId
  parent_id?: TodoId
  horizon?: TodoHorizon[]
  status?: TodoStatus[]
  /** `due` 或 `scheduled.start` 落在 [from, to) 内 */
  from?: Iso8601
  to?: Iso8601
  /** 有 `scheduled` 的才要（日历） */
  scheduled_only?: boolean
  limit?: number
}

export interface GoalFilter {
  workspace_id: WorkspaceId
  level?: GoalLevel
  position_id?: PositionId
  owner?: PersonId
  parent_id?: GoalId
  status?: GoalStatus[]
}

/**
 * 事项 / 目标 / 待办 / 计划 / 复盘的存储。内存档与 SQLite 档实现同一份，跑同一份一致性套件
 * （照 `TxnStore` 的做法）。全同步——`better-sqlite3` 是同步 API。
 */
export interface WorkStore {
  // 事项
  putMatter(matter: Matter): void
  getMatter(id: MatterId): Matter | undefined
  listMatters(filter: MatterFilter): Matter[]
  appendMatterEvent(event: MatterEvent): void
  /** 倒序取最近 `limit` 条，返回时按时间升序；`before` 用于往前翻 */
  listMatterEvents(
    matter_id: MatterId,
    options?: { limit?: number; before?: Iso8601 },
  ): MatterEvent[]
  countMatterEvents(matter_id: MatterId): number

  // 目标
  putGoal(goal: Goal): void
  getGoal(id: GoalId): Goal | undefined
  listGoals(filter: GoalFilter): Goal[]

  // 待办
  putTodo(todo: Todo): void
  getTodo(id: TodoId): Todo | undefined
  listTodos(filter: TodoFilter): Todo[]

  // 每日计划与复盘
  putPlan(plan: DailyPlan): void
  getPlan(id: DailyPlanId): DailyPlan | undefined
  /** 某人某天的计划（一天一条） */
  findPlan(workspace_id: WorkspaceId, person_id: PersonId, date: string): DailyPlan | undefined
  putReview(review: Review): void
  getReview(id: ReviewId): Review | undefined
  listReviews(filter: {
    workspace_id: WorkspaceId
    person_id?: PersonId
    kind?: ReviewPeriodKind
    limit?: number
  }): Review[]
}

/**
 * 委托与「在事项里说话」都要起 Run，但工作模型包不依赖运行时——由宿主注入这个回调
 * （17 §1：`work_item` 就是这个 Matter）。
 */
export type StartRun = (input: {
  matter: Matter
  brief: string
  actor: { person_id: PersonId; assignment_id: AssignmentId }
  todo_id?: TodoId
}) => MaybePromise<{ run_id: RunId }>
