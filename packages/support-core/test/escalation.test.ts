import { describe, expect, it } from 'vitest'
import type { ThreadState } from '../src/index.js'
import {
  classifyText,
  computeSla,
  deEscalated,
  escalationDedupeKey,
  evaluateManualReview,
  MANUAL_REVIEW_RULES,
  MANUAL_REVIEW_SCAN_CHARS,
  returnWindowPolicy,
  shouldEscalate,
} from '../src/index.js'

const NOW = '2026-09-07T01:00:00.000Z'
const ANSWERED = [
  returnWindowPolicy(14, NOW),
  { boundary_id: 'policy.return_shipping_payer' },
  { boundary_id: 'policy.replacement_first' },
]

const CALM = classifyText({ text: 'where is my package for order #4105' }, { now: NOW })
const QUIET_THREAD: ThreadState = { messages: 1, agent_replies: 0 }
const TRACKING_ANSWERED = [
  ...ANSWERED,
  { boundary_id: 'policy.logistics_anomaly_days' },
  { boundary_id: 'policy.customs_duty_payer' },
  { boundary_id: 'policy.cancel_change_window' },
  { boundary_id: 'policy.lost_package_liability' },
]

describe('强制人工复核词面（KefuAgent AMAZON_MANUAL_REVIEW_KEYWORDS 的移植）', () => {
  it('每条规则都有对应的命中样本，且只返回规则 id', () => {
    const samples: Record<string, string> = {
      negative_feedback: 'I will leave negative feedback',
      negative_review: 'expect a negative review',
      bad_review: 'I will write a bad review',
      poor_review: 'that deserves a poor review',
      one_star: 'this is a 1 star order',
      leave_feedback_threat: 'I will leave a bad review about this',
      a_to_z: 'I opened an a-to-z case',
      a2z: 'filing a2z now',
      marketplace_guarantee: 'this is a guarantee claim',
      chargeback: 'I am filing a chargeback',
      legal: 'my lawyer will call you',
      legal_zh: '我要起诉你们',
    }
    for (const { rule } of MANUAL_REVIEW_RULES) {
      const text = samples[rule]
      expect(text, rule).toBeDefined()
      expect(evaluateManualReview(text).rules, rule).toContain(rule)
    }
    expect(evaluateManualReview('all good, thanks').required).toBe(false)
    expect(evaluateManualReview(undefined, '').required).toBe(false)
  })

  it('超长正文只扫前 20000 字', () => {
    const padded = `${'x'.repeat(MANUAL_REVIEW_SCAN_CHARS + 10)} chargeback`
    expect(evaluateManualReview(padded).required).toBe(false)
    expect(evaluateManualReview(`chargeback ${padded}`).required).toBe(true)
  })

  it('起草文本也一起扫（回复里出现的威胁同样要人看）', () => {
    const decision = shouldEscalate(CALM, { ...QUIET_THREAD, draft_text: 'a2z' }, TRACKING_ANSWERED)
    expect(decision.reasons).toContain('manual_review:a2z')
  })
})

describe('shouldEscalate', () => {
  it('一切正常 → 不转', () => {
    const d = shouldEscalate(CALM, QUIET_THREAD, TRACKING_ANSWERED)
    expect(d.escalate).toBe(false)
    expect(d.reason).toBe('none')
    expect(d.to).toBe('role_holder')
  })

  it('关系授权门禁挡下 → 转管理者，最高优先级', () => {
    const d = shouldEscalate(
      CALM,
      { ...QUIET_THREAD, authorization_blocked: true },
      TRACKING_ANSWERED,
    )
    expect(d.escalate).toBe(true)
    expect(d.reason).toBe('authorization_check_failed')
    expect(d.to).toBe('manager')
    expect(d.severity).toBe('high')
  })

  it('拒付 / 法律 → 管理者；差评 → 职责持有人', () => {
    const chargeback = shouldEscalate(
      CALM,
      { ...QUIET_THREAD, inbound_text: 'I am filing a chargeback' },
      TRACKING_ANSWERED,
    )
    expect(chargeback.to).toBe('manager')
    const review = shouldEscalate(
      CALM,
      { ...QUIET_THREAD, inbound_text: 'I will leave a negative review' },
      TRACKING_ANSWERED,
    )
    expect(review.to).toBe('role_holder')
    expect(review.severity).toBe('high')
  })

  it('没答过的边界也算一条理由（但不升级严重度）', () => {
    const d = shouldEscalate(CALM, QUIET_THREAD, [])
    expect(d.escalate).toBe(true)
    expect(d.reasons.some((r) => r.startsWith('boundary_unanswered:'))).toBe(true)
    expect(d.severity).toBe('medium')
  })

  it('SLA 三档各产生一条理由，停表后不产生', () => {
    const anchor = NOW
    const mk = (now: string) => computeSla({ anchor_at: anchor, now })
    const reminder = shouldEscalate(
      CALM,
      { ...QUIET_THREAD, sla: mk('2026-09-07T14:00:00.000Z') },
      TRACKING_ANSWERED,
    )
    expect(reminder.reasons).toContain('sla_reminder')
    const critical = shouldEscalate(
      CALM,
      { ...QUIET_THREAD, sla: mk('2026-09-07T22:00:00.000Z') },
      TRACKING_ANSWERED,
    )
    expect(critical.reasons).toContain('sla_critical')
    expect(critical.severity).toBe('high')
    const breached = shouldEscalate(
      CALM,
      { ...QUIET_THREAD, sla: mk('2026-09-09T00:00:00.000Z') },
      TRACKING_ANSWERED,
    )
    expect(breached.reasons).toContain('sla_first_response_breached')
    expect(breached.to).toBe('manager')
    const stopped = computeSla({
      anchor_at: anchor,
      now: '2026-09-09T00:00:00.000Z',
      last_outbound_at: '2026-09-07T03:00:00.000Z',
    })
    expect(
      shouldEscalate(CALM, { ...QUIET_THREAD, sla: stopped }, TRACKING_ANSWERED).escalate,
    ).toBe(false)
    expect(deEscalated(stopped, '2026-09-09T00:00:00.000Z')).toBe(true)
    expect(deEscalated(undefined, NOW)).toBe(false)
  })

  it('反复来信与谈不下去', () => {
    expect(
      shouldEscalate(CALM, { ...QUIET_THREAD, reopened: 2 }, TRACKING_ANSWERED).reasons,
    ).toContain('repeated_reopen')
    expect(
      shouldEscalate(CALM, { messages: 6, agent_replies: 3 }, TRACKING_ANSWERED).reasons,
    ).toContain('conversation_stalled')
  })

  it('客户声称我们承诺过什么 → 高严重度', () => {
    const claim = classifyText(
      { text: 'you promised a full refund for order #4129 last week' },
      { now: NOW },
    )
    const d = shouldEscalate(claim, QUIET_THREAD, TRACKING_ANSWERED)
    expect(d.reasons).toContain('claimed_commitment')
    expect(d.severity).toBe('high')
  })
})

describe('去重键', () => {
  it('形状是 workspace:family:carrier，载体按优先级退', () => {
    expect(
      escalationDedupeKey({ workspace_id: 'ws', family: 'chat_assist', thread_id: 'thr_1' }),
    ).toBe('ws:chat_assist:thr_1')
    expect(escalationDedupeKey({ workspace_id: 'ws', family: 'sla', conversation_id: 'c1' })).toBe(
      'ws:sla:c1',
    )
    expect(escalationDedupeKey({ workspace_id: 'ws', family: 'sla', operation_id: 'op' })).toBe(
      'ws:sla:op',
    )
    expect(escalationDedupeKey({ workspace_id: 'ws', family: 'sla' })).toBe('ws:sla:workspace')
  })
})
