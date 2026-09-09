import type { EventEnvelope } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { BATTLE_REPORT_EVENT_TYPES, battleReport } from '../src/index.js'

/** Asia/Shanghai：UTC+8，日界线在 UTC 16:00。 */
const TZ = 480
const NOW = '2026-09-07T01:00:00.000Z' // 当地 09-07 09:00

function evt(over: Partial<EventEnvelope> & { type: string; at: string }): EventEnvelope {
  return {
    id: `evt_${over.type}_${over.at}`,
    schema_version: 1,
    workspace_id: 'ws_1',
    actor: { kind: 'agent', id: 'agent_1' },
    correlation: { trace_id: 'tr_1' },
    payload: {},
    ...over,
  }
}

describe('今日战报四格（37 §1 第 9 行；只从事件日志算）', () => {
  it('四格各按自己的判据数', () => {
    const events: EventEnvelope[] = [
      // 跑完了，没回头问人 → AI 自主处理
      evt({
        type: 'run.completed',
        at: '2026-09-07T00:10:00.000Z',
        correlation: { trace_id: 't', run_id: 'run_ok' },
      }),
      // 跑完了，但中途建了卡 → 不算自主
      evt({
        type: 'approval.created',
        at: '2026-09-07T00:20:00.000Z',
        correlation: { trace_id: 't', run_id: 'run_ask' },
      }),
      evt({
        type: 'run.completed',
        at: '2026-09-07T00:30:00.000Z',
        correlation: { trace_id: 't', run_id: 'run_ask' },
      }),
      // 人做的决定
      evt({
        type: 'approval.decided',
        at: '2026-09-07T00:40:00.000Z',
        actor: { kind: 'person', id: 'p_wang' },
      }),
      // mandate 自动决定的不算「你已处理」
      evt({
        type: 'approval.decided',
        at: '2026-09-07T00:41:00.000Z',
        actor: { kind: 'system', id: 'mandate' },
      }),
      // 额度内自动批准
      evt({
        type: 'approval.auto_approved',
        at: '2026-09-07T00:50:00.000Z',
        actor: { kind: 'system', id: 'mandate' },
      }),
    ]
    expect(battleReport(events, { now: NOW, tz_offset_minutes: TZ })).toEqual({
      date: '2026-09-07',
      ai_handled: 1,
      handled: 1,
      auto_sent: 1,
      intercepted: 1,
    })
  })

  it('run_id 从 actor 上取也算数；没有 run_id 的完成一律算自主', () => {
    const events: EventEnvelope[] = [
      evt({
        type: 'approval.created',
        at: '2026-09-07T00:20:00.000Z',
        actor: { kind: 'agent', id: 'a', run_id: 'run_x' },
      }),
      evt({
        type: 'run.completed',
        at: '2026-09-07T00:21:00.000Z',
        actor: { kind: 'agent', id: 'a', run_id: 'run_x' },
      }),
      evt({ type: 'run.completed', at: '2026-09-07T00:22:00.000Z' }),
    ]
    const r = battleReport(events, { now: NOW, tz_offset_minutes: TZ })
    expect(r.ai_handled).toBe(1)
    expect(r.intercepted).toBe(1)
  })

  it('日界线按工作区时区切，不按 UTC', () => {
    // UTC 09-06 17:00 = 当地 09-07 01:00 → 算今天
    const inside = evt({ type: 'approval.auto_approved', at: '2026-09-06T17:00:00.000Z' })
    // UTC 09-06 15:00 = 当地 09-06 23:00 → 算昨天
    const outside = evt({ type: 'approval.auto_approved', at: '2026-09-06T15:00:00.000Z' })
    const r = battleReport([inside, outside], { now: NOW, tz_offset_minutes: TZ })
    expect(r.auto_sent).toBe(1)
    // UTC 档下两条都不是 09-07
    expect(battleReport([inside, outside], { now: NOW, tz_offset_minutes: 0 }).auto_sent).toBe(0)
  })

  it('不认识的事件与坏时间戳一律不计；空表出四个零', () => {
    const r = battleReport(
      [evt({ type: 'model.usage', at: NOW }), evt({ type: 'approval.decided', at: 'nope' })],
      { now: NOW, tz_offset_minutes: TZ },
    )
    expect(r).toEqual({
      date: '2026-09-07',
      ai_handled: 0,
      handled: 0,
      auto_sent: 0,
      intercepted: 0,
    })
    expect(battleReport([], { now: NOW, tz_offset_minutes: TZ }).handled).toBe(0)
  })

  it('now 坏掉时不抛，退到纪元日', () => {
    expect(battleReport([], { now: 'x', tz_offset_minutes: 0 }).date).toBe('1970-01-01')
  })

  it('导出预过滤用的类型表（调用方拿它省 IO，不影响结果）', () => {
    expect([...BATTLE_REPORT_EVENT_TYPES]).toEqual([
      'run.completed',
      'approval.created',
      'approval.decided',
      'approval.auto_approved',
    ])
  })
})
