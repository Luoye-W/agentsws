/**
 * WP96：09-18 设计画布的**语义色**只有六档，所有共用件都从这里取 class。
 *
 * 为什么不让各组件各写各的 `bg-emerald-50`：画布上"好 / 注意 / 坏 / 信息"是四种
 * 含义，不是四个色号。深浅色各一套值已经在 `index.css` 的 `--ws-*` 里，这里只
 * 负责把"含义 → token"这一步写在一处——换皮时改 token，不改组件。
 */
export type Tone = 'brand' | 'good' | 'warn' | 'bad' | 'info' | 'neutral'

/** 圆形 / 圆角图标徽：浅底 + 同色前景。 */
export const TONE_BADGE: Record<Tone, string> = {
  brand: 'bg-ws-tint text-ws-brand',
  good: 'bg-ws-good-bg text-ws-good',
  warn: 'bg-ws-warn-bg text-ws-warn',
  bad: 'bg-ws-bad-bg text-ws-bad',
  info: 'bg-ws-info-bg text-ws-info',
  neutral: 'bg-ws-surface text-ws-muted-fg',
}

/** 状态胶囊：带一个小圆点的那种（画布 `.st`）。 */
export const TONE_PILL: Record<Tone, string> = {
  brand: 'bg-ws-tint text-ws-brand-ink',
  good: 'bg-ws-good-bg text-ws-good',
  warn: 'bg-ws-warn-bg text-ws-warn',
  bad: 'bg-ws-bad-bg text-ws-bad',
  info: 'bg-ws-info-bg text-ws-info',
  neutral: 'bg-ws-surface text-ws-muted-fg',
}

/** 纯前景色（火花线、柱、进度条用）。 */
export const TONE_FG: Record<Tone, string> = {
  brand: 'text-ws-brand',
  good: 'text-ws-good',
  warn: 'text-ws-warn',
  bad: 'text-ws-bad',
  info: 'text-ws-info',
  neutral: 'text-ws-muted-fg',
}
