/**
 * 25 的装配：调度器 + 流程引擎，以及**七个消费者**各自的一个函数。
 *
 * 这一层的规矩：
 * - 调度器不认识业务，业务不认识调度器。中间只有一个名字（`handler`）。
 * - 每个消费者一个 `registerXxx`，各自 try/catch 在调度器里——**一个挂了不影响别的**。
 * - 任务 id 固定（`sched_daily_plan_<assignment>`），所以重启不会重复建；
 *   用户改过时间 / 按过暂停的，重启后**照他改的来**（`ensure` 只在没有时建）。
 * - 时间只经注入的 Clock；工作区时区从数据源来，不读机器本地时区。
 *
 * 七个消费者（38 §2 WP27 那一行）：
 * ① 每日计划（每岗位 08:00）② 复盘（20:00 / 周五加周复盘 / 月末加月复盘）
 * ③ 会议记录源轮询（15 分钟）④ 幂等表清理（每小时）⑤ Shopify 令牌刷新（到期前 1 小时）
 * ⑥ 技能周合并（周一 06:00）⑦ 复盘 → 次日计划草案的接力（复盘跑完注册一个 at 任务）
 */
import { join } from 'node:path'
import type { SweepableIdempotencyStore } from '@agentsws/api'
import type {
  ApprovalBus,
  ApprovalItem,
  Clock,
  DailyPlanDraft,
  EventEnvelope,
  GoalProgress,
  Iso8601,
  MeetingRecordSource,
  PersonId,
  Review,
  RoleId,
  WorkspaceId,
} from '@agentsws/contracts'
import {
  createScheduler,
  createSqliteScheduleStore,
  createWorkflowEngine,
  type FireOutcome,
  MemoryScheduleStore,
  type ScheduleInput,
  type Scheduler,
  type ScheduleStore,
  type ScheduleTask,
  type WorkflowEngine,
  wallClock,
} from '@agentsws/schedule'
import {
  buildReview,
  DAY_MS,
  planSummary,
  planTitle,
  reviewSummary,
  reviewTitle,
  type Work,
} from '@agentsws/work'
import type { MeetingsAssembly } from './meetings.js'

/** 每个消费者的登记名。改名字要同时改工作台的 i18n（列表上显示的是它）。 */
export const HANDLERS = {
  dailyPlan: 'work.daily_plan',
  review: 'work.review',
  planFromReview: 'work.plan_from_review',
  meetingsPoll: 'meetings.poll',
  idempotencySweep: 'api.idempotency_sweep',
  shopifyRefresh: 'connect.shopify_refresh',
  skillsWeekly: 'skills.weekly_consolidate',
} as const

/** 令牌到期前多久换新的（25 交付：Shopify 客户端凭据 24 小时到期）。 */
export const TOKEN_REFRESH_LEAD_MS = 60 * 60 * 1000
/** 没有连接可查时隔多久再看一眼。 */
export const TOKEN_IDLE_INTERVAL_MS = 60 * 60 * 1000

/** 一个岗位（本人持有的一条 Assignment）；每日计划与复盘按它一条一条来。 */
export interface SchedulePosition {
  assignment_id: string
  person_id: PersonId
  role_id: RoleId
}

export interface ScheduleAssemblyOptions {
  workspace_id: WorkspaceId
  clock: Clock
  random?: () => number
  /** 给了数据目录就落盘（重启续跑）；不给就是内存档。 */
  dbDir?: string
  /** 事件出口：与别的模块同一条日志（21 §1）。 */
  appendEvent(e: Omit<EventEnvelope, 'id' | 'at'> & { at?: string }): void
  /** 工作区时区（`+08:00` / `Asia/Shanghai`）；cron 按它算。 */
  tz?: string
  /** 真实进程里巡检的间隔；`0` = 不起定时器（测试与模拟回路自己驱动 `runDue`）。 */
  intervalMs?: number
}

export interface ScheduleAssembly {
  scheduler: Scheduler
  workflows: WorkflowEngine
  store: ScheduleStore
  /** 真实进程：起巡检定时器。 */
  start(): void
  close(): void
}

const iso = (ms: number): Iso8601 => new Date(ms).toISOString()

export function createScheduleAssembly(options: ScheduleAssemblyOptions): ScheduleAssembly {
  const { clock } = options
  const store: ScheduleStore =
    options.dbDir === undefined
      ? new MemoryScheduleStore()
      : createSqliteScheduleStore({ dbPath: join(options.dbDir, 'schedule.sqlite'), clock })

  const eventSink = (e: {
    type: string
    workspace_id: WorkspaceId
    at: Iso8601
    subject?: { type: string; id: string }
    payload: Record<string, unknown>
  }): void => {
    options.appendEvent({
      schema_version: 1,
      workspace_id: e.workspace_id,
      type: e.type,
      at: e.at,
      actor: { kind: 'system', id: 'schedule' },
      ...(e.subject === undefined ? {} : { subject: e.subject }),
      correlation: { trace_id: `tr_sched_${e.at}` },
      payload: e.payload,
    })
  }

  const scheduler = createScheduler({
    clock,
    store,
    eventSink,
    ...(options.random === undefined ? {} : { random: options.random }),
    ...(options.intervalMs === undefined ? {} : { intervalMs: options.intervalMs }),
  })
  const workflows = createWorkflowEngine({
    clock,
    store,
    eventSink,
    ...(options.random === undefined ? {} : { random: options.random }),
  })

  return {
    scheduler,
    workflows,
    store,
    start() {
      if (options.intervalMs === 0) return
      scheduler.start()
    },
    close() {
      scheduler.close()
    },
  }
}

/**
 * 建一条固定 id 的系统任务：**已经有了就不动它**。
 *
 * 为什么不覆盖：用户可能把「每天 08:00 出计划」改成了 09:00、或者干脆停掉了。
 * 重启一次就给他改回来，那这个界面上的开关就是假的。
 */
export function ensureTask(
  scheduler: Scheduler,
  id: string,
  input: Omit<ScheduleInput, 'id'>,
): Promise<ScheduleTask> | ScheduleTask {
  const existing = scheduler.get(id)
  if (existing !== undefined) return existing
  return scheduler.schedule({ ...input, id })
}

/** 一条系统任务除了「谁的」之外要填的东西；`created_by` / `misfire_policy` 有默认值。 */
type SystemTaskSpec = Omit<
  ScheduleInput,
  'workspace_id' | 'owner' | 'role_id' | 'assignment_id' | 'created_by' | 'misfire_policy'
> & { created_by?: ScheduleInput['created_by']; misfire_policy?: ScheduleInput['misfire_policy'] }

/** 系统自己的巡检任务：没有对话，挂在持有它的那个岗位名下。 */
function systemTask(
  base: { workspace_id: WorkspaceId; owner: PersonId; role_id: RoleId; assignment_id: string },
  over: SystemTaskSpec,
): Omit<ScheduleInput, 'id'> {
  return {
    ...base,
    created_by: 'user',
    // 系统巡检错过了默认跳过：补跑一堆过期的清理没有意义
    misfire_policy: 'skip',
    ...over,
  }
}

/* ------------------------------------------------------------------ */
/* ① 每日计划：每岗位每天早上（工作区时区 08:00）                          */
/* ------------------------------------------------------------------ */

export interface PlanDeps {
  workspace_id: WorkspaceId
  work: Work
  approvals: ApprovalBus
  positions(): SchedulePosition[]
  /** 目标进度；不给就是空（计划里那一段不出） */
  goals?(position: SchedulePosition): Promise<GoalProgress[]> | GoalProgress[]
  /** 本人队列里等着定的卡数 */
  cardsWaiting?(position: SchedulePosition): Promise<number> | number
  tz: string
}

/** 一张 `daily_plan` 卡（37 §2.4 早上；payload 就是计划草案，选择题：采纳 / 调整 / 稍后）。 */
async function createPlanCard(
  deps: PlanDeps,
  position: SchedulePosition,
  plan: DailyPlanDraft & { id: string; date: string },
): Promise<ApprovalItem> {
  return deps.approvals.create({
    workspace_id: deps.workspace_id,
    schema_version: 1,
    kind: 'daily_plan',
    role_id: position.role_id,
    subject: { object: { type: 'daily_plan', id: plan.id } },
    dedupe_key: `${deps.workspace_id}:daily_plan:${position.assignment_id}:${plan.date}`,
    title: planTitle(plan),
    summary: planSummary(plan),
    payload: plan,
    evidence: { source_events: [], provenance: { seen: [] }, precheck: {} },
    proposer: { kind: 'system', id: 'work.planner' },
    automation: {
      level_at_creation: 'L1',
      auto_approved: false,
      mandate_check: { within: true, caps_hit: [] },
      sampling: { selected: false },
    },
    routing: {
      recipients: [{ person: position.person_id, via: 'role_holder' }],
      rule: 'role_holder',
      escalation: { after_hours: 24, business_hours: true, chain: ['owner'], escalated_at: [] },
      separation_of_duties: false,
    },
    priority: 'queue',
    options: plan.options.map((o) => ({ id: o.id, label: o.label })),
  }) as Promise<ApprovalItem>
}

/** 拟一天的计划并出卡；一天一条（`todayPlan` 自己去重），卡也按天去重。 */
export async function draftPlansFor(deps: PlanDeps): Promise<{ plans: string[] }> {
  const plans: string[] = []
  for (const position of deps.positions()) {
    const plan = deps.work.todayPlan({
      person_id: position.person_id,
      goals: (await deps.goals?.(position)) ?? [],
      cards_waiting: (await deps.cardsWaiting?.(position)) ?? 0,
      delegate_to: position.assignment_id,
    })
    if (plan.approval_item_id === undefined) {
      const card = await createPlanCard(deps, position, plan)
      deps.work.linkPlanApproval(plan.id, card.id)
    }
    plans.push(plan.id)
  }
  return { plans }
}

export function registerDailyPlan(scheduler: Scheduler, deps: PlanDeps): void {
  scheduler.register(HANDLERS.dailyPlan, () => draftPlansFor(deps))
}

/* ------------------------------------------------------------------ */
/* ② 复盘：每天 20:00；周五加周复盘；月末加月复盘                          */
/* ------------------------------------------------------------------ */

export interface ReviewDeps extends PlanDeps {
  /** 本人可见的审批项（战报四格从它数） */
  cards(position: SchedulePosition): Promise<ApprovalItem[]> | ApprovalItem[]
  /** 24 的 lesson，进复盘的「Agent 学到的」 */
  lessons?(position: SchedulePosition): { id: string; text: string }[]
  /** 复盘跑完把「明天的计划草案」接力成一个 `at` 任务（消费者 ⑦） */
  relay?(review: Review, position: SchedulePosition): Promise<void> | void
}

const WAITING_STATES = new Set(['pending', 'in_review'])
const SPAN_DAYS = { day: 1, week: 7, month: 30 } as const

function outcomeOf(item: ApprovalItem) {
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

/** 一张 `review` 卡（37 §2.4 晚上；payload = ReviewDraft，含明天的计划草案）。 */
async function createReviewCard(
  deps: ReviewDeps,
  position: SchedulePosition,
  review: Review,
): Promise<ApprovalItem> {
  return deps.approvals.create({
    workspace_id: deps.workspace_id,
    schema_version: 1,
    kind: 'review',
    role_id: position.role_id,
    subject: { object: { type: 'review', id: review.id } },
    dedupe_key: `${deps.workspace_id}:review:${position.assignment_id}:${review.period.kind}:${review.period.end}`,
    title: reviewTitle(review),
    summary: reviewSummary(review),
    payload: review,
    evidence: { source_events: [], provenance: { seen: [] }, precheck: {} },
    proposer: { kind: 'system', id: 'work.reviewer' },
    automation: {
      level_at_creation: 'L1',
      auto_approved: false,
      mandate_check: { within: true, caps_hit: [] },
      sampling: { selected: false },
    },
    routing: {
      recipients: [{ person: position.person_id, via: 'role_holder' }],
      rule: 'role_holder',
      escalation: { after_hours: 24, business_hours: true, chain: ['owner'], escalated_at: [] },
      separation_of_duties: false,
    },
    priority: 'queue',
  }) as Promise<ApprovalItem>
}

/**
 * 跑一次复盘。`kind` 决定回看多久：day / week / month 是**同一张卡的长周期版本**
 * （37 §2.4），不是三种不同的卡。
 */
export async function buildReviewsFor(
  deps: ReviewDeps,
  kind: 'day' | 'week' | 'month',
): Promise<{ reviews: string[] }> {
  const reviews: string[] = []
  const work = deps.work
  const range = work.todayRange()
  const start = iso(Date.parse(range.to) - SPAN_DAYS[kind] * DAY_MS)
  for (const position of deps.positions()) {
    const cards = await deps.cards(position)
    const waiting = cards.filter((i) => WAITING_STATES.has(i.state)).length
    const draft = buildReview({
      now: work.now(),
      person_id: position.person_id,
      tz_offset_minutes: work.tz_offset_minutes,
      period: { kind, start, end: range.to },
      goals: (await deps.goals?.(position)) ?? [],
      cards_events: cards
        .filter((i) => Date.parse(i.updated_at) >= Date.parse(start))
        .map(outcomeOf),
      todos: work.listTodos({
        owner: position.person_id,
        horizon: ['today'],
        status: ['open', 'doing', 'blocked'],
      }),
      meetings: [],
      ...(deps.lessons === undefined ? {} : { lessons: deps.lessons(position) }),
      tomorrow: {
        now: iso(Date.parse(work.now()) + DAY_MS),
        todos: work.inbox(position.person_id),
        today_meetings: [],
        cards_waiting: waiting,
        delegate_to: position.assignment_id,
      },
    })
    const review = work.saveReview(draft)
    await createReviewCard(deps, position, review)
    reviews.push(review.id)
    await deps.relay?.(review, position)
  }
  return { reviews }
}

/** 今天是不是这个月的最后一天（按工作区时区）。cron 不认识「月末」，只能这样判。 */
export function isMonthEnd(now: Iso8601, tz: string): boolean {
  const today = wallClock(Date.parse(now), tz)
  const tomorrow = wallClock(Date.parse(now) + DAY_MS, tz)
  return today.month !== tomorrow.month
}

export function registerReview(scheduler: Scheduler, deps: ReviewDeps): void {
  scheduler.register(HANDLERS.review, (ctx) => {
    const kind = (ctx.task.params?.kind ?? 'day') as 'day' | 'week' | 'month'
    // 月复盘那条 cron 排在 28–31 号（cron 没有「月末」），真到不到月末在这里判
    if (kind === 'month' && !isMonthEnd(ctx.at, deps.tz)) {
      return { skipped: 'not_month_end' }
    }
    return buildReviewsFor(deps, kind)
  })
}

/* ------------------------------------------------------------------ */
/* ⑦ 复盘 → 次日计划草案的接力                                            */
/* ------------------------------------------------------------------ */

/** 明天早上 07:55（本地）：赶在 08:00 那条计划任务之前，把复盘产物变成草案。 */
export function nextMorningAt(now: Iso8601, tz: string, hour = 7, minute = 55): Iso8601 {
  const nowMs = Date.parse(now)
  const w = wallClock(nowMs, tz)
  const localMidnight = Date.UTC(w.year, w.month - 1, w.day) - w.offset * 60_000
  return iso(localMidnight + DAY_MS + hour * 3600_000 + minute * 60_000)
}

export interface RelayDeps {
  workspace_id: WorkspaceId
  scheduler: Scheduler
  work: Work
  tz: string
}

/**
 * 复盘跑完 → 注册一个一次性任务，明早把 `next_plan_draft` 落成明天的 `DailyPlan`。
 *
 * 为什么要接力而不是当场写：计划是「明天的」，当场写会占掉明天早上那条
 * `todayPlan` 的位置，用户第二天看到的就是昨晚拍的脑袋，而不是早上的真实情况。
 */
export function registerPlanRelay(deps: RelayDeps): (review: Review) => Promise<void> {
  deps.scheduler.register(HANDLERS.planFromReview, (ctx) => {
    const review_id = String(ctx.task.params?.review_id ?? '')
    const review = deps.work.listReviews({ limit: 50 }).find((r: Review) => r.id === review_id)
    if (review === undefined) return { skipped: 'review_gone' }
    // 只是「已注册的草案」：真正出卡还是明早那条 daily_plan 任务干的
    return { review_id, suggestions: review.next_plan_draft.suggestions.length }
  })
  return async (review: Review) => {
    if (review.period.kind !== 'day') return
    await deps.scheduler.schedule({
      workspace_id: deps.workspace_id,
      owner: review.person_id,
      role_id: 'common.member',
      assignment_id: 'system',
      title: '把昨晚复盘的产物接成今天的计划草案',
      handler: HANDLERS.planFromReview,
      params: { review_id: review.id },
      trigger: { kind: 'once', at: nextMorningAt(deps.work.now(), deps.tz) },
      created_by: 'user',
      misfire_policy: 'run_once_now',
    })
  }
}

/* ------------------------------------------------------------------ */
/* ③ 会议记录源轮询：每 15 分钟                                           */
/* ------------------------------------------------------------------ */

export interface MeetingPollDeps {
  workspace_id: WorkspaceId
  clock: Clock
  meetings: MeetingsAssembly
  actor: PersonId
}

/**
 * 只拉 `mode: 'poll'` 且实现了 `poll` 的来源。内核自带的六个都是 manual / device_sync
 * （实时入会属付费增强，37 §4.2），所以默认档下这条任务每 15 分钟跑一次、拉到零条——
 * 装了付费应用之后不用改一行装配就开始工作。
 */
export async function pollMeetingSources(
  deps: MeetingPollDeps,
): Promise<{ polled: number; drafts: number; failed: string[] }> {
  const sources: MeetingRecordSource[] = deps.meetings.pipeline.sources.list()
  const ctx = { workspace_id: deps.workspace_id, actor: deps.actor, now: deps.clock.now() }
  let polled = 0
  let drafts = 0
  const failed: string[] = []
  for (const source of sources) {
    if (source.mode !== 'poll' || source.poll === undefined) continue
    polled += 1
    try {
      // 一个来源拉不动不该拖垮别的来源
      drafts += (await source.poll(ctx)).length
    } catch {
      failed.push(source.id)
    }
  }
  return { polled, drafts, failed }
}

export function registerMeetingPoll(scheduler: Scheduler, deps: MeetingPollDeps): void {
  scheduler.register(HANDLERS.meetingsPoll, () => pollMeetingSources(deps))
}

/* ------------------------------------------------------------------ */
/* ④ 幂等表清理：每小时                                                   */
/* ------------------------------------------------------------------ */

export function registerIdempotencySweep(
  scheduler: Scheduler,
  deps: { clock: Clock; store: SweepableIdempotencyStore },
): void {
  scheduler.register(HANDLERS.idempotencySweep, () => ({ removed: deps.store.sweep(deps.clock) }))
}

/* ------------------------------------------------------------------ */
/* ⑤ Shopify 令牌刷新：到期前 1 小时                                      */
/* ------------------------------------------------------------------ */

export interface TokenRefreshDeps {
  clock: Clock
  scheduler: Scheduler
  refreshTokens(): Promise<void>
  /** 现有连接的到期时刻；下一次巡检就排在最早那条的到期前一小时 */
  expiries(): Iso8601[]
}

/** 下一次什么时候看：最早到期的那条减一小时；一条都没有就一小时后再看。 */
export function nextTokenCheck(deps: TokenRefreshDeps, now: Iso8601): Iso8601 {
  const nowMs = Date.parse(now)
  const times = deps
    .expiries()
    .map((t) => Date.parse(t))
    .filter((t) => Number.isFinite(t))
  const earliest = times.length === 0 ? undefined : Math.min(...times)
  const wanted =
    earliest === undefined ? nowMs + TOKEN_IDLE_INTERVAL_MS : earliest - TOKEN_REFRESH_LEAD_MS
  // 至少一分钟以后，别把自己排成死循环
  return iso(Math.max(wanted, nowMs + 60_000))
}

export function registerTokenRefresh(deps: TokenRefreshDeps): void {
  deps.scheduler.register(HANDLERS.shopifyRefresh, async (ctx) => {
    await deps.refreshTokens()
    const at = nextTokenCheck(deps, ctx.at)
    await deps.scheduler.update(ctx.task.id, { trigger: { kind: 'once', at } })
    return { next_check: at }
  })
}

/* ------------------------------------------------------------------ */
/* ⑥ 技能周合并：每周一 06:00                                             */
/* ------------------------------------------------------------------ */

export interface SkillsWeeklyDeps {
  workspace_id: WorkspaceId
  clock: Clock
  weeklyConsolidate(workspace_id: WorkspaceId, now: Iso8601): Promise<{ proposals: unknown[] }>
}

export function registerSkillsWeekly(scheduler: Scheduler, deps: SkillsWeeklyDeps): void {
  scheduler.register(HANDLERS.skillsWeekly, async () => {
    const { proposals } = await deps.weeklyConsolidate(deps.workspace_id, deps.clock.now())
    return { proposals: proposals.length }
  })
}

/* ------------------------------------------------------------------ */
/* 排期：七条任务的时间表                                                  */
/* ------------------------------------------------------------------ */

export interface SchedulePlanOptions {
  workspace_id: WorkspaceId
  owner: PersonId
  role_id: RoleId
  assignment_id: string
  tz: string
  /** 每个岗位一条计划任务与一条复盘任务 */
  positions: SchedulePosition[]
  /** 装了哪些消费者：没装的不建任务（列表上不会出现一条永远失败的东西） */
  has: {
    work?: boolean
    meetings?: boolean
    idempotency?: boolean
    shopify?: boolean
    skills?: boolean
  }
}

/** 建齐七条任务。已经存在的（用户改过时间 / 停过）不动。 */
export async function ensureSystemTasks(
  scheduler: Scheduler,
  options: SchedulePlanOptions,
): Promise<ScheduleTask[]> {
  const { tz } = options
  const base = {
    workspace_id: options.workspace_id,
    owner: options.owner,
    role_id: options.role_id,
    assignment_id: options.assignment_id,
  }
  const out: ScheduleTask[] = []
  const add = async (id: string, input: Omit<ScheduleInput, 'id'>): Promise<void> => {
    out.push(await ensureTask(scheduler, id, input))
  }

  if (options.has.work === true) {
    for (const p of options.positions) {
      // ① 每岗位每天早上 08:00 出计划卡
      await add(
        `sched_daily_plan_${p.assignment_id}`,
        systemTask(
          { ...base, owner: p.person_id, role_id: p.role_id, assignment_id: p.assignment_id },
          {
            title: '每天早上拟一版今天的安排',
            handler: HANDLERS.dailyPlan,
            trigger: { kind: 'cron', expr: '0 8 * * *', tz },
            // 早上开机晚了也要出：这张卡是一天的入口
            misfire_policy: 'run_once_now',
          },
        ),
      )
      // ② 每天 20:00 复盘；周五 20:30 周复盘；月末 20:45 月复盘
      await add(
        `sched_review_day_${p.assignment_id}`,
        systemTask(
          { ...base, owner: p.person_id, role_id: p.role_id, assignment_id: p.assignment_id },
          {
            title: '晚上做一次复盘',
            handler: HANDLERS.review,
            params: { kind: 'day' },
            trigger: { kind: 'cron', expr: '0 20 * * *', tz },
            misfire_policy: 'run_once_now',
          },
        ),
      )
      await add(
        `sched_review_week_${p.assignment_id}`,
        systemTask(
          { ...base, owner: p.person_id, role_id: p.role_id, assignment_id: p.assignment_id },
          {
            title: '周五加一次周复盘',
            handler: HANDLERS.review,
            params: { kind: 'week' },
            trigger: { kind: 'cron', expr: '30 20 * * 5', tz },
            misfire_policy: 'run_once_now',
          },
        ),
      )
      await add(
        `sched_review_month_${p.assignment_id}`,
        systemTask(
          { ...base, owner: p.person_id, role_id: p.role_id, assignment_id: p.assignment_id },
          {
            title: '月末加一次月复盘',
            handler: HANDLERS.review,
            params: { kind: 'month' },
            // cron 没有「月末」：排在 28–31 号，真不是月末的那几天由处理器里的 `isMonthEnd` 挡掉
            trigger: { kind: 'cron', expr: '45 20 28-31 * *', tz },
            misfire_policy: 'skip',
          },
        ),
      )
    }
  }
  // ③ 会议记录源每 15 分钟拉一次
  if (options.has.meetings === true) {
    await add(
      'sched_meetings_poll',
      systemTask(base, {
        title: '每 15 分钟看一眼会议记录来源',
        handler: HANDLERS.meetingsPoll,
        trigger: { kind: 'interval', every_ms: 15 * 60_000 },
      }),
    )
  }
  // ④ 幂等表每小时清一次
  if (options.has.idempotency === true) {
    await add(
      'sched_idempotency_sweep',
      systemTask(base, {
        title: '每小时清一次过期的幂等记录',
        handler: HANDLERS.idempotencySweep,
        trigger: { kind: 'cron', expr: '0 * * * *', tz },
      }),
    )
  }
  // ⑤ Shopify 令牌：先一小时后看一眼，之后每次跑完自己把下一次排到「到期前一小时」
  if (options.has.shopify === true) {
    await add(
      'sched_shopify_refresh',
      systemTask(base, {
        title: '到期前一小时换新的 Shopify 令牌',
        handler: HANDLERS.shopifyRefresh,
        trigger: { kind: 'interval', every_ms: TOKEN_IDLE_INTERVAL_MS },
        misfire_policy: 'run_once_now',
      }),
    )
  }
  // ⑥ 技能周合并：周一早上 06:00
  if (options.has.skills === true) {
    await add(
      'sched_skills_weekly',
      systemTask(base, {
        title: '每周一合并一次学到的东西',
        handler: HANDLERS.skillsWeekly,
        trigger: { kind: 'cron', expr: '0 6 * * 1', tz },
      }),
    )
  }
  return out
}

export type { FireOutcome }

/** `tz_offset_minutes`（480）→ cron 认的固定偏移（`+08:00`）。 */
export function offsetToTz(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+'
  const abs = Math.abs(Math.trunc(minutes))
  const hh = String(Math.floor(abs / 60)).padStart(2, '0')
  const mm = String(abs % 60).padStart(2, '0')
  return `${sign}${hh}:${mm}`
}
