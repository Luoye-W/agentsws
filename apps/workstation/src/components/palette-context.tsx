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

interface PaletteApi {
  open(handoff?: Handoff): void
}

const PaletteContext = createContext<PaletteApi>({ open: () => undefined })

export const PaletteProvider = PaletteContext.Provider

export function usePalette(): PaletteApi {
  return useContext(PaletteContext)
}
