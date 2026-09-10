/**
 * 一天的例行公事（25 消费者 ① ② ⑦ 在模拟回路里的最小版）。
 *
 * 为什么模拟回路里再写一遍而不是复用 `apps/server/src/schedule.ts`：
 * 包不该依赖应用（`@agentsws/simulation` → `@agentsws/server` 会把整个服务进程拖进
 * 模拟回路）。这里只留**最小的那一份**——早上出一张计划卡、晚上出一张复盘卡、
 * 复盘完注册一个明早的接力任务。判定逻辑（`draftDailyPlan` / `buildReview`）用的是
 * `@agentsws/work` 的同一对纯函数，所以两边不会算出不一样的东西。
 *
 * 装不装是场景说了算（`routine.start` 事件）：不装的世界一条任务都没有，
 * 调度器每一拍都是空转，原有场景的指标一个不变。
 */
import type { ApprovalItem, DailyPlanDraft, Iso8601, Review } from '@agentsws/contracts'
import {
  createScheduler,
  createWorkflowEngine,
  MemoryScheduleStore,
  type Scheduler,
  type ScheduleStore,
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
import type { World } from './world.js'

/** 与 `apps/server/src/schedule.ts` 同名，这样报告与事件对得上。 */
export const ROUTINE_HANDLERS = {
  dailyPlan: 'work.daily_plan',
  review: 'work.review',
  planFromReview: 'work.plan_from_review',
} as const

export interface Routine {
  scheduler: Scheduler
  workflows: WorkflowEngine
  store: ScheduleStore
  work: Work
}

export interface RoutineOptions {
  /** 早上几点出计划（本地）。 */
  planHour?: number
  /** 晚上几点复盘（本地）。 */
  reviewHour?: number
}

const iso = (ms: number): Iso8601 => new Date(ms).toISOString()

/** 明早 07:55（本地）：赶在计划任务之前。 */
function nextMorning(now: Iso8601, tz: string): Iso8601 {
  const w = wallClock(Date.parse(now), tz)
  const localMidnight = Date.UTC(w.year, w.month - 1, w.day) - w.offset * 60_000
  return iso(localMidnight + DAY_MS + 7 * 3600_000 + 55 * 60_000)
}

/** 卡片的公共信封（14 §1：所有改变都以一条审批项进同一条队列）。 */
function cardEnvelope(world: World, kind: 'daily_plan' | 'review') {
  return {
    workspace_id: world.workspace_id,
    schema_version: 1 as const,
    kind,
    role_id: world.role_id,
    evidence: { source_events: [], provenance: { seen: [] }, precheck: {} },
    proposer: {
      kind: 'system' as const,
      id: kind === 'daily_plan' ? 'work.planner' : 'work.reviewer',
    },
    automation: {
      level_at_creation: 'L1' as const,
      auto_approved: false,
      mandate_check: { within: true, caps_hit: [] },
      sampling: { selected: false },
    },
    routing: {
      recipients: [{ person: world.roleHolder, via: 'role_holder' as const }],
      rule: 'role_holder' as const,
      escalation: {
        after_hours: 24,
        business_hours: true,
        chain: ['owner' as const],
        escalated_at: [] as Iso8601[],
      },
      separation_of_duties: false,
    },
    priority: 'queue' as const,
  }
}

/**
 * 装上「一天的例行公事」：早上 08:00 计划、晚上 20:00 复盘、复盘完接力明早的草案。
 * 返回的调度器由 runner 每推进一拍调一次 `runDue`。
 */
export function installDailyRoutine(world: World, options: RoutineOptions = {}): Routine {
  const tz = world.pack.workspace.tz
  const store = new MemoryScheduleStore()
  const clock = world.clock
  const scheduler = createScheduler({
    clock,
    store,
    random: world.random,
    eventSink: (e) => {
      world.appendEvent(e.type, e.payload, {
        ...(e.subject === undefined ? {} : { subject: e.subject }),
      })
    },
  })
  const workflows = createWorkflowEngine({
    clock,
    store,
    random: world.random,
    eventSink: (e) => {
      world.appendEvent(e.type, e.payload, {
        ...(e.subject === undefined ? {} : { subject: e.subject }),
      })
    },
  })
  // 工作模型由 `createWorld` 统一装（场景不必先 `routine.start` 才能建待办）
  const work = world.work

  const base = {
    workspace_id: world.workspace_id,
    owner: world.roleHolder,
    role_id: world.role_id,
    assignment_id: world.assignment.id,
    created_by: 'user' as const,
    misfire_policy: 'run_once_now' as const,
  }

  // ① 早上：一张 daily_plan 卡
  scheduler.register(ROUTINE_HANDLERS.dailyPlan, async () => {
    const plan = work.todayPlan({ person_id: world.roleHolder, goals: [], cards_waiting: 0 })
    if (plan.approval_item_id !== undefined) return { plan: plan.id, deduped: true }
    const draft: DailyPlanDraft = plan
    const card = (await world.txn.approvals.create({
      ...cardEnvelope(world, 'daily_plan'),
      subject: { object: { type: 'daily_plan', id: plan.id } },
      dedupe_key: `${world.workspace_id}:daily_plan:${plan.date}`,
      title: planTitle(draft),
      summary: planSummary(draft),
      payload: draft,
      options: draft.options.map((o) => ({ id: o.id, label: o.label })),
    })) as ApprovalItem
    work.linkPlanApproval(plan.id, card.id)
    return { plan: plan.id, card: card.id }
  })

  // ② 晚上：一张 review 卡；⑦ 顺手把明天的草案接力出去
  scheduler.register(ROUTINE_HANDLERS.review, async (ctx) => {
    const range = work.todayRange()
    const review: Review = work.saveReview(
      buildReview({
        now: work.now(),
        person_id: world.roleHolder,
        tz_offset_minutes: work.tz_offset_minutes,
        period: { kind: 'day', start: range.from, end: range.to },
        goals: [],
        cards_events: [],
        todos: [],
        meetings: [],
        tomorrow: {
          now: iso(Date.parse(work.now()) + DAY_MS),
          todos: work.inbox(world.roleHolder),
          today_meetings: [],
          cards_waiting: 0,
        },
      }),
    )
    const card = (await world.txn.approvals.create({
      ...cardEnvelope(world, 'review'),
      subject: { object: { type: 'review', id: review.id } },
      dedupe_key: `${world.workspace_id}:review:day:${review.period.end}`,
      title: reviewTitle(review),
      summary: reviewSummary(review),
      payload: review,
    })) as ApprovalItem
    // ⑦ 复盘产物 → 次日计划草案：注册一个明早的一次性任务
    await scheduler.schedule({
      ...base,
      title: '把昨晚复盘的产物接成今天的计划草案',
      handler: ROUTINE_HANDLERS.planFromReview,
      params: { review_id: review.id },
      trigger: { kind: 'once', at: nextMorning(ctx.at, tz) },
    })
    return { review: review.id, card: card.id }
  })

  // ⑦ 到点：把草案落成明天的计划记录（真出卡还是明早那条 daily_plan 任务干的）
  scheduler.register(ROUTINE_HANDLERS.planFromReview, (ctx) => {
    const review_id = String(ctx.task.params?.review_id ?? '')
    const review = work.listReviews({ limit: 50 }).find((r) => r.id === review_id)
    if (review === undefined) return { skipped: 'review_gone' }
    return { review_id, suggestions: review.next_plan_draft.suggestions.length }
  })

  void scheduler.schedule({
    ...base,
    id: 'sched_daily_plan',
    title: '每天早上拟一版今天的安排',
    handler: ROUTINE_HANDLERS.dailyPlan,
    trigger: { kind: 'cron', expr: `0 ${options.planHour ?? 8} * * *`, tz },
  })
  void scheduler.schedule({
    ...base,
    id: 'sched_review_day',
    title: '晚上做一次复盘',
    handler: ROUTINE_HANDLERS.review,
    trigger: { kind: 'cron', expr: `0 ${options.reviewHour ?? 20} * * *`, tz },
  })

  return { scheduler, workflows, store, work }
}
