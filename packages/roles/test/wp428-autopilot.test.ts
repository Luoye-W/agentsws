/**
 * WP428（决策 1244 改）：够条件 → 建议开全自动（判定这一半）。
 */
import type { ApprovalItem } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { type AutopilotHistoryItem, autopilotOutcomeOf, evaluateAutopilot } from '../src/index.js'

const at = (i: number): string => new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString()
const approved = (n: number, from = 0): AutopilotHistoryItem[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `ap_${from + i}`,
    at: at(from + i),
    outcome: 'approved',
  }))

describe('evaluateAutopilot', () => {
  it('最近 N 张都原样批了 → 够条件，说清凭什么', () => {
    const v = evaluateAutopilot(approved(10), { needed: 10 })
    expect(v.eligible).toBe(true)
    expect(v.sample_ids).toHaveLength(10)
    expect(v.why).toContain('原样批了')
  })

  it('还差几张 / 最近一张被改过 → 不够', () => {
    const short = evaluateAutopilot(approved(7), { needed: 10 })
    expect(short.eligible).toBe(false)
    expect(short.why).toContain('还差 3 张')
    const edited = evaluateAutopilot(
      [...approved(12), { id: 'ap_x', at: at(99), outcome: 'edited' }],
      { needed: 10 },
    )
    expect(edited.eligible).toBe(false)
    expect(edited.streak).toBe(0)
    expect(edited.why).toContain('被改过')
  })

  it('出过事（施行失败）断掉连续；`since` 之后才重新算', () => {
    const failed = evaluateAutopilot(
      [...approved(5), { id: 'ap_f', at: at(5), outcome: 'failed' }, ...approved(9, 6)],
      { needed: 10 },
    )
    expect(failed.eligible).toBe(false)
    expect(failed.streak).toBe(9)
    const since = evaluateAutopilot(approved(20), { needed: 10, since: at(14) })
    expect(since.streak).toBe(5)
    expect(since.eligible).toBe(false)
  })
})

describe('autopilotOutcomeOf', () => {
  const base = {
    id: 'ap_1',
    updated_at: at(1),
    state: 'approved',
    decision: { action: 'approve', by: 'p_1', at: at(1), via: 'workstation' },
  } as unknown as ApprovalItem
  it('人原样批 / 改了批 / 驳回 / 施行失败 / 额度内自动批不算', () => {
    expect(autopilotOutcomeOf(base)?.outcome).toBe('approved')
    expect(
      autopilotOutcomeOf({
        ...base,
        state: 'approved_edited',
        decision: { ...base.decision, action: 'approve_edited' },
      } as ApprovalItem)?.outcome,
    ).toBe('edited')
    expect(
      autopilotOutcomeOf({
        ...base,
        state: 'rejected',
        decision: { ...base.decision, action: 'reject' },
      } as ApprovalItem)?.outcome,
    ).toBe('rejected')
    expect(autopilotOutcomeOf({ ...base, state: 'apply_failed' } as ApprovalItem)?.outcome).toBe(
      'failed',
    )
    expect(
      autopilotOutcomeOf({
        ...base,
        decision: { ...base.decision, by: 'mandate' },
      } as ApprovalItem),
    ).toBeUndefined()
    expect(
      autopilotOutcomeOf({ ...base, decision: undefined, state: 'pending' } as ApprovalItem),
    ).toBeUndefined()
  })
})
