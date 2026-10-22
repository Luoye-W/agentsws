/**
 * WP461（WP456 §2.3 / §2.5）：认得工坊档位的 `cn`。
 *
 * `cn` 合并类名时要知道 `text-ws-tiny` 是**字号**、不是文字颜色——不然
 * `cn('text-ws-tiny', 'text-ws-muted-fg')` 会把前一个当成被覆盖的颜色扔掉。
 * 这里把 index.css 里新加的字号 / 圆角 / 阴影档位名告诉它。
 *
 * vite（含 vitest）把裸的 `'cn'` 指到这个文件（vite.config.ts 的 alias），所以 shadcn 组件里
 * `import { cn } from 'cn'` 和应用层 `@/lib/utils` 用的是同一份。
 * 这里自己从 `cn/config` 取，不走 `'cn'`，免得指回自己。
 */
import { createCn } from 'cn/config'

/** 字号七档的语义名（index.css `--text-ws-*`）。 */
export const WS_TEXT_TIERS = [
  'ws-page',
  'ws-title',
  'ws-read',
  'ws-ui',
  'ws-note',
  'ws-tiny',
  'ws-big',
] as const
/** 圆角五档的语义名（index.css `--radius-ws-*`）。 */
export const WS_RADIUS_TIERS = ['ws-tag', 'ws-ctl', 'ws-block', 'ws-card', 'ws-dialog'] as const
/** 阴影三层（外加悬停 / 选中光晕）的名字（index.css `--shadow-ws*`）。 */
export const WS_SHADOW_TIERS = ['ws', 'ws-hover', 'ws-glow', 'ws-pop', 'ws-dialog'] as const

export const cn = createCn({
  extend: {
    theme: {
      text: [...WS_TEXT_TIERS],
      radius: [...WS_RADIUS_TIERS],
      shadow: [...WS_SHADOW_TIERS],
    },
  },
})
