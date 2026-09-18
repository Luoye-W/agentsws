/**
 * WP100：**人点开证据的那张卡**，一份真源。
 *
 * 为什么要它：第三栏的证据面板（36 §9 那一格）要显示"当前卡的依据"，而面板拿到的
 * props 只有作用域、地址与路径（`RailPanelBodyProps`）——那是**注册接口**，第三方
 * 面板与内置面板共用一份，不能为了一个内置面板往上加一格（WP95 定的纪律）。
 *
 * 于是换个方向：卡片在人点「证据 N」的那一下**把自己放在这里**，面板来读。
 * 与 `rail-state` 里那句 `show('evidence')` 是同一下动作的两半——一半开面板，
 * 一半说"开的是哪张卡的"。
 *
 * 只活在内存里（与 `RailState.address` 同一条理由）：刷新之后这一格回到空，
 * 面板照实说"点卡片右上角的证据 N"。**一个字都不落到这台电脑上**（40 §1.2）。
 */
import type { DeckCard } from '@agentsws/deck'
import { useSyncExternalStore } from 'react'

let focused: DeckCard | null = null
const listeners = new Set<() => void>()

/** 把这张卡设成"证据面板正在看的那张"（传 `null` 清空）。 */
export function focusEvidenceCard(card: DeckCard | null): void {
  focused = card
  for (const fn of listeners) fn()
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

const snapshot = (): DeckCard | null => focused

/** 证据面板正在看哪张卡；没人点过「证据 N」时是 `null`。 */
export function useEvidenceCard(): DeckCard | null {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}
