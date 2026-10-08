/**
 * WP276（docs/95 §4.3，决策 241 / 242）：**交给对方**的纯逻辑。
 *
 * ② 同事互联里一个人把一件事（事项或待办）交给平级的同事：交出去只是「请你接」，
 * **对方点「接下」之前主人不变**（31 I13 同一条规矩）。对方可以不接（带一句可选的理由），
 * 没人理到点自动退回，发起人随时能撤回。
 *
 * 这里只有判定，没有 IO：给同样的输入永远出同样的结果。读写在 `service.ts` 的 `Work` 上。
 */
import type { Handoff, HandoffState, Iso8601, PersonId } from '@agentsws/contracts'
import { DEFAULT_HANDOFF_RETURN_DAYS } from '@agentsws/contracts'
import { DAY_MS, ms } from './util.js'

/** 交出去时写的那句话最多多长（字）。 */
export const HANDOFF_NOTE_MAX = 200

/** 一次交接的对象：事项或待办。 */
export interface HandoffRef {
  kind: 'matter' | 'todo'
  id: string
}

/** 结果态（除了「等对方定」都是）。 */
export const HANDOFF_OUTCOMES: readonly HandoffState[] = [
  'accepted',
  'declined',
  'returned',
  'withdrawn',
]

/** 还悬着：交出去了、对方还没定。 */
export const isHandoffPending = (h: Handoff | undefined): h is Handoff & { state: 'offered' } =>
  h?.state === 'offered'

/** 到点了没有（`expires_at` 之后的第一次巡检就退回）。 */
export function handoffExpired(h: Handoff, now: Iso8601): boolean {
  return h.state === 'offered' && ms(now) >= ms(h.expires_at)
}

/** 交出去的那一刻算出几点到期（天数不合理就用默认 3 天）。 */
export function handoffExpiry(at: Iso8601, days?: number): Iso8601 {
  const d =
    days === undefined || !Number.isFinite(days) || days <= 0 ? DEFAULT_HANDOFF_RETURN_DAYS : days
  return new Date(ms(at) + d * DAY_MS).toISOString()
}

/** 新的一次交接（`offered`）。留言去掉首尾空白、超长截断、空串不写。 */
export function newHandoff(input: {
  from: PersonId
  to: PersonId
  at: Iso8601
  note?: string | undefined
  days?: number | undefined
}): Handoff {
  const note = input.note?.trim().slice(0, HANDOFF_NOTE_MAX)
  return {
    state: 'offered',
    from: input.from,
    to: input.to,
    at: input.at,
    expires_at: handoffExpiry(input.at, input.days),
    ...(note === undefined || note === '' ? {} : { note }),
  }
}

/** 有了结果（接下 / 不接 / 退回 / 撤回）。理由同样去空白、空串不写。 */
export function settleHandoff(
  h: Handoff,
  state: Exclude<HandoffState, 'offered'>,
  at: Iso8601,
  extra: {
    reason?: string | undefined
    position_id?: string | undefined
    cards_moved?: number
  } = {},
): Handoff {
  const reason = extra.reason?.trim().slice(0, HANDOFF_NOTE_MAX)
  return {
    ...h,
    state,
    decided_at: at,
    ...(reason === undefined || reason === '' ? {} : { reason }),
    ...(extra.position_id === undefined ? {} : { position_id: extra.position_id }),
    ...(extra.cards_moved === undefined ? {} : { cards_moved: extra.cards_moved }),
  }
}

/**
 * 发起人那边要不要出一行通知：接下 / 不接 / 退回了、他还没点掉。撤回是他自己做的，不通知。
 */
export function handoffNoticeDue(h: Handoff | undefined, person: PersonId): boolean {
  if (h === undefined || h.from !== person || h.seen === true) return false
  return h.state === 'accepted' || h.state === 'declined' || h.state === 'returned'
}

/** 一条交接的展示投影（首页通知、卡片、待办「我交出去的」那一栏）。 */
export interface HandoffItem {
  ref: HandoffRef
  title: string
  handoff: Handoff
  /** 事项本身，或待办挂的那件事 */
  matter_id?: string
  /** 事项「到哪了」/ 待办备注 */
  summary?: string
  due?: Iso8601
  /** 事项 / 待办现在的状态 */
  status: string
}
