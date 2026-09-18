/**
 * 母品牌「出海 Agents 工坊」的六块标记 + 产品色。
 *
 * 三条规矩（Luoye 2026-09-18 定）：
 *
 * 1. **内联，不引外链**。云侧这几个页面（首页 / 登录落地页 / 登录信）要在
 *    没有 CDN、没有静态资源目录、甚至邮件客户端离线的情况下也长得对。
 * 2. **标记本身不改**：六块的位置、圆角、渐变方向都是母品牌的，
 *    不加描边 / 投影 / 发光，不旋转，不换色。
 * 3. **渐变只出现在标记上**；页面主色仍是产品绿 `#007B67`。
 *    深色圆底上用；浅底要用就先放进 `#1B1D22` 的圆底里（{@link brandMark}
 *    的 `disc` 就是干这件事的）。
 *
 * 几何与颜色的真源是 `@agentsws/brand`（WP112）；这里只负责把它拼成能内联进页面 / 邮件的字符串。
 */
import {
  ALL_BLOCKS,
  BLOCK_RADIUS,
  BLOCK_SIZE,
  GRADIENT_AXIS,
  INK,
  STOPS_ON_DARK,
  VIEW_BOX,
} from '@agentsws/brand'

/** 产品绿。页面上除了标记之外的所有强调色都用它。 */
export const BRAND_GREEN = '#007B67'

/** 标记的底色（浅色页面上给它垫一个圆底）。 */
export const BRAND_DISC = INK

/** 六块标记本体。`id` 参数是给渐变用的——同一页出现两次就得有两个不同的 id。 */
export function brandMark(options: { size?: number; id?: string } = {}): string {
  const size = options.size ?? 40
  const id = options.id ?? 'aw'
  const stops = STOPS_ON_DARK.map(
    (stop) => `<stop offset="${String(stop.offset)}" stop-color="${stop.color}"/>`,
  ).join('')
  const rects = [...ALL_BLOCKS]
    .sort((p, q) => p.x - q.x || q.y - p.y)
    .map(
      (block) =>
        `<rect x="${String(block.x)}" y="${String(block.y)}" width="${String(BLOCK_SIZE)}" height="${String(BLOCK_SIZE)}" rx="${String(BLOCK_RADIUS)}" fill="url(#${id})"/>`,
    )
    .join('')
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${VIEW_BOX}" width="${String(size)}" height="${String(size)}" role="img" aria-label="Agents 工坊">`,
    `<defs><linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${String(GRADIENT_AXIS.x1)}" y1="${String(GRADIENT_AXIS.y1)}" x2="${String(GRADIENT_AXIS.x2)}" y2="${String(GRADIENT_AXIS.y2)}">`,
    stops,
    '</linearGradient></defs>',
    rects,
    '</svg>',
  ].join('')
}

/**
 * 标记 + 深色圆底。浅色页面与邮件页头用这一个。
 *
 * 邮件里不能靠 CSS 变量与外部样式表，所以内联 style 是有意的。
 */
export function brandDisc(options: { size?: number; id?: string } = {}): string {
  const size = options.size ?? 56
  const inner = Math.round(size * 0.68)
  return [
    `<span style="display:inline-flex;align-items:center;justify-content:center;width:${String(size)}px;height:${String(size)}px;border-radius:${String(Math.round(size / 2))}px;background:${BRAND_DISC};">`,
    brandMark({ size: inner, ...(options.id === undefined ? {} : { id: options.id }) }),
    '</span>',
  ].join('')
}
