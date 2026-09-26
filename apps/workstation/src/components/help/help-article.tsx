/**
 * WP156：教程文章的渲染（右栏「教程」面板与「看教程」对话框里用）。
 *
 * WP157 起它只是 `SafeMarkdown` 的 `article` 排法——与时间线的 Agent 回话同一份渲染、
 * 同一套安全纪律（`components/ui/safe-markdown.tsx`）。
 */
import type { ReactNode } from 'react'
import { SafeMarkdown } from '@/components/ui/safe-markdown'

export function HelpArticle({ markdown }: { markdown: string }): ReactNode {
  return <SafeMarkdown text={markdown} variant="article" />
}
