/**
 * 37 工作模型端口的服务端实现。
 *
 * 这一层只做装配：`@agentsws/work` 出逻辑，审批总线出卡片，数据源出订单行，
 * 目标指标按 29 的命名查询名在服务端算（数字不经模型手）。
 *
 * 一条边界：**委托与在事项里说话都要起 Run**，运行时由调用方注入（`startRun`）；
 * 没注入时这两条路回 `not_implemented`，其余照常——工作台仍然能记事项、待办、目标。
 */
import type { WorkActor, WorkHome, WorkPoolItem, WorkPort } from '@agentsws/api'
import type {
  ApprovalItem,
  CalendarItem,
  ClaimPayload,
  Clock,
  Goal,
  GoalProgress,
  Iso8601,
  PersonId,
  StartRun,
  Todo,
  WorkStore,
} from '@agentsws/contracts'
import type { OrderRow } from '@agentsws/deck'
import {
  battleReport,
  buildReview,
  type CalendarSources,
  type CardOutcome,
  cardRefOf,
  claimOf,
  createWork,
  DAY_MS,
  ms,
  type PoolItem,
  planSummary,
  planTitle,
  poolItemOf,
  type QueryRunner,
  reviewSummary,
  reviewTitle,
  type ScheduledTaskLike,
  type Work,
} from '@agentsws/work'

/** 队列上还等着人的状态。 */
const WAITING_STATES = new Set(['pending', 'in_review'])

/**
 * 撞车候选里的 `owner` 是 person_id；界面上不该出现裸 id，所以在这里补一份展示名
 * （29 enrichment：服务端补，前端不猜）。翻译不出来就回落成 id 本身。
 */
function labelCandidates(err: unknown, label: (id: PersonId) => string): unknown {
  if (err === null || typeof err !== 'object') return err
  const rec = err as { details?: { reason?: string; candidates?: { owner: PersonId }[] } }
  const candidates = rec.details?.candidates
  if (rec.details?.reason !== 'similar_in_progress' || candidates === undefined) return err
  rec.details.candidates = candidates.map((c) => ({ ...c, owner_label: label(c.owner) }))
  return err
}

/** `PoolItem` → 网关的 `WorkPoolItem`（同形；显式抄一遍，别让内部形状漏出去）。 */
function poolItemView(item: PoolItem): WorkPoolItem {
  return {
    todo_id: item.todo_id,
    title: item.title,
    source: item.source,
    pooled_at: item.pooled_at,
    recycled: item.recycled,
    similar_to: item.similar_to,
    ...(item.note === undefined ? {} : { note: item.note }),
    ...(item.position_id === undefined ? {} : { position_id: item.position_id }),
    ...(item.matter_id === undefined ? {} : { matter_id: item.matter_id }),
    ...(item.due === undefined ? {} : { due: item.due }),
  }
}

export interface WorkPortOptions {
  clock: Clock
  work: Work
  /** 本人可见的审批项（已按 recipient 过滤）——卡片到期叠层与战报四格都从它数 */
  approvals(actor: WorkActor): Promise<ApprovalItem[]> | ApprovalItem[]
  /** 店铺侧订单行；目标指标从它算 */
  orders(): OrderRow[]
  /** ObjectRef → 人话 */
  label(ref: { type: string; id: string }): string | undefined
  /** 25 的定时任务；不给就是没有 */
  scheduledTasks?(actor: WorkActor): ScheduledTaskLike[]
  /** WP23 的会议；不给就是没有（会议上日历，37 §2 表第三行） */
  meetings?(
    actor: WorkActor,
    range: { from: Iso8601; to: Iso8601 },
  ): Promise<CalendarItem[]> | CalendarItem[]
  /** 24 的 lesson，进复盘的「Agent 学到的」 */
  lessons?(actor: WorkActor): { id: string; text: string }[]
}

/**
 * 目标指标：**按目标自己的期间**跑 29 的命名查询。
 *
 * `@agentsws/deck` 的 `runQuery` 只认「昨天 / 近 7 天」两个窗口（36 §3 的数字块就那两档），
 * 而目标是周 / 月 / 季，所以窗口在这里自己切，行的语义与 deck 逐条对齐（同一批 `OrderRow`）。
 * 不认识的查询名回 `undefined` → 进度显示 `no_data`，而不是编一个数。
 */
export function periodQueryRunner(
  orders: () => OrderRow[],
  approvals: () => ApprovalItem[],
  base_currency: string,
): QueryRunner {
  return (goal: Goal) => {
    const from = ms(goal.period.start)
    const to = ms(goal.period.end)
    const inWindow = (at: Iso8601): boolean => {
      const t = ms(at)
      return t >= from && t < to
    }
    const rows = orders().filter((o) => inWindow(o.created_at))
    switch (goal.metric.query) {
      case 'sales.total':
        return {
          value: round2(rows.reduce((s, o) => s + o.total_price - o.refunded_amount, 0)),
          currency: base_currency,
        }
      case 'orders.count':
        return { value: rows.length }
      case 'refunds.total':
        return {
          value: round2(rows.reduce((s, o) => s + o.refunded_amount, 0)),
          currency: base_currency,
        }
      case 'approvals.pending_replies':
        return {
          value: approvals().filter((i) => WAITING_STATES.has(i.state) && inWindow(i.created_at))
            .length,
        }
      default:
        return undefined
    }
  }
}

function round2(v: number): number {
  return Math.round(v * 100) / 100
}

function outcomeOf(item: ApprovalItem): CardOutcome {
  const by = item.decision?.by
  return {
    id: item.id,
    kind: item.kind,
    state: item.state,
    auto_approved: item.automation.auto_approved || item.state === 'auto_approved',
    decided_by_person: by !== undefined && by !== 'mandate',
    applied: item.state === 'applied',
    blocked: item.state === 'blocked',
  }
}

export function createWorkPort(options: WorkPortOptions): WorkPort {
  const work = options.work

  const cardsOf = async (actor: WorkActor): Promise<ApprovalItem[]> => options.approvals(actor)

  const waitingCount = (items: readonly ApprovalItem[]): number =>
    items.filter((i) => WAITING_STATES.has(i.state)).length

  const sourcesFor = async (
    actor: WorkActor,
    range: { from: Iso8601; to: Iso8601 },
    cards: readonly ApprovalItem[],
  ): Promise<CalendarSources> => ({
    cards: cards.filter((i) => WAITING_STATES.has(i.state)),
    ...(options.scheduledTasks === undefined ? {} : { tasks: options.scheduledTasks(actor) }),
    ...(options.meetings === undefined ? {} : { meetings: await options.meetings(actor, range) }),
  })

  const runnerFor = (cards: readonly ApprovalItem[]): QueryRunner =>
    periodQueryRunner(options.orders, () => [...cards], 'USD')

  const progressFor = async (
    actor: WorkActor,
    filter: { level?: Goal['level']; position_id?: string } = {},
  ): Promise<GoalProgress[]> => {
    const cards = await cardsOf(actor)
    return work.progress(runnerFor(cards), { ...filter, status: ['active'] })
  }

  const todayDue = (person_id: PersonId): Todo[] =>
    work.listTodos({ owner: person_id, horizon: ['today'], status: ['open', 'doing', 'blocked'] })

  return {
    async home(actor): Promise<WorkHome> {
      const cards = await cardsOf(actor)
      const range = work.todayRange()
      const review = work.latestReview(actor.person_id, 'day')
      const dayStart = ms(range.from)
      const plan = work.store.findPlan(work.workspace_id, actor.person_id, work.todayDate())
      return {
        goals: await progressFor(actor),
        // 白天的四格战报：今天动过的卡
        report: battleReport(cards.filter((i) => ms(i.updated_at) >= dayStart).map(outcomeOf)),
        today: {
          timeline: work.calendar(
            range,
            { person_id: actor.person_id },
            await sourcesFor(actor, range, cards),
          ),
          due: { todos: todayDue(actor.person_id), cards_waiting: waitingCount(cards) },
        },
        ...(review === undefined ? {} : { review }),
        ...(plan === undefined ? {} : { plan }),
      }
    },

    matters: (_actor, filter) => work.listMatters(filter),
    matter: (_actor, id) => {
      const view = work.matterView(id, { label: (ref) => options.label(ref) })
      return {
        ...view,
        // 40 §3.3：事项页显示参与者（展示名由服务端补，翻译不出来回落成 id）
        participant_labels: view.matter.context.participants.map((person_id) => ({
          person_id,
          label: options.label({ type: 'person', id: person_id }) ?? person_id,
        })),
      }
    },
    createMatter: (actor, input) =>
      work.createMatter({
        ...input,
        position_id: actor.assignment_id,
        participants: [actor.person_id],
      }),
    closeMatter: (actor, id, unfinished) =>
      work.closeMatter(id, { unfinished, by: actor.person_id }),
    timeline: (_actor, id, opts) => {
      const events = work.store.listMatterEvents(id, opts)
      return { events, has_more: work.store.countMatterEvents(id) > events.length }
    },
    say: (actor, id, text) =>
      work.say(id, { person_id: actor.person_id, assignment_id: actor.assignment_id, text }),

    async goals(actor, filter) {
      return {
        goals: work.listGoals(filter),
        progress: await progressFor(actor, filter),
      }
    },
    createGoal: (actor, input) => work.createGoal({ ...input, owner: actor.person_id }),

    todos: (actor, filter) =>
      work.listTodos({
        ...(filter.mine === false ? {} : { owner: actor.person_id }),
        ...(filter.horizon === undefined ? {} : { horizon: filter.horizon }),
        ...(filter.status === undefined ? {} : { status: filter.status }),
        ...(filter.matter_id === undefined ? {} : { matter_id: filter.matter_id }),
        ...(filter.goal_id === undefined ? {} : { goal_id: filter.goal_id }),
      }),
    /**
     * 40 §3.1「建之前先查」：撞上进行中的相似项就不建，抛 `conflict` 带候选
     * （网关映射成 409，`details.reason = 'similar_in_progress'`）。
     * 带上 `collision` 才放行：`join` 加进对方的事项、`handoff` 交给对方、`force` 要写一句区别。
     */
    createTodo: (actor, input) => {
      try {
        return work.createTodoChecked({
          ...input,
          owner: actor.person_id,
          position_id: actor.assignment_id,
        }).todo
      } catch (err) {
        throw labelCandidates(err, (id) => options.label({ type: 'person', id }) ?? id)
      }
    },

    pool: (actor) => [
      ...work.poolView({ position_id: actor.assignment_id }).map(poolItemView),
      // 「交给你」的那几条也挂在这一区：它们同样是「等你点头才形成责任」
      ...work.offeredTo(actor.person_id).map((t) => {
        const c = claimOf(t)
        return {
          ...poolItemView(poolItemOf(t)),
          ...(c.offered_by === undefined ? {} : { offered_by: c.offered_by }),
        }
      }),
    ],

    claimTodo: (actor, id) =>
      work.claimTodo(id, actor.person_id, { position_id: actor.assignment_id }),
    transferTodo: (actor, id, to) => work.transferTodo(id, { to, by: actor.person_id }),
    addCollaborator: (_actor, id, person_id) => work.addCollaborator(id, person_id),

    inProgress: (actor, scope) =>
      work
        .inProgress(scope === 'workspace' ? {} : { position_id: actor.assignment_id, scope })
        .map((i) => ({
          kind: i.kind,
          id: i.id,
          title: i.title,
          owner: i.owner,
          // 展示名由服务端补（29 enrichment）；数据源翻译不出来就回落成 id
          owner_label: options.label({ type: 'person', id: i.owner }) ?? i.owner,
          collaborators: i.collaborators,
          status: i.status,
          started_at: i.started_at,
          last_activity: i.last_activity,
          cards: i.cards,
          ...(i.position_id === undefined ? {} : { position_id: i.position_id }),
          ...(i.matter_id === undefined ? {} : { matter_id: i.matter_id }),
        })),
    updateTodo: (_actor, id, patch) => work.updateTodo(id, patch),
    scheduleTodo: (_actor, id, slot) => work.schedule(id, slot),
    delegateTodo: (actor, id, input) =>
      work.delegate(id, {
        assignment_id: input.assignment_id ?? actor.assignment_id,
        by: actor.person_id,
        ...(input.brief === undefined ? {} : { brief: input.brief }),
      }),
    splitTodo: (_actor, id, children) => work.splitTodo(id, children),

    async calendar(actor, range) {
      const cards = await cardsOf(actor)
      return work.calendar(
        range,
        { person_id: actor.person_id },
        await sourcesFor(actor, range, cards),
      )
    },

    async todayPlan(actor, refresh) {
      const cards = await cardsOf(actor)
      const range = work.todayRange()
      const meetings = work
        .calendar(range, { person_id: actor.person_id }, await sourcesFor(actor, range, cards))
        .filter((i) => i.source === 'meeting')
      return work.todayPlan({
        person_id: actor.person_id,
        goals: await progressFor(actor),
        today_meetings: meetings,
        cards_waiting: waitingCount(cards),
        delegate_to: actor.assignment_id,
        refresh,
      })
    },
    decidePlan: async (actor, id, input) => {
      if (input.option === 'later') return { plan: work.deferPlan(id), todos: [] }
      return work.adoptPlan(id, {
        by: actor.person_id,
        ...(input.option === 'adjust' ? { selected_ids: input.selected_ids ?? [] } : {}),
      })
    },

    reviews: (actor, filter) => work.listReviews({ person_id: actor.person_id, ...filter }),
    async createReview(actor, kind) {
      const cards = await cardsOf(actor)
      const range = work.todayRange()
      const span = kind === 'day' ? 1 : kind === 'week' ? 7 : 30
      const start = new Date(ms(range.to) - span * DAY_MS).toISOString()
      const sources = await sourcesFor(actor, range, cards)
      const meetings = work
        .calendar(range, { person_id: actor.person_id }, sources)
        .filter((i) => i.source === 'meeting')
      const draft = buildReview({
        now: work.now(),
        person_id: actor.person_id,
        tz_offset_minutes: work.tz_offset_minutes,
        period: { kind, start, end: range.to },
        goals: await progressFor(actor),
        cards_events: cards.filter((i) => ms(i.updated_at) >= ms(start)).map(outcomeOf),
        todos: todayDue(actor.person_id),
        meetings,
        ...(options.lessons === undefined ? {} : { lessons: options.lessons(actor) }),
        tomorrow: {
          now: new Date(ms(work.now()) + DAY_MS).toISOString(),
          todos: work.inbox(actor.person_id),
          today_meetings: [],
          cards_waiting: waitingCount(cards),
          delegate_to: actor.assignment_id,
        },
      })
      return work.saveReview(draft)
    },

    /**
     * 37 §4.1：认领卡接下来 → 一条真待办。
     *
     * `source: 'meeting'`，`matter_id` 指向会议事项（`ClaimPayload.matter_id` 由会议侧回填），
     * `anchor` 指向事项时间线上那条产出——点待办标题就回到会议现场的那一处（37 §2.2b）。
     * **本人确认前不形成责任**（31 I13）：这一步只在本人按下"接"之后才发生。
     */
    acceptClaim(actor, item) {
      const payload = item.payload as ClaimPayload | undefined
      if (payload?.form !== 'claim') return undefined
      const matter_id = payload.matter_id
      // 同一张卡按两次不重复建（认领卡的 dedupe_key 稳定，卡本身也只能决定一次）
      const existing = work
        .listTodos({ owner: actor.person_id, ...(matter_id === undefined ? {} : { matter_id }) })
        .find((t) => t.origin?.card_id === item.id)
      if (existing !== undefined) return existing
      /**
       * 40 §3.2「认领卡批准 = 认领」：会议侧已经把这条活放进待认领池了，
       * 批准这张卡就是从池里把它认下来——**第一个成功的是主人**，
       * 别人再点同一张卡会拿到 `conflict / already_claimed`。
       */
      const pooled = work.pool().find((t) => t.origin?.card_id === item.id)
      if (pooled !== undefined)
        return work.claimTodo(pooled.id, actor.person_id, { position_id: actor.assignment_id })
      const anchor =
        matter_id === undefined
          ? undefined
          : work.store
              .listMatterEvents(matter_id, { limit: 500 })
              .find((e) => e.text === payload.text)
      return work.createTodo({
        title: payload.text,
        owner: actor.person_id,
        source: 'meeting',
        position_id: actor.assignment_id,
        origin: { card_id: item.id },
        ...(matter_id === undefined ? {} : { matter_id }),
        ...(anchor === undefined ? {} : { anchor: { matter_event_id: anchor.id } }),
        ...(payload.due === undefined ? {} : { due: payload.due }),
      })
    },
  }
}

/** demo 与服务进程共用的装配：给了 store 就落盘，没给就是内存档。 */
export function createWorkModel(options: {
  workspace_id: string
  clock: Clock
  random?: () => number
  store?: WorkStore
  startRun?: StartRun
  tz_offset_minutes?: number
}): Work {
  return createWork(options)
}

export type { CardOutcome }
export { battleReport, cardRefOf, planSummary, planTitle, reviewSummary, reviewTitle }
