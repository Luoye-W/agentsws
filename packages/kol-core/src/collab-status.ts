/**
 * 合作的紧急程度（WP302，决策 406 第一期）：合作线程清单按它分四组、上五档色。
 *
 * 色阶移植自 KOLAgents（Luoye 的产品，非模板代码）：`src/components/influencer/cards/status-tier.ts`
 * @ 88d74b2c——五档、按急到缓排：`action` 红（要你动手）/ `scheduled` 蓝（我们这边排上了）/
 * `waiting` 黄（球在对方那儿）/ `active` 绿（在做，没什么要你管）/ `idle` 灰（没事、结了、谢绝了）。
 * 「状态从往来推出来，不另存一份」的做法照 KOLAgents `src/influencer/conversation-state.ts`；
 * 推的规则按工坊的数据改写（工坊有卡、有交付物排期、有跟进节奏）。
 *
 * 四组（决策 406）：要处理 = action；等对方 = scheduled + waiting；进行中 = active；其他 = idle。
 *
 * docs/96 P1：「要处理」那一组**每一条后面都是卡片流里的一张卡**（或一条要审的交付物）——
 * 清单上只说状态、点了去那张卡，清单自己不放决定按钮。
 *
 * 纯函数，没有 `Date.now()`。
 */
import type { CollaborationStage, KolReplyClass } from '@agentsws/contracts'
import { collaborationStageName } from './stages.js'

/** 五档，按急到缓。 */
export const COLLAB_TIERS = ['action', 'scheduled', 'waiting', 'active', 'idle'] as const
export type CollabTier = (typeof COLLAB_TIERS)[number]

/** 四组（清单上的分组标题按这个顺序）。 */
export const COLLAB_GROUPS = ['action', 'waiting', 'active', 'idle'] as const
export type CollabGroup = (typeof COLLAB_GROUPS)[number]

/** 档 → 组：蓝（排上了）和黄（等对方）都是「等对方」。 */
export function groupOfTier(tier: CollabTier): CollabGroup {
  return tier === 'scheduled' ? 'waiting' : tier
}

/** 档的先后（清单里组内按它排、再按停了几天排）。认不得的排最后。 */
export function collabTierRank(tier: string): number {
  const i = (COLLAB_TIERS as readonly string[]).indexOf(tier)
  return i === -1 ? COLLAB_TIERS.length : i
}

export interface CollabStatusInput {
  stage: CollaborationStage
  now: string
  stage_changed_at?: string | undefined
  last_activity_at?: string | undefined
  /** 这条合作（及这个人的开发信）上还在等人批的卡。 */
  pending_cards?: number | undefined
  /** 交了、还没验收的交付物。 */
  pending_reviews?: number | undefined
  /** 过了交稿日、还没交上来的交付物。 */
  overdue_deliverables?: number | undefined
  /** 最近一封往来。 */
  last_exchange?: { direction: 'in' | 'out'; at: string; reply_class?: KolReplyClass } | undefined
  /** 我们发出去了几封（首封算 1）。 */
  outbound_count?: number | undefined
  /** 下一封跟进按节奏哪天会提（没有就不给）。 */
  next_follow_up_at?: string | undefined
}

export interface CollabStatus {
  tier: CollabTier
  /** 清单行上那一小句（「要报价 · 待回应」「等回复 · 已 5 天（第 2 封）」）。 */
  label: string
}

const DAY_MS = 86_400_000

const daysBetween = (from: string | undefined, to: string): number | undefined => {
  if (from === undefined) return undefined
  const a = Date.parse(from)
  const b = Date.parse(to)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return undefined
  return Math.max(0, Math.floor((b - a) / DAY_MS))
}

/** 对方回信的意向 → 清单上那几个字。 */
const REPLY_SHORT: Readonly<Record<KolReplyClass, string>> = {
  interested: '有意向',
  wants_quote: '要报价',
  declined: '婉拒',
  already_working: '已有合作',
  cold_inbound: '来信',
  spam: '垃圾信',
  unknown: '回信了',
}

/** 一条合作现在急不急、该怎么说。 */
export function collabStatus(input: CollabStatusInput): CollabStatus {
  const { stage, now } = input
  if (stage === 'closed') return { tier: 'idle', label: '已结案' }
  if (stage === 'declined') return { tier: 'idle', label: '谢绝了' }
  if ((input.pending_cards ?? 0) > 0)
    return {
      tier: 'action',
      label: input.pending_cards === 1 ? '有一张卡等你批' : `有 ${input.pending_cards} 张卡等你批`,
    }
  if ((input.overdue_deliverables ?? 0) > 0) return { tier: 'action', label: '交付逾期' }
  if ((input.pending_reviews ?? 0) > 0) return { tier: 'action', label: '交付物等你审' }
  const last = input.last_exchange
  const talking = stage === 'contacted' || stage === 'replied' || stage === 'negotiating'
  if (talking && last?.direction === 'in')
    return { tier: 'action', label: `${REPLY_SHORT[last.reply_class ?? 'unknown']} · 待回应` }
  if (stage === 'sourced') return { tier: 'idle', label: '还没联系' }
  if (stage === 'contacted') {
    const ahead = daysBetween(now, input.next_follow_up_at ?? '')
    if (
      input.next_follow_up_at !== undefined &&
      Date.parse(input.next_follow_up_at) > Date.parse(now)
    )
      return {
        tier: 'scheduled',
        label: ahead === undefined || ahead === 0 ? '跟进已排上' : `跟进已排上 · ${ahead} 天后`,
      }
    const waited = daysBetween(last?.at ?? input.stage_changed_at ?? input.last_activity_at, now)
    const nth = input.outbound_count === undefined ? '' : `（第 ${input.outbound_count} 封）`
    return {
      tier: 'waiting',
      label: `等回复${waited === undefined ? '' : ` · 已 ${waited} 天`}${nth}`,
    }
  }
  if (talking) {
    const waited = daysBetween(last?.at ?? input.last_activity_at, now)
    return { tier: 'waiting', label: `等对方${waited === undefined ? '' : ` · 已 ${waited} 天`}` }
  }
  // 谈成之后：在做，没什么要你管（停久了由分段进度条标黄说）
  return { tier: 'active', label: collaborationStageName(stage) }
}
