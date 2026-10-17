/**
 * WP372：对话的两个动作——手动归档一件（底部「已归档…· 撤销」）、看已归档的列表。
 *
 * 归档与撤销的状态在外壳里（`app-shell.tsx`，WP207 起就在那儿），右侧面板里的对话列表只是触发它们。
 * 没有外壳（单测只渲染一个面板）时两样都是 `undefined`：列表就不出「⋯」菜单与「已归档」。
 */
import { createContext, useContext } from 'react'
import type { RailMatter } from '@/lib/work-archive'

export interface ConversationActions {
  archive?: (matter: RailMatter) => void
  openArchived?: (scope: { position_id: string; role_id: string }) => void
}

const Ctx = createContext<ConversationActions>({})

export const ConversationActionsProvider = Ctx.Provider

export function useConversationActions(): ConversationActions {
  return useContext(Ctx)
}
