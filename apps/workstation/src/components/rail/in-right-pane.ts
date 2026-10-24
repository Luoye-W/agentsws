/**
 * WP500：「我现在是不是已经画在第三栏那一格里」。
 *
 * 第三栏同一时间只开一格（WP437 / WP481）。一个本来就画在第三栏里的东西（比如「计划」那一格里的红人候选池）
 * 要再开一个详情时，不能去开第三栏——那会把它自己换掉；它要在自己里面叠一层（← 回去）。
 * `RailPanel` 给它的孩子垫上 `true`，别处都是 `false`。
 */
import { createContext, useContext } from 'react'

export const InRightPaneContext = createContext(false)

export function useInRightPane(): boolean {
  return useContext(InRightPaneContext)
}
