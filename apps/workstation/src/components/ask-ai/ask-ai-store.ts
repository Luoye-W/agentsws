/**
 * WP504（决策 1775 A / 1776 A）：**「✦ 问 AI」的一份真源**——第三栏里任何卡 / 数据块点了 ✦，
 * 这张卡变成一枚**引用小卡**放进中栏的输入框，输入框上面换成 2–3 个按这张卡出的建议问题；
 * 第三栏不关，被问的那张卡亮一圈。
 *
 * 通用件，不认红人也不认知识：调用方交来一份 {@link ContextRef}（是什么、叫什么、一排字段），
 * 这里只管「放进输入框 / 拿出来 / 发出去时交给模型」。发出去时引用按**结构化摘要**交给服务端
 * （`context: [{ kind, id, label, facts }]`），不是截图——服务端把它记在那句话上、围起来交给模型。
 *
 * 只在内存里（刷新就没了）：引用的是这一刻屏幕上的东西，不该留在这台电脑上。
 */
import { useSyncExternalStore } from 'react'

/** 一枚引用小卡交给模型的一格（「粉丝：164k」）。 */
export interface ContextFact {
  k: string
  v: string
}

/** 一张被引用的卡 / 数据块。 */
export interface ContextRef {
  /** 它是什么（`creator` / `knowledge` / `report_block`……）；同 kind + id 只放一次。 */
  kind: string
  id: string
  /** 小卡上那一行字（「Desk Fixture」）。 */
  label: string
  /** 小卡上名字后面那一小截（「红人 · 83 分」）。 */
  sub?: string
  /** 头像那一格（一个字）。 */
  initial?: string
  /** 交给模型的结构化摘要（一行一格）。 */
  facts: readonly ContextFact[]
  /** 按这张卡出的建议问题（2–3 个；没有就不出）。 */
  suggestions?: readonly string[]
}

/** 发给服务端的那一份（`context` 字段）。 */
export interface ContextRefPayload {
  kind: string
  id: string
  label: string
  facts: { k: string; v: string }[]
}

/** 一句话最多带几张卡（服务端也是这个上限）。 */
export const MAX_REFS = 10

export const refKey = (r: Pick<ContextRef, 'kind' | 'id'>): string => `${r.kind}:${r.id}`

interface State {
  refs: readonly ContextRef[]
  /** 刚被问的那几张（第三栏里亮一圈）。 */
  asked: ReadonlySet<string>
  /** 每放进一次 +1：输入框据此聚焦。 */
  nonce: number
}

let state: State = { refs: [], asked: new Set(), nonce: 0 }
const listeners = new Set<() => void>()
const publish = (next: State): void => {
  state = next
  for (const l of listeners) l()
}
const subscribe = (l: () => void): (() => void) => {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

/** 把几张卡放进输入框（已经在里面的不重复放；超过上限的丢掉后面的）。 */
export function addRefs(refs: readonly ContextRef[]): void {
  const have = new Set(state.refs.map(refKey))
  const fresh = refs.filter((r) => !have.has(refKey(r)))
  const next = [...state.refs, ...fresh].slice(0, MAX_REFS)
  publish({
    refs: next,
    asked: new Set([...state.asked, ...refs.map(refKey)]),
    nonce: state.nonce + 1,
  })
}

/** 拿掉一张（小卡上的 ×）。 */
export function removeRef(key: string): void {
  const asked = new Set(state.asked)
  asked.delete(key)
  publish({ ...state, refs: state.refs.filter((r) => refKey(r) !== key), asked })
}

/** 发出去了 / 换页了：清空。 */
export function clearRefs(): void {
  if (state.refs.length === 0 && state.asked.size === 0) return
  publish({ ...state, refs: [], asked: new Set() })
}

export function useAskAi(): State {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  )
}

/** 现在这一份（不订阅）。 */
export function currentRefs(): readonly ContextRef[] {
  return state.refs
}

/** 引用 → 发给服务端的形状（字段截到上限，空的不带）。 */
export function refsPayload(refs: readonly ContextRef[]): ContextRefPayload[] {
  return refs.slice(0, MAX_REFS).map((r) => ({
    kind: r.kind.slice(0, 40),
    id: r.id.slice(0, 200),
    label: r.label.slice(0, 200),
    facts: r.facts
      .filter((f) => f.v.trim() !== '')
      .slice(0, 40)
      .map((f) => ({ k: f.k.slice(0, 60), v: f.v.slice(0, 500) })),
  }))
}

/**
 * 建议问题：几张卡一起问时取第一张的前两个 + 一个「比一比」；只有一张就用它自己的（最多 3 个）。
 * 没有就是空的——不硬编。
 */
export function suggestionsOf(refs: readonly ContextRef[], compare: string): string[] {
  if (refs.length === 0) return []
  if (refs.length === 1) return [...(refs[0]?.suggestions ?? [])].slice(0, 3)
  return [...(refs[0]?.suggestions ?? []).slice(0, 2), compare].slice(0, 3)
}

/** 拖卡进输入框时 `dataTransfer` 里那一格的类型。 */
export const REF_MIME = 'application/x-agentsws-ref'

/** 只给测试用。 */
export function resetAskAi(): void {
  state = { refs: [], asked: new Set(), nonce: 0 }
}
