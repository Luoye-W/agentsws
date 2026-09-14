/**
 * Extracted from KefuAgent src/lib/support/chat.ts
 * (liveChatAssistTimeouts / isAssistReminderDue / isAssistDemotionDue / isChatCustomerPresent),
 * rewritten for agentsws contracts.
 *
 * 求助超时：访客要人工之后，商家没接，这条会话不能就这么挂着。
 *
 * - **T+3 分钟**：给访客一条进度提醒（"还在确认；不方便等就留个邮箱"）。一次，只此一次；
 * - **T+10 分钟**：转邮件跟进——把在这里干等换成"我们发邮件给你"，然后放访客走。
 *
 * 这两个值是产品口径，不是可调旋钮（本地档只有一个商家，没有"每个工作区一套预设"
 * 那件事；KefuAgent 的四档预设留给托管档）。
 *
 * 全部纯判定：时间从参数进来，本文件里没有 `Date.now()`。
 */
import type { Iso8601 } from '@agentsws/contracts'

export const CHAT_ASSIST_TIMEOUTS = {
  /** T+3：访客能拿到的那一条进度提醒。 */
  reminder_ms: 3 * 60 * 1000,
  /** T+10：停止等待，转邮件跟进。 */
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

export function chatAssistSchedule(requested_at: Iso8601): ChatAssistSchedule {
  const base = Date.parse(requested_at)
  return {
    requested_at,
    remind_at: new Date(base + CHAT_ASSIST_TIMEOUTS.reminder_ms).toISOString(),
    deadline_at: new Date(base + CHAT_ASSIST_TIMEOUTS.deadline_ms).toISOString(),
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
  const schedule = chatAssistSchedule(input.requested_at)
  const now = Date.parse(input.now)

  if (now >= Date.parse(schedule.deadline_at)) {
    return { action: 'email_follow_up', reason: 'assist_deadline_reached' }
  }

  if (input.reminded_at !== undefined) {
    return {
      action: 'wait',
      reason: 'already_reminded',
      next_check_at: schedule.deadline_at,
    }
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
    return { action: 'wait', reason: 'visitor_away', next_check_at: schedule.deadline_at }
  }

  return { action: 'remind', reason: 'reminder_due' }
}
