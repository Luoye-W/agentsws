import type { Assignment, DecisionOutcome } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { adoptionLowerBound, createRoleStore, demote, suggestPromotion } from '../src/index.js'
import { aftersales, fixedClock } from './helpers.js'

function seeded() {
  const clock = fixedClock()
  const s = createRoleStore({ clock, roles: [aftersales()] })
  const a = s.assignments.create({
    person_id: 'p_cs',
    workspace_id: 'ws_1',
    role_id: 'dtc.aftersales',
    ranges: [{ kind: 'store', id: 'shop_a' }],
    granted_by: 'p_owner',
  })
  return { s, a, clock }
}

function feed(
  store: ReturnType<typeof createRoleStore>,
  id: string,
  actionId: string,
  outcome: DecisionOutcome,
  times: number,
): Assignment {
  let last = store.assignments.require(id)
  for (let i = 0; i < times; i += 1) last = store.recordDecision(id, actionId, outcome)
  return last
}

describe('adoptionLowerBound', () => {
  it('is the one-sided 95% bound and never rewards a tiny perfect run', () => {
    expect(adoptionLowerBound(0, 0)).toBe(0)
    expect(adoptionLowerBound(3, 3)).toBeLessThan(0.5)
    expect(adoptionLowerBound(30, 30)).toBeLessThan(0.95)
    expect(adoptionLowerBound(50, 50)).toBeGreaterThan(0.95)
    expect(adoptionLowerBound(190, 200)).toBeLessThan(190 / 200)
    expect(adoptionLowerBound(1, 1)).toBeGreaterThanOrEqual(0)
  })
})

describe('recordDecision (05 §1.4)', () => {
  it('counts accepted / edited / rejected per action', () => {
    const { s, a } = seeded()
    feed(s, a.id, 'reply_customer', 'accepted', 3)
    feed(s, a.id, 'reply_customer', 'edited', 2)
    const updated = feed(s, a.id, 'reply_customer', 'rejected', 1)
    expect(updated.automation_state.reply_customer?.adoption).toMatchObject({
      accepted: 3,
      edited: 2,
      rejected: 1,
    })
    // 其他动作不受影响
    expect(updated.automation_state.stage_refund?.adoption).toMatchObject({
      accepted: 0,
      edited: 0,
      rejected: 0,
    })
  })

  it('refuses an action the role does not declare', () => {
    const { s, a } = seeded()
    expect(() => s.recordDecision(a.id, 'stage_price_change', 'accepted')).toThrow(/no action/)
  })

  it('demotes one level and records the reason', () => {
    const { a, clock } = seeded()
    const promoted: Assignment = {
      ...a,
      automation_state: {
        ...a.automation_state,
        reply_customer: {
          level: 'L3',
          adoption: { accepted: 0, edited: 0, rejected: 0, since: a.granted_at },
          last_change: { at: a.granted_at, reason: 'manual' },
        },
      },
    }
    const down = demote(promoted, 'reply_customer', 'customer_complaint', clock)
    expect(down.automation_state.reply_customer?.level).toBe('L2')
    expect(down.automation_state.reply_customer?.last_change.reason).toBe('customer_complaint')
    expect(
      demote(down, 'reply_customer', 'guardrail_hit', clock).automation_state.reply_customer?.level,
    ).toBe('L1')
  })
})

describe('suggestPromotion (31 §3.4)', () => {
  it('suggests L2 for a low-risk action at 50/50 adoption', () => {
    const { s, a } = seeded()
    feed(s, a.id, 'reply_customer', 'accepted', 50)
    const suggestion = s.suggestPromotion(a.id, 'reply_customer', 'low')
    expect(suggestion).not.toBeNull()
    expect(suggestion?.to).toBe('L2')
    expect(suggestion?.from).toBe('L1')
    expect(suggestion?.samples).toBe(50)
    expect(suggestion?.adoption_rate).toBe(1)
    expect(suggestion?.target).toBe(0.95)
    expect(suggestion?.lower_bound).toBeGreaterThanOrEqual(0.95)
  })

  it('does not suggest at 30/30: the lower bound is still under 0.95', () => {
    const { s, a } = seeded()
    feed(s, a.id, 'reply_customer', 'accepted', 30)
    expect(s.suggestPromotion(a.id, 'reply_customer', 'low')).toBeNull()
    expect(adoptionLowerBound(30, 30)).toBeLessThan(0.95)
  })

  it('never suggests for a medium-risk action, not even at 200/200', () => {
    const { s, a } = seeded()
    feed(s, a.id, 'stage_refund', 'accepted', 200)
    expect(s.suggestPromotion(a.id, 'stage_refund', 'medium')).toBeNull()
    // 不传 risk_class 时按动作自己的 ChangeKind 推导，结论一样
    expect(s.suggestPromotion(a.id, 'stage_refund')).toBeNull()
  })

  it('never suggests past a hard ceiling or without samples', () => {
    const { s, a } = seeded()
    expect(s.suggestPromotion(a.id, 'draft_chargeback_evidence', 'low')).toBeNull()
    expect(s.suggestPromotion(a.id, 'reply_customer', 'low')).toBeNull()
    expect(suggestPromotion(a, aftersales(), 'nope', 'low')).toBeNull()
  })

  it('stops suggesting once edits show up', () => {
    const { s, a } = seeded()
    feed(s, a.id, 'reply_customer', 'accepted', 50)
    feed(s, a.id, 'reply_customer', 'edited', 5)
    expect(s.suggestPromotion(a.id, 'reply_customer', 'low')).toBeNull()
  })

  it('never suggests for a revoked assignment', () => {
    const { s, a } = seeded()
    feed(s, a.id, 'reply_customer', 'accepted', 50)
    const revoked = s.assignments.revoke(a.id)
    expect(suggestPromotion(revoked, aftersales(), 'reply_customer', 'low')).toBeNull()
  })
})
