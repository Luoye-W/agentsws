import { describe, expect, it } from 'vitest'
import {
  ASSIST_MID_REMINDER_THRESHOLD_SECONDS,
  ASSIST_WAIT_DEFAULT_SECONDS,
  ASSIST_WAIT_MAX_SECONDS,
  ASSIST_WAIT_MIN_SECONDS,
  ASSIST_WAIT_QUICK_OPTIONS,
  chatAssistSchedule,
  evaluateChatAssist,
  normalizeAssistWaitSeconds,
} from '../src/chat/assist-timeout.js'

const T0 = '2026-09-21T10:00:00.000Z'
const at = (base: string, seconds: number): string =>
  new Date(Date.parse(base) + seconds * 1000).toISOString()

describe('求助等待时长（WP124 修订第 3 条）', () => {
  it('默认 30 秒；范围 10–600；非法值回落默认而不是最长档', () => {
    expect(ASSIST_WAIT_DEFAULT_SECONDS).toBe(30)
    expect(ASSIST_WAIT_MIN_SECONDS).toBe(10)
    expect(ASSIST_WAIT_MAX_SECONDS).toBe(600)
    expect(ASSIST_WAIT_QUICK_OPTIONS).toEqual([30, 60, 180, 300, 600])
    expect(normalizeAssistWaitSeconds(45)).toBe(45)
    expect(normalizeAssistWaitSeconds(0)).toBe(30)
    expect(normalizeAssistWaitSeconds(-5)).toBe(30)
    expect(normalizeAssistWaitSeconds(601)).toBe(30)
    expect(normalizeAssistWaitSeconds('abc')).toBe(30)
    expect(normalizeAssistWaitSeconds(30.5)).toBe(30)
  })

  it('30 秒档：没有中途提醒（死线即提醒），死线在 +30s 固化', () => {
    const schedule = chatAssistSchedule(T0, 30)
    expect(schedule.deadline_at).toBe(at(T0, 30))
    expect(Date.parse(schedule.remind_at)).toBe(Date.parse(schedule.deadline_at))
    // +29s：还在等
    expect(
      evaluateChatAssist({
        requested_at: T0,
        deadline_at: schedule.deadline_at,
        wait_seconds: 30,
        now: at(T0, 29),
      }).action,
    ).toBe('wait')
    // +30s：转邮件
    expect(
      evaluateChatAssist({
        requested_at: T0,
        deadline_at: schedule.deadline_at,
        wait_seconds: 30,
        now: at(T0, 30),
      }).action,
    ).toBe('email_follow_up')
  })

  it('5 分钟档：+3 分钟有中途提醒（措辞由调用方换），死线在 +5 分钟', () => {
    expect(ASSIST_MID_REMINDER_THRESHOLD_SECONDS).toBe(180)
    const schedule = chatAssistSchedule(T0, 300)
    expect(schedule.deadline_at).toBe(at(T0, 300))
    expect(schedule.remind_at).toBe(at(T0, 180))
    const mid = evaluateChatAssist({
      requested_at: T0,
      deadline_at: schedule.deadline_at,
      wait_seconds: 300,
      now: at(T0, 180),
      last_seen_at: at(T0, 179),
    })
    expect(mid.action).toBe('remind')
    // 提醒过的幂等锚还在
    const again = evaluateChatAssist({
      requested_at: T0,
      deadline_at: schedule.deadline_at,
      wait_seconds: 300,
      now: at(T0, 240),
      reminded_at: at(T0, 180),
    })
    expect(again.action).toBe('wait')
  })

  it('固化的死线优先于现在的设置：商家改短不许把在等的客户提前踢走', () => {
    // 求助那一刻按 10 分钟固化；商家现在把默认改成 30 秒（参数不传 wait，死线仍在）
    const decision = evaluateChatAssist({
      requested_at: T0,
      deadline_at: at(T0, 600),
      now: at(T0, 120),
    })
    expect(decision.action).toBe('wait')
    // 下一次检查还在 +3 分钟（这条没传 wait_seconds → 按老口径可能有中途提醒）
    expect(decision.next_check_at).toBe(at(T0, 180))
  })

  it('老口径不变：没存死线的旧会话按 T+3 / T+10 跑', () => {
    const schedule = chatAssistSchedule(T0)
    expect(schedule.deadline_at).toBe(at(T0, 600))
    expect(schedule.remind_at).toBe(at(T0, 180))
    expect(
      evaluateChatAssist({ requested_at: T0, now: at(T0, 180), last_seen_at: at(T0, 179) }).action,
    ).toBe('remind')
    expect(evaluateChatAssist({ requested_at: T0, now: at(T0, 600) }).action).toBe(
      'email_follow_up',
    )
  })
})
