/**
 * 红人那几块共用的渠道小工具（WP500 从 `kol-panel.tsx` 挪出来：红人详情要在第三栏里单独渲染，
 * 不能反过来 import 整个面板）。`kol-panel.tsx` 照旧转出这几个名字，调用方一行不改。
 */
import type { KolChannelId } from '@/lib/api'

/** 五条渠道（真源是契约的 `KOL_CHANNEL_IDS`；工作台不依赖服务端包，这里照抄一份）。 */
export const ALL_CHANNELS: readonly KolChannelId[] = [
  'youtube',
  'facebook',
  'instagram',
  'tiktok',
  'x',
]

/**
 * WP142：渠道 → 连接目录里那一家（搜不了时「接自己的数据接口」去哪、渠道的品牌图标用哪张）。
 */
export const CHANNEL_SERVICE: Readonly<Record<KolChannelId, string>> = {
  youtube: 'youtube_data',
  instagram: 'instagram_graph',
  facebook: 'facebook_graph',
  tiktok: 'tiktok_research',
  x: 'x_api',
}

/**
 * WP201：显示用的 `@handle`。插件从 YouTube 收进来的 handle 自带 `@`（YouTube 自己就这么写），
 * 导入的与公共库来的不带——显示时统一成一个 `@`，别出现 `@@TheTechReviewer`。库里的值不动。
 */
export function atHandle(handle: string | undefined): string {
  return handle === undefined || handle === '' ? '—' : `@${handle.replace(/^@+/, '')}`
}
