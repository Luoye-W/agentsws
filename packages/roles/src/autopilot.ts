/**
 * WP428（决策 1244 改）：**够条件 → 建议开全自动**（通用积木，判定这一半）。
 *
 * 与 `automation.ts` 的升级建议是同一回事的另一头：那边按采纳率的置信下界只给 low 风险动作建议升到 L2；
 * 这里回答的是另一个问题——「这一类卡人是不是一直原样在批？」：
 *
 * > 这条职责最近 N 张同类卡都被**原样批准**（没改、没驳回）、**也没出过事**（施行没失败），
 * > 就出一张建议卡「这类可以交给 AI 全自动了」，说清凭什么；人点了才开，随时能关。
 *
 * 只判定，不开关：开不开、开了让 AI 多做哪一步，由各职责自己接（这一单只在红人上真开）。
 * 纯函数，零 IO。
 */
import type { ApprovalItem, Iso8601 } from '@agentsws/contracts'

/** 一张同类卡的结局（只认人真点过的）。 */
export type AutopilotOutcome = 'approved' | 'edited' | 'rejected' | 'failed'

export interface AutopilotHistoryItem {
  id: string
  /** 决定（或施行失败）的时刻。 */
  at: Iso8601
  outcome: AutopilotOutcome
}

export interface AutopilotEligibility {
  eligible: boolean
  /** 从最近一张往回数，连着原样批准了几张。 */
  streak: number
  /** 要连着几张。 */
  needed: number
  /** 算进来的那几张卡（最近的在前，最多 `needed` 张）。 */
  sample_ids: string[]
  /** 一句人话：凭什么 / 还差什么。 */
  why: string
}

/**
 * 一张卡 → 它的结局。没定的（等着、稍后、撤回、过期、被顶替）回 `undefined`，不算样本；
 * 额度内自动批的（`by: 'mandate'`）也不算——要的是**人**原样批过。
 */
export function autopilotOutcomeOf(item: ApprovalItem): AutopilotHistoryItem | undefined {
  const d = item.decision
  if (d === undefined || d.by === 'mandate') return undefined
  const at = item.updated_at
  if (item.state === 'apply_failed' || item.apply?.attempts.at(-1)?.result === 'failed')
    return { id: item.id, at, outcome: 'failed' }
  if (d.action === 'reject') return { id: item.id, at, outcome: 'rejected' }
  if (
    d.action === 'approve_edited' ||
    item.state === 'approved_edited' ||
    d.edited_payload !== undefined
  )
    return { id: item.id, at, outcome: 'edited' }
  if (d.action === 'approve') return { id: item.id, at, outcome: 'approved' }
  return undefined
}

const WHY_BREAK: Record<Exclude<AutopilotOutcome, 'approved'>, string> = {
  edited: '被改过',
  rejected: '被驳回了',
  failed: '施行没成功',
}

/**
 * 最近 `needed` 张同类卡是不是都原样批准、没出事。`since` 给了就只看它之后的（人说过「先不开」/ 关过之后，
 * 要重新攒满一轮才再建议）。
 */
export function evaluateAutopilot(
  history: readonly AutopilotHistoryItem[],
  rule: { needed: number; since?: Iso8601 },
): AutopilotEligibility {
  const needed = Math.max(1, Math.floor(rule.needed))
  const recent = history
    .filter((h) => rule.since === undefined || h.at > rule.since)
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.id < b.id ? 1 : -1))
  let streak = 0
  for (const h of recent) {
    if (h.outcome !== 'approved') break
    streak += 1
  }
  const breaker = recent[streak]
  const sample_ids = recent.slice(0, Math.min(streak, needed)).map((h) => h.id)
  if (streak >= needed)
    return {
      eligible: true,
      streak,
      needed,
      sample_ids,
      why: `最近 ${needed} 张同类卡你都原样批了，没改过、没驳回、施行也都成功了`,
    }
  const why =
    breaker !== undefined && streak < needed
      ? `最近一张${breaker.outcome === 'approved' ? '' : WHY_BREAK[breaker.outcome]}，要重新连着原样批满 ${needed} 张`
      : `已经连着原样批了 ${streak} 张，还差 ${needed - streak} 张`
  return { eligible: false, streak, needed, sample_ids, why }
}
