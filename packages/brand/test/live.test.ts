/**
 * WP197：官网用的「活」标记——待机那层原样取自 `markSvg({ idle })`，
 * 集结 / 一变一队 / 呼吸的时长、延迟、缓动全从 geometry 来，减少动效时静态。
 */
import { describe, expect, it } from 'vitest'
import {
  ALL_BLOCKS,
  ASSEMBLE_DELAYS_MS,
  ASSEMBLE_LEAD_DELAY_MS,
  ASSEMBLE_TOTAL_MS,
  BREATHE_PERIOD_MS,
  EASING,
  IDLE_START_MS,
  LIVE_POSES,
  liveMarkCss,
  liveMarkSvg,
  markSvg,
  SPLIT_BLOCK_DURATION_MS,
  SPLIT_FIRST_DELAY_MS,
  SPLIT_OFFSETS,
  SPLIT_STEP_MS,
  STOPS_ON_LIGHT,
} from '../src/index.js'

describe('liveMarkSvg', () => {
  it('带待机：六块都补上了类名与变量，待机那一层与 markSvg 出的一字不差', () => {
    const svg = liveMarkSvg({ id: 't1', idle: 'wave-sheen', pose: 'assemble' })
    expect(svg.match(/class="aw-b/g)?.length).toBe(6)
    expect(svg.match(/class="aw-b aw-lead"/g)?.length).toBe(1)
    expect(svg).toContain('class="aw-mark aw-assemble"')
    // 去掉补上的类名与变量，就是 markSvg 那一张的内容
    const stripped = svg.replace(/ class="aw-b[^"]*" style="[^"]*"/g, '')
    const base = markSvg({ id: 't1', idle: 'wave-sheen' })
    const inner = (s: string): string => s.replace(/^<svg[^>]*>/u, '').replace(/<\/svg>$/u, '')
    expect(inner(stripped)).toBe(inner(base))
  })

  it('每块的集结延迟与一变一队位移取自 geometry', () => {
    const svg = liveMarkSvg({ id: 't2' })
    ALL_BLOCKS.forEach((_, i) => {
      const lead = i === ALL_BLOCKS.length - 1
      const d = lead ? ASSEMBLE_LEAD_DELAY_MS : ASSEMBLE_DELAYS_MS[i]
      const off = lead ? { dx: 0, dy: 0 } : SPLIT_OFFSETS[i]
      expect(svg).toContain(`--aw-d:${d}ms;--aw-i:${i};--aw-dx:${off?.dx}px;--aw-dy:${off?.dy}px`)
    })
  })

  it('浅底那套端点、只画领头、无障碍标签', () => {
    const light = liveMarkSvg({ id: 't3', stops: STOPS_ON_LIGHT, label: 'Agents 工坊' })
    expect(light).toContain('role="img" aria-label="Agents 工坊"')
    const lead = liveMarkSvg({ id: 't4', leadOnly: true, pose: 'breathe' })
    expect(lead.match(/<rect/g)?.length).toBe(1)
    expect(lead).toContain('viewBox="62 12 17 17"')
    expect(lead).toContain('aria-hidden="true"')
  })

  it('集结在待机第一下之前播完（两层不打架）', () => {
    expect(ASSEMBLE_TOTAL_MS).toBeLessThan(IDLE_START_MS)
  })
})

describe('liveMarkCss', () => {
  const css = liveMarkCss()

  it('三种姿态的类名、时长与缓动', () => {
    for (const cls of Object.values(LIVE_POSES)) expect(css).toContain(`.${cls}`)
    expect(css).toContain(`aw-assemble 1.2s ${EASING.enter} var(--aw-d)`)
    expect(css).toContain(`aw-assemble-lead .9s ${EASING.lead} ${ASSEMBLE_LEAD_DELAY_MS}ms`)
    expect(css).toContain(
      `aw-split ${SPLIT_BLOCK_DURATION_MS}ms ${EASING.enter} calc(${SPLIT_FIRST_DELAY_MS}ms + var(--aw-i) * ${SPLIT_STEP_MS}ms)`,
    )
    expect(css).toContain(`aw-breathe ${BREATHE_PERIOD_MS}ms ease-in-out var(--aw-p) infinite`)
  })

  it('减少动态效果：一律静态、全不透明', () => {
    expect(css).toMatch(
      /@media \(prefers-reduced-motion:reduce\)\{[^}]*animation:none!important;opacity:1!important/,
    )
  })

  it('页面藏起来时整张停（含待机那层）', () => {
    expect(css).toContain('.aw-paused .aw-mark *')
    expect(css).toContain('animation-play-state:paused')
  })
})
