/**
 * 往上浮（40 §2.2 第 3 条）：个人建的东西默认个人层，**被两个岗位以上采用或周复盘点名**
 * 就进候选；真要不要出晋升卡，用 24 §3 那把尺子——`@agentsws/roles` 的
 * Wilson 单侧 95% 下界（不在两处各写一套统计）。
 *
 * 把"采纳率"翻译到工具箱上，只有一种读法说得通：
 * - **正样本** = 它真的被用了：最近 30 天跑的次数 + 采用它的岗位数
 * - **负样本** = 有人查到过它、看完说"我这个不一样"（那句理由就存在目录里）
 *
 * 于是"一条每天在跑、没人说不合用的定时任务"越得过 0.9（全采纳时 n ≥ 25 才过线），
 * 而"两个岗位挂着但从来没跑过"不会被推上去。门槛与 24 一致，写死不作配置项。
 */
import { adoptionLowerBound } from '@agentsws/roles'
import type { CatalogEntry, CatalogLayer, PromotionCandidate } from './types.js'

/** 与 24 §3 / 07 §1 第 3 条同一个数：Wilson 下界 ≥ 0.9。 */
export const PROMOTION_CRITERIA = { min_positions: 2, min_lower_bound: 0.9 } as const

const round4 = (n: number): number => Math.round(n * 10_000) / 10_000

const LABEL: Readonly<Record<string, string>> = {
  app: '应用',
  skill: '技能',
  workflow: '流程',
  schedule: '定时任务',
  custom_card: '定制卡',
  rule: '规矩',
}

export interface PromotionInput {
  entries: readonly CatalogEntry[]
  /** 每条被"仍新建"顶掉过几次（目录自己记的） */
  rejections: Readonly<Record<string, number>>
  /** 周复盘里被点名的条目 id */
  named_in_review?: Iterable<string>
  /** 升到哪一层；缺省部门层（与 24 的默认晋升目标一致） */
  to_layer?: CatalogLayer
}

/**
 * 候选清单。**不过判据的也回**（带 `passed: false` 与缺什么），
 * 因为工具箱上要能说清"为什么这条还没被推上去"。宿主只给 `passed` 的出卡。
 */
export function promotionCandidates(input: PromotionInput): PromotionCandidate[] {
  const named = new Set(input.named_in_review ?? [])
  const to_layer: CatalogLayer = input.to_layer ?? 'dept'
  const out: PromotionCandidate[] = []
  for (const entry of input.entries) {
    // 已经在部门 / 公司层的、或者已被取代的，不再往上推
    if (entry.layer !== 'personal' || entry.superseded_by !== undefined) continue
    const positions = entry.used_by_positions.length
    const byReview = named.has(entry.id)
    if (positions < PROMOTION_CRITERIA.min_positions && !byReview) continue

    const adoptions = entry.runs_30d + positions
    const rejections = input.rejections[entry.id] ?? 0
    const samples = adoptions + rejections
    const lower = round4(adoptionLowerBound(adoptions, samples))
    const missing: string[] = []
    if (positions < PROMOTION_CRITERIA.min_positions && !byReview) missing.push('采用岗位 < 2')
    if (lower < PROMOTION_CRITERIA.min_lower_bound) {
      missing.push(
        `采用率下界 ${lower.toFixed(2)} < ${PROMOTION_CRITERIA.min_lower_bound}（用了 ${adoptions} 次，${rejections} 次被说"我这个不一样"）`,
      )
    }
    const label = LABEL[entry.kind] ?? entry.kind
    out.push({
      entry,
      to_layer,
      card_kind: entry.kind === 'skill' ? 'skill_promotion' : 'policy_change',
      trigger: positions >= PROMOTION_CRITERIA.min_positions ? 'positions' : 'review',
      positions,
      adoptions,
      rejections,
      samples,
      lower_bound: lower,
      passed: missing.length === 0,
      missing,
      title: `好东西往上浮：把${label}「${entry.title}」提到${to_layer === 'dept' ? '部门' : '公司'}层`,
      summary:
        positions >= PROMOTION_CRITERIA.min_positions
          ? `${positions} 个岗位在用，最近 30 天跑了 ${entry.runs_30d} 次。提上去之后大家用同一份，个人副本自动指向它。`
          : `周复盘点名了这一条，最近 30 天跑了 ${entry.runs_30d} 次。提上去之后大家用同一份，个人副本自动指向它。`,
    })
  }
  out.sort((a, b) => b.lower_bound - a.lower_bound || a.entry.id.localeCompare(b.entry.id))
  return out
}
