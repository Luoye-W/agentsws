/**
 * 晋升（24 §2 第二行、06 §3.4 每周巩固、07 §1 第 3 条判据）。
 *
 * 判据用 **Wilson 单侧 95% 下界**（`@agentsws/roles` 的 `adoptionLowerBound`，
 * 与自动化档位晋级同一把尺子——不在两处各写一套统计）：
 * 少数几次全采纳不算数，要样本够多才越得过 0.9。
 *
 * 产出仍然只是一张 `skill_promotion` 卡：eval 红 → 预检 blocked，不进队列（24 §6.6）。
 */
import type { AssignmentId, Iso8601, SkillTier } from '@agentsws/contracts'
import { adoptionLowerBound } from '@agentsws/roles'
import type { PooledLesson } from './types.js'

/** 07 §1 第 3 条：≥ 0.9、≥ 5 次采用、≥ 2 个贡献者、≥ 14 天。 */
export const PROMOTION_CRITERIA = {
  min_lower_bound: 0.9,
  min_adoptions: 5,
  min_contributors: 2,
  min_age_days: 14,
} as const

const DAY_MS = 86_400_000

const round = (n: number, digits: number): number => {
  const f = 10 ** digits
  return Math.round(n * f) / f
}

export interface PromotionCriteriaCheck {
  /** Wilson 单侧 95% 下界（不是裸采纳率） */
  lower_bound: number
  accepted: number
  samples: number
  contributors: number
  age_days: number
  passed: boolean
  missing: string[]
}

export interface PromotionEvalResult {
  status: 'green' | 'red' | 'unknown'
  failed?: string[]
  detail?: string
}

export interface PromotionCard {
  skill: string
  section_ids: string[]
  from: { tier: SkillTier; owner: string }
  to_tier: SkillTier
  title: string
  summary: string
  proposed_text: string
  contributors: AssignmentId[]
  evidence: { lessons: string[]; quotes: string[] }
  criteria: PromotionCriteriaCheck
  diff: { before: string | null; after: string; summary: string }
  created_at: Iso8601
}

export interface PromotionBlocked {
  skill: string
  reason: 'eval_red' | 'criteria' | 'policy_layer'
  detail: string
  criteria?: PromotionCriteriaCheck
}

/** 算判据。`samples` = 这些 lesson 一共被提过几次（accepted + ignored + refuted 都算样本）。 */
export function promotionCriteria(input: {
  accepted: number
  samples: number
  contributors: number
  oldest_at?: Iso8601
  now: Iso8601
}): PromotionCriteriaCheck {
  // 保留四位：一是人读得懂，二是卡片 payload 里不出现十几位连续数字
  // （14 §6 的密钥 / 卡号扫描会把 `0.3663787018712345` 当成卡号拦下来）
  const lower = round(adoptionLowerBound(input.accepted, input.samples), 4)
  const nowMs = Date.parse(input.now)
  const oldMs = input.oldest_at === undefined ? Number.NaN : Date.parse(input.oldest_at)
  const age_days =
    Number.isFinite(oldMs) && Number.isFinite(nowMs)
      ? round(Math.max(0, (nowMs - oldMs) / DAY_MS), 2)
      : 0
  const missing: string[] = []
  if (lower < PROMOTION_CRITERIA.min_lower_bound) {
    missing.push(`采纳率下界 ${lower.toFixed(2)} < ${PROMOTION_CRITERIA.min_lower_bound}`)
  }
  if (input.accepted < PROMOTION_CRITERIA.min_adoptions) missing.push('采用次数 < 5')
  if (input.contributors < PROMOTION_CRITERIA.min_contributors) missing.push('贡献者 < 2')
  if (age_days < PROMOTION_CRITERIA.min_age_days) missing.push('存在时间 < 14 天')
  return {
    lower_bound: lower,
    accepted: input.accepted,
    samples: input.samples,
    contributors: input.contributors,
    age_days,
    passed: missing.length === 0,
    missing,
  }
}

export interface WeeklyPromotionInput {
  workspace_id: string
  /** 全池（本函数自己挑 accepted 的那些） */
  lessons: readonly PooledLesson[]
  now: Iso8601
  from: { tier: SkillTier; owner: string }
  to_tier?: SkillTier
  /** eval 结果由宿主跑完给进来；本包不跑 eval（24 §6.6） */
  evalResult?: PromotionEvalResult
  policySkills?: Iterable<string>
  /** 不满足量化判据时是否照样出卡；缺省不出（07 §1 是硬门槛） */
  enforce_criteria?: boolean
}

export interface WeeklyPromotionResult {
  cards: PromotionCard[]
  blocked: PromotionBlocked[]
}

/**
 * 每周巩固：同一 (skill, section) 下 ≥ 2 个 assignment 接受了相似修改 → 一条晋升提议。
 */
export function weeklyPromotions(input: WeeklyPromotionInput): WeeklyPromotionResult {
  const toTier = input.to_tier ?? 'department'
  const policySkills = new Set(input.policySkills ?? [])
  const enforce = input.enforce_criteria ?? true
  const pool = input.lessons.filter((l) => l.workspace_id === input.workspace_id)
  const accepted = pool.filter((l) => l.status === 'accepted')

  const groups = new Map<string, PooledLesson[]>()
  for (const l of accepted) {
    const key = `${l.applies_to.skill}::${l.applies_to.section_id ?? ''}`
    const list = groups.get(key) ?? []
    list.push(l)
    groups.set(key, list)
  }

  const cards: PromotionCard[] = []
  const blocked: PromotionBlocked[] = []
  for (const key of [...groups.keys()].sort()) {
    const cluster = groups.get(key) ?? []
    const head = cluster[0]
    if (head === undefined) continue
    const skill = head.applies_to.skill
    if (policySkills.has(skill)) {
      blocked.push({
        skill,
        reason: 'policy_layer',
        detail: '策略层不进学习回路（24 §3）',
      })
      continue
    }
    const contributors = [...new Set(cluster.flatMap((l) => l.assignments))]
    if (contributors.length < PROMOTION_CRITERIA.min_contributors) continue

    const semanticKeys = new Set(cluster.map((l) => l.semantic_key))
    // 样本 = 池里同语义键的全部（含被忽略 / 驳回的），不然采纳率永远是 1
    const samples = pool.filter((l) => semanticKeys.has(l.semantic_key))
    const acceptedCount = cluster.reduce((n, l) => n + l.hits, 0)
    const sampleCount = samples.reduce((n, l) => n + l.hits, 0)
    const oldest = cluster
      .map((l) => l.created_at)
      .sort()
      .at(0)
    const criteria = promotionCriteria({
      accepted: acceptedCount,
      samples: sampleCount,
      contributors: contributors.length,
      ...(oldest === undefined ? {} : { oldest_at: oldest }),
      now: input.now,
    })

    if (input.evalResult?.status === 'red') {
      const failed = input.evalResult.failed ?? []
      blocked.push({
        skill,
        reason: 'eval_red',
        detail: `eval 回归（红），晋升预检 blocked${failed.length === 0 ? '' : `：${failed.join('、')}`}`,
        criteria,
      })
      continue
    }
    if (enforce && !criteria.passed) {
      blocked.push({
        skill,
        reason: 'criteria',
        detail: `未达晋升判据（07 §1）：${criteria.missing.join('、')}`,
        criteria,
      })
      continue
    }

    const rep = [...cluster].sort((a, b) => b.hits - a.hits || a.id.localeCompare(b.id))[0]
    if (rep === undefined) continue
    const section_ids = [
      ...new Set(
        cluster
          .map((l) => l.applies_to.section_id)
          .filter((s): s is string => s !== undefined && s !== ''),
      ),
    ]
    cards.push({
      skill,
      section_ids,
      from: input.from,
      to_tier: toTier,
      title: `${contributors.length} 个人都这么改了：把「${skill}」这一段提上去`,
      summary: `同一段有 ${contributors.length} 位同事接受了相似修改，建议合并到${
        toTier === 'department' ? '部门' : '公司'
      }层。`,
      proposed_text: rep.text,
      contributors,
      evidence: {
        lessons: cluster.map((l) => l.id),
        quotes: [...new Set(cluster.flatMap((l) => l.evidence.map((e) => e.quote)))],
      },
      criteria,
      diff: { before: null, after: rep.text, summary: `${skill} 段级晋升` },
      created_at: input.now,
    })
  }
  return { cards, blocked }
}
