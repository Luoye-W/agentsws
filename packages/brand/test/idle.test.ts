/**
 * WP195：待机姿态的参数守不守那四条规矩（周期长、幅度小、只动 transform、和呼吸分得开），
 * 以及给云端后台 / 官网 / favicon 用的那张「自己会动」的 SVG 长得对不对。
 */
import { describe, expect, it } from 'vitest'
import {
  ALL_BLOCKS,
  BLOCK_SIZE,
  BLOCKS,
  BRAND_MARK_SVG_IDLE_DARK,
  BRAND_MARK_SVG_IDLE_LIGHT,
  BREATHE_PERIOD_MS,
  DEFAULT_IDLE_STYLE,
  IDLE_BLINK,
  IDLE_SHEEN,
  IDLE_STYLES,
  IDLE_WAVE,
  IDLE_WAVE_DELAYS_MS,
  idleCss,
  idlePercent,
  markSvg,
  SPLIT_BLOCK_DURATION_MS,
  SPLIT_FIRST_DELAY_MS,
  SPLIT_STEP_MS,
  SPLIT_TOTAL_MS,
} from '../src/index.js'

const GAP = 24 - BLOCK_SIZE

describe('待机：四条规矩', () => {
  it('三个候选，默认那个在里面', () => {
    expect(IDLE_STYLES).toEqual(['wave', 'sheen', 'blink'])
    expect(IDLE_STYLES).toContain(DEFAULT_IDLE_STYLE)
  })

  it('一轮都 ≥ 6 秒，且比呼吸那 2.6s 长得多（不会被看成「Agent 在干活」）', () => {
    for (const period of [IDLE_WAVE.periodMs, IDLE_SHEEN.periodMs, IDLE_BLINK.periodMs]) {
      expect(period).toBeGreaterThanOrEqual(6000)
      expect(period).toBeGreaterThan(BREATHE_PERIOD_MS * 2)
    }
  })

  it('动的那一下不到一轮的五分之一：大部分时间一动不动', () => {
    const wave = IDLE_WAVE.riseMs + IDLE_WAVE.fallMs + IDLE_WAVE.spreadMs
    expect(wave / IDLE_WAVE.periodMs).toBeLessThan(0.2)
    expect(IDLE_SHEEN.sweepMs / IDLE_SHEEN.periodMs).toBeLessThan(0.2)
    expect((IDLE_BLINK.outMs + IDLE_BLINK.backMs) / IDLE_BLINK.periodMs).toBeLessThan(0.2)
  })

  it('幅度小：位移都不超过方块间缝（7）', () => {
    expect(IDLE_WAVE.lift).toBeLessThanOrEqual(GAP)
    expect(Math.hypot(IDLE_BLINK.dx, IDLE_BLINK.dy)).toBeLessThanOrEqual(GAP)
    expect(IDLE_SHEEN.peakOpacity).toBeLessThanOrEqual(0.6)
  })

  it('三段 keyframes 只写 transform（颜色、渐变、布局一概不动）', () => {
    for (const style of IDLE_STYLES) {
      const css = idleCss(style, 'x')
      const frames = css.slice(css.indexOf('@keyframes'), css.indexOf('@media'))
      const props = [...frames.matchAll(/([a-z-]+):/g)].map((m) => m[1])
      expect(new Set(props)).toEqual(new Set(['transform']))
      expect(css).toContain('transform-box:fill-box')
      expect(css).toContain('prefers-reduced-motion: reduce')
    }
  })
})

describe('波：沿渐变方向走', () => {
  it('六块一个延迟；左下那块 0，领头最后', () => {
    expect(IDLE_WAVE_DELAYS_MS).toHaveLength(ALL_BLOCKS.length)
    expect(Math.min(...IDLE_WAVE_DELAYS_MS)).toBe(0)
    expect(IDLE_WAVE_DELAYS_MS[BLOCKS.length]).toBe(IDLE_WAVE.spreadMs)
    expect(IDLE_WAVE_DELAYS_MS[0]).toBe(0)
  })

  it('越靠右上越晚（中心 x − y 越大越晚）', () => {
    const order = ALL_BLOCKS.map((b, i) => ({ k: b.x - b.y, d: IDLE_WAVE_DELAYS_MS[i] ?? 0 }))
    const sorted = [...order].sort((a, b) => a.k - b.k)
    for (let i = 1; i < sorted.length; i += 1) {
      expect(sorted[i]?.d ?? 0).toBeGreaterThanOrEqual(sorted[i - 1]?.d ?? 0)
    }
  })

  it('keyframes 的百分比就是毫秒换算出来的', () => {
    expect(idlePercent(IDLE_WAVE.riseMs, IDLE_WAVE.periodMs)).toBe('5%')
    expect(idleCss('wave', 'x')).toContain(`translateY(-${IDLE_WAVE.lift}px)`)
  })
})

describe('一变一队整段时长', () => {
  it('= 最后一块起步 + 它自己那一段', () => {
    expect(SPLIT_TOTAL_MS).toBe(
      SPLIT_FIRST_DELAY_MS + (BLOCKS.length - 1) * SPLIT_STEP_MS + SPLIT_BLOCK_DURATION_MS,
    )
  })
})

describe('自己会动的 SVG（云端后台、官网、favicon 用）', () => {
  it('波：六块都挂类、每块自己一条渐变（§3.0），样式内联', () => {
    const svg = BRAND_MARK_SVG_IDLE_DARK
    expect(svg).toContain('<style>')
    expect(svg.match(/<rect [^>]*class="aw-idle-dark-idle"/g)).toHaveLength(6)
    expect(svg).not.toContain('userSpaceOnUse')
    expect(svg.match(/<linearGradient /g)).toHaveLength(6)
    expect(BRAND_MARK_SVG_IDLE_LIGHT).toContain('aw-idle-light-idle')
  })

  it('眨眼：只有领头那一块挂类', () => {
    const svg = markSvg({ idle: 'blink', id: 'k' })
    expect(svg.match(/class="k-idle"/g)).toHaveLength(1)
    expect(svg).toContain(
      '<rect x="62" y="12" width="17" height="17" rx="2.5" fill="url(#k-b5)" class="k-idle"/>',
    )
  })

  it('流光：方块不动，所以还是一条 userSpaceOnUse；亮带被六块裁出来', () => {
    const svg = markSvg({ idle: 'sheen', id: 's' })
    expect(svg.match(/userSpaceOnUse/g)).toHaveLength(1)
    expect(svg).toContain('<clipPath id="s-clip">')
    expect(svg).toContain('clip-path="url(#s-clip)"')
    expect(svg.match(/class="s-idle"/g)).toHaveLength(1)
  })

  it('不带外链、不带脚本', () => {
    for (const style of IDLE_STYLES) {
      const svg = markSvg({ idle: style, id: style })
      expect(svg).not.toMatch(/<script|href="http|@import/)
    }
  })
})
