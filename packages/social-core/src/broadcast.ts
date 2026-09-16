/**
 * 群发：受众、抑制名单、频率（56 §3 `broadcast.ts`）。
 *
 * 这个模块把"这一条群发能不能发、发给谁"算成一张卡面上看得懂的表，
 * 然后交给 guardrail 去真拦（`community_broadcast` 在 `HARD_L1` 里）。
 * 两层的分工是有意的：
 *
 * - **这里**算出 `audience` / `suppressed` / `suppression_checked` 三格，
 *   并给出剔了几个人、为什么剔；
 * - **guardrail** 只认那三格：不报 `suppression_checked` 就 block，
 *   名单上的人漏在受众里也 block（15 §2 / WP64 `campaign_send` 那一条）。
 *
 * 为什么不把判断也放在 guardrail 里：guardrail 是纯规则，它不知道"这个群里
 * 有多少人""哪些人三十天内已经收过一条"。反过来，也不能只在这里判——
 * 这里是**提案方**写的代码，提案方自己说"我查过了"不算数，所以最后一道门
 * 必须在 guardrail。这正是 18 §3 那条 fail-closed 的形状。
 *
 * 抑制名单的规则本身**一个字都不在这里**：`@agentsws/core` 的 `suppression.ts`
 * 是全仓唯一一份（客服出站、邮件营销、开发信、群发，四处同一份）。
 */

import type { Iso8601, SocialChannel } from '@agentsws/contracts'
import { suppressedRecipients, withoutSuppressed } from '@agentsws/core'

/** 56 §7 的频率默认值。 */
export const BROADCAST_RULES = {
  /** 一周最多几条群发。 */
  max_per_week: 1,
  /** 同一个人最少隔多少天才收得到第二条（频率疲劳）。 */
  min_days_between_per_recipient: 7,
  /** WhatsApp 模板消息一天最多几条。 */
  whatsapp_max_template_messages_per_day: 100,
} as const

/** 一次群发的受众算完之后长什么样。 */
export interface BroadcastAudience {
  /** 真要发给的那些（已剔除名单上的人与频率疲劳的人）。 */
  recipients: string[]
  /** 因为在抑制名单上被剔掉的（**收件人那一侧的原样字符串**，卡面上要认得出来）。 */
  suppressed: string[]
  /** 因为离上一条太近被剔掉的。 */
  too_soon: string[]
  /** 恒为 `true`：这个函数跑过 = 查过了。guardrail 认的就是这一格。 */
  suppression_checked: true
  /** 一句人话，原样进卡面（"342 人收，剔了 18 个"）。 */
  note: string
}

/**
 * 算一次群发的受众。
 *
 * `last_sent_at` 是"这个人上一次收到我们群发是什么时候"（收件人 → 时刻）。
 * 不给 = 这条渠道还没记过，那一条就不判——**不假装判过**：
 * 把没有的数据当成"很久没收到了"，等于把频率闸门悄悄打开。
 */
export function buildAudience(input: {
  /** 群里 / 名单上的全部人（平台 id 或邮箱，按渠道）。 */
  members: readonly string[]
  /** 抑制名单（退订、投诉过、手工加的）。 */
  suppression_list: readonly string[]
  now: Iso8601
  last_sent_at?: ReadonlyMap<string, Iso8601>
  min_days_between?: number
}): BroadcastAudience {
  const suppressed = suppressedRecipients(input.members, input.suppression_list)
  const afterList = withoutSuppressed(input.members, input.suppression_list)

  const gapDays = input.min_days_between ?? BROADCAST_RULES.min_days_between_per_recipient
  const nowMs = Date.parse(input.now)
  const too_soon: string[] = []
  const recipients: string[] = []
  for (const r of afterList) {
    const last = input.last_sent_at?.get(r)
    const lastMs = last === undefined ? Number.NaN : Date.parse(last)
    // 没记过就不判（见上面那一段）
    if (!Number.isNaN(lastMs) && nowMs - lastMs < gapDays * 86_400_000) too_soon.push(r)
    else recipients.push(r)
  }

  const bits = [`${recipients.length} 人收`]
  if (suppressed.length > 0) bits.push(`退订 / 抑制名单剔了 ${suppressed.length} 个`)
  if (too_soon.length > 0) bits.push(`${gapDays} 天内已经收过的剔了 ${too_soon.length} 个`)
  return {
    recipients,
    suppressed,
    too_soon,
    suppression_checked: true,
    note: bits.join('，'),
  }
}

/** 一条群发提案（提交给变更账本前的形状）。 */
export interface BroadcastProposal {
  channel: SocialChannel
  account_id: string
  body: string
  audience: string[]
  suppressed: string[]
  audience_size: number
  suppression_checked: true
  /** WhatsApp 才有：预先审过的模板 id。 */
  template_id?: string
  /** WhatsApp 才有：这批人是不是都 opt-in 过。 */
  opt_in_verified?: boolean
}

/** 提案前的自查结论。`ok` 为假 = 别提交，先把 `problems` 解决掉。 */
export interface BroadcastCheck {
  ok: boolean
  problems: string[]
}

/**
 * 提案前自查一遍（尽早给人反馈；真正的拦在 guardrail）。
 *
 * WhatsApp 那两条是**硬的**（56 §1 / §2）：没有预先审过的模板、或者这批人
 * 没有全部 opt-in 过，就不许提交。这不是我们的洁癖，是 Meta 的规矩——
 * 违了封的是这个品牌的号。所以它在这里是"别提交"，在 guardrail 里是 block，
 * 两层都不给"人点一下就发"的路径。
 */
export function checkBroadcast(
  proposal: BroadcastProposal,
  ctx: { sent_this_week?: number; max_per_week?: number } = {},
): BroadcastCheck {
  const problems: string[] = []
  if (proposal.body.trim() === '') problems.push('正文是空的。')
  if (proposal.audience.length === 0)
    problems.push('剔完之后一个人都不剩了——这条群发发出去也没人收得到。')
  if (proposal.suppression_checked !== true)
    problems.push('没查退订 / 抑制名单。没问过与问过了没人，在群发这件事上必须分得开。')

  if (proposal.channel === 'whatsapp') {
    if ((proposal.template_id ?? '').trim() === '')
      problems.push(
        'WhatsApp 的主动消息只能按**预先审过的模板**发。去后台建一个模板，批下来之后把 template_id 填进来。',
      )
    if (proposal.opt_in_verified !== true)
      problems.push(
        'WhatsApp 要求收件人先 opt-in。这批人里有没 opt-in 的，或者我们还没核过——两种情况都不许发（封的是这个品牌的号）。',
      )
    if (proposal.audience.length > BROADCAST_RULES.whatsapp_max_template_messages_per_day)
      problems.push(
        `一天最多 ${BROADCAST_RULES.whatsapp_max_template_messages_per_day} 条模板消息，这一批是 ${proposal.audience.length} 条。分几天发。`,
      )
  }

  const cap = ctx.max_per_week ?? BROADCAST_RULES.max_per_week
  const sent = ctx.sent_this_week ?? 0
  if (sent + 1 > cap)
    problems.push(`这一周已经群发过 ${sent} 条了（上限 ${cap} 条）。超了要人点头。`)

  return { ok: problems.length === 0, problems }
}
