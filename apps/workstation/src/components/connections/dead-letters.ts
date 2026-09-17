import type { ConnectionView, DeadLetterView } from '@/lib/api'

/**
 * 死信归到"它是从哪条连接进来的"那张卡上。
 *
 * 09-17 Luoye 真机：邮箱的三封死信同时出现在 Shopify 卡上——`GET /v1/channels/dead-letters`
 * 回的是整个工作区的，页面原样塞给了每一行。入站渠道与连接的对应关系只有这一张表：
 * 邮箱连接（`imap_smtp`）↔ `email` 渠道；Shopify 之类没有入站渠道，一封都不该显示。
 * 表里没有的渠道（将来的 IM）不在这一页显示，归各自的页面。
 */
const CHANNELS_BY_SERVICE: Readonly<Record<string, readonly string[]>> = {
  imap_smtp: ['email'],
}

export function deadLettersFor(
  connection: Pick<ConnectionView, 'service'>,
  all: readonly DeadLetterView[],
): DeadLetterView[] {
  const channels = CHANNELS_BY_SERVICE[connection.service] ?? []
  return all.filter((d) => channels.includes(d.channel))
}
