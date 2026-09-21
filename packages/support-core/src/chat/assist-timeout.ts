/**
 * Extracted from KefuAgent src/lib/support/chat.ts
 * (liveChatAssistTimeouts / isAssistReminderDue / isAssistDemotionDue / isChatCustomerPresent),
 * rewritten for agentsws contracts.
 *
 * 求助超时：访客要人工之后，商家没接，这条会话不能就这么挂着。
 *
 * WP124（修订第 3 条）把这套口径改成**可配置**：
 *
 * - **默认 30 秒**；商家可自定义 10–600 秒（30s / 1 / 3 / 5 / 10 分钟是快捷项）；
 *   非法值回落 30 秒——等太短最多是客户早一点收到邮件，等太长是客户对着静默
 *   页面坐着，安全不对称是反的；
 * - **死线在求助那一刻固化**进会话行（`assist_deadline_at`），巡检不回读设置；
 * - **只有超过 3 分钟的档才有中途提醒**，措辞与 T+0 那句不同（T+0 的话术里已经
 *   要过一次邮箱，照抄会让客户连收两遍同一句——KA 勘误 12-C）。
 *
 * 没存死线的旧会话按老口径（T+3 提醒 / T+10 转邮件）跑，不回填。
 *
 * 全部纯判定：时间从参数进来，本文件里没有 `Date.now()`。
 */
import type { Iso8601 } from '@agentsws/contracts'

export const CHAT_ASSIST_TIMEOUTS = {
  /** T+3：访客能拿到的那一条进度提醒（老口径，>3 分钟档沿用）。 */
  reminder_ms: 3 * 60 * 1000,
  /** T+10：停止等待，转邮件跟进（老口径；没存死线的旧会话用它）。 */
  deadline_ms: 10 * 60 * 1000,
  /**
   * 访客"还在页面上"的判定窗口。比 widget 的心跳周期宽得多，
   * 健康的连接不会被读成"人已经走了"。
   */
  presence_ms: 90_000,
} as const

/** 一次求助的两个钟点，从"什么时候求助的"算出来，不另外存两列。 */
export interface ChatAssistSchedule {
  requested_at: Iso8601
  remind_at: Iso8601
  deadline_at: Iso8601
}

/** 求助等待默认 30 秒（修订第 3 条）。 */
export const ASSIST_WAIT_DEFAULT_SECONDS = 30
/** 可自定义的边界。 */
export const ASSIST_WAIT_MIN_SECONDS = 10
export const ASSIST_WAIT_MAX_SECONDS = 600
/** 设置页的快捷项（30s / 1 / 3 / 5 / 10 分钟）。 */
export const ASSIST_WAIT_QUICK_OPTIONS: readonly number[] = [30, 60, 180, 300, 600]
/** 只有超过 3 分钟的档才有中途提醒。 */
export const ASSIST_MID_REMINDER_THRESHOLD_SECONDS = 180

/** 非法值回落默认（不是回落最长档——等太长比等太短更伤）。 */
export function normalizeAssistWaitSeconds(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(n) || !Number.isInteger(n)) return ASSIST_WAIT_DEFAULT_SECONDS
  if (n < ASSIST_WAIT_MIN_SECONDS || n > ASSIST_WAIT_MAX_SECONDS) return ASSIST_WAIT_DEFAULT_SECONDS
  return n
}

/**
 * 一次求助的两个钟点。老口径（不带 `wait_seconds`）= T+3 / T+10；
 * WP124 起（带 `wait_seconds`）= 死线在求助那一刻算定，中途提醒只有
 * 超过 3 分钟的档才有。
 */
export function chatAssistSchedule(
  requested_at: Iso8601,
  wait_seconds?: number,
): ChatAssistSchedule {
  const base = Date.parse(requested_at)
  if (wait_seconds === undefined) {
    return {
      requested_at,
      remind_at: new Date(base + CHAT_ASSIST_TIMEOUTS.reminder_ms).toISOString(),
      deadline_at: new Date(base + CHAT_ASSIST_TIMEOUTS.deadline_ms).toISOString(),
    }
  }
  const deadline = base + wait_seconds * 1000
  return {
    requested_at,
    // 只有 >3 分钟的档才有中途提醒（1 分钟档死线即提醒）
    remind_at:
      wait_seconds > ASSIST_MID_REMINDER_THRESHOLD_SECONDS
        ? new Date(base + CHAT_ASSIST_TIMEOUTS.reminder_ms).toISOString()
        : new Date(deadline).toISOString(),
    deadline_at: new Date(deadline).toISOString(),
  }
}

/** 访客还在不在页面上（心跳或他自己刚说过话，取新的那个）。 */
export function isVisitorPresent(input: {
  last_seen_at?: Iso8601
  last_visitor_message_at?: Iso8601
  now: Iso8601
}): boolean {
  const freshest = Math.max(
    input.last_seen_at === undefined ? 0 : Date.parse(input.last_seen_at),
    input.last_visitor_message_at === undefined ? 0 : Date.parse(input.last_visitor_message_at),
  )
  if (freshest === 0) return false
  return Date.parse(input.now) - freshest <= CHAT_ASSIST_TIMEOUTS.presence_ms
}

export type ChatAssistAction = 'wait' | 'remind' | 'email_follow_up'

export interface ChatAssistDecision {
  action: ChatAssistAction
  /** 机器可读的原因（进事件与报告），不是对客文案。 */
  reason: string
  /** 下一次该什么时候再看（`wait` 时有值）。 */
  next_check_at?: Iso8601
}

export interface ChatAssistInput {
  /** 什么时候求的助；没求过就不该调这个函数。 */
  requested_at: Iso8601
  /**
   * WP124：**固化的死线**（求助那一刻从当时的设置算出来存进会话行）。
   * 巡检不回读设置——商家中途改短，不许把已经在等的客户提前踢走。
   * 不给就按老口径（requested + T+10）。
   */
  deadline_at?: Iso8601
  /** 求助那一刻的等待时长（决定有没有中途提醒）；老口径 T+3 恒有。 */
  wait_seconds?: number
  /** 已经提醒过的时刻；提醒的幂等锚——没有它，一分钟一次的巡检会提醒七遍。 */
  reminded_at?: Iso8601
  now: Iso8601
  last_seen_at?: Iso8601
  last_visitor_message_at?: Iso8601
}

/**
 * 巡检的那一下：现在该等、该提醒，还是该转邮件。
 *
 * 顺序是有讲究的：**先判到期**。过了点就是转邮件这一件事，
 * "我还在确认" 紧接着 "我已经转到邮件了" 比两句里的任何一句单独出现都糟。
 */
export function evaluateChatAssist(input: ChatAssistInput): ChatAssistDecision {
  const schedule = chatAssistSchedule(input.requested_at, input.wait_seconds)
  // 固化的死线优先：它是在求助那一刻从"当时的设置"算出来的
  const deadline_at = input.deadline_at ?? schedule.deadline_at
  const now = Date.parse(input.now)

  if (now >= Date.parse(deadline_at)) {
    return { action: 'email_follow_up', reason: 'assist_deadline_reached' }
  }

  // 没有中途提醒的档（≤3 分钟）：死线即提醒，跳过提醒判定
  const hasMidReminder =
    input.wait_seconds === undefined || input.wait_seconds > ASSIST_MID_REMINDER_THRESHOLD_SECONDS
  if (input.reminded_at !== undefined) {
    return {
      action: 'wait',
      reason: 'already_reminded',
      next_check_at: deadline_at,
    }
  }
  if (!hasMidReminder && input.wait_seconds !== undefined) {
    return { action: 'wait', reason: 'before_deadline', next_check_at: deadline_at }
  }

  if (now < Date.parse(schedule.remind_at)) {
    return { action: 'wait', reason: 'before_reminder', next_check_at: schedule.remind_at }
  }

  // 到了 T+3，但人已经不在页面上：提醒一个空页面要花一次模型调用，写一条没人读的消息
  if (
    !isVisitorPresent({
      now: input.now,
      ...(input.last_seen_at === undefined ? {} : { last_seen_at: input.last_seen_at }),
      ...(input.last_visitor_message_at === undefined
        ? {}
        : { last_visitor_message_at: input.last_visitor_message_at }),
    })
  ) {
    return { action: 'wait', reason: 'visitor_away', next_check_at: deadline_at }
  }

  return { action: 'remind', reason: 'reminder_due' }
}
