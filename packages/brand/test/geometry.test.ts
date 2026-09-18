/**
 * 这份测试就是"代码里的副本有没有跟规范走样"的那道闸。
 *
 * 每一条断言的右边都是从
 * `Luoye/projects/AgentsWorkshop/00_Brand/品牌设计规范-v2.md`
 * 抄下来的数字，抄的是哪一节写在注释里。规范改了而这里没改，测试会红。
 */
import { describe, expect, it } from 'vitest'
import {
  ALL_BLOCKS,
  ASSEMBLE_DELAYS_MS,
  ASSEMBLE_LEAD_DELAY_MS,
  axisParam,
  BLOCK_RADIUS,
  BLOCK_SIZE,
  BLOCKS,
  BRAND_MARK_SVG_DARK,
  BRAND_MARK_SVG_LIGHT,
  BRAND_MARK_SVG_MONO,
  BREATHE_OPACITY,
  BREATHE_PERIOD_MS,
  BREATHE_PHASE_MS,
  BREATHE_SCALE,
  EASING,
  GRADIENT_AXIS,
  INK,
  LEAD,
  MARK_BOX,
  MIN_GRADIENT_PX,
  MONO_ON_DARK,
  MONO_ON_LIGHT,
  MOTION_GRADIENTS_ON_DARK,
  MOTION_GRADIENTS_ON_LIGHT,
  PAPER,
  SAFE_AREA,
  SPLIT_OFFSETS,
  SPLIT_STEP_MS,
  STOPS_ON_DARK,
  STOPS_ON_LIGHT,
  sampleStops,
  VIEW_BOX,
} from '../src/index.js'

describe('§1.1 几何真源', () => {
  it('六块的坐标与规范那张表逐行相等', () => {
    // | 块 | x | y |  1:14,44  2:38,52  3:38,28  4:62,60  5:62,36  领头:62,12
    expect(BLOCKS).toEqual([
      { x: 14, y: 44 },
      { x: 38, y: 52 },
      { x: 38, y: 28 },
      { x: 62, y: 60 },
      { x: 62, y: 36 },
    ])
    expect(LEAD).toEqual({ x: 62, y: 12 })
    expect(ALL_BLOCKS).toHaveLength(6)
  })

  it('方块 17×17、圆角 2.5', () => {
    expect(BLOCK_SIZE).toBe(17)
    expect(BLOCK_RADIUS).toBe(2.5)
  })

  it('三列 x = 14 / 38 / 62，列距行距都是 24', () => {
    expect([...new Set(ALL_BLOCKS.map((b) => b.x))].sort((a, b) => a - b)).toEqual([14, 38, 62])
    expect(38 - 14).toBe(24)
    expect(62 - 38).toBe(24)
    // 同一列里相邻两块的行距也是 24
    for (const x of [38, 62]) {
      const ys = ALL_BLOCKS.filter((b) => b.x === x)
        .map((b) => b.y)
        .sort((a, b) => a - b)
      for (let i = 1; i < ys.length; i += 1) expect((ys[i] ?? 0) - (ys[i - 1] ?? 0)).toBe(24)
    }
  })

  it('外框 65×65（x 14→79，y 12→77），viewBox 就是外框', () => {
    expect(MARK_BOX).toEqual({ x: 14, y: 12, width: 65, height: 65 })
    expect(Math.min(...ALL_BLOCKS.map((b) => b.x))).toBe(MARK_BOX.x)
    expect(Math.min(...ALL_BLOCKS.map((b) => b.y))).toBe(MARK_BOX.y)
    expect(Math.max(...ALL_BLOCKS.map((b) => b.x)) + BLOCK_SIZE).toBe(MARK_BOX.x + MARK_BOX.width)
    expect(Math.max(...ALL_BLOCKS.map((b) => b.y)) + BLOCK_SIZE).toBe(MARK_BOX.y + MARK_BOX.height)
    expect(VIEW_BOX).toBe('14 12 65 65')
  })

  it('§1.3 最小 28px；§1.4 安全区 = 一个方块宽', () => {
    expect(MIN_GRADIENT_PX).toBe(24)
    expect(SAFE_AREA).toBe(BLOCK_SIZE)
  })
})

describe('§1.2 整体渐变', () => {
  it('轴是对角 ↗：外框左下 → 右上', () => {
    expect(GRADIENT_AXIS).toEqual({ x1: 14, y1: 77, x2: 79, y2: 12 })
  })

  it('深底端点 / 浅底压暗端点 / 两个底色', () => {
    expect(STOPS_ON_DARK.map((s) => s.color)).toEqual(['#4EA8FF', '#2FE0C8', '#FFD84D'])
    expect(STOPS_ON_LIGHT.map((s) => s.color)).toEqual(['#2E86D8', '#1FB8A4', '#D9A82E'])
    expect(STOPS_ON_DARK.map((s) => s.offset)).toEqual([0, 0.52, 1])
    expect(INK).toBe('#1B1D22')
    expect(PAPER).toBe('#FBFAF8')
    expect(MONO_ON_DARK).toBe(PAPER)
    expect(MONO_ON_LIGHT).toBe(INK)
  })

  it('端点处取到的就是端点本身', () => {
    expect(sampleStops(0)).toBe('#4EA8FF')
    expect(sampleStops(0.52)).toBe('#2FE0C8')
    expect(sampleStops(1)).toBe('#FFD84D')
  })

  it('轴参数：左下角是 0、右上角是 1、轴外夹回 0–1', () => {
    expect(axisParam(14, 77)).toBeCloseTo(0, 6)
    expect(axisParam(79, 12)).toBeCloseTo(1, 6)
    expect(axisParam(-100, 200)).toBe(0)
    expect(axisParam(400, -400)).toBe(1)
  })

  it('静态 SVG 用的是 userSpaceOnUse 的一条渐变，六块共用（§1.2 / §1.5）', () => {
    for (const svg of [BRAND_MARK_SVG_DARK, BRAND_MARK_SVG_LIGHT]) {
      expect(svg).toContain('gradientUnits="userSpaceOnUse"')
      expect(svg).not.toContain('objectBoundingBox')
      // 一条渐变，六块引用它
      expect(svg.match(/<linearGradient/g) ?? []).toHaveLength(1)
      expect(svg.match(/<rect/g) ?? []).toHaveLength(6)
      expect(svg.match(/fill="url\(#/g) ?? []).toHaveLength(6)
      // 渐变坐标写的是局部坐标，和 rect 自己的 x/y 同一套数字（§4.1 坑 2）
      expect(svg).toContain('x1="14" y1="77" x2="79" y2="12"')
      expect(svg).toContain('viewBox="14 12 65 65"')
    }
    expect(BRAND_MARK_SVG_DARK).toContain('#FFD84D')
    expect(BRAND_MARK_SVG_LIGHT).toContain('#D9A82E')
  })

  it('单色版一条渐变都没有，全部 currentColor', () => {
    expect(BRAND_MARK_SVG_MONO).not.toContain('linearGradient')
    expect(BRAND_MARK_SVG_MONO.match(/fill="currentColor"/g) ?? []).toHaveLength(6)
  })

  it('§1.5 禁止项：不加描边 / 投影 / 发光、不旋转、不斜切', () => {
    for (const svg of [BRAND_MARK_SVG_DARK, BRAND_MARK_SVG_LIGHT, BRAND_MARK_SVG_MONO]) {
      expect(svg).not.toMatch(/stroke|filter|feGaussianBlur|rotate|skew|matrix/)
    }
  })
})

describe('§3.0 动效里每块自己那一段渐变', () => {
  it('六块的起止色与规范那张表逐格相等', () => {
    // | b1 (14,44) #47B5F2 → #37D1D6 | b2 (38,52) #3FC3E5 → #30DFC9 | …
    expect(MOTION_GRADIENTS_ON_DARK).toEqual([
      { from: '#47B5F2', to: '#37D1D6' },
      { from: '#3FC3E5', to: '#30DFC9' },
      { from: '#34D6D1', to: '#7ADD9C' },
      { from: '#38D0D8', to: '#5FDEAC' },
      { from: '#3EDFBF', to: '#AFDB7C' },
      { from: '#8EDC90', to: '#FFD84D' },
    ])
  })

  it('浅底那一套同一条推法，只换端点——六块各不相同，不是纯色', () => {
    expect(MOTION_GRADIENTS_ON_LIGHT).toHaveLength(6)
    for (const g of MOTION_GRADIENTS_ON_LIGHT) expect(g.from).not.toBe(g.to)
    expect(new Set(MOTION_GRADIENTS_ON_LIGHT.map((g) => g.from)).size).toBe(6)
    // 领头那块的止色就是压暗版的黄端点
    expect(MOTION_GRADIENTS_ON_LIGHT[5]?.to).toBe('#D9A82E')
  })
})

describe('§3.1 – §3.4 动效参数', () => {
  it('缓动三条', () => {
    expect(EASING.enter).toBe('cubic-bezier(.22, 1, .36, 1)')
    expect(EASING.lead).toBe('cubic-bezier(.34, 1.56, .64, 1)')
    expect(EASING.transition).toBe('cubic-bezier(.65, 0, .35, 1)')
  })

  it('集结：块延迟 0/100/160/240/300，领头 380', () => {
    expect(ASSEMBLE_DELAYS_MS).toEqual([0, 100, 160, 240, 300])
    expect(ASSEMBLE_LEAD_DELAY_MS).toBe(380)
    expect(ASSEMBLE_DELAYS_MS).toHaveLength(BLOCKS.length)
  })

  it('一变一队：分裂位移与规范那五行相等，且等于"领头减自己"', () => {
    expect(SPLIT_OFFSETS).toEqual([
      { dx: 48, dy: -32 },
      { dx: 24, dy: -40 },
      { dx: 24, dy: -16 },
      { dx: 0, dy: -48 },
      { dx: 0, dy: -24 },
    ])
    expect(SPLIT_STEP_MS).toBe(100)
  })

  it('呼吸：0.94↔1、0.55↔1、2.6s、相位差 46ms', () => {
    expect(BREATHE_SCALE).toEqual([0.94, 1])
    expect(BREATHE_OPACITY).toEqual([0.55, 1])
    expect(BREATHE_PERIOD_MS).toBe(2600)
    expect(BREATHE_PHASE_MS).toBe(46)
  })
})
