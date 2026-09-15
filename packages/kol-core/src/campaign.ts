/**
 * campaign 向导骨架（48 §5.2「campaign 向导（一个 campaign 跨渠道挑人，
 * 但每个渠道的动作仍走各自职责的额度）」）。
 *
 * 这句话里最要紧的是后半句，它决定了这个模块**不做什么**：
 * 它挑完人就结束，一封信都不发、一条合作都不建。挑出来的清单按渠道分好组，
 * 交回去之后，每一组的动作由**那条渠道职责**自己提——用它的 Assignment、
 * 它的额度、它的自动化等级。跨渠道一把梭是 05 §4「不做跨 Assignment 并集」
 * 那条规矩在红人这边最容易破的地方，所以这里写死：**只出清单，不出动作**。
 *
 * 目标 / 预算 / 渠道 / 人数四格填完 → 一份挑人清单。四格缺一格就不给清单，
 * 而是告诉用户还缺哪一格（向导就是这么工作的）。
 */
import type { KolChannel } from '@agentsws/contracts'
import {
  type CreatorScore,
  rankCreators,
  type ScorableAccount,
  type ScoreCriteria,
} from './scoring.js'

/** 向导那四格。 */
export interface CampaignBrief {
  /** 这次要干什么（一句话，进开发信的 `reason` 与 UTM 的 campaign 名）。 */
  goal?: string
  /** 总预算。 */
  budget?: number
  currency?: string
  /** 走哪几条渠道（空 = 还没选）。 */
  channels?: readonly KolChannel[]
  /** 想找几个人。 */
  headcount?: number
  /** 打分条件（类目 / 语言 / 地区 / 粉丝带）。 */
  criteria?: Omit<ScoreCriteria, 'now'>
}

export type BriefGap = 'goal' | 'budget' | 'channels' | 'headcount'

/** 向导缺哪几格（顺序即界面上问的顺序）。 */
export function briefGaps(brief: CampaignBrief): BriefGap[] {
  const gaps: BriefGap[] = []
  if (brief.goal === undefined || brief.goal.trim() === '') gaps.push('goal')
  if (brief.budget === undefined || brief.budget <= 0) gaps.push('budget')
  if (brief.channels === undefined || brief.channels.length === 0) gaps.push('channels')
  if (brief.headcount === undefined || brief.headcount <= 0) gaps.push('headcount')
  return gaps
}

const GAP_ZH: Readonly<Record<BriefGap, string>> = {
  goal: '这次想达成什么（一句话就行）',
  budget: '总共打算花多少',
  channels: '走哪几条渠道',
  headcount: '想找几个人',
}

/** 缺格时给人看的那一句。 */
export function briefGapMessage(gaps: readonly BriefGap[]): string {
  return `还差 ${gaps.length} 件事没定：${gaps.map((g) => GAP_ZH[g]).join('、')}。`
}

/** 挑人清单里的一条。 */
export interface CampaignPick<T> {
  account: T
  score: CreatorScore
  channel: KolChannel
  /** 这一条该由哪条职责去动它（`kol.youtube` …）。见文件头。 */
  role_id: string
}

export interface CampaignPlan<T> {
  /** 四格齐了没有。没齐时 `picks` 是空的。 */
  ready: boolean
  gaps: BriefGap[]
  /** 缺格时那一句人话（齐了是空串）。 */
  message: string
  /** 按渠道分组的挑人清单。 */
  by_channel: { channel: KolChannel; role_id: string; picks: CampaignPick<T>[] }[]
  /** 摊平的清单（按分从高到低）。 */
  picks: CampaignPick<T>[]
  /** 人均预算（总预算 ÷ 真挑到的人数；一个都没挑到时是 0）。 */
  budget_per_creator: number
}

/** 渠道 → 职责 id。**只有这一条规则**，别处不许再拼一次字符串。 */
export const roleIdOfChannel = (channel: KolChannel): string => `kol.${channel}`

/**
 * 出一份挑人清单。
 *
 * 名额按渠道**平分**（除不尽时靠前的渠道多一个）：不按分数一把排序取前 N，
 * 因为那样常常一条渠道全占了——而用户选了三条渠道，本来就是想三条都试试。
 * 想全压在一条渠道上，他会只选那一条。
 */
export function planCampaign<T extends ScorableAccount>(
  brief: CampaignBrief,
  pool: readonly T[],
  now: string,
): CampaignPlan<T> {
  const gaps = briefGaps(brief)
  if (gaps.length > 0)
    return {
      ready: false,
      gaps,
      message: briefGapMessage(gaps),
      by_channel: [],
      picks: [],
      budget_per_creator: 0,
    }
  const channels = brief.channels as readonly KolChannel[]
  const headcount = brief.headcount as number
  const criteria: ScoreCriteria = { ...brief.criteria, now }

  const per = Math.floor(headcount / channels.length)
  const extra = headcount % channels.length

  const by_channel = channels.map((channel, i) => {
    const quota = per + (i < extra ? 1 : 0)
    const ranked = rankCreators(
      pool.filter((a) => a.channel === channel),
      criteria,
    )
    const picks: CampaignPick<T>[] = ranked
      // 命中刷粉护栏的不进清单：清单是"准备发信的人"，不是"搜索结果"
      .filter((r) => r.score.blocked === undefined)
      .slice(0, quota)
      .map((r) => ({
        account: r.account as T,
        score: r.score,
        channel,
        role_id: roleIdOfChannel(channel),
      }))
    return { channel, role_id: roleIdOfChannel(channel), picks }
  })

  const picks = by_channel.flatMap((g) => g.picks).sort((a, b) => b.score.total - a.score.total)
  const budget = brief.budget as number
  return {
    ready: true,
    gaps: [],
    message: '',
    by_channel,
    picks,
    budget_per_creator: picks.length === 0 ? 0 : Math.round((budget / picks.length) * 100) / 100,
  }
}
