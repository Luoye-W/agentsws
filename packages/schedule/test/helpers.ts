/** 测试用的小工具：可推进的时钟、任务模板、事件收集器。本包不依赖 kernel，时钟自带一个。 */
import type { Clock, Iso8601 } from '@agentsws/contracts'
import type { ScheduleEventSink, ScheduleInput, ScheduleTask } from '../src/index.js'

export class TestClock implements Clock {
  private ms: number

  constructor(start: Iso8601 | number) {
    this.ms = typeof start === 'number' ? start : Date.parse(start)
  }

  now(): Iso8601 {
    return new Date(this.ms).toISOString()
  }

  nowMs(): number {
    return this.ms
  }

  advance(ms: number): void {
    this.ms += ms
  }

  set(at: Iso8601): void {
    this.ms = Date.parse(at)
  }
}

export interface Recorded {
  type: string
  payload: Record<string, unknown>
  at: Iso8601
  subject?: { type: string; id: string }
}

export function recorder(): { sink: ScheduleEventSink; events: Recorded[] } {
  const events: Recorded[] = []
  return {
    events,
    sink: (e) => {
      events.push({
        type: e.type,
        payload: e.payload,
        at: e.at,
        ...(e.subject === undefined ? {} : { subject: e.subject }),
      })
    },
  }
}

/** 一条最小可用的任务：工作区 / 岗位 / 职责三样齐（13 §1.3 与职责绑定）。 */
export function taskInput(over: Partial<ScheduleInput> = {}): ScheduleInput {
  return {
    workspace_id: 'ws_test',
    owner: 'p_owner',
    role_id: 'dtc.aftersales',
    assignment_id: 'asg_1',
    trigger: { kind: 'once', at: '2026-09-10T09:00:00.000Z' },
    created_by: 'user',
    misfire_policy: 'run_once_now',
    handler: 'noop',
    ...over,
  }
}

export const isActive = (t: ScheduleTask): boolean => t.state === 'active'
