/**
 * 老地址 `/chat-window`（WP124 的「聊天窗」页）。
 *
 * WP351（Luoye 10-16 追加，决策 906 第 4 条修订）：这一页拆成两半、左栏不再有「聊天窗」——
 * - 访客的对话（进行中的对话、谁在聊、对话、教 AI）并进「消息」，当和邮箱并列的来源「网站聊天」
 *   （`components/messages/site-chat.tsx`）；
 * - 挂件设置（外观、嵌入代码、转发方式 / 托管档）挪进「消息渠道」页，当一个渠道「网站聊天窗」
 *   （`components/chat-window/widget-settings.tsx`）。
 *
 * 老地址（书签、教程里的链接、旧版托盘）跳到「消息」里那个来源。
 */
import { Navigate } from 'react-router-dom'
import { SITE_CHAT_HREF } from '@/components/messages/site-chat'

export function ChatWindowPage(): React.ReactNode {
  return <Navigate to={SITE_CHAT_HREF} replace />
}
