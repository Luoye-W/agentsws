/**
 * WP153（09-26 真账号冒烟 §1）：Agent 回话里的 markdown **安全地**画出来（时间线用）。
 *
 * WP157 起它只是 `SafeMarkdown` 的 `reply` 排法——渲染与安全纪律（不解析 HTML、不加载图片、
 * 链接只认 http(s) / 站内 / 教程互链）都在 `safe-markdown.tsx` 一处，教程文章也用同一份。
 */
import { SafeMarkdown } from '@/components/ui/safe-markdown'

/** Agent 的一段回话（时间线用）。 */
export function ReplyMarkdown({ text }: { text: string }): React.ReactNode {
  return <SafeMarkdown text={text} variant="reply" />
}
