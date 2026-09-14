/**
 * Extracted from KefuAgent src/lib/support/amazon-sla.ts
 * （`AMAZON_SLA_WINDOW_MINUTES` / `REMINDER` / `CRITICAL` 三档、唯一时钟锚语义、
 * 三个幂等列「为空**或早于锚** = 本轮还没做」），rewritten for agentsws contracts。
 *
 * 纯函数：`evaluateAmazonSlaCycle` 吃一条线程的当前状态 + `now`，回一个动作。
 * 时间全部经参数传入，包内不碰 `Date.now()`。
 *
 * ## 唯一时钟锚：`last_buyer_message_at`
 *
 * **不是**「最近一次入站」。退货 / A-to-z / 退款通知 / 钓鱼件都会落在**同一条
 * 线程**上并推高「最近一次入站」，拿它当锚的话，一封「退款已处理」的系统通知会
 * 把买家那封还没回的信的倒计时**重置回 24 小时**——面板一片绿，Amazon 那边的
 * 响应率照常扣。只有 `buyer_message` / `amazon_cs_relay` 写这个键
 * （`buildAmazonChannelMeta`），只读上下文线程天然无锚、天然不进这张表。
 *
 * ## 一个周期的状态机（锚 A、截止 D = A + 1440min、剩余 R = D − now）
 *
 * - 已回复（最后一次出站 > A）：不出任何卡，直接闭账（R ≤ 24h 记 within，否则
 *   miss），三列一并推到 now = 本轮结案，并把这条线程上还开着的 SLA 卡收掉
 *   （卡上写的是「这封信还没回」，回了之后它就是一句过时的话）。
 * - R ≤ 4h（含负）：出告警档，同时把提醒列也一并推到 now——12h 档已被 4h 档吸收，
 *   第一次看见就已经 ≤4h 的线程不该先补一张提醒卡。
 * - R ≤ 12h：出提醒档。
 * - now > D 且仍未回复：闭账 miss。
 *
 * 三个幂等字段的语义都是「为空**或早于锚** = 本轮还没做」。新一轮买家来信把锚
 * 往前推，三个字段自动全部「过期」= 重新武装，不需要任何清理任务。
 */

import type { Iso8601 } from '@agentsws/contracts'

const MINUTE_MS = 60_000

/** 固定日历 1440 分钟（Amazon 的响应率考核不看周末与节假日）。 */
export const AMAZON_SLA_WINDOW_MINUTES = 1440
/** 剩余 ≤ 该值 → 提醒档。 */
export const AMAZON_SLA_REMINDER_MINUTES = 12 * 60
/** 剩余 ≤ 该值（含负数 = 已超时）→ 升级档。 */
export const AMAZON_SLA_CRITICAL_MINUTES = 4 * 60
/** 单轮 sweep 的扫描上限；落后的会在下一轮补上。 */
export const AMAZON_SLA_SWEEP_BATCH = 200

/** 一条 Amazon 线程在 SLA 表里的全部状态（三个幂等字段 + 两个时刻）。 */
export interface AmazonSlaThreadState {
  thread_id: string
  /** 唯一时钟锚：线程 `channel_meta.last_buyer_message_at`。 */
  last_buyer_message_at?: Iso8601 | undefined
  /** 最后一次出站（回信）。 */
  last_outbound_at?: Iso8601 | undefined
  /** 幂等：本轮的提醒卡出过没有。 */
  reminder_fired_at?: Iso8601 | undefined
  /** 幂等：本轮的告警卡出过没有。 */
  escalation_fired_at?: Iso8601 | undefined
  /** 幂等：本轮闭账过没有。 */
  cycle_accounted_at?: Iso8601 | undefined
}

/** 一条线程这一轮该做什么。 */
export type AmazonSlaAction =
  /** 无锚 / 本轮该做的都做过了 —— 原地不动。 */
  | { kind: 'none'; reason: 'no_anchor' | 'already_done' | 'within_window' }
  /** 出提醒卡（剩余 ≤ 12h）。 */
  | { kind: 'reminder'; deadline: Iso8601; remaining_minutes: number; cycle_stamp: string }
  /** 出告警卡（剩余 ≤ 4h，含已超时）；同时把提醒列一并推到 now。 */
  | {
      kind: 'critical'
      deadline: Iso8601
      remaining_minutes: number
      cycle_stamp: string
      absorbs_reminder: boolean
    }
  /** 闭账：回了 = within / miss；没回且已过截止 = miss。同时收掉还开着的卡。 */
  | {
      kind: 'account'
      deadline: Iso8601
      outcome: 'within' | 'miss'
      responded: boolean
      cycle_stamp: string
      /** 回复了就把这条线程上还开着的 SLA 卡收掉。 */
      resolves_open_cards: boolean
    }

/** ISO 串 → epoch ms；解析不出来回 undefined（= 这条线程本轮不进表）。 */
export function parseAmazonSlaAnchor(value: string | null | undefined): number | undefined {
  if (typeof value !== 'string' || value.length < 10) return undefined
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? undefined : ms
}

/** 从线程 `channel_meta` 里读锚。 */
export function readAmazonSlaAnchor(channel_meta: unknown): number | undefined {
  const meta =
    channel_meta !== null && typeof channel_meta === 'object' && !Array.isArray(channel_meta)
      ? (channel_meta as Record<string, unknown>)
      : {}
  const raw = meta.last_buyer_message_at
  return parseAmazonSlaAnchor(typeof raw === 'string' ? raw : undefined)
}

/** 锚 → 24h 截止时刻。 */
export function amazonSlaDeadline(anchor_ms: number): number {
  return anchor_ms + AMAZON_SLA_WINDOW_MINUTES * MINUTE_MS
}

/**
 * 周期号（`YYYY-MM-DD HH:mm UTC`）。
 *
 * 卡片标题里要同时满足两件相反的事：同一个 SLA 周期内**逐字相同**（否则一张卡
 * 变成每 5 分钟一张），新一轮买家来信后**必须不同**（否则新周期的卡会被上一轮那
 * 张还开着的卡吃掉，而它说的是上一封信）。截止时刻与锚一一对应，所以它就是周期号。
 */
export function amazonSlaCycleStamp(deadline_ms: number): string {
  const iso = new Date(deadline_ms).toISOString()
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`
}

/** 「为空**或早于锚** = 本轮还没做」。 */
function armed(fired_at: Iso8601 | undefined, anchor_ms: number): boolean {
  const fired = parseAmazonSlaAnchor(fired_at)
  return fired === undefined || fired < anchor_ms
}

/**
 * 一条线程这一轮该做什么。纯函数，调用方负责认领（把幂等字段推到 now）与出卡。
 *
 * 认领必须发生在**写**这一侧（条件更新：字段为空或 < 锚），不是「先查后写」——
 * 两个 sweep 同时读到同一条、都判「该出卡」，然后各出一张，这不是理论问题。
 */
export function evaluateAmazonSlaCycle(state: AmazonSlaThreadState, now: Iso8601): AmazonSlaAction {
  const anchor = parseAmazonSlaAnchor(state.last_buyer_message_at)
  if (anchor === undefined) return { kind: 'none', reason: 'no_anchor' }

  const now_ms = Date.parse(now)
  const deadline_ms = amazonSlaDeadline(anchor)
  const deadline = new Date(deadline_ms).toISOString() as Iso8601
  const cycle_stamp = amazonSlaCycleStamp(deadline_ms)
  const remaining_minutes = Math.floor((deadline_ms - now_ms) / MINUTE_MS)

  const outbound = parseAmazonSlaAnchor(state.last_outbound_at)
  const responded = outbound !== undefined && outbound > anchor

  // ① 回了 → 闭账（在窗口内回的记 within），并把还开着的卡收掉。
  if (responded) {
    if (!armed(state.cycle_accounted_at, anchor)) return { kind: 'none', reason: 'already_done' }
    return {
      kind: 'account',
      deadline,
      outcome: outbound <= deadline_ms ? 'within' : 'miss',
      responded: true,
      cycle_stamp,
      resolves_open_cards: true,
    }
  }

  // ② 没回且已过截止 → 闭账 miss。
  if (now_ms > deadline_ms && !armed(state.escalation_fired_at, anchor)) {
    if (!armed(state.cycle_accounted_at, anchor)) return { kind: 'none', reason: 'already_done' }
    return {
      kind: 'account',
      deadline,
      outcome: 'miss',
      responded: false,
      cycle_stamp,
      resolves_open_cards: false,
    }
  }

  // ③ 剩余 ≤ 4h（含负）→ 告警档；12h 档被它吸收。
  if (remaining_minutes <= AMAZON_SLA_CRITICAL_MINUTES) {
    if (!armed(state.escalation_fired_at, anchor)) {
      if (now_ms > deadline_ms && armed(state.cycle_accounted_at, anchor)) {
        return {
          kind: 'account',
          deadline,
          outcome: 'miss',
          responded: false,
          cycle_stamp,
          resolves_open_cards: false,
        }
      }
      return { kind: 'none', reason: 'already_done' }
    }
    return {
      kind: 'critical',
      deadline,
      remaining_minutes,
      cycle_stamp,
      absorbs_reminder: armed(state.reminder_fired_at, anchor),
    }
  }

  // ④ 剩余 ≤ 12h → 提醒档。
  if (remaining_minutes <= AMAZON_SLA_REMINDER_MINUTES) {
    if (!armed(state.reminder_fired_at, anchor)) return { kind: 'none', reason: 'already_done' }
    return { kind: 'reminder', deadline, remaining_minutes, cycle_stamp }
  }

  return { kind: 'none', reason: 'within_window' }
}

/** 卡片标题：同周期逐字相同，跨周期必不同。 */
export function amazonSlaCardTitle(
  kind: 'reminder' | 'critical',
  thread_id: string,
  cycle_stamp: string,
): string {
  const label = kind === 'reminder' ? 'Amazon 24 小时响应提醒' : 'Amazon 24 小时响应告警'
  return `${label} · 截止 ${cycle_stamp} · ${thread_id}`
}
