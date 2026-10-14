/**
 * WP333（10-14 盘点发现的老问题）：**客服回信起草带上品牌语气**。
 *
 * 社媒那边（Reddit 起草）早就把品牌话术注进提示词了——经 `social-core` 的
 * `resolveVoice` + `voicePrompt`，`guidance` 原样引用、一个字不改写。客服这边一直没有：
 * 客服职责（`dtc.support` / `dtc.live-chat` / `amz.support`）只挂了 `customer-care`，
 * 没挂 `brand-voice`，于是同一个品牌在群里一个调子、在邮件里另一个调子。
 *
 * 这里只做两件很窄的事：
 *
 * 1. {@link brandVoiceCard}：这个品牌**自己写过**话术没有——`brand-voice` 叠加之后只有包里那一层
 *    （随软件带的基础版）= 没写过，回 `undefined`，客服起草**照旧**（不把基础版硬塞进去）；
 *    公司 / 岗位 / 职责 / 个人任何一层写过 = 有一张话术卡。
 * 2. {@link supportVoiceSection}：有卡就拼一段提示词，与社媒同一个 `voicePrompt`。
 *
 * 已经挂了 `brand-voice` 的职责（社群客服）不再注一遍——技能正文里已经有了。
 */
import type { PromptSection, SkillRef, SkillTier } from '@agentsws/contracts'
import { resolveVoice, type VoiceCard, voicePrompt } from '@agentsws/social-core'

/** 话术技能的名字（公司层技能，24）。 */
export const BRAND_VOICE_SKILL = 'brand-voice'

/** 客服起草挂的那本技能：挂了它的职责就是「写客服回信」的职责。 */
export const CUSTOMER_CARE_SKILL = 'customer-care'

/** 每条客服职责对外说话走哪条渠道（`resolveVoice` 按渠道挑卡；没有渠道那张就用公司那张）。 */
const CHANNEL_OF: Readonly<Record<string, string>> = {
  'dtc.support': 'email',
  'dtc.live-chat': 'chat',
  'amz.support': 'amazon',
}

/** 这条职责要不要补注品牌话术：挂了 `customer-care`、没挂 `brand-voice`。 */
export function needsSupportVoice(skills: readonly Pick<SkillRef, 'name'>[]): boolean {
  return (
    skills.some((s) => s.name === CUSTOMER_CARE_SKILL) &&
    !skills.some((s) => s.name === BRAND_VOICE_SKILL)
  )
}

/** 去掉 front matter 的正文（技能文件的 `---…---` 头不是话术）。 */
function bodyOf(markdown: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(markdown)
  return (m === null ? markdown : markdown.slice(m[0].length)).trim()
}

/**
 * 这个品牌自己写过的那张话术卡。叠加结果里只有 `package` 那一层（或根本解析不出来）= 没写过。
 */
export function brandVoiceCard(
  resolved: { markdown: string; layers_applied: readonly SkillTier[] } | undefined,
): VoiceCard | undefined {
  if (resolved === undefined) return undefined
  if (!resolved.layers_applied.some((t) => t !== 'package')) return undefined
  const guidance = bodyOf(resolved.markdown)
  if (guidance === '') return undefined
  return { id: BRAND_VOICE_SKILL, scope: 'org', guidance }
}

/** 拼给客服起草的那一段（没有卡 = `undefined`，整段不出）。 */
export function supportVoiceSection(
  role_id: string,
  card: VoiceCard | undefined,
): PromptSection | undefined {
  if (card === undefined) return undefined
  const channel = CHANNEL_OF[role_id] ?? 'email'
  return {
    id: 'brand_voice',
    name: '品牌话术',
    order: 24,
    text: voicePrompt(resolveVoice([card], channel)),
  }
}
