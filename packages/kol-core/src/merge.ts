/**
 * 同一人合并（48 §5.2「同一人合并」）。
 *
 * **只出建议卡，永远不自动合。** 这不是保守，是算得出来的：合错了两个人，
 * 他们的合作、交付物、追踪链接、联系方式全混在一条记录上，拆回去要人一条条看；
 * 而"没合上"的代价只是清单上多一行。两边不对称，所以只走人点头那条路。
 *
 * 判据三条，每条都得说得出来（`reasons` 进卡面）：
 *
 * 1. **同一条联系方式**（按 `@agentsws/core` 的 `suppressionKey` 归一比对）——
 *    最强的一条。注意比的是 `value_ref` 指向的那个归一键，不是明文：
 *    明文不出加密库，所以调用方传进来的是**已经算好的键**。
 * 2. **跨渠道同 handle**：`@gadgetjonas` 在 YouTube 和在 Instagram，多半是同一个人，
 *    但也真有撞名的——所以它一条不够，要配合第 3 条。
 * 3. **显示名高度相似**（归一后相等，或一方包含另一方）。
 *
 * 一条判据不出建议；两条才出。只有"同一条联系方式"是例外——那一条单独成立。
 */

import type { Creator, KolChannel } from '@agentsws/contracts'
import { suppressionKey } from '@agentsws/core'
import { normalizeHandle } from './urls.js'

/** 合并判断要的那一份画像（调用方从三张表拼出来，这里不查库）。 */
export interface MergeProfile {
  creator_id: string
  display_name: string
  /** 这个人名下的账号（渠道 + handle）。 */
  accounts: readonly { channel: KolChannel; handle: string }[]
  /**
   * 这个人名下联系方式的**归一键**（`suppressionKey(明文)` 的结果）。
   *
   * 传键不传明文：这个模块因此永远碰不到一个真的邮箱地址，
   * 而"两条记录是不是同一个邮箱"照样判得出来。
   */
  contact_keys: readonly string[]
}

export type MergeReasonId = 'same_contact' | 'same_handle' | 'similar_name'

export interface MergeReason {
  id: MergeReasonId
  /** 一句人话（卡面上那一行）。 */
  text: string
}

export interface MergeSuggestion {
  /** 建议保留的那条（账号多的那条；一样多就 id 小的那条——要的是稳定，不是聪明）。 */
  keep_id: string
  /** 建议合进去的那条。 */
  merge_id: string
  reasons: MergeReason[]
  /** 0–1。同联系方式 0.95，两条弱判据 0.7。 */
  confidence: number
}

/** 显示名归一：去空白与常见标点，转小写。 */
function nameKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[\s._\-|·,]/g, '')
    .trim()
}

function nameSimilar(a: string, b: string): boolean {
  const x = nameKey(a)
  const y = nameKey(b)
  if (x === '' || y === '') return false
  if (x === y) return true
  // 一方包含另一方，且短的那个够长（3 个字以下的包含判断全是噪声）
  const short = x.length <= y.length ? x : y
  const long = x.length <= y.length ? y : x
  return short.length >= 3 && long.includes(short)
}

function sharedContact(a: MergeProfile, b: MergeProfile): string | undefined {
  const keys = new Set(a.contact_keys.map(suppressionKey))
  return b.contact_keys.map(suppressionKey).find((k) => keys.has(k))
}

function sharedHandle(
  a: MergeProfile,
  b: MergeProfile,
): { handle: string; channels: KolChannel[] } | undefined {
  for (const x of a.accounts) {
    for (const y of b.accounts) {
      if (x.channel === y.channel) continue // 同一渠道同 handle 是同一条账号，不是"两个人"
      if (normalizeHandle(x.handle) !== normalizeHandle(y.handle)) continue
      if (normalizeHandle(x.handle) === '') continue
      return { handle: normalizeHandle(x.handle), channels: [x.channel, y.channel] }
    }
  }
  return undefined
}

/** 两条画像之间有没有合并建议。没有回 `undefined`。 */
export function suggestMerge(a: MergeProfile, b: MergeProfile): MergeSuggestion | undefined {
  if (a.creator_id === b.creator_id) return undefined
  const reasons: MergeReason[] = []

  const contact = sharedContact(a, b)
  if (contact !== undefined)
    reasons.push({
      id: 'same_contact',
      // 键本身也不上卡面（它是邮箱归一后的样子，等于半个明文）——只说"同一条"
      text: '两条记录挂着同一条联系方式。',
    })

  const handle = sharedHandle(a, b)
  if (handle !== undefined)
    reasons.push({
      id: 'same_handle',
      text: `两条记录在 ${handle.channels.join(' 与 ')} 上都叫 @${handle.handle}。`,
    })

  if (nameSimilar(a.display_name, b.display_name))
    reasons.push({
      id: 'similar_name',
      text: `名字几乎一样：「${a.display_name}」与「${b.display_name}」。`,
    })

  const strong = contact !== undefined
  if (!strong && reasons.length < 2) return undefined

  const [keep, merge] =
    a.accounts.length === b.accounts.length
      ? a.creator_id <= b.creator_id
        ? [a, b]
        : [b, a]
      : a.accounts.length > b.accounts.length
        ? [a, b]
        : [b, a]

  return {
    keep_id: keep.creator_id,
    merge_id: merge.creator_id,
    reasons,
    confidence: strong ? 0.95 : 0.7,
  }
}

/**
 * 一批画像里的全部合并建议，按把握从高到低。
 *
 * 一条记录可能在好几对里出现——不去重：哪两条该合是人来点的，
 * 我们替他把候选都摆出来，不替他先挑一遍。
 */
export function suggestMerges(profiles: readonly MergeProfile[]): MergeSuggestion[] {
  const out: MergeSuggestion[] = []
  for (let i = 0; i < profiles.length; i += 1) {
    for (let j = i + 1; j < profiles.length; j += 1) {
      const a = profiles[i]
      const b = profiles[j]
      if (a === undefined || b === undefined) continue
      const s = suggestMerge(a, b)
      if (s !== undefined) out.push(s)
    }
  }
  return out.sort((x, y) => y.confidence - x.confidence)
}

/**
 * 人点了"合"之后，两条 `Creator` 怎么变。
 *
 * **纯函数，不写库**：调用方拿着结果去改存储、迁移账号与合作。
 * `merged_from` 把被合掉那条的 id 留着（连同它自己合过的那些），
 * 所以合错了拆得回来——这正是"只出建议不自动合"能成立的另一半。
 */
export function applyMerge(keep: Creator, merge: Creator): Creator {
  const from = [...keep.merged_from, merge.id, ...merge.merged_from]
  return {
    ...keep,
    merged_from: [...new Set(from)].filter((id) => id !== keep.id),
  }
}
