/**
 * WP468（决策 1478）：「这次运行是哪条分配发起的」——第三栏浏览器面板的窄放行靠它。
 * 认 `run.started` 那一条的 `actor.id`（运行时记事件时 actor 就是分配 id）；认不出一律不给。
 */
import type { EventEnvelope } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { type RunEventReader, readRunAssignment } from '../src/run-browser.js'

let seq = 0
function ev(over: Partial<EventEnvelope> & { type: string }): EventEnvelope {
  seq += 1
  return {
    id: `ev_${seq}`,
    schema_version: 1,
    workspace_id: 'ws_1',
    at: '2026-10-22T02:00:00.000Z',
    actor: { kind: 'agent', id: 'asg_kol', run_id: 'run_1' },
    correlation: { trace_id: 'trc_run_run_1', run_id: 'run_1' },
    payload: {},
    ...over,
  }
}

/** 按 workspace / run 过滤的假日志（同 `GatewayDeps.eventLog.read` 的形状）。 */
function reader(events: EventEnvelope[]): RunEventReader {
  return {
    async *read(filter) {
      for (const e of events) {
        if (e.workspace_id !== filter.workspace_id) continue
        if (filter.run_id !== undefined && e.correlation.run_id !== filter.run_id) continue
        yield e
      }
    },
  }
}

describe('readRunAssignment', () => {
  it('run.started 的 actor 就是发起的那条分配', async () => {
    const log = reader([
      ev({ type: 'run.started' }),
      ev({ type: 'tool.call', payload: { tool: 'ego_run' } }),
    ])
    expect(await readRunAssignment(log, 'ws_1', 'run_1')).toBe('asg_kol')
  })

  it('没有这次运行 / 别的工作区 / 没记 run.started / actor 不是 agent → 认不出', async () => {
    const started = ev({ type: 'run.started' })
    expect(await readRunAssignment(reader([started]), 'ws_1', 'run_2')).toBeUndefined()
    expect(await readRunAssignment(reader([started]), 'ws_2', 'run_1')).toBeUndefined()
    expect(
      await readRunAssignment(reader([ev({ type: 'tool.call' })]), 'ws_1', 'run_1'),
    ).toBeUndefined()
    expect(
      await readRunAssignment(
        reader([ev({ type: 'run.started', actor: { kind: 'person', id: 'p_1' } })]),
        'ws_1',
        'run_1',
      ),
    ).toBeUndefined()
  })

  it('同一次运行里后来别人做的事（审批、转交）不改「谁发起的」', async () => {
    const log = reader([
      ev({ type: 'run.started' }),
      ev({ type: 'approval.claimed', actor: { kind: 'person', id: 'p_boss' } }),
      ev({ type: 'run.started', actor: { kind: 'agent', id: 'asg_other', run_id: 'run_1' } }),
    ])
    expect(await readRunAssignment(log, 'ws_1', 'run_1')).toBe('asg_kol')
  })
})
