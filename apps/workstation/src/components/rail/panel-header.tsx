/**
 * WP504（F1 / F2）：第三栏那一格的**头**可以由面板自己换——库面板头上「红人库 · 红人营销」+ ↑ ⋯，
 * 详情叠上来时换成「← 红人库 / Desk Fixture」+「✦ 问 AI」。
 *
 * 做法是一个插槽：`RailPanel` 在头里留一格，面板身体用 {@link PanelHeaderSlot} 把内容送进去（portal），
 * 送了东西就盖掉默认的「名字 · 哪一层」；右上角的 × 永远是外壳的。不在第三栏里（单独渲染、测试）时插槽不存在，
 * {@link PanelHeaderSlot} 什么都不画——面板照常能用。
 */
import { createContext, type ReactNode, useContext, useEffect } from 'react'
import { createPortal } from 'react-dom'

export interface PanelHeaderHost {
  /** 头里那一格（还没挂上时是 `null`）。 */
  slot: HTMLElement | null
  /** 有几个插槽在用（> 0 时默认标题让位）。 */
  claim(): () => void
}

export const PanelHeaderContext = createContext<PanelHeaderHost | undefined>(undefined)

/** 把头换成这些（标题那一截 + 右边几颗图标）。 */
export function PanelHeaderSlot({ children }: { children: ReactNode }): ReactNode {
  const host = useContext(PanelHeaderContext)
  useEffect(() => host?.claim(), [host])
  if (host?.slot == null) return null
  return createPortal(children, host.slot)
}

/** 这一格的头能不能换（库面板据此决定把标题画在头上还是画在身体里）。 */
export function useHasPanelHeader(): boolean {
  return useContext(PanelHeaderContext) !== undefined
}
