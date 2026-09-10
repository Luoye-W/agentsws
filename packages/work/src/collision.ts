/**
 * 撞车检测（40 §3.1）：**一件事一个主人**。
 *
 * 建之前先看撞不撞，用三把钥匙找**进行中**的相似项：
 * - ① **同一个主题对象**：同订单 / 同客户 / 同会议 / 同店铺（`ObjectRef`）。最硬的一把——
 *   两条待办指着同一张订单，几乎一定是同一件事。
 * - ② **语义键相似**：复用 24 的语义键（`@agentsws/learning` 的 `semanticKey` / `keyTokens`）——
 *   去停用词的词袋，词序无关；键相同，或词面重合 > {@link SEMANTIC_THRESHOLD} 也算。
 * - ③ **同岗位同日同类**：同一个岗位、同一个本地日、同一种来源（待办 `source` / 事项 `kind`）。
 *   这一把**只作旁证**：单靠它会把同一天同一个岗位建的每一条都判成撞车，所以还要有
 *   {@link COROBORATION_THRESHOLD} 以上的词面重合才算数。
 *
 * 纪律：
 * - 纯函数。没有 IO、没有存储、没有模型、没有 `Date.now()`——「现在」由调用方经 Clock 给。
 * - 只看**进行中**：open / doing / blocked 的待办，open / waiting 的事项。已完成的不算撞车。
 * - 回的是**候选**，不是判决。建不建、怎么建（加入 / 交给他 / 仍新建）是人的选择题（40 §3.2 ①）。
 */
import type { Iso8601, MatterId, ObjectRef, PersonId, PositionId } from '@agentsws/contracts'
import { keySimilarity, keyTokens, semanticKey } from '@agentsws/learning'
import { localDay } from './util.js'

/** 三把钥匙的名字；候选身上带着「是靠哪几把命中的」，界面直接拿去解释。 */
export type CollisionKey = 'object' | 'semantic' | 'position_day'

/** 词面重合超过它就算「同一件事换了个说法」（40 §3.1 ②）。 */
export const SEMANTIC_THRESHOLD = 0.7

/** ③ 同岗位同日同类只是旁证，还要有这么多重合才算撞（否则同岗位同日的每一条都会撞）。 */
export const COROBORATION_THRESHOLD = 0.34

/** 语义键的命名空间：撞车与 24 的 lesson 不共享一把键，只共享同一套分词与停用词。 */
const COLLISION_SKILL = 'work.collision'

/** 一条文本的语义键（同一件事换个说法是同一把键）。导出给测试与解释用。 */
export function collisionKey(text: string): string {
  return semanticKey({ skill: COLLISION_SKILL, kind: 'rule', text })
}

/** 参与撞车判定的一条「正在做的事」——待办或事项都投影成它。 */
export interface InProgressItem {
  kind: 'todo' | 'matter'
  id: string
  title: string
  /** 主人；池里没主人的项不进这份清单（没有主人就不构成撞车） */
  owner: PersonId
  collaborators: PersonId[]
  /** 各自的状态（待办 `TodoStatus` / 事项 `MatterStatus`），只用于显示 */
  status: string
  /** 主题对象：待办取自它的事项的 `pinned`，事项取自自己的 `pinned` */
  refs: ObjectRef[]
  position_id?: PositionId
  /** 「类」：待办是 `source`，事项是 `kind` */
  item_kind: string
  started_at: Iso8601
  last_activity: Iso8601
  /** 等他定的卡数（选择题卡上那句「2 张卡等他定」） */
  cards: number
  matter_id?: MatterId
}

/** 要建的那件事（还没建）。 */
export interface CollisionSubject {
  title: string
  note?: string | undefined
  /** 明确带上的主题对象（订单 / 客户 / 会议 / 店铺） */
  refs?: readonly ObjectRef[] | undefined
  position_id?: PositionId | undefined
  /** 待办的 `source` 或事项的 `kind` */
  item_kind?: string | undefined
  /** 现在（经 Clock），③ 的「同日」按它算 */
  at: Iso8601
}

export interface CollisionCandidate extends InProgressItem {
  /** 靠哪几把钥匙命中的 */
  keys: CollisionKey[]
  /** 词面重合 0..1（同一把语义键时为 1） */
  similarity: number
}

export interface CollisionInput {
  subject: CollisionSubject
  /** 现在正在做的事（调用方已按可见范围过滤好） */
  pool: readonly InProgressItem[]
  tz_offset_minutes: number
  /** 这些 id 不参与（改自己那条时别撞自己） */
  exclude_ids?: readonly string[] | undefined
}

const refKey = (r: ObjectRef): string => `${r.type}:${r.id}`

/** 待办 / 事项的完整文本：标题 + 备注一起进词袋（备注里常带订单号）。 */
const textOf = (title: string, note?: string): string =>
  note === undefined || note === '' ? title : `${title} ${note}`

/**
 * 找**进行中**的相似项。按「命中几把钥匙 → 重合度 → 最近活动」排序，最像的在前。
 *
 * 回空数组 = 没撞，照建。
 */
export function findInProgressSimilar(input: CollisionInput): CollisionCandidate[] {
  const { subject, pool } = input
  const excluded = new Set(input.exclude_ids ?? [])
  const myText = textOf(subject.title, subject.note)
  const myKey = collisionKey(myText)
  const myRefs = new Set((subject.refs ?? []).map(refKey))
  const myDay = localDay(subject.at, input.tz_offset_minutes)
  const out: CollisionCandidate[] = []

  for (const item of pool) {
    if (excluded.has(item.id)) continue
    const itemText = item.title
    const similarity = keySimilarity(myText, itemText)
    const keys: CollisionKey[] = []

    // ① 同一个主题对象
    if (myRefs.size > 0 && item.refs.some((r) => myRefs.has(refKey(r)))) keys.push('object')

    // ② 语义键相同，或词面重合过线
    if (collisionKey(itemText) === myKey || similarity > SEMANTIC_THRESHOLD) keys.push('semantic')

    // ③ 同岗位同日同类（旁证：还要有起码的词面重合）
    if (
      subject.position_id !== undefined &&
      item.position_id === subject.position_id &&
      localDay(item.started_at, input.tz_offset_minutes) === myDay &&
      (subject.item_kind === undefined || item.item_kind === subject.item_kind) &&
      similarity >= COROBORATION_THRESHOLD
    )
      keys.push('position_day')

    if (keys.length === 0) continue
    out.push({ ...item, keys, similarity })
  }

  out.sort(
    (a, b) =>
      b.keys.length - a.keys.length ||
      b.similarity - a.similarity ||
      Date.parse(b.last_activity) - Date.parse(a.last_activity) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )
  return out
}

/** 一句人话，解释为什么判它撞车（选择题卡的副标题）。 */
export function collisionReason(candidate: CollisionCandidate): string {
  const parts: string[] = []
  if (candidate.keys.includes('object')) parts.push('指着同一个对象')
  if (candidate.keys.includes('semantic')) parts.push('说的是同一件事')
  if (candidate.keys.includes('position_day')) parts.push('同岗位同一天的同类活')
  return parts.join('、')
}

/** 选择题卡的一句话：「李默正在做『核对昨天的退款单』（进行中，2 张卡等他定）」。 */
export function collisionHeadline(
  candidate: CollisionCandidate,
  nameOf?: (id: PersonId) => string,
): string {
  const who = nameOf?.(candidate.owner) ?? candidate.owner
  const cards = candidate.cards > 0 ? `，${candidate.cards} 张卡等他定` : ''
  return `${who}正在做「${candidate.title}」（进行中${cards}）`
}

/** 词袋（导出给测试：解释为什么两条判成同一件事）。 */
export { keyTokens }
