/**
 * WP372（决策 1019）：岗位页（中间栏）与右侧面板「报表 → 看板」之间的两句话。
 *
 * 「工作」与数据看板搬进右侧面板之后，有两处原来在同一页里互相够得着的动作要隔着一栏传：
 * - 页头「1 件卡住了」「今天 2 个待办」点了 → 面板里的「工作」筛到那一组（`requestWorkFilter`）；
 * - 面板「工作」行尾「N 张卡等你」点了 → 中间栏的「要你拍板」翻到那张（`requestCardJump`）。
 *
 * 只在内存里、只留最近一句（与 `quick-answer-store.ts` 同一个写法）。
 */
import { useSyncExternalStore } from 'react'
import type { WorkPrefs } from '@/lib/position-work'

interface Bridge {
  filter?: { position: string; filters: WorkPrefs['filters']; nonce: number }
  jump?: { position: string; card_id: string; nonce: number }
}

let state: Bridge = {}
let seq = 0
const listeners = new Set<() => void>()

const publish = (next: Bridge): void => {
  state = next
  for (const l of listeners) l()
}

const subscribe = (l: () => void): (() => void) => {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

export function requestWorkFilter(position: string, filters: WorkPrefs['filters']): void {
  seq += 1
  publish({ ...state, filter: { position, filters, nonce: seq } })
}

export function requestCardJump(position: string, card_id: string): void {
  seq += 1
  publish({ ...state, jump: { position, card_id, nonce: seq } })
}

export function useWorkFilterRequest(position: string): Bridge['filter'] {
  const s = useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  )
  return s.filter?.position === position ? s.filter : undefined
}

export function useCardJumpRequest(position: string): Bridge['jump'] {
  const s = useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  )
  return s.jump?.position === position ? s.jump : undefined
}
