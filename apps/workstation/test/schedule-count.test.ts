/**
 * WP208：「定时任务」徽标的数法（纯函数那一半；画出来那一半在 `rail-registry.test.tsx`）。
 */
import { describe, expect, it } from 'vitest'
import type { RailScope } from '@/components/rail/rail-scope'
import {
  isRunningSchedule,
  runningSchedulesIn,
  scheduleInScope,
} from '@/components/rail/schedule-count'
import type { ScheduledTaskRow } from '@/lib/api'

const row = (over: Partial<ScheduledTaskRow>): ScheduledTaskRow => ({
  id: 'sch_1',
  handler: 'automation.reminder',
  trigger: { kind: 'cron', expr: '0 9 * * *' },
  state: 'active',
  fire_count: 0,
  ...over,
})

const POSITION: RailScope = {
  tier: 'position',
  scope_id: 'customer-care',
  name: '客服',
  assignment: 'asg_support',
  assignments: ['asg_support', 'asg_chat'],
}
const ROLE: RailScope = {
  tier: 'role',
  scope_id: 'dtc.live-chat',
  name: '在线聊天',
  assignment: 'asg_chat',
  assignments: ['asg_chat'],
}

describe('在跑的', () => {
  it('active / running 算；暂停、等批、完成、别的种类不算', () => {
    expect(isRunningSchedule(row({}))).toBe(true)
    expect(isRunningSchedule(row({ state: 'running' }))).toBe(true)
    expect(isRunningSchedule(row({ state: 'paused' }))).toBe(false)
    expect(isRunningSchedule(row({ params: { awaiting_approval: true } }))).toBe(false)
    expect(isRunningSchedule(row({ state: 'pending' }))).toBe(false)
    expect(isRunningSchedule(row({ state: 'done' }))).toBe(false)
    expect(isRunningSchedule(row({ handler: 'mail.poll' }))).toBe(false)
  })
})

describe('范围', () => {
  it('岗位层 = 这个岗位里我持有的每一条分配；职责层 = 那一条', () => {
    const rows = [
      row({ assignment_id: 'asg_support', role_id: 'dtc.support' }),
      row({ assignment_id: 'asg_chat', role_id: 'dtc.live-chat' }),
      row({ assignment_id: 'asg_chat', role_id: 'dtc.live-chat', state: 'paused' }),
      // 同一条职责在另一个岗位（独立站运营）下的分配：不算进客服
      row({ assignment_id: 'asg_ops_support', role_id: 'dtc.support' }),
    ]
    expect(runningSchedulesIn(rows, POSITION)).toBe(2)
    expect(runningSchedulesIn(rows, ROLE)).toBe(1)
  })

  it('行上没有分配时，职责层退回按职责 id 认；岗位层不猜', () => {
    const bare = row({ role_id: 'dtc.live-chat' })
    expect(scheduleInScope(bare, ROLE)).toBe(true)
    expect(scheduleInScope(bare, POSITION)).toBe(false)
  })
})
