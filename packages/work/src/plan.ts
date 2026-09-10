/**
 * 每日计划（37 §2.4 早上）：Agent 看目标差距、昨日数据、昨日复盘、今天会议、到期待办，
 * **建议**把哪几条 backlog 拆到今天、哪几条委托给 AI。
 *
 * 三条纪律：
 * - **它只是建议**：本函数只产 `daily_plan` 卡的 payload，**不写待办**；采纳后才写（37 C6）。
 * - **纯函数**：给同样的输入永远出同样的输出，没有 IO、没有 `Date.now()`、没有模型。
 * - **一次一张、给选择题**：选项固定三个——采纳 / 调整 / 稍后；「调整」就是把 `suggestions`
 *   当可勾选清单展开（`selected` 是默认勾选状态）。
 */
import type {
  AssignmentId,
  CalendarItem,
  DailyPlanDraft,
  DailyPlanSuggestion,
  GoalProgress,
  Iso8601,
  PersonId,
  Review,
  Todo,
} from '@agentsws/contracts'
import { findInProgressSimilar, type InProgressItem } from './collision.js'
import { isOpen } from './horizon.js'
import { atLocalTime, HOUR_MS, localDay, MINUTE_MS, ms, overlaps, startOfDay } from './util.js'

/** 计划里最多给几条建议——一次一张卡，不能变成长列表。 */
export const MAX_SUGGESTIONS = 5
/** 今天会议多于这个数就少建议几条（人已经没时间了）。 */
export const BUSY_MEETINGS = 3
export const BUSY_MAX_SUGGESTIONS = 3
/** 默认勾选前几条。 */
export const DEFAULT_SELECTED = 3
/** 排期建议的时段长度与工作时段。 */
export const SLOT_MINUTES = 60
export const WORK_START_HOUR = 9
export const WORK_END_HOUR = 18

export interface DailyPlanInput {
  now: Iso8601
  person_id: PersonId
  tz_offset_minutes: number
  goals: readonly GoalProgress[]
  todos: { backlog: readonly Todo[]; week: readonly Todo[]; today: readonly Todo[] }
  yesterday_review?: Review
  today_meetings: readonly CalendarItem[]
  /** 待我定的卡片数（37 §3 ②「右：到期清单」的第二个数字） */
  cards_waiting?: number
  /** 有它才会给「委托给 Agent」的建议 */
  delegate_to?: AssignmentId
  /**
   * 40 §3.4「分配任务时就防撞」：别人正在做的事。撞上的建议**不建议**——
   * 计划卡不该把人推去做一件已经有主人的事。
   */
  in_progress?: readonly InProgressItem[]
  /** 计划是给这个人拟的；他自己正在做的不算撞车（那本来就是他的活） */
  in_progress_position?: string
}

/** 一条被撞车挡掉的建议：谁挡的、挡的理由（进 `daily_plan` 卡的运行结果，不进 payload）。 */
export interface FilteredSuggestion {
  suggestion_id: string
  reason: 'in_progress_elsewhere'
  /** 谁在做 */
  owner: PersonId
  /** 在做的那条（待办 / 事项 id） */
  conflicts_with: string
}

/**
 * 把与「别人正在做的事」撞上的建议挑出来（40 §3.4）。
 *
 * 只挡**别人**的：自己正在做的那条，正是计划该提醒他接着做的。
 */
export function filterCollidingSuggestions(input: {
  suggestions: readonly DailyPlanSuggestion[]
  in_progress: readonly InProgressItem[]
  person_id: PersonId
  now: Iso8601
  tz_offset_minutes: number
  position_id?: string | undefined
}): { kept: DailyPlanSuggestion[]; filtered: FilteredSuggestion[] } {
  const pool = input.in_progress.filter((i) => i.owner !== input.person_id)
  if (pool.length === 0) return { kept: [...input.suggestions], filtered: [] }
  const kept: DailyPlanSuggestion[] = []
  const filtered: FilteredSuggestion[] = []
  for (const s of input.suggestions) {
    // 已经指着某条待办的建议（promote / schedule / delegate）不算撞车：那条待办本来就是他的
    if (s.todo_id !== undefined) {
      kept.push(s)
      continue
    }
    const hit = findInProgressSimilar({
      subject: {
        title: s.title,
        at: input.now,
        ...(input.position_id === undefined ? {} : { position_id: input.position_id }),
      },
      pool,
      tz_offset_minutes: input.tz_offset_minutes,
    })[0]
    if (hit === undefined) kept.push(s)
    else
      filtered.push({
        suggestion_id: s.id,
        reason: 'in_progress_elsewhere',
        owner: hit.owner,
        conflicts_with: hit.id,
      })
  }
  return { kept, filtered }
}

const OPTIONS: DailyPlanDraft['options'] = [
  { id: 'adopt', label: '就按这个来' },
  { id: 'adjust', label: '我改几条' },
  { id: 'later', label: '稍后再说' },
]

/** 今天工作时段里还没被会议占掉的空档（按 60 分钟切）。 */
export function freeSlots(
  now: Iso8601,
  tzOffsetMinutes: number,
  meetings: readonly CalendarItem[],
  wanted: number,
): { start: Iso8601; end: Iso8601 }[] {
  const day = startOfDay(ms(now), tzOffsetMinutes)
  const busy = meetings
    .filter((m) => !m.all_day)
    .map((m) => ({
      from: ms(m.start),
      to: m.end === undefined ? ms(m.start) + HOUR_MS : ms(m.end),
    }))
  const out: { start: Iso8601; end: Iso8601 }[] = []
  const step = SLOT_MINUTES * MINUTE_MS
  for (let h = WORK_START_HOUR; h < WORK_END_HOUR && out.length < wanted; h += 1) {
    const start = day + h * HOUR_MS
    const end = start + step
    // 已经过去的时段不建议
    if (end <= ms(now)) continue
    if (busy.some((b) => overlaps(start, end, b.from, b.to))) continue
    out.push({ start: atLocalTime(day, h), end: new Date(end).toISOString() })
  }
  return out
}

function promoteSuggestion(todo: Todo, reason: string): DailyPlanSuggestion {
  return {
    id: `sug_promote_${todo.id}`,
    kind: 'promote',
    title: todo.title,
    reason,
    todo_id: todo.id,
    ...(todo.goal_id === undefined ? {} : { goal_id: todo.goal_id }),
    ...(todo.matter_id === undefined ? {} : { matter_id: todo.matter_id }),
    horizon: 'today',
    selected: false,
  }
}

export function draftDailyPlan(input: DailyPlanInput): DailyPlanDraft {
  return draftDailyPlanWithFilter(input).draft
}

/** 同 {@link draftDailyPlan}，另外回「哪几条被撞车挡掉了」（进任务运行结果，便于解释）。 */
export function draftDailyPlanWithFilter(input: DailyPlanInput): {
  draft: DailyPlanDraft
  filtered: FilteredSuggestion[]
} {
  const openOf = (list: readonly Todo[]): Todo[] => list.filter(isOpen)
  const backlog = openOf(input.todos.backlog)
  const week = openOf(input.todos.week)
  const today = openOf(input.todos.today)

  const suggestions: DailyPlanSuggestion[] = []
  const seen = new Set<string>()
  const push = (s: DailyPlanSuggestion): void => {
    const key = s.todo_id ?? s.id
    if (seen.has(key)) return
    seen.add(key)
    suggestions.push(s)
  }

  // ① 昨天复盘里已经拟好的草案排最前——复盘的产物就是今天计划的草案（37 §2.4）
  for (const s of input.yesterday_review?.next_plan_draft.suggestions ?? []) {
    push({ ...s, reason: `昨天复盘：${s.reason}`, selected: false })
  }

  // ② 落后的目标：把挂在它下面的长期 / 本周待办挑到今天
  const behind = [...input.goals]
    .filter((g) => g.status === 'behind')
    .sort(
      (a, b) => (a.progress_pct ?? 0) - (b.progress_pct ?? 0) || (a.goal_id < b.goal_id ? -1 : 1),
    )
  for (const goal of behind) {
    const candidates = [...week, ...backlog].filter((t) => t.goal_id === goal.goal_id)
    for (const todo of candidates.slice(0, 2)) {
      push(
        promoteSuggestion(
          todo,
          `目标「${goal.title}」落后：进度 ${goal.progress_pct ?? 0}%，时间已过 ${goal.elapsed_pct}%`,
        ),
      )
    }
  }

  // ③ 有事项上下文、又还没委托的本周待办：建议交给 Agent 在事项里接着做（37 §2.2 交点一）
  if (input.delegate_to !== undefined) {
    for (const todo of week.filter((t) => t.matter_id !== undefined && t.delegate === undefined)) {
      push({
        id: `sug_delegate_${todo.id}`,
        kind: 'delegate',
        title: todo.title,
        reason: '这条有事项上下文，交给 Agent 接着做，问题回来成卡片',
        todo_id: todo.id,
        ...(todo.matter_id === undefined ? {} : { matter_id: todo.matter_id }),
        assignment_id: input.delegate_to,
        brief: todo.note ?? todo.title,
        selected: false,
      })
    }
  }

  // ④ 今天到期、还没排时段的：给一个空档
  const slots = freeSlots(input.now, input.tz_offset_minutes, input.today_meetings, MAX_SUGGESTIONS)
  let slotIndex = 0
  for (const todo of today.filter((t) => t.scheduled === undefined)) {
    const slot = slots[slotIndex]
    if (slot === undefined) break
    slotIndex += 1
    push({
      id: `sug_schedule_${todo.id}`,
      kind: 'schedule',
      title: todo.title,
      reason: '今天到期但还没排时段',
      todo_id: todo.id,
      ...(todo.matter_id === undefined ? {} : { matter_id: todo.matter_id }),
      scheduled: slot,
      selected: false,
    })
  }

  // ⑤ 都没有的话，至少把 backlog 最老的一条挑出来——别让待办箱只进不出
  if (suggestions.length === 0 && backlog[0] !== undefined) {
    push(promoteSuggestion(backlog[0], '待办箱里最久没动的一条'))
  }

  // 40 §3.4：撞上「别人正在做的」那几条不建议
  const { kept, filtered } = filterCollidingSuggestions({
    suggestions,
    in_progress: input.in_progress ?? [],
    person_id: input.person_id,
    now: input.now,
    tz_offset_minutes: input.tz_offset_minutes,
    ...(input.in_progress_position === undefined
      ? {}
      : { position_id: input.in_progress_position }),
  })

  const cap = input.today_meetings.length >= BUSY_MEETINGS ? BUSY_MAX_SUGGESTIONS : MAX_SUGGESTIONS
  const capped = kept.slice(0, cap).map((s, i) => ({ ...s, selected: i < DEFAULT_SELECTED }))

  const draft: DailyPlanDraft = {
    date: localDay(input.now, input.tz_offset_minutes),
    person_id: input.person_id,
    basis: {
      goals: [...input.goals],
      meetings: input.today_meetings.length,
      due_todos: today.length,
      cards_waiting: input.cards_waiting ?? 0,
      ...(input.yesterday_review === undefined
        ? {}
        : { yesterday_review_id: input.yesterday_review.id }),
    },
    suggestions: capped,
    options: OPTIONS,
  }
  return { draft, filtered }
}

/** 一句话卡面标题（14 §2 title ≤ 80 字）。 */
export function planTitle(draft: DailyPlanDraft): string {
  return `今天的安排：${draft.suggestions.length} 条建议`
}

export function planSummary(draft: DailyPlanDraft): string {
  const behind = draft.basis.goals.filter((g) => g.status === 'behind').length
  const parts = [
    `今天 ${draft.basis.meetings} 个会`,
    `${draft.basis.due_todos} 条待办到期`,
    `${draft.basis.cards_waiting} 张卡等你定`,
  ]
  if (behind > 0) parts.push(`${behind} 个目标落后`)
  return `${parts.join('，')}。下面是建议，采纳之后才会写进待办。`
}
