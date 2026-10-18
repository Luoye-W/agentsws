/**
 * WP414（Luoye 10-19 真机，Reddit 回信卡）：**哪几张算「同类」**——给网关 `similarCards` 用。
 *
 * 不另造轮子：分词用技能层那把中英混排粗分词（`@agentsws/skills` 的 `tokenize`），停用词用学习回路
 * 语义钥匙那一份（`@agentsws/learning` 的 `keyTokens` 判一个词有没有区分力），重合度照 `keySimilarity`
 * 的算法（词集合 Jaccard）。不直接调 `keySimilarity` 是因为它只取排序后的前 12 个词——那是给短句做
 * 稳定键的，Reddit 原帖动辄几十个词，截断后比的就成了字母序靠前的那几个词。不叫模型、离线算得出同一个值。
 *
 * 前提（网关已经筛过）：同一个人、同一条职责、同一种卡、都还没定。这里再加一道门：**同一种卡面**
 * （`payload.form` 一样；改动卡还要改的是同一类东西）。过了门，下面任一条就算同类：
 *
 * 1. **同一个对象**：同一个帖子 / 同一个对象（一串里好几条回复）；
 * 2. **同一话题**：说的是同一件事（词重合 ≥ {@link TOPIC_THRESHOLD}）；
 * 3. **同一来源 + 同一判断依据**：同一个来源（同一个版块 / 渠道），而且 AI 出卡时的理由相近
 *    （≥ {@link BASIS_THRESHOLD}），或者话题也沾边（≥ {@link LOOSE_TOPIC}）。
 *
 * 只有「同一来源」**不够**：自家版块里每一条都是同一个来源，否掉一条不能把整个版块的回复都否了。
 */

import type { FollowBasis, SimilarCard } from '@agentsws/api'
import type { ApprovalItem } from '@agentsws/contracts'
import { keyTokens } from '@agentsws/learning'
import { tokenize } from '@agentsws/skills'

/** 话题单独过这条线就算同类。 */
export const TOPIC_THRESHOLD = 0.5
/** 同一来源时，AI 判断理由过这条线算同一判断依据。 */
export const BASIS_THRESHOLD = 0.5
/** 同一来源时，话题过这条（更低的）线也算。 */
export const LOOSE_TOPIC = 0.3

const rec = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined

/** 卡面是哪一种（`form`；改动卡再加上改的是哪一类）。 */
function faceOf(item: ApprovalItem): string {
  const p = rec(item.payload)
  return `${str(p.form) ?? ''}|${item.kind === 'staged_change' ? (str(p.kind) ?? '') : ''}`
}

/** 帖子 id（`/r/x/comments/<id>/…`）。 */
const postOf = (permalink: string | undefined): string | undefined =>
  permalink?.match(/\/comments\/([a-z0-9]+)/i)?.[1]

/** 同一个对象：同一个帖子，或同一个审批对象。 */
function objectOf(item: ApprovalItem): string | undefined {
  const reddit = rec(rec(item.payload).reddit)
  const post = postOf(str(reddit.permalink))
  if (post !== undefined) return `reddit_post:${post}`
  const obj = item.subject.object
  return obj === undefined ? undefined : `${obj.type}:${obj.id}`
}

/** 来源（给人看的那个名字：「r/Smartphones」「Reddit · r/x」「邮件」…）。 */
function sourceOf(item: ApprovalItem): string | undefined {
  const p = rec(item.payload)
  const sub = str(rec(p.reddit).subreddit)
  if (sub !== undefined) return `r/${sub.replace(/^r\//i, '')}`
  return str(p.channel_label) ?? str(p.channel)
}

/** 话题那段字：一句话摘要 + 回的那一句 / 原帖标题（卡标题里多是人名，不算）。 */
function topicOf(item: ApprovalItem): string {
  const p = rec(item.payload)
  const reddit = rec(p.reddit)
  return [
    item.summary,
    str(p.in_reply_to),
    str(reddit.post_title),
    str(reddit.parent_text),
    str(rec(p.after).title),
  ]
    .filter((s): s is string => s !== undefined && s !== '')
    .join(' ')
}

/** AI 出这张卡的理由（判断依据）。 */
const basisOf = (item: ApprovalItem): string | undefined => str(rec(item.payload).reason)

/** 有区分力的词（拉丁单字母、停用词都不算）。 */
function bag(text: string): Set<string> {
  const out = new Set<string>()
  for (const t of tokenize(text)) {
    if (/^[a-z0-9]$/.test(t)) continue
    if (keyTokens(t).length === 0) continue
    out.add(t)
  }
  return out
}

/** 词集合重合度（0..1；与 `keySimilarity` 同一个算法，不截词）。 */
export function overlap(a: string, b: string): number {
  const sa = bag(a)
  const sb = bag(b)
  if (sa.size === 0 || sb.size === 0) return 0
  let inter = 0
  for (const t of sa) if (sb.has(t)) inter += 1
  return inter / (sa.size + sb.size - inter)
}

const shared = (a: string, b: string): string[] => {
  const other = bag(b)
  return [...bag(a)].filter((t) => other.has(t)).slice(0, 3)
}

/** 一张卡和带头那张像不像；不像回 `undefined`。 */
export function similarTo(leader: ApprovalItem, card: ApprovalItem): SimilarCard | undefined {
  if (card.id === leader.id || card.kind !== leader.kind || card.role_id !== leader.role_id)
    return undefined
  if (faceOf(card) !== faceOf(leader)) return undefined

  const object = objectOf(leader)
  if (object !== undefined && object === objectOf(card))
    return { id: card.id, why: '同一个帖子 / 同一个对象', basis: ['same_object'] }

  const ta = topicOf(leader)
  const tb = topicOf(card)
  const topic = overlap(ta, tb)
  if (topic >= TOPIC_THRESHOLD) {
    const words = shared(ta, tb)
    return {
      id: card.id,
      why: words.length === 0 ? '说的是同一件事' : `说的是同一件事（${words.join('、')}）`,
      basis: ['same_topic'],
    }
  }

  const source = sourceOf(leader)
  if (source === undefined || source !== sourceOf(card)) return undefined
  const ba = basisOf(leader)
  const bb = basisOf(card)
  const basis = ba === undefined || bb === undefined ? 0 : overlap(ba, bb)
  if (basis >= BASIS_THRESHOLD)
    return {
      id: card.id,
      why: `同在 ${source}，AI 出卡的理由相近`,
      basis: ['same_source', 'same_judgement'],
      source,
    }
  if (topic >= LOOSE_TOPIC)
    return {
      id: card.id,
      why: `同在 ${source}，说的也是相近的事`,
      basis: ['same_source', 'same_topic'] satisfies FollowBasis[],
      source,
    }
  return undefined
}

/** 网关的 `similarCards`：在待处理卡里挑出同类的（同一个对象的排前面，其余按原次序）。 */
export function similarApprovals(
  leader: ApprovalItem,
  pool: readonly ApprovalItem[],
): SimilarCard[] {
  const out: SimilarCard[] = []
  for (const card of pool) {
    const hit = similarTo(leader, card)
    if (hit !== undefined) out.push(hit)
  }
  return out.sort(
    (a, b) => Number(b.basis.includes('same_object')) - Number(a.basis.includes('same_object')),
  )
}
