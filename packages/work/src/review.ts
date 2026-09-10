/**
 * 复盘（37 §2.4 晚上 / 次日早）：目标进度、异常、今天卡片处理结果（战报四格）、
 * 待办完成率、会议产出、Agent 学到的（24 lesson）；**产物是明天 `daily_plan` 的草案**。
 *
 * 与 {@link draftDailyPlan} 一样是纯函数：给同样的输入永远出同样的输出，没有 IO、没有模型。
 * 战报四格的数从审批项的状态里数出来，不从文本里读（29 原则 ③）。
 */
import type {
  BattleReport,
  CalendarItem,
  DailyPlanDraft,
  GoalProgress,
  Iso8601,
  PersonId,
  ReviewDraft,
  ReviewPeriodKind,
  Todo,
} from '@agentsws/contracts'
import { type DailyPlanInput, draftDailyPlan } from './plan.js'
import { round2 } from './util.js'

/**
 * 一张卡在这段时间里的结局。只取判定战报要用的那几项——
 * 本包不该认识整个 `ApprovalItem`，宿主投影一下就行（见 `cardOutcomeOf`）。
 */
export interface CardOutcome {
  id: string
  kind: string
  state: string
  /** 额度内自动通过（14 §0 的 auto_approved 支路） */
  auto_approved: boolean
  /** 有人真的点了（approve / approve_edited / reject / redirect / defer） */
  decided_by_person: boolean
  /** 已经施行 / 已经发出去了 */
  applied: boolean
  /** 预检没过，压根没进队列 */
  blocked: boolean
}

/** 战报四格：AI 自主处理 / 你已处理 / 自动发送 / 拦截待确认（36 §1 空态）。 */
export function battleReport(outcomes: readonly CardOutcome[]): BattleReport {
  let ai_handled = 0
  let you_handled = 0
  let auto_sent = 0
  let blocked = 0
  for (const o of outcomes) {
    if (o.blocked) {
      blocked += 1
      continue
    }
    if (o.auto_approved) {
      ai_handled += 1
      if (o.applied) auto_sent += 1
      continue
    }
    if (o.decided_by_person) you_handled += 1
  }
  return { ai_handled, you_handled, auto_sent, blocked }
}

/**
 * 40 §2.2 第 4 条：周复盘里的"疑似重复"——相似度高**而且两条都还在用**的成对。
 *
 * 判定不在本包（在 `@agentsws/catalog`）；这里只负责把它端到复盘上，并在
 * `highlights` 里写一句人话。复盘卡上那个"合并"按钮走 05 的 `policy_change`。
 */
export interface ReviewDuplicate {
  a: { id: string; title: string; owner: string; kind: string }
  b: { id: string; title: string; owner: string; kind: string }
  similarity: number
  both_in_use: boolean
  reasons?: string[]
}

export interface ReviewInput {
  now: Iso8601
  person_id: PersonId
  tz_offset_minutes: number
  period: { kind: ReviewPeriodKind; start: Iso8601; end: Iso8601 }
  goals: readonly GoalProgress[]
  /** 这段时间里所有卡的结局 */
  cards_events: readonly CardOutcome[]
  /** 这段时间里「本该完成」的待办（今天到期 / 排期在今天的） */
  todos: readonly Todo[]
  meetings: readonly CalendarItem[]
  /** 会议产出的条数（决定 + 待办 + 边界答案 + 知识；WP23 给） */
  meeting_outputs?: number
  lessons?: readonly { id: string; text: string }[]
  /** 40 §2.2：疑似重复的成对（日复盘不给，周 / 月复盘才报） */
  duplicates?: readonly ReviewDuplicate[]
  /** 明天的计划草案要用的输入；`goals` 不给就沿用今天的 */
  tomorrow: Omit<DailyPlanInput, 'yesterday_review' | 'person_id' | 'tz_offset_minutes' | 'goals'> &
    Partial<Pick<DailyPlanInput, 'goals'>>
}

export function buildReview(input: ReviewInput): ReviewDraft & { duplicates?: ReviewDuplicate[] } {
  const cards = battleReport(input.cards_events)
  const total = input.todos.length
  const done = input.todos.filter((t) => t.status === 'done').length
  const completion_pct = total === 0 ? 100 : round2((done / total) * 100)
  const lessons = [...(input.lessons ?? [])]

  const highlights: string[] = []
  for (const g of input.goals) {
    if (g.status === 'behind')
      highlights.push(
        `目标「${g.title}」落后：进度 ${g.progress_pct ?? 0}%，时间已过 ${g.elapsed_pct}%`,
      )
  }
  if (total > 0 && completion_pct < 50) highlights.push(`待办完成 ${done}/${total}，不到一半`)
  if (total > 0 && completion_pct === 100) highlights.push(`待办全清：${done} 条`)
  if (cards.blocked > 0) highlights.push(`拦下 ${cards.blocked} 张没过预检的卡`)
  if (cards.ai_handled > 0)
    highlights.push(`AI 自主处理 ${cards.ai_handled} 张，其中发出去 ${cards.auto_sent} 张`)
  if (lessons.length > 0)
    highlights.push(`Agent 记下 ${lessons.length} 条经验，明天会问你要不要采纳`)
  const duplicates = [...(input.duplicates ?? [])]
  if (duplicates.length > 0) {
    const first = duplicates[0]
    highlights.push(
      first === undefined
        ? `发现 ${duplicates.length} 对疑似重复的东西`
        : `疑似重复 ${duplicates.length} 对，最像的是「${first.a.title}」与「${first.b.title}」——要不要合成一份`,
    )
  }

  const next_plan_draft: DailyPlanDraft = draftDailyPlan({
    ...input.tomorrow,
    person_id: input.person_id,
    tz_offset_minutes: input.tz_offset_minutes,
    goals: input.tomorrow.goals ?? input.goals,
  })

  return {
    person_id: input.person_id,
    period: input.period,
    goals: [...input.goals],
    cards,
    todos: { done, total, completion_pct },
    meetings: { count: input.meetings.length, outputs: input.meeting_outputs ?? 0 },
    lessons,
    highlights,
    next_plan_draft,
    // 契约里的 `ReviewDraft` 还没有这一段（见交付报告的契约建议）；多带一个字段不影响别处
    ...(duplicates.length === 0 ? {} : { duplicates }),
  }
}

export function reviewTitle(draft: ReviewDraft): string {
  const label =
    draft.period.kind === 'day' ? '今天' : draft.period.kind === 'week' ? '本周' : '本月'
  return `${label}的复盘：你处理 ${draft.cards.you_handled} 张，AI ${draft.cards.ai_handled} 张`
}

export function reviewSummary(draft: ReviewDraft): string {
  return `待办完成 ${draft.todos.done}/${draft.todos.total}，会议 ${draft.meetings.count} 个。看完顺手确认一下明天的安排。`
}
