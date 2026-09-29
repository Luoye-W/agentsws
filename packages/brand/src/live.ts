/**
 * WP197：给**拿不到工作台 `BrandMark` 组件**的页面（官网、将来的云端网页）用的「活」标记。
 *
 * 一张标记同时挂三种姿态，参数全从 `geometry.ts` 取、一个数不另写：
 *
 * - **集结**（§3.2）：进场播一次，五块依次到位、领头 380ms 落下回弹；
 * - **一变一队**（§3.3）：领头先出现，其余五块从它的位置分出去（悬停、滚到眼前各播一次）；
 * - **呼吸**（§3.4）：一直起伏（= Agent 正在替你干活）；
 * - **待机**（WP195）：直接用 `markSvg({ idle })` 出的那一张——波 + 流光的数字与工作台、
 *   云端后台是同一份，将来改了（如 WP200 调浅色流光）这里自动跟上。
 *
 * 做法：待机那一层挂在每块外面的 `<g>` 上，进场 / 一变一队挂在块本身（`<rect>`）上，
 * 两层各动各的；待机 1.6s 后才动第一下，集结 1.5s 已经播完，所以不打架。
 * 姿态由 SVG 根上的类名切（`aw-assemble` / `aw-split` / `aw-breathe`），keyframes 在
 * {@link liveMarkCss} 里，一页只要一份。系统开了「减少动态效果」一律静态。
 *
 * keyframes 的形状（位移、缩放、各帧百分比）与工作台 `index.css` 的 `ws-bm-*` 同一套数字。
 */
import {
  ALL_BLOCKS,
  ASSEMBLE_DELAYS_MS,
  ASSEMBLE_LEAD_DELAY_MS,
  BLOCK_RADIUS,
  BLOCK_SIZE,
  BREATHE_OPACITY,
  BREATHE_PERIOD_MS,
  BREATHE_PHASE_MS,
  BREATHE_SCALE,
  blockGradient,
  EASING,
  type IdleStyle,
  LEAD,
  SPLIT_BLOCK_DURATION_MS,
  SPLIT_FIRST_DELAY_MS,
  SPLIT_LEAD_DURATION_MS,
  SPLIT_OFFSETS,
  SPLIT_STEP_MS,
  STOPS_ON_DARK,
  type Stop,
  VIEW_BOX,
} from './geometry.js'
import { markSvg } from './svg.js'

/** 块上的类名（进场 / 一变一队 / 呼吸都挂在它上面）。 */
export const LIVE_BLOCK_CLASS = 'aw-b'
/** 领头那块多挂的类名。 */
export const LIVE_LEAD_CLASS = 'aw-lead'
/** SVG 根上切姿态的类名。 */
export const LIVE_POSES = {
  assemble: 'aw-assemble',
  split: 'aw-split',
  breathe: 'aw-breathe',
  paused: 'aw-paused',
} as const

/** 集结整段多久播完：最后一块（或领头）落定的那一刻。 */
export const ASSEMBLE_TOTAL_MS = Math.max(
  ...ASSEMBLE_DELAYS_MS.map((d) => d + 1200),
  ASSEMBLE_LEAD_DELAY_MS + 900,
)

export interface LiveMarkOptions {
  /** 渐变与裁切的 id 前缀；同一页里每张都要不一样。 */
  id: string
  stops?: readonly Stop[]
  /** 给了就在外层挂待机（`markSvg({ idle })` 那一套）；不给就只有块本身。 */
  idle?: IdleStyle
  /** 起始姿态（根上的类名）；不给就是静止的六块（等脚本或滚动再挂）。 */
  pose?: keyof typeof LIVE_POSES
  /** 只画领头那一块（「为什么」第 3 级：单个 Agent 在呼吸）。 */
  leadOnly?: boolean
  /** 根上额外的类名。 */
  className?: string
  /** 无障碍：给了就是 `role="img"` + `aria-label`，不给就 `aria-hidden`。 */
  label?: string
  width?: number
  height?: number
}

function blockVars(i: number): string {
  const isLead = i === ALL_BLOCKS.length - 1
  const assemble = isLead ? ASSEMBLE_LEAD_DELAY_MS : (ASSEMBLE_DELAYS_MS[i] ?? 0)
  const off = isLead ? { dx: 0, dy: 0 } : (SPLIT_OFFSETS[i] ?? { dx: 0, dy: 0 })
  return `--aw-d:${assemble}ms;--aw-i:${i};--aw-dx:${off.dx}px;--aw-dy:${off.dy}px;--aw-p:-${i * BREATHE_PHASE_MS}ms`
}

function blockClass(i: number): string {
  return i === ALL_BLOCKS.length - 1 ? `${LIVE_BLOCK_CLASS} ${LIVE_LEAD_CLASS}` : LIVE_BLOCK_CLASS
}

function rootAttrs(o: LiveMarkOptions, viewBox: string): string {
  const cls = ['aw-mark', o.pose !== undefined ? LIVE_POSES[o.pose] : '', o.className ?? '']
    .filter((c) => c !== '')
    .join(' ')
  const size =
    (o.width !== undefined ? ` width="${o.width}"` : '') +
    (o.height !== undefined ? ` height="${o.height}"` : '')
  const a11y = o.label !== undefined ? ` role="img" aria-label="${o.label}"` : ' aria-hidden="true"'
  return `xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" class="${cls}"${size}${a11y} fill="none" overflow="visible"`
}

/**
 * 出一张「活」标记的 SVG 字符串（内联进页面用；待机的 `<style>` 在 SVG 里自带）。
 */
export function liveMarkSvg(o: LiveMarkOptions): string {
  const stops = o.stops ?? STOPS_ON_DARK
  if (o.leadOnly === true) {
    const g = blockGradient(LEAD, stops)
    const viewBox = `${LEAD.x} ${LEAD.y} ${BLOCK_SIZE} ${BLOCK_SIZE}`
    const grad = `<linearGradient id="${o.id}-b5" x1="0" y1="1" x2="1" y2="0"><stop offset="0%" stop-color="${g.from}"/><stop offset="100%" stop-color="${g.to}"/></linearGradient>`
    return `<svg ${rootAttrs(o, viewBox)}><defs>${grad}</defs><rect class="${blockClass(5)}" style="${blockVars(5)}" x="${LEAD.x}" y="${LEAD.y}" width="${BLOCK_SIZE}" height="${BLOCK_SIZE}" rx="${BLOCK_RADIUS}" fill="url(#${o.id}-b5)"/></svg>`
  }
  if (o.idle !== undefined) {
    // 待机那一张原样拿来，只在六块上补类名与变量——波 + 流光的数字一个不经手
    const base = markSvg({ stops, id: o.id, idle: o.idle })
    let body = base.replace(/^<svg[^>]*>/u, '').replace(/<\/svg>$/u, '')
    ALL_BLOCKS.forEach((_, i) => {
      const fill = `fill="url(#${o.id}-b${i})"`
      body = body.replace(
        `<rect x="${ALL_BLOCKS[i]?.x}" y="${ALL_BLOCKS[i]?.y}" width="${BLOCK_SIZE}" height="${BLOCK_SIZE}" rx="${BLOCK_RADIUS}" ${fill}/>`,
        `<rect class="${blockClass(i)}" style="${blockVars(i)}" x="${ALL_BLOCKS[i]?.x}" y="${ALL_BLOCKS[i]?.y}" width="${BLOCK_SIZE}" height="${BLOCK_SIZE}" rx="${BLOCK_RADIUS}" ${fill}/>`,
      )
    })
    return `<svg ${rootAttrs(o, VIEW_BOX)}>${body}</svg>`
  }
  const grads = ALL_BLOCKS.map((b, i) => {
    const g = blockGradient(b, stops)
    return `<linearGradient id="${o.id}-b${i}" x1="0" y1="1" x2="1" y2="0"><stop offset="0%" stop-color="${g.from}"/><stop offset="100%" stop-color="${g.to}"/></linearGradient>`
  }).join('')
  const rects = ALL_BLOCKS.map(
    (b, i) =>
      `<rect class="${blockClass(i)}" style="${blockVars(i)}" x="${b.x}" y="${b.y}" width="${BLOCK_SIZE}" height="${BLOCK_SIZE}" rx="${BLOCK_RADIUS}" fill="url(#${o.id}-b${i})"/>`,
  ).join('')
  return `<svg ${rootAttrs(o, VIEW_BOX)}><defs>${grads}</defs>${rects}</svg>`
}

const pct = (n: number): string => `${n}%`

/**
 * 「活」标记的 CSS（一页一份）：集结、一变一队、呼吸三种姿态 + 页面藏起来时停 + 减少动效时静态。
 *
 * 帧的形状照工作台 `index.css` 的 `ws-bm-assemble(-lead)` / `ws-bm-split(-lead)` / `ws-bm-breathe`；
 * 时长、延迟、缓动全从 `geometry.ts` 来。
 */
export function liveMarkCss(): string {
  const b = `.aw-mark .${LIVE_BLOCK_CLASS}`
  const lead = `.${LIVE_LEAD_CLASS}`
  const { assemble, split, breathe, paused } = LIVE_POSES
  return [
    `.aw-mark{overflow:visible}`,
    `${b}{transform-box:fill-box;transform-origin:center}`,
    // 集结（§3.2）
    `.${assemble} .${LIVE_BLOCK_CLASS}{opacity:0;animation:aw-assemble 1.2s ${EASING.enter} var(--aw-d) forwards}`,
    `.${assemble} ${lead}{animation:aw-assemble-lead .9s ${EASING.lead} ${ASSEMBLE_LEAD_DELAY_MS}ms forwards}`,
    `@keyframes aw-assemble{0%{opacity:0;transform:translateY(12px) scale(.72)}${pct(58)}{opacity:1;transform:translateY(0) scale(1.06)}100%{opacity:1;transform:translateY(0) scale(1)}}`,
    `@keyframes aw-assemble-lead{0%{opacity:0;transform:translateY(16px) scale(.5)}${pct(60)}{opacity:1;transform:translateY(-3px) scale(1.22)}100%{opacity:1;transform:translateY(0) scale(1)}}`,
    // 一变一队（§3.3）
    `.${split} .${LIVE_BLOCK_CLASS}{opacity:0;animation:aw-split ${SPLIT_BLOCK_DURATION_MS}ms ${EASING.enter} calc(${SPLIT_FIRST_DELAY_MS}ms + var(--aw-i) * ${SPLIT_STEP_MS}ms) forwards}`,
    `.${split} ${lead}{animation:aw-split-lead ${SPLIT_LEAD_DURATION_MS}ms ${EASING.lead} forwards}`,
    `@keyframes aw-split-lead{0%{opacity:0;transform:scale(0)}${pct(60)}{opacity:1;transform:scale(1.18)}100%{opacity:1;transform:scale(1)}}`,
    `@keyframes aw-split{0%{opacity:0;transform:translate(var(--aw-dx),var(--aw-dy)) scale(.3)}100%{opacity:1;transform:translate(0,0) scale(1)}}`,
    // 呼吸（§3.4）：负延迟 = 一出现就错开相位
    `.${breathe} .${LIVE_BLOCK_CLASS}{opacity:${BREATHE_OPACITY[0]};animation:aw-breathe ${BREATHE_PERIOD_MS}ms ease-in-out var(--aw-p) infinite}`,
    `@keyframes aw-breathe{0%,100%{opacity:${BREATHE_OPACITY[0]};transform:scale(${BREATHE_SCALE[0]})}50%{opacity:${BREATHE_OPACITY[1]};transform:scale(${BREATHE_SCALE[1]})}}`,
    // 页面不在前台就停（挂在根上或任一祖先上都行）
    `.${paused} .aw-mark *,.aw-mark.${paused} *{animation-play-state:paused!important}`,
    // 系统开了「减少动态效果」：一律静态（待机那层由 SVG 自带的 media query 停）
    `@media (prefers-reduced-motion:reduce){${b}{animation:none!important;opacity:1!important;transform:none!important}}`,
  ].join('')
}
