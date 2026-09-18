/**
 * 标记的 SVG 字符串（静态资产那一档）。
 *
 * 静态一律**一条 `userSpaceOnUse` 渐变铺满整个标记，方块把它切开**（规范 §1.2）。
 * 用默认的 `objectBoundingBox` 的话每块内部都会跑一遍完整渐变，六块长得一模一样——
 * 那是错的。动效才是"每块自己一条渐变"（§3.0），那一档在工作台的
 * `components/design/brand-mark.tsx` 里。
 *
 * 渐变坐标写的是**局部坐标**（14/77 → 79/12），与 rect 自己的 x/y 同一套数字。
 * `userSpaceOnUse` 取的是引用它的元素当时所在的用户空间，换算成画布绝对坐标会让
 * 渐变起止点落到方块范围之外，六块只能各自取到几乎同一个点，整体看起来就是纯色
 * （规范 §4.1 坑 2，`avatar-dark.svg` 2026-08-26 修过的那个）。
 */
import {
  ALL_BLOCKS,
  BLOCK_RADIUS,
  BLOCK_SIZE,
  GRADIENT_AXIS,
  STOPS_ON_DARK,
  STOPS_ON_LIGHT,
  type Stop,
  VIEW_BOX,
} from './geometry.js'

function rects(fill: string): string {
  return ALL_BLOCKS.map(
    (b) =>
      `<rect x="${b.x}" y="${b.y}" width="${BLOCK_SIZE}" height="${BLOCK_SIZE}" rx="${BLOCK_RADIUS}" fill="${fill}"/>`,
  ).join('')
}

function gradient(id: string, stops: readonly Stop[]): string {
  const body = stops
    .map((s) => `<stop offset="${s.offset * 100}%" stop-color="${s.color}"/>`)
    .join('')
  return `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${GRADIENT_AXIS.x1}" y1="${GRADIENT_AXIS.y1}" x2="${GRADIENT_AXIS.x2}" y2="${GRADIENT_AXIS.y2}">${body}</linearGradient>`
}

/**
 * 出一张标记 SVG。
 *
 * @param id 渐变的 id。同一个页面里塞两张就得给不同的 id，否则后一张会引用前一张的。
 */
export function markSvg(
  options: {
    stops?: readonly Stop[]
    /** 给了就是单色（印刷、灰度、favicon 的小尺寸、刻蚀），渐变那一段整个不出。 */
    solid?: string
    id?: string
  } = {},
): string {
  const id = options.id ?? 'aw-mark'
  const head = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${VIEW_BOX}" fill="none">`
  if (options.solid !== undefined) return `${head}${rects(options.solid)}</svg>`
  const stops = options.stops ?? STOPS_ON_DARK
  return `${head}<defs>${gradient(id, stops)}</defs>${rects(`url(#${id})`)}</svg>`
}

/** 深底上用的标记：那套亮端点（`#4EA8FF → #2FE0C8 → #FFD84D`）。 */
export const BRAND_MARK_SVG_DARK = markSvg({ stops: STOPS_ON_DARK, id: 'aw-mark-dark' })

/** 浅底上用的标记：压暗端点，否则黄那一头在纸白上几乎消失（§1.2「浅底的坑」）。 */
export const BRAND_MARK_SVG_LIGHT = markSvg({ stops: STOPS_ON_LIGHT, id: 'aw-mark-light' })

/**
 * 单色标记：`currentColor`，颜色由用它的地方说了算。
 *
 * 小于 28px、印刷单色、灰度显示、刻蚀一律用它——再小方块间的缝会并起来，
 * 渐变只剩一团糊（§1.3）。深底该取 `MONO_ON_DARK`，浅底取 `MONO_ON_LIGHT`。
 */
export const BRAND_MARK_SVG_MONO = markSvg({ solid: 'currentColor' })
