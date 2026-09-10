/**
 * 37 工作模型面：事项 / 目标 / 待办 / 日历 / 每日计划 / 复盘。
 *
 * 三条边界（与 `workstation.ts` 同）：
 * - **一次请求一个 Assignment**（31 §3.1）：所有路由要 `X-Assignment`；委托与在事项里说话
 *   会起 Run，起 Run 用的就是这条 Assignment。
 * - **数字不经模型手**（29 原则 ③）：目标进度、完成率、战报四格全在服务端算好。
 * - **网关里不写业务**（28 §2）：每条路由都只是 `@agentsws/work` 某个方法的投影。
 *
 * 鉴权元组用的是「读自己的队列」那一条（`approval.read/own`）。理由：事项与待办是**本人自己的
 * 承诺与工作现场**，05 的 scopes 是对业务数据域说的，没有对应的写动作；真正会对外产生影响的
 * 只有委托与发言，那两条起的 Run 仍然要过 17 的额度、门禁与 14 的审批。
 */
import type {
  ApprovalItem,
  AssignmentId,
  BattleReport,
  CalendarItem,
  DailyPlan,
  Goal,
  GoalLevel,
  GoalProgress,
  Matter,
  MatterEvent,
  MatterKind,
  MatterView,
  MaybePromise,
  PersonId,
  Review,
  ReviewPeriodKind,
  Todo,
  TodoHorizon,
  TodoStatus,
  WorkspaceId,
} from '@agentsws/contracts'
import { z } from 'zod'
import { ApiError } from '../errors.js'
import { assignmentOf, body, ok, param, principalOf } from '../helpers.js'
import { type Route, route } from '../route-spec.js'
import type { GatewayDeps } from '../types.js'

/** 与工作台面同一个准入：能读自己的队列就能看自己的事项与待办。 */
const READ = { domain: 'approval', op: 'read', range: 'own', sensitivity: 'internal' } as const

export interface WorkActor {
  workspace_id: WorkspaceId
  person_id: PersonId
  /** 本次绑定的岗位（= X-Assignment）；委托与发言用它起 Run */
  assignment_id: AssignmentId
}

/**
 * 「正在进行」的一条（40 §3.3）。展示名由服务端补（前端不猜、也不查库）：
 * `owner_label` 没有数据源能翻译时回落成 `owner` 本身。
 */
export interface WorkInProgressItem {
  kind: 'todo' | 'matter'
  id: string
  title: string
  owner: PersonId
  owner_label: string
  collaborators: PersonId[]
  status: string
  position_id?: string
  started_at: string
  last_activity: string
  /** 等他定的卡数 */
  cards: number
  matter_id?: string
}

/**
 * 进入事项的一屏，比契约的 `MatterView` 多一份参与者展示名（29 enrichment：
 * 服务端补，前端不猜、也不查库）。翻译不出来时回落成 `person_id` 本身。
 */
export interface WorkMatterView extends MatterView {
  participant_labels: { person_id: PersonId; label: string }[]
}

/** 待认领池里的一条（40 §3.2）。 */
export interface WorkPoolItem {
  todo_id: string
  title: string
  note?: string
  source: Todo['source']
  position_id?: string
  matter_id?: string
  due?: string
  pooled_at: string
  /** 回过几次池（上一个主人没动它） */
  recycled: number
  /** 可能与这些进行中项重复 */
  similar_to: string[]
  /** 这条是转交给我的，不是池里的公共项 */
  offered_by?: PersonId
}

/** 首页第三稿（37 §3）在 `GET /v1/home` 上多出来的三段。 */
export interface WorkHome {
  /** ① 目标进度 */
  goals: GoalProgress[]
  /** ② 今天：左时间轴 / 右到期清单 */
  today: {
    timeline: CalendarItem[]
    due: { todos: Todo[]; cards_waiting: number }
  }
  /** ④ 战报四格：白天就是它；数从今天的审批项状态里数出来（29 原则 ③） */
  report: BattleReport
  /** ④ 晚上有复盘就给复盘 */
  review?: Review
  /** 早上的每日计划卡（37 §2.4） */
  plan?: DailyPlan
}

const MATTER_KIND = ['conversation', 'project', 'meeting', 'incident', 'adhoc'] as const
const MATTER_STATUS = ['open', 'waiting', 'closed'] as const
const HORIZON = ['backlog', 'week', 'today'] as const
const TODO_STATUS = ['open', 'doing', 'blocked', 'done', 'dropped'] as const
const REVIEW_KIND = ['day', 'week', 'month'] as const

const Slot = z.object({ start: z.string().min(1), end: z.string().min(1) })

const CreateMatterBody = z.object({
  kind: z.enum(MATTER_KIND),
  title: z.string().min(1).max(120),
  goal_id: z.string().min(1).optional(),
  summary: z.string().max(2000).optional(),
})

const CloseMatterBody = z.object({ unfinished: z.enum(['close_all', 'keep']) })

const MessageBody = z.object({ text: z.string().min(1).max(4000) })

const CreateGoalBody = z.object({
  level: z.enum(['company', 'position', 'person']),
  title: z.string().min(1).max(120),
  target: z.number(),
  metric: z.object({
    query: z.string().min(1),
    format: z.enum(['money', 'count', 'percent', 'ratio']),
  }),
  period: z.object({
    kind: z.enum(['week', 'month', 'quarter']),
    start: z.string().min(1),
    end: z.string().min(1),
  }),
  parent_id: z.string().min(1).optional(),
  position_id: z.string().min(1).optional(),
})

const Ref = z.object({ type: z.string().min(1).max(40), id: z.string().min(1).max(200) })

/** 撞上了怎么办（40 §3.1 的选择题三选一）。 */
const COLLISION = ['join', 'handoff', 'force'] as const

const CreateTodoBody = z.object({
  title: z.string().min(1).max(200),
  note: z.string().max(2000).optional(),
  matter_id: z.string().min(1).optional(),
  goal_id: z.string().min(1).optional(),
  parent_id: z.string().min(1).optional(),
  due: z.string().min(1).optional(),
  horizon: z.enum(HORIZON).optional(),
  /** 主题对象（订单 / 客户 / 会议 / 店铺）——撞车第一把钥匙 */
  refs: z.array(Ref).max(5).optional(),
  /** 不给就是「先查」：撞上了回 409，不建 */
  collision: z.enum(COLLISION).optional(),
  collision_target: z.string().min(1).optional(),
  /** 选「我这个不一样」必须写一句区别 */
  distinct_reason: z.string().max(500).optional(),
})

const ClaimBody = z.object({ position_id: z.string().min(1).optional() })
const TransferBody = z.object({ to: z.string().min(1) })
const CollaboratorBody = z.object({ person_id: z.string().min(1) })

const UpdateTodoBody = z.object({
  title: z.string().min(1).max(200).optional(),
  note: z.string().max(2000).optional(),
  status: z.enum(TODO_STATUS).optional(),
  horizon: z.enum(HORIZON).optional(),
  due: z.string().min(1).nullable().optional(),
  goal_id: z.string().min(1).nullable().optional(),
})

const ScheduleBody = z.object({ scheduled: Slot.nullable() })

const DelegateBody = z.object({
  assignment_id: z.string().min(1).optional(),
  brief: z.string().max(2000).optional(),
})

const SplitBody = z.object({
  children: z
    .array(z.object({ title: z.string().min(1).max(200), due: z.string().min(1).optional() }))
    .min(1)
    .max(20),
})

const PlanDecideBody = z.object({
  option: z.enum(['adopt', 'adjust', 'later']),
  selected_ids: z.array(z.string().min(1)).optional(),
})

const CreateReviewBody = z.object({ kind: z.enum(REVIEW_KIND).optional() })

function listQuery(c: Ctx, name: string, allowed: readonly string[]): string[] | undefined {
  const raw = c.req.query(name)
  if (raw === undefined || raw.trim() === '') return undefined
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
  for (const p of parts)
    if (!allowed.includes(p))
      throw new ApiError('invalid_input', `${name} 只能是 ${allowed.join(' / ')}`, {
        details: { value: p },
      })
  return parts
}

function positiveInt(c: Ctx, name: string): number | undefined {
  const raw = c.req.query(name)
  if (raw === undefined || raw.trim() === '') return undefined
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) throw new ApiError('invalid_input', `${name} 必须是正整数`)
  return n
}

function requiredQuery(c: Ctx, name: string): string {
  const raw = c.req.query(name)
  if (raw === undefined || raw.trim() === '')
    throw new ApiError('invalid_input', `缺少查询参数 ${name}`)
  return raw
}

export interface MatterListFilter {
  kind?: MatterKind
  status?: Matter['status'][]
  position_id?: string
  limit?: number
}

export interface TodoListFilter {
  horizon?: TodoHorizon[]
  status?: TodoStatus[]
  matter_id?: string
  goal_id?: string
  /** 只看自己的（默认 true） */
  mine?: boolean
}

/**
 * 37 工作模型端口。网关只做装配与校验，逻辑在 `@agentsws/work`，
 * 起 Run 与「命名查询算目标指标」由 `apps/server` 接上。
 */
export interface WorkPort {
  home(actor: WorkActor): MaybePromise<WorkHome>

  matters(actor: WorkActor, filter: MatterListFilter): MaybePromise<Matter[]>
  matter(actor: WorkActor, id: string): MaybePromise<WorkMatterView>
  createMatter(actor: WorkActor, input: z.infer<typeof CreateMatterBody>): MaybePromise<Matter>
  closeMatter(
    actor: WorkActor,
    id: string,
    unfinished: 'close_all' | 'keep',
  ): MaybePromise<{ matter: Matter; closed_todo_ids: string[]; kept_todo_ids: string[] }>
  timeline(
    actor: WorkActor,
    id: string,
    options: { limit?: number; before?: string },
  ): MaybePromise<{ events: MatterEvent[]; has_more: boolean }>
  /** 人在事项里说话 → 起 Run（17 §1，`work_item` 就是这个事项） */
  say(actor: WorkActor, id: string, text: string): Promise<{ event: MatterEvent; run_id?: string }>

  goals(
    actor: WorkActor,
    filter: { level?: GoalLevel; position_id?: string },
  ): MaybePromise<{ goals: Goal[]; progress: GoalProgress[] }>
  createGoal(actor: WorkActor, input: z.infer<typeof CreateGoalBody>): MaybePromise<Goal>

  todos(actor: WorkActor, filter: TodoListFilter): MaybePromise<Todo[]>
  /**
   * 记一条待办。**建之前先查**（40 §3.1）：撞上进行中的相似项时抛
   * `conflict` + `details.reason = 'similar_in_progress'` + 候选，由界面出选择题；
   * 带上 `collision` 才放行。
   */
  createTodo(actor: WorkActor, input: z.infer<typeof CreateTodoBody>): MaybePromise<Todo>

  /** 待认领池（40 §3.2）：来自会议 / 计划 / 告警的活，还没有主人 */
  pool(actor: WorkActor): MaybePromise<WorkPoolItem[]>
  /** 认领即锁：第一个成功的是主人，其余回 `conflict / already_claimed` */
  claimTodo(actor: WorkActor, id: string): MaybePromise<Todo>
  /** 转交（对方接下之前不形成责任，31 I13） */
  transferTodo(actor: WorkActor, id: string, to: PersonId): MaybePromise<Todo>
  addCollaborator(actor: WorkActor, id: string, person_id: PersonId): MaybePromise<Todo>
  /** 看得见谁在做（40 §3.3） */
  inProgress(actor: WorkActor, scope: 'position' | 'workspace'): MaybePromise<WorkInProgressItem[]>
  updateTodo(
    actor: WorkActor,
    id: string,
    patch: z.infer<typeof UpdateTodoBody>,
  ): MaybePromise<Todo>
  scheduleTodo(
    actor: WorkActor,
    id: string,
    slot: { start: string; end: string } | null,
  ): MaybePromise<Todo>
  delegateTodo(actor: WorkActor, id: string, input: z.infer<typeof DelegateBody>): Promise<Todo>
  splitTodo(
    actor: WorkActor,
    id: string,
    children: z.infer<typeof SplitBody>['children'],
  ): MaybePromise<{ parent: Todo; children: Todo[] }>

  calendar(actor: WorkActor, range: { from: string; to: string }): MaybePromise<CalendarItem[]>

  todayPlan(actor: WorkActor, refresh: boolean): MaybePromise<DailyPlan>
  decidePlan(
    actor: WorkActor,
    id: string,
    input: z.infer<typeof PlanDecideBody>,
  ): Promise<{ plan: DailyPlan; todos: Todo[] }>

  reviews(
    actor: WorkActor,
    filter: { kind?: ReviewPeriodKind; limit?: number },
  ): MaybePromise<Review[]>
  createReview(actor: WorkActor, kind: ReviewPeriodKind): MaybePromise<Review>

  /**
   * 37 §4.1：认领卡被本人接下来才形成责任（31 I13）。
   * 决定路由在 approve / approve_edited 之后调它，把 `claim` 变成一条真待办
   * （`source: 'meeting'`，`matter_id` 指向会议事项，`anchor` 指向那条产出）。
   * 不认识这张卡就回 `undefined`，什么都不发生。
   */
  acceptClaim?(actor: WorkActor, item: ApprovalItem): MaybePromise<Todo | undefined>
}

function workOf(deps: GatewayDeps): WorkPort {
  const w = deps.work
  if (w === undefined)
    throw new ApiError('not_implemented', '这个服务进程没有装配工作模型（GatewayDeps.work）')
  return w
}

type Ctx = Parameters<typeof param>[0]

function actorOf(c: Ctx): WorkActor {
  const p = principalOf(c)
  return {
    workspace_id: p.workspace_id,
    person_id: p.person_id,
    assignment_id: assignmentOf(c).id,
  }
}

const ID_PARAM = { name: 'id', in: 'path', required: true, description: '对象 id' } as const

export function workRoutes(): Route[] {
  return [
    // ── 事项 ────────────────────────────────────────────────────────
    route(
      {
        method: 'get',
        path: '/v1/matters',
        operationId: 'listMatters',
        summary: '事项列表（37 §2.2b：事项 = 上下文的家，就是正名后的 work_item）',
        tag: 'work',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [
          { name: 'kind', in: 'query', description: MATTER_KIND.join(' / ') },
          { name: 'status', in: 'query', description: `${MATTER_STATUS.join(' / ')}，逗号分隔` },
          { name: 'position_id', in: 'query', description: '按岗位筛' },
          { name: 'limit', in: 'query', description: '最多几条' },
        ],
        returns: '{ matters: Matter[] }',
      },
      async (c, deps) => {
        const actor = actorOf(c)
        const kind = listQuery(c, 'kind', MATTER_KIND)?.[0]
        const status = listQuery(c, 'status', MATTER_STATUS)
        const position_id = c.req.query('position_id')
        const limit = positiveInt(c, 'limit')
        const matters = await workOf(deps).matters(actor, {
          ...(kind === undefined ? {} : { kind: kind as MatterKind }),
          ...(status === undefined ? {} : { status: status as Matter['status'][] }),
          ...(position_id === undefined || position_id === '' ? {} : { position_id }),
          ...(limit === undefined ? {} : { limit }),
        })
        return ok(c, { matters })
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/matters',
        operationId: 'createMatter',
        summary: '开一个事项',
        tag: 'work',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        body: CreateMatterBody,
        returns: '{ matter: Matter }',
      },
      async (c, deps) => {
        const actor = actorOf(c)
        const input = await body(c, CreateMatterBody)
        return ok(c, { matter: await workOf(deps).createMatter(actor, input) }, 201)
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/matters/:id',
        operationId: 'getMatter',
        summary: '进入事项：摘要 + 固定记录 + 最近 20 条时间线 + 未完待办 + 未决的卡',
        tag: 'work',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [ID_PARAM],
        returns: 'WorkMatterView',
      },
      async (c, deps) => ok(c, await workOf(deps).matter(actorOf(c), param(c, 'id'))),
    ),
    route(
      {
        method: 'get',
        path: '/v1/matters/:id/timeline',
        operationId: 'getMatterTimeline',
        summary: '事项时间线（往前翻用 before）',
        tag: 'work',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [
          ID_PARAM,
          { name: 'limit', in: 'query', description: '取最近几条，默认 20' },
          { name: 'before', in: 'query', description: '这个时刻之前的（往前翻）' },
        ],
        returns: '{ events: MatterEvent[], has_more }',
      },
      async (c, deps) => {
        const limit = positiveInt(c, 'limit')
        const before = c.req.query('before')
        return ok(
          c,
          await workOf(deps).timeline(actorOf(c), param(c, 'id'), {
            ...(limit === undefined ? {} : { limit }),
            ...(before === undefined || before === '' ? {} : { before }),
          }),
        )
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/matters/:id/messages',
        operationId: 'postMatterMessage',
        summary: '在事项里说话（第四处对话入口，有事项边界）→ 起 Run（17 §1）',
        tag: 'work',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [ID_PARAM],
        body: MessageBody,
        returns: '{ event: MatterEvent, run_id? }',
      },
      async (c, deps) => {
        const actor = actorOf(c)
        const { text } = await body(c, MessageBody)
        return ok(c, await workOf(deps).say(actor, param(c, 'id'), text), 201)
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/matters/:id/close',
        operationId: 'closeMatter',
        summary: '关闭事项；未完待办一并关闭还是保留由调用方选（37 §2.2b）',
        tag: 'work',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [ID_PARAM],
        body: CloseMatterBody,
        returns: '{ matter, closed_todo_ids, kept_todo_ids }',
      },
      async (c, deps) => {
        const actor = actorOf(c)
        const { unfinished } = await body(c, CloseMatterBody)
        return ok(c, await workOf(deps).closeMatter(actor, param(c, 'id'), unfinished))
      },
    ),

    // ── 目标 ────────────────────────────────────────────────────────
    route(
      {
        method: 'get',
        path: '/v1/goals',
        operationId: 'listGoals',
        summary: '目标树与进度（指标复用 29 的命名查询；数在服务端算）',
        tag: 'work',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [
          { name: 'level', in: 'query', description: 'company / position / person' },
          { name: 'position_id', in: 'query', description: '按岗位筛' },
        ],
        returns: '{ goals: Goal[], progress: GoalProgress[] }',
      },
      async (c, deps) => {
        const level = listQuery(c, 'level', ['company', 'position', 'person'])?.[0]
        const position_id = c.req.query('position_id')
        return ok(
          c,
          await workOf(deps).goals(actorOf(c), {
            ...(level === undefined ? {} : { level: level as GoalLevel }),
            ...(position_id === undefined || position_id === '' ? {} : { position_id }),
          }),
        )
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/goals',
        operationId: 'createGoal',
        summary: '定一个目标（公司 / 岗位 / 个人三级）',
        tag: 'work',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        body: CreateGoalBody,
        returns: '{ goal: Goal }',
      },
      async (c, deps) =>
        ok(
          c,
          { goal: await workOf(deps).createGoal(actorOf(c), await body(c, CreateGoalBody)) },
          201,
        ),
    ),

    // ── 待办 ────────────────────────────────────────────────────────
    route(
      {
        method: 'get',
        path: '/v1/todos',
        operationId: 'listTodos',
        summary: '待办箱：backlog / 本周 / 今天（37 §2.2）',
        tag: 'work',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [
          { name: 'horizon', in: 'query', description: `${HORIZON.join(' / ')}，逗号分隔` },
          { name: 'status', in: 'query', description: `${TODO_STATUS.join(' / ')}，逗号分隔` },
          { name: 'matter_id', in: 'query', description: '某个事项下的' },
          { name: 'goal_id', in: 'query', description: '挂某个目标的' },
          { name: 'mine', in: 'query', description: '只看自己的，默认 true' },
        ],
        returns: '{ todos: Todo[] }',
      },
      async (c, deps) => {
        const horizon = listQuery(c, 'horizon', HORIZON)
        const status = listQuery(c, 'status', TODO_STATUS)
        const matter_id = c.req.query('matter_id')
        const goal_id = c.req.query('goal_id')
        const todos = await workOf(deps).todos(actorOf(c), {
          ...(horizon === undefined ? {} : { horizon: horizon as TodoHorizon[] }),
          ...(status === undefined ? {} : { status: status as TodoStatus[] }),
          ...(matter_id === undefined || matter_id === '' ? {} : { matter_id }),
          ...(goal_id === undefined || goal_id === '' ? {} : { goal_id }),
          mine: c.req.query('mine') !== 'false',
        })
        return ok(c, { todos })
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/todos',
        operationId: 'createTodo',
        summary:
          '记一条待办（人的承诺）。建之前先查撞车：命中回 409（details.reason = similar_in_progress）+ 候选',
        tag: 'work',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        body: CreateTodoBody,
        returns: '{ todo: Todo }',
      },
      async (c, deps) =>
        ok(
          c,
          { todo: await workOf(deps).createTodo(actorOf(c), await body(c, CreateTodoBody)) },
          201,
        ),
    ),
    route(
      {
        method: 'get',
        path: '/v1/todos/pool',
        operationId: 'listClaimPool',
        summary: '待认领池：会议 / 计划 / 告警抽出来的活，谁点「我来」谁是主人（40 §3.2）',
        tag: 'work',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: '{ pool: WorkPoolItem[] }',
      },
      async (c, deps) => ok(c, { pool: await workOf(deps).pool(actorOf(c)) }),
    ),
    route(
      {
        method: 'post',
        path: '/v1/todos/:id/claim',
        operationId: 'claimTodo',
        summary: '我来做这条（认领即锁；已经有人认了回 409 并附主人）',
        tag: 'work',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [ID_PARAM],
        body: ClaimBody,
        returns: '{ todo: Todo }',
      },
      async (c, deps) => {
        const actor = actorOf(c)
        await body(c, ClaimBody)
        return ok(c, { todo: await workOf(deps).claimTodo(actor, param(c, 'id')) })
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/todos/:id/transfer',
        operationId: 'transferTodo',
        summary: '转交给别人（对方接下之前不形成责任，31 I13）',
        tag: 'work',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [ID_PARAM],
        body: TransferBody,
        returns: '{ todo: Todo }',
      },
      async (c, deps) => {
        const actor = actorOf(c)
        const { to } = await body(c, TransferBody)
        return ok(c, { todo: await workOf(deps).transferTodo(actor, param(c, 'id'), to) })
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/todos/:id/collaborators',
        operationId: 'addTodoCollaborator',
        summary: '加协作者（主人还是一个）',
        tag: 'work',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [ID_PARAM],
        body: CollaboratorBody,
        returns: '{ todo: Todo }',
      },
      async (c, deps) => {
        const actor = actorOf(c)
        const { person_id } = await body(c, CollaboratorBody)
        return ok(c, {
          todo: await workOf(deps).addCollaborator(actor, param(c, 'id'), person_id),
        })
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/work/in-progress',
        operationId: 'listInProgress',
        summary: '谁在做什么：进行中的待办与事项，带主人、开始时间、卡数（40 §3.3）',
        tag: 'work',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [
          { name: 'scope', in: 'query', description: 'position（默认，本岗位）/ workspace' },
        ],
        returns: '{ items: WorkInProgressItem[], scope }',
      },
      async (c, deps) => {
        const raw = c.req.query('scope')
        if (raw !== undefined && raw !== '' && raw !== 'position' && raw !== 'workspace')
          throw new ApiError('invalid_input', 'scope 只能是 position / workspace')
        const scope = raw === 'workspace' ? 'workspace' : 'position'
        return ok(c, { items: await workOf(deps).inProgress(actorOf(c), scope), scope })
      },
    ),
    route(
      {
        method: 'put',
        path: '/v1/todos/:id',
        operationId: 'updateTodo',
        summary: '改待办：标题 / 备注 / 状态（done、dropped 就是关闭与删除）/ 改期',
        tag: 'work',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [ID_PARAM],
        body: UpdateTodoBody,
        returns: '{ todo: Todo }',
      },
      async (c, deps) => {
        const actor = actorOf(c)
        const patch = await body(c, UpdateTodoBody)
        return ok(c, { todo: await workOf(deps).updateTodo(actor, param(c, 'id'), patch) })
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/todos/:id/done',
        operationId: 'completeTodo',
        summary: '打勾 = 完成（不进事项现场）',
        tag: 'work',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [ID_PARAM],
        returns: '{ todo: Todo }',
      },
      async (c, deps) =>
        ok(c, {
          todo: await workOf(deps).updateTodo(actorOf(c), param(c, 'id'), { status: 'done' }),
        }),
    ),
    route(
      {
        method: 'post',
        path: '/v1/todos/:id/drop',
        operationId: 'dropTodo',
        summary: '关闭 / 删除（落成 dropped，留痕不真删）',
        tag: 'work',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [ID_PARAM],
        returns: '{ todo: Todo }',
      },
      async (c, deps) =>
        ok(c, {
          todo: await workOf(deps).updateTodo(actorOf(c), param(c, 'id'), { status: 'dropped' }),
        }),
    ),
    route(
      {
        method: 'post',
        path: '/v1/todos/:id/schedule',
        operationId: 'scheduleTodo',
        summary: '排期 = 写 scheduled（把待办拖到日历某天就是它，37 C3）',
        tag: 'work',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [ID_PARAM],
        body: ScheduleBody,
        returns: '{ todo: Todo }',
      },
      async (c, deps) => {
        const actor = actorOf(c)
        const { scheduled } = await body(c, ScheduleBody)
        return ok(c, { todo: await workOf(deps).scheduleTodo(actor, param(c, 'id'), scheduled) })
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/todos/:id/delegate',
        operationId: 'delegateTodo',
        summary: '委托给 Agent：在这个事项里接着做（起 Run，问题回来成卡片）',
        tag: 'work',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [ID_PARAM],
        body: DelegateBody,
        returns: '{ todo: Todo }',
      },
      async (c, deps) => {
        const actor = actorOf(c)
        const input = await body(c, DelegateBody)
        return ok(c, { todo: await workOf(deps).delegateTodo(actor, param(c, 'id'), input) })
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/todos/:id/split',
        operationId: 'splitTodo',
        summary: '长期拆短期（父子，不是两种对象）',
        tag: 'work',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [ID_PARAM],
        body: SplitBody,
        returns: '{ parent: Todo, children: Todo[] }',
      },
      async (c, deps) => {
        const actor = actorOf(c)
        const { children } = await body(c, SplitBody)
        return ok(c, await workOf(deps).splitTodo(actor, param(c, 'id'), children), 201)
      },
    ),

    // ── 日历 ────────────────────────────────────────────────────────
    route(
      {
        method: 'get',
        path: '/v1/calendar',
        operationId: 'getCalendar',
        summary: '日历：会议 / 有排期的待办 / 定时任务 / 卡片到期，四类合一份',
        tag: 'work',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [
          { name: 'from', in: 'query', required: true, description: '起（含）' },
          { name: 'to', in: 'query', required: true, description: '止（不含）' },
        ],
        returns: '{ items: CalendarItem[], from, to }',
      },
      async (c, deps) => {
        const from = requiredQuery(c, 'from')
        const to = requiredQuery(c, 'to')
        if (!Number.isFinite(Date.parse(from)) || !Number.isFinite(Date.parse(to)))
          throw new ApiError('invalid_input', 'from / to 必须是 ISO8601 时间')
        if (Date.parse(to) <= Date.parse(from))
          throw new ApiError('invalid_input', 'to 必须晚于 from')
        return ok(c, { items: await workOf(deps).calendar(actorOf(c), { from, to }), from, to })
      },
    ),

    // ── 每日计划与复盘 ──────────────────────────────────────────────
    route(
      {
        method: 'get',
        path: '/v1/plans/today',
        operationId: 'getTodayPlan',
        summary: '今天的计划建议（一天一条；它只是建议，采纳才写待办）',
        tag: 'work',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [{ name: 'refresh', in: 'query', description: 'true = 重拟一版' }],
        returns: '{ plan: DailyPlan }',
      },
      async (c, deps) =>
        ok(c, {
          plan: await workOf(deps).todayPlan(actorOf(c), c.req.query('refresh') === 'true'),
        }),
    ),
    route(
      {
        method: 'post',
        path: '/v1/plans/:id/decide',
        operationId: 'decidePlan',
        summary: '采纳 / 调整 / 稍后；「调整」带勾选清单，采纳后才写待办',
        tag: 'work',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [ID_PARAM],
        body: PlanDecideBody,
        returns: '{ plan: DailyPlan, todos: Todo[] }',
      },
      async (c, deps) => {
        const actor = actorOf(c)
        const input = await body(c, PlanDecideBody)
        if (input.option === 'adjust' && input.selected_ids === undefined)
          throw new ApiError('invalid_input', '「调整」要带 selected_ids（勾选清单）', {
            details: { reason: 'SELECTION_REQUIRED' },
          })
        return ok(c, await workOf(deps).decidePlan(actor, param(c, 'id'), input))
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/reviews',
        operationId: 'listReviews',
        summary: '复盘：目标进度、战报四格、待办完成率、会议产出、明天的计划草案',
        tag: 'work',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [
          { name: 'kind', in: 'query', description: 'day / week / month' },
          { name: 'limit', in: 'query', description: '最多几条' },
        ],
        returns: '{ reviews: Review[] }',
      },
      async (c, deps) => {
        const kind = listQuery(c, 'kind', REVIEW_KIND)?.[0]
        const limit = positiveInt(c, 'limit')
        return ok(c, {
          reviews: await workOf(deps).reviews(actorOf(c), {
            ...(kind === undefined ? {} : { kind: kind as ReviewPeriodKind }),
            ...(limit === undefined ? {} : { limit }),
          }),
        })
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/reviews',
        operationId: 'createReview',
        summary: '现在做一次复盘（默认日复盘）',
        tag: 'work',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        body: CreateReviewBody,
        returns: '{ review: Review }',
      },
      async (c, deps) => {
        const actor = actorOf(c)
        const { kind } = await body(c, CreateReviewBody)
        return ok(c, { review: await workOf(deps).createReview(actor, kind ?? 'day') }, 201)
      },
    ),
  ]
}
