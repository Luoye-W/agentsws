/**
 * WP511（决策 1546 / 1765「资料在右、决策在中」）：「打开那一段」在第三栏的地址。
 *
 * 小结（话题分隔线上那一行）、回复下面的出处点了，用 `rail.openAddress(assistantSegmentAddress(段, 句))`
 * 在右边开当时的原话。单独一个小文件：内置面板注册要认这个地址，不该为此把面板正文拉进首包。
 */
export const ASSISTANT_SEGMENT_PREFIX = 'agentsws://assistant-segment/'

/** 段 id（+ 那一句的 id，面板里亮那一句）→ 地址。 */
export const assistantSegmentAddress = (segment_id: string, message_id?: string): string =>
  `${ASSISTANT_SEGMENT_PREFIX}${encodeURIComponent(segment_id)}${message_id === undefined ? '' : `/${encodeURIComponent(message_id)}`}`

/** 地址 → 段 id（+ 句 id）；不是这一类的回 `undefined`。 */
export function parseAssistantSegmentAddress(
  address: string | undefined,
): { segment_id: string; message_id?: string } | undefined {
  if (address === undefined || !address.startsWith(ASSISTANT_SEGMENT_PREFIX)) return undefined
  const [seg, msg] = address.slice(ASSISTANT_SEGMENT_PREFIX.length).split('/')
  if (seg === undefined || seg === '') return undefined
  return {
    segment_id: decodeURIComponent(seg),
    ...(msg === undefined || msg === '' ? {} : { message_id: decodeURIComponent(msg) }),
  }
}
