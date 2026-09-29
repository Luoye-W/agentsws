/**
 * WP200：① 浅底上那道光调淡（深底原样）；② README 顶上那张改成会动的独立 SVG。
 */
import { describe, expect, it } from 'vitest'
import {
  BRAND_MARK_SVG_IDLE_DARK,
  BRAND_MARK_SVG_IDLE_LIGHT,
  BRAND_MARK_SVG_README_DARK,
  BRAND_MARK_SVG_README_LIGHT,
  IDLE_BLINK,
  IDLE_SHEEN,
  IDLE_WAVE,
  IDLE_WAVE_SHEEN,
  markSvg,
  README_MARK_PAD,
  SHEEN_ON_DARK,
  SHEEN_ON_LIGHT,
  STOPS_ON_DARK,
  STOPS_ON_LIGHT,
} from '../src/index.js'

/** 亮带那条渐变中间那个 stop（最亮处）的颜色与不透明度。 */
function peakStop(svg: string, id: string): { color: string; opacity: number } {
  const g = svg.match(new RegExp(`<linearGradient id="${id}-sheen"[^>]*>(.*?)</linearGradient>`))
  const mid = g?.[1]?.match(/<stop offset="50%" stop-color="([^"]+)" stop-opacity="([^"]+)"\/>/)
  if (mid === null || mid === undefined) throw new Error(`没找到 ${id} 的亮带`)
  return { color: mid[1] as string, opacity: Number(mid[2]) }
}

describe('浅底那道光调淡，深底不变', () => {
  it('深底：纯白、力度 1，最亮处仍是 WP195 的 0.42', () => {
    expect(SHEEN_ON_DARK).toEqual({ color: '#FFFFFF', strength: 1 })
    expect(peakStop(BRAND_MARK_SVG_IDLE_DARK, 'aw-idle-dark')).toEqual({
      color: '#fff',
      opacity: IDLE_WAVE_SHEEN.peakOpacity,
    })
  })

  it('浅底：换成极淡的品牌青，最亮处 = 0.42 × 力度，且不再是纯白', () => {
    const p = peakStop(BRAND_MARK_SVG_IDLE_LIGHT, 'aw-idle-light')
    expect(p.color).toBe(SHEEN_ON_LIGHT.color)
    expect(p.opacity).toBeCloseTo(IDLE_WAVE_SHEEN.peakOpacity * SHEEN_ON_LIGHT.strength, 3)
    expect(BRAND_MARK_SVG_IDLE_LIGHT).not.toContain('stop-color="#fff"')
  })

  it('浅底的力度在一半上下：看得见（≥ 0.4），又明显比深底淡（≤ 0.7）', () => {
    expect(SHEEN_ON_LIGHT.strength).toBeGreaterThanOrEqual(0.4)
    expect(SHEEN_ON_LIGHT.strength).toBeLessThanOrEqual(0.7)
  })

  it('浅底那道光是很淡的颜色（每个通道 ≥ 0xD0）：是光，不是往块上刷一层别的色', () => {
    const c = SHEEN_ON_LIGHT.color
    for (const at of [1, 3, 5])
      expect(Number.parseInt(c.slice(at, at + 2), 16)).toBeGreaterThanOrEqual(0xd0)
  })

  it('不给 sheen 时按底色挑；给了就听给的', () => {
    const light = markSvg({ idle: 'sheen', stops: STOPS_ON_LIGHT, id: 'l' })
    expect(peakStop(light, 'l').opacity).toBeCloseTo(
      IDLE_SHEEN.peakOpacity * SHEEN_ON_LIGHT.strength,
      3,
    )
    const dark = markSvg({ idle: 'sheen', stops: STOPS_ON_DARK, id: 'd' })
    expect(peakStop(dark, 'd')).toEqual({ color: '#fff', opacity: IDLE_SHEEN.peakOpacity })
    const forced = markSvg({
      idle: 'wave-sheen',
      stops: STOPS_ON_LIGHT,
      id: 'f',
      sheen: SHEEN_ON_DARK,
    })
    expect(peakStop(forced, 'f')).toEqual({ color: '#fff', opacity: IDLE_WAVE_SHEEN.peakOpacity })
  })
})

describe('README 顶上那张会动的', () => {
  const both = [
    ['dark', BRAND_MARK_SVG_README_DARK],
    ['light', BRAND_MARK_SVG_README_LIGHT],
  ] as const

  it.each(both)('%s：自带 keyframes、不带脚本和外链，「减少动态效果」时停', (_, svg) => {
    expect(svg).toContain('@keyframes')
    expect(svg).toContain('@media (prefers-reduced-motion: reduce)')
    expect(svg).not.toMatch(/<script|href=|xlink:|@import|url\((?!#)/)
  })

  it('四周放宽 README_MARK_PAD 个单位：<img> 里抬起 / 探出的那块不被裁', () => {
    const p = README_MARK_PAD
    for (const [, svg] of both)
      expect(svg).toContain(`viewBox="${14 - p} ${12 - p} ${65 + 2 * p} ${65 + 2 * p}"`)
    expect(IDLE_WAVE_SHEEN.lift).toBeLessThanOrEqual(p)
    expect(IDLE_WAVE.lift).toBeLessThanOrEqual(p)
    expect(Math.max(Math.abs(IDLE_BLINK.dx), Math.abs(IDLE_BLINK.dy))).toBeLessThanOrEqual(p)
  })

  it('浅色那张用浅底那道淡光，深色那张用纯白', () => {
    expect(peakStop(BRAND_MARK_SVG_README_LIGHT, 'aw-readme-light').color).toBe(
      SHEEN_ON_LIGHT.color,
    )
    expect(peakStop(BRAND_MARK_SVG_README_DARK, 'aw-readme-dark').color).toBe('#fff')
  })

  it('不给 pad 时 viewBox 仍是外框本身（已有那几张一个字节不变）', () => {
    expect(BRAND_MARK_SVG_IDLE_DARK).toContain('viewBox="14 12 65 65"')
  })
})
