/**
 * WP188：从页面里打开 ⌘K 命令面板——尤其是「交给岗位去做」：随便聊里点了，面板带着这段对话打开，
 * 只列岗位，选一个就把这件事交过去（与岗位页顶部「交给这个岗位一件事」同一条路）。
 */
import { createContext, useContext } from 'react'

/** 要交给岗位的那件事：一句话标题 + 带过去的上下文（这段对话）。 */
export interface Handoff {
  title: string
  summary: string
}

/**
 * WP207：左栏职责行上的「+」——在**这条职责**下开一件新事。等价于 ⌘K「交给某个岗位一件事」
 * 预选好岗位与职责：面板打开时只剩一格输入，回车就交出去。
 */
export interface ComposeTarget {
  /** 本人在这条职责上的分配（开事项就用它）。 */
  assignment: string
  role_id: string
  /** 「岗位 › 职责」，面板标题上那一句。 */
  label: string
}

interface PaletteApi {
  open(handoff?: Handoff): void
  /** WP207：只有外壳里那一份有它（单测里只渲染一页时可以不给）。 */
  compose?(target: ComposeTarget): void
}

const PaletteContext = createContext<PaletteApi>({
  open: () => undefined,
  compose: () => undefined,
})

export const PaletteProvider = PaletteContext.Provider

export function usePalette(): PaletteApi {
  return useContext(PaletteContext)
}
