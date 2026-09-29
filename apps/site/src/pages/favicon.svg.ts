import { markSvg, STOPS_ON_DARK, STOPS_ON_LIGHT } from '@agentsws/brand'

/**
 * favicon：品牌标记（`@agentsws/brand` 的静态那一档）。浏览器标签栏是浅色就用压暗端点，
 * 深色就换亮端点——两套渐变都放进去，用 SVG 自己的 prefers-color-scheme 切。
 */
export function GET(): Response {
  const light = markSvg({ stops: STOPS_ON_LIGHT, id: 'fl' })
  const dark = markSvg({ stops: STOPS_ON_DARK, id: 'fd' })
  const inner = (s: string) => s.replace(/^<svg[^>]*>/u, '').replace(/<\/svg>$/u, '')
  const vb = /viewBox="([^"]+)"/u.exec(light)?.[1] ?? '14 12 65 65'
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" fill="none"><style>.d{display:none}@media (prefers-color-scheme:dark){.l{display:none}.d{display:inline}}</style><g class="l">${inner(light)}</g><g class="d">${inner(dark)}</g></svg>`
  return new Response(svg, { headers: { 'content-type': 'image/svg+xml' } })
}
