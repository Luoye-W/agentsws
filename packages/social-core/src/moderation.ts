/**
 * 群规匹配与分级（56 §3 `moderation.ts`）。
 *
 * 干的事只有一件：拿一条群规清单去比一条发言，**说清楚它违了哪一条、
 * 按这条群规该做什么**。分级的名单在 `@agentsws/core` 的
 * `COMMUNITY_MODERATION_L1_ACTIONS` 里（封禁要人点），这里不另立一份。
 *
 * 三条纪律：
 *
 * 1. **群规是人写的，不是我们编的**。{@link CommunityRule} 里的 `terms` /
 *    `action` 全来自这个群自己的群规卡。这个文件里没有一条默认群规——
 *    "不许发广告"在一个卖货群和一个二手交换群里根本不是同一件事。
 * 2. **累犯才升级**（{@link escalate}）：同一个人第一次发链接是删帖，
 *    第三次才是禁言。不记次数的话，一条规则要么太松要么太狠。
 * 3. **判完不等于做完**。这里出的是一条**提案**（`community_moderation`），
 *    封禁那一档在 guardrail 里升 L1——把一个人从你自己的社群里永久赶出去，
 *    这件事该由人点。
 */

import { COMMUNITY_MODERATION_L1_ACTIONS } from '@agentsws/core'

/** 群规允许的动作（与 guardrail 的 `community_moderation` 那张白名单一字不差）。 */
export type ModerationAction =
  | 'none'
  | 'warn'
  | 'delete_post'
  | 'mute'
  | 'unmute'
  | 'ban'
  | 'permanent_ban'
  | 'unban'

/** 这个群自己写的一条群规。 */
export interface CommunityRule {
  id: string
  /** 人能看懂的一句（卡面上原样显示："群里不发外部推广链接"）。 */
  text: string
  /** 命中这条规则的词 / 片段（人写的）。 */
  terms: readonly string[]
  /** 第一次违反做什么。 */
  action: Exclude<ModerationAction, 'unmute' | 'unban'>
  /**
   * 累犯到第几次升一级（不写 = 不升级）。
   *
   * 升级的梯子是固定的：`warn → delete_post → mute → ban`。梯子不许配，
   * 因为一个能配出"第二次就永久封"的界面，迟早会有人配出那个。
   */
  escalate_after?: number
}

/** 判一条发言的结论。 */
export interface ModerationVerdict {
  /** 违了哪几条（按群规顺序；一条发言可能同时违好几条）。 */
  matched_rules: { id: string; text: string; terms: string[] }[]
  /** 按最重的那一条 + 累犯次数算出来的动作。 */
  action: ModerationAction
  /** 这个动作要不要人点（`ban` / `permanent_ban`）。 */
  needs_approval: boolean
  /** 一句人话，原样进卡面。 */
  reason: string
}

/** 升级的梯子（固定，见 {@link CommunityRule.escalate_after} 的注释）。 */
const LADDER: readonly ModerationAction[] = ['warn', 'delete_post', 'mute', 'ban']

const weight = (a: ModerationAction): number => {
  const i = LADDER.indexOf(a)
  if (i >= 0) return i
  return a === 'permanent_ban' ? LADDER.length : -1
}

/** 按累犯次数往上走几级（走到 `ban` 为止，**不会**走到 `permanent_ban`）。 */
export function escalate(
  base: ModerationAction,
  offenses: number,
  after?: number,
): ModerationAction {
  if (after === undefined || offenses < after) return base
  const steps = Math.floor(offenses / after)
  const from = weight(base)
  if (from < 0) return base
  // 永久封禁不在梯子上：它只能由人手工选，不能靠"违规次数够了"自动走到
  const to = Math.min(from + steps, LADDER.length - 1)
  return LADDER[to] as ModerationAction
}

/**
 * 判一条发言。
 *
 * `prior_offenses` 是**这个人在这个群里**此前已确认的违规次数（不是全平台，
 * 也不是全部群）。跨群累加听着更安全，实际上是把一个人在 A 群的历史
 * 拿来判他在 B 群的一句话——那不是群规，那是黑名单。
 */
export function moderate(input: {
  text: string
  rules: readonly CommunityRule[]
  prior_offenses?: number
}): ModerationVerdict {
  const text = input.text.toLowerCase()
  const matched: ModerationVerdict['matched_rules'] = []
  let action: ModerationAction = 'none'
  let reasonRule: CommunityRule | undefined

  for (const rule of input.rules) {
    const hits = rule.terms.filter((t) => text.includes(t.trim().toLowerCase()))
    if (hits.length === 0) continue
    matched.push({ id: rule.id, text: rule.text, terms: hits })
    const stepped = escalate(rule.action, input.prior_offenses ?? 0, rule.escalate_after)
    if (weight(stepped) > weight(action)) {
      action = stepped
      reasonRule = rule
    }
  }

  const needs_approval = COMMUNITY_MODERATION_L1_ACTIONS.includes(action)
  if (matched.length === 0)
    return { matched_rules: [], action: 'none', needs_approval: false, reason: '没违反群规。' }

  const offenses = input.prior_offenses ?? 0
  const bits = [`违反「${reasonRule?.text ?? matched[0]?.text}」`]
  if (offenses > 0) bits.push(`这是第 ${offenses + 1} 次`)
  bits.push(ACTION_WORDS[action])
  if (needs_approval) bits.push('封禁改不回来，所以这一条要你点头')
  return { matched_rules: matched, action, needs_approval, reason: `${bits.join('，')}。` }
}

/** 动作 → 卡面上的那个词。界面与这里读同一张表。 */
export const ACTION_WORDS: Readonly<Record<ModerationAction, string>> = {
  none: '不处理',
  warn: '提醒一句',
  delete_post: '删掉这条',
  mute: '禁言',
  unmute: '解除禁言',
  ban: '移出并封禁',
  permanent_ban: '永久封禁',
  unban: '解封',
}
