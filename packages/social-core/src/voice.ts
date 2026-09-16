/**
 * 品牌话术（56 §3 `voice.ts`）：**只取公司层技能，不在这里编**。
 *
 * 这个文件里没有一句现成的品牌文案，也不该有。理由是 24（技能分层）那一条：
 * "我们说话是什么调子"属于**公司层技能**，由人写、由学习回路沉淀，
 * 一个共享包不该替某家公司决定它的语气。
 *
 * 所以这里只做三件很窄的事：
 *
 * 1. {@link resolveVoice}：从递进来的技能卡里**挑出**该用哪一张（按渠道细化，
 *    没有渠道那张就用公司那张；一张都没有就明说"没有"）。
 * 2. {@link voicePrompt}：把挑中的那张拼成一段给模型的指导——**原样引用**，
 *    一个字不改写。改写等于我们替品牌重写了它的话术。
 * 3. {@link checkOutbound}：出站文案的最后一道自查——承诺扫描
 *    （`support-core` 的 `scanOutboundCommitment`，**全仓同一份**）
 *    + 品牌禁用词。命中就回打回重写的理由，不静默删改。
 *
 * 第 3 条为什么在"话术"这个模块里：56 §2 末行写的是"所有出站文案过
 * `commitment_scan` + 抑制名单"。抑制名单在 `broadcast.ts`（它是受众那一侧的事），
 * 承诺扫描在这里——出站文案这一跳只有一个入口，两处各写一遍必然漏一处。
 */

import { scanOutboundCommitment } from '@agentsws/support-core'

/**
 * 一张话术技能卡（`packages/skills` 那一侧的投影）。
 *
 * `scope` 是**这张卡管到哪儿**：公司层那张 `scope: 'org'`，某条渠道单独一张
 * `scope: 'channel'` + `channel`。层级只有这两级——再细就该写在具体那条内容里了。
 */
export interface VoiceCard {
  id: string
  scope: 'org' | 'channel'
  channel?: string
  /** 语气指导正文（人写的，原样用）。 */
  guidance: string
  /** 这个品牌不许出现的词（人写的，原样用）。 */
  banned_terms?: readonly string[]
  /** 这张卡是什么时候定下来的（卡面上要说"用的是哪一版"）。 */
  updated_at?: string
}

/** 挑出来的结果。`card` 为 `undefined` = 这家公司还没写过话术。 */
export interface ResolvedVoice {
  card?: VoiceCard
  /** 一句人话：用的是哪一张、为什么。界面与模型指导都读它。 */
  note: string
}

/**
 * 挑一张。渠道那张优先；没有就用公司那张；一张都没有就说没有。
 *
 * **不合并两张**：把公司话术与渠道话术拼起来听着合理，实际上是我们替品牌
 * 编了第三份它没写过的话术。渠道那张存在，就说明有人专门为这条渠道写过。
 */
export function resolveVoice(cards: readonly VoiceCard[], channel: string): ResolvedVoice {
  const scoped = cards.find((c) => c.scope === 'channel' && c.channel === channel)
  if (scoped !== undefined)
    return { card: scoped, note: `用的是 ${channel} 这条渠道单独写的那张话术卡。` }
  const org = cards.find((c) => c.scope === 'org')
  if (org !== undefined)
    return {
      card: org,
      note: `用的是公司层那张话术卡（${channel} 还没有单独的一张）。`,
    }
  return {
    note: '这个品牌还没写过话术卡。出来的稿子只按事实写，语气上不做任何假设——要定调子，去技能里写一张。',
  }
}

/**
 * 拼给模型的那一段。
 *
 * `guidance` **原样引用**，一个字不改写；我们只在它前后加一句说明它是什么。
 * 没有卡的时候回的是"没有卡"那句话，而不是一段我们编的默认语气——
 * 编一段等于给这家公司定了调子，而没有人同意过。
 */
export function voicePrompt(resolved: ResolvedVoice): string {
  const card = resolved.card
  if (card === undefined) return `【品牌话术】${resolved.note}`
  const banned =
    card.banned_terms === undefined || card.banned_terms.length === 0
      ? ''
      : `\n【不许出现的词】${card.banned_terms.join('、')}`
  return `【品牌话术｜${card.id}${card.updated_at === undefined ? '' : ` · ${card.updated_at}`}】\n${card.guidance}${banned}`
}

/** 出站自查的结论。`ok` 为假 = **打回重写**，不是静默删改后照发。 */
export interface OutboundCheck {
  ok: boolean
  /** 承诺扫描命中的规则名（`support-core` 的那一份）。 */
  commitment_hits: string[]
  /** 品牌禁用词命中的那几个（原样，人写的词）。 */
  banned_hits: string[]
  /** 被子句级否定抵消、因此**没有**阻断的那几条——留痕，否则放松方向不可复核。 */
  negated: string[]
  /** 给起草那一跳的重写指令（`ok` 为真时是空串）。 */
  rewrite_instruction: string
}

/**
 * 出站文案的最后一道自查（56 §2 末行）。
 *
 * 承诺扫描用的是 `@agentsws/support-core` 的 `scanOutboundCommitment`——
 * **全仓同一份**，与客服回信、与 Amazon 出站硬闸读的是同一套规则。
 * 在这里再写一份"社媒版承诺词表"的后果是：同一句"我们给你补发"，
 * 客服那边拦得住，社群这边发出去了。
 *
 * 真正的强制在审批前置（`packages/txn` 的 `runPrecheck` 那三道门）；
 * 这一跳是**尽早给模型反馈**，与 `kol-core` 起草时先自查一遍是同一个位置。
 */
export function checkOutbound(
  text: string,
  options: { banned_terms?: readonly string[] } = {},
): OutboundCheck {
  const scan = scanOutboundCommitment(text)
  const lower = text.toLowerCase()
  const banned = (options.banned_terms ?? []).filter((t) => lower.includes(t.trim().toLowerCase()))
  const commitment = scan.hits.map((h) => h.rule)
  const unsourced = scan.unsourced_concession ? ['unsourced_concession'] : []
  const hits = [...commitment, ...unsourced]
  const ok = hits.length === 0 && banned.length === 0
  const parts: string[] = []
  if (hits.length > 0)
    parts.push(
      `正文里有第一人称承诺或无依据让步（${hits.join('、')}）。把"我们会…""一定…"这类话去掉；要给什么，走对应的审批，别在群里许诺。`,
    )
  if (banned.length > 0) parts.push(`用了这个品牌禁用的词：${banned.join('、')}。换个说法再来。`)
  return {
    ok,
    commitment_hits: hits,
    banned_hits: banned,
    negated: scan.negated_hits.map((h) => h.rule),
    rewrite_instruction: parts.join(' '),
  }
}
