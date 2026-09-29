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
  IDLE_WAVE_SHEEN,
  IDLE_WAVE_SHEEN_DELAYS_MS,
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
  it('四个候选（波 + 流光排最前），默认那个在里面', () => {
    expect(IDLE_STYLES).toEqual(['wave-sheen', 'wave', 'sheen', 'blink'])
    expect(DEFAULT_IDLE_STYLE).toBe('wave-sheen')
  })

  it('一轮都 ≥ 6 秒，且比呼吸那 2.6s 长得多（不会被看成「Agent 在干活」）', () => {
    for (const period of [
      IDLE_WAVE_SHEEN.periodMs,
      IDLE_WAVE.periodMs,
      IDLE_SHEEN.periodMs,
      IDLE_BLINK.periodMs,
    ]) {
      expect(period).toBeGreaterThanOrEqual(6000)
      expect(period).toBeGreaterThan(BREATHE_PERIOD_MS * 2)
    }
  })

  it('动的那一下不到一轮的五分之一：大部分时间一动不动', () => {
    const wave = IDLE_WAVE.riseMs + IDLE_WAVE.fallMs + IDLE_WAVE.spreadMs
    expect(wave / IDLE_WAVE.periodMs).toBeLessThan(0.2)
    expect(IDLE_SHEEN.sweepMs / IDLE_SHEEN.periodMs).toBeLessThan(0.2)
    expect((IDLE_BLINK.outMs + IDLE_BLINK.backMs) / IDLE_BLINK.periodMs).toBeLessThan(0.2)
    // 波 + 流光：光扫 2s（其间各块轮流抬一下），一轮里四分之三的时间一动不动
    expect(IDLE_WAVE_SHEEN.sweepMs / IDLE_WAVE_SHEEN.periodMs).toBeLessThanOrEqual(0.25)
  })

  it('幅度小：位移都不超过方块间缝（7）', () => {
    expect(IDLE_WAVE.lift).toBeLessThanOrEqual(GAP)
    expect(Math.hypot(IDLE_BLINK.dx, IDLE_BLINK.dy)).toBeLessThanOrEqual(GAP)
    expect(IDLE_WAVE_SHEEN.lift).toBeLessThanOrEqual(GAP)
    expect(IDLE_WAVE_SHEEN.peakOpacity).toBeLessThanOrEqual(0.5)
    expect(IDLE_SHEEN.peakOpacity).toBeLessThanOrEqual(0.6)
  })

  it('三段 keyframes 只写 transform（颜色、渐变、布局一概不动）', () => {
    for (const style of IDLE_STYLES) {
      const css = idleCss(style, 'x')
      // 抠出每一段 @keyframes（波 + 流光有两段）
      const frames = [...css.matchAll(/@keyframes [\w-]+\{((?:[^{}]*\{[^{}]*\})*)\}/g)]
        .map((m) => m[1])
        .join('')
      expect(frames.length).toBeGreaterThan(0)
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

describe('波 + 流光：同一道光带着方块起伏', () => {
  it('每块抬到最高的那一刻，亮带中心正好经过它的中心', () => {
    const w = IDLE_WAVE_SHEEN
    ALL_BLOCKS.forEach((blk, i) => {
      const peak = (IDLE_WAVE_SHEEN_DELAYS_MS[i] ?? 0) + w.riseMs
      // 亮带中心在渐变轴上的位置（匀速）
      const u = 0.5 - w.travel + (2 * w.travel * peak) / w.sweepMs
      const cx = blk.x + BLOCK_SIZE / 2
      const cy = blk.y + BLOCK_SIZE / 2
      const tb = (cx - 14 - (cy - 77)) / 130
      expect(Math.abs(u - tb)).toBeLessThan(0.005)
    })
  })

  it('亮带是匀速的（linear）——否则上面那条对不上', () => {
    expect(idleCss('wave-sheen', 'x')).toMatch(/\.x-band\{[^}]*linear/)
  })

  it('SVG：每块一个会抬起的 <g>，里面是块 + 被它自己裁出来的那份亮带', () => {
    const svg = markSvg({ idle: 'wave-sheen', id: 'w' })
    expect(svg.match(/<g class="w-idle"/g)).toHaveLength(6)
    expect(svg.match(/class="w-idle-band"/g)).toHaveLength(6)
    expect(svg.match(/<clipPath id="w-c\d"/g)).toHaveLength(6)
    // 块是每块自己一条渐变；唯一的 userSpaceOnUse 是亮带那一条（WP200：不在矩形边上被切断）
    expect(svg.match(/userSpaceOnUse/g)).toHaveLength(1)
    expect(svg).toContain('<linearGradient id="w-sheen" gradientUnits="userSpaceOnUse"')
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
  it('默认那两张（波 + 流光）：样式内联、每块自己一条渐变（§3.0）+ 一条亮带', () => {
    const svg = BRAND_MARK_SVG_IDLE_DARK
    expect(svg).toContain('<style>')
    expect(svg.match(/<g class="aw-idle-dark-idle"/g)).toHaveLength(6)
    // 唯一的 userSpaceOnUse 是亮带（WP200），块仍是每块自己一条
    expect(svg.match(/userSpaceOnUse/g)).toHaveLength(1)
    expect(svg).toContain('<linearGradient id="aw-idle-dark-sheen" gradientUnits="userSpaceOnUse"')
    expect(svg.match(/<linearGradient /g)).toHaveLength(7)
    expect(BRAND_MARK_SVG_IDLE_LIGHT).toContain('aw-idle-light-idle')
  })

  it('波：六块都挂类', () => {
    const svg = markSvg({ idle: 'wave', id: 'v' })
    expect(svg.match(/<rect [^>]*class="v-idle"/g)).toHaveLength(6)
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
    // 整体那一条 + 亮带那一条（WP200）
    expect(svg.match(/userSpaceOnUse/g)).toHaveLength(2)
    expect(svg).toContain('<linearGradient id="s" gradientUnits="userSpaceOnUse"')
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
