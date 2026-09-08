/**
 * 05 §1.4 + 31 §3.4：采纳率是体验指标，不解锁自动执行。
 * 只有 `risk_class == 'low'` 的动作才可能被建议升到 L2；medium / high 永远人审。
 * 样本量不用固定 30，用单侧 95% 置信下界 ≥ `promotion.adoption_rate_min`。
 */
import type { Assignment, Clock, Level, RiskClass } from '@agentsws/contracts'
import {
  type DecisionOutcome,
  type PromotionSuggestion,
  type RoleDefinitionFull,
  RoleError,
} from './types.js'

/** 单侧 95% 的正态分位数。 */
export const Z_95_ONE_SIDED = 1.6448536269514722

/**
 * 采纳率的单侧 95% 置信下界（正态近似）。
 *
 * 方差取 `max(p(1-p), 1/n)`：p 顶到 1 时朴素正态近似的方差为 0，会让"3 次全采纳"直接过线；
 * 用"至少一次失败"的不确定度兜底后，全采纳仍需 n ≥ 33 才能越过 0.95。
 */
export function adoptionLowerBound(accepted: number, samples: number): number {
  if (samples <= 0) return 0
  const p = accepted / samples
  const variance = Math.max(p * (1 - p), 1 / samples)
  const lower = p - Z_95_ONE_SIDED * Math.sqrt(variance / samples)
  return Math.min(1, Math.max(0, lower))
}

const emptyState = (at: string, level: Level): Assignment['automation_state'][string] => ({
  level,
  adoption: { accepted: 0, edited: 0, rejected: 0, since: at },
  last_change: { at, reason: 'assignment_created' },
})

/**
 * 记一次人对草稿的处置，更新该 (Assignment, action) 的采纳统计。
 * 返回新的 Assignment（不改入参）。
 */
export function recordDecision(
  assignment: Assignment,
  actionId: string,
  outcome: DecisionOutcome,
  clock: Clock,
): Assignment {
  const at = clock.now()
  const current = assignment.automation_state[actionId] ?? emptyState(at, 'L1')
  const adoption = { ...current.adoption }
  adoption[outcome] += 1
  return {
    ...assignment,
    automation_state: {
      ...assignment.automation_state,
      [actionId]: { ...current, adoption },
    },
  }
}

/** 采纳率 = accepted / (accepted + edited + rejected)。 */
export function adoptionRate(adoption: { accepted: number; edited: number; rejected: number }): {
  rate: number
  samples: number
} {
  const samples = adoption.accepted + adoption.edited + adoption.rejected
  return { rate: samples === 0 ? 0 : adoption.accepted / samples, samples }
}

/**
 * 只在 `risk_class == 'low'` 时可能给出建议，且 v1 最高只建议到 L2（31 §3.4）。
 * 建议只是建议：真正升级要人确认，且执行侧仍走同一个审批 gate。
 */
export function suggestPromotion(
  assignment: Assignment,
  role: RoleDefinitionFull,
  actionId: string,
  riskClass: RiskClass,
): PromotionSuggestion | null {
  if (assignment.revoked_at) return null
  if (riskClass !== 'low') return null
  const spec = role.automation[actionId]
  if (!spec) return null
  if (spec.hard_ceiling && spec.ceiling === 'L1') return null

  const state = assignment.automation_state[actionId]
  const from: Level = state?.level ?? spec.initial
  if (from !== 'L1') return null
  const to: Level = 'L2'
  if (spec.ceiling === 'L1') return null

  const { rate, samples } = adoptionRate(state?.adoption ?? { accepted: 0, edited: 0, rejected: 0 })
  if (samples === 0) return null
  const lower = adoptionLowerBound(state?.adoption.accepted ?? 0, samples)
  const target = spec.promotion.adoption_rate_min
  if (lower < target) return null

  return {
    assignment_id: assignment.id,
    action_id: actionId,
    from,
    to,
    risk_class: riskClass,
    samples,
    adoption_rate: rate,
    lower_bound: lower,
    target,
    reason: `one-sided 95% lower bound ${lower.toFixed(4)} >= adoption_rate_min ${target} over ${samples} samples`,
  }
}

/** 05 §1.4 降级触发即降一级；不做自动升级，升级只出建议。 */
export function demote(
  assignment: Assignment,
  actionId: string,
  reason: 'customer_complaint' | 'guardrail_hit' | 'manual',
  clock: Clock,
): Assignment {
  const at = clock.now()
  const current = assignment.automation_state[actionId]
  if (!current) throw new RoleError('not_found', `no automation state for action ${actionId}`)
  const order: Level[] = ['L1', 'L2', 'L3']
  const next = order[Math.max(0, order.indexOf(current.level) - 1)] ?? 'L1'
  return {
    ...assignment,
    automation_state: {
      ...assignment.automation_state,
      [actionId]: { ...current, level: next, last_change: { at, reason } },
    },
  }
}
