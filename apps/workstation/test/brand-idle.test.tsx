/**
 * WP195：标记的第五种姿态「待机」+ 悬停播一次一变一队 + 「界面动效」设置项。
 *
 * 五件要钉住的事（派工单第 5 条）：待机类名挂上、reduce 时不挂、页面隐藏时暂停、
 * 悬停触发一次 split、单色小图标不挂待机。另外核 `index.css` 那几段 keyframes
 * 与 `@agentsws/brand` 的 `IDLE_*` 数字逐个相等，以及设置项真的改得动。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_IDLE_STYLE,
  IDLE_BLINK,
  IDLE_SHEEN,
  IDLE_START_MS,
  IDLE_WAVE,
  IDLE_WAVE_DELAYS_MS,
  IDLE_WAVE_SHEEN,
  IDLE_WAVE_SHEEN_DELAYS_MS,
  idlePercent,
  MIN_GRADIENT_PX,
  MIN_IDLE_PX,
  SHEEN_ON_DARK,
  SHEEN_ON_LIGHT,
  SPLIT_TOTAL_MS,
} from '@agentsws/brand'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrandMark, setMotionPref } from '@/components/design'
import { resetMotionPrefForTest } from '@/components/design/motion-pref'
import { SettingsPage } from '@/pages/settings'
import { renderWithProviders } from './helpers'

const CSS = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.css'),
  'utf8',
)

function mark(ui: React.ReactNode): SVGSVGElement {
  const { container } = render(ui)
  const svg = container.querySelector('svg[data-testid="brand-mark"]')
  if (svg === null) throw new Error('没渲染出标记')
  return svg as SVGSVGElement
}

const rects = (svg: SVGSVGElement): SVGRectElement[] => [
  ...svg.querySelectorAll<SVGRectElement>(':scope > rect'),
]

function reduceMotion(on: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: on && query.includes('prefers-reduced-motion'),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }))
}

let hidden = false
let store = new Map<string, string>()

beforeEach(() => {
  hidden = false
  // Node 25 自带那个全局 localStorage 是残的（没有 getItem / setItem），换一份内存的
  store = new Map()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v)
    },
  })
  resetMotionPrefForTest()
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  resetMotionPrefForTest()
  delete document.documentElement.dataset.wsMotion
})

describe('待机类名挂上', () => {
  it('默认候选是「波 + 流光」：每块一个会抬起的 <g>（块 + 它自己那份亮带），延迟由亮带位置算出', () => {
    expect(DEFAULT_IDLE_STYLE).toBe('wave-sheen')
    const svg = mark(<BrandMark size={32} motion="idle" />)
    expect(svg.getAttribute('data-motion')).toBe('idle')
    expect(svg.getAttribute('data-idle-style')).toBe('wave-sheen')
    const groups = [...svg.querySelectorAll<SVGGElement>(':scope > g.ws-bm-idle-ws')]
    expect(groups).toHaveLength(6)
    groups.forEach((g, i) => {
      expect(g.style.animationDelay).toBe(
        `${IDLE_START_MS + (IDLE_WAVE_SHEEN_DELAYS_MS[i] ?? 0)}ms`,
      )
      // 块本身 + 被它自己裁出来的那份亮带
      expect(g.querySelector(':scope > rect')?.getAttribute('fill')).toMatch(/^url\(#.+-b\d\)$/)
      const band = g.querySelector('.ws-bm-idle-ws-band')
      expect(band?.parentElement?.getAttribute('clip-path')).toMatch(/^url\(#.+-clip\d\)$/)
    })
    expect(svg.querySelectorAll('clipPath')).toHaveLength(6)
    expect(svg.querySelectorAll('linearGradient[gradientUnits="userSpaceOnUse"]')).toHaveLength(0)
  })

  it('波：六块都挂，延迟 = 1.6s + 沿渐变方向的错开', () => {
    const svg = mark(<BrandMark size={32} motion="idle" idleStyle="wave" />)
    expect(svg.getAttribute('data-idle-style')).toBe('wave')
    const blocks = rects(svg)
    expect(blocks).toHaveLength(6)
    blocks.forEach((r, i) => {
      expect(r.getAttribute('class')).toBe('ws-bm-idle-wave')
      expect(r.style.animationDelay).toBe(`${IDLE_START_MS + (IDLE_WAVE_DELAYS_MS[i] ?? 0)}ms`)
    })
    // 块在动：每块自己一条渐变（§3.0），不是整体那一条
    expect(svg.querySelectorAll('linearGradient[gradientUnits="userSpaceOnUse"]')).toHaveLength(0)
  })

  it('眨眼：只有领头那一块挂类', () => {
    const svg = mark(<BrandMark size={32} motion="idle" idleStyle="blink" />)
    const classed = rects(svg).filter((r) => r.getAttribute('class') !== null)
    expect(classed).toHaveLength(1)
    expect(classed[0]?.getAttribute('x')).toBe('62')
    expect(classed[0]?.getAttribute('y')).toBe('12')
    expect(classed[0]?.getAttribute('class')).toBe('ws-bm-idle-blink')
  })

  it('流光：方块不挂类、仍用整体渐变；亮带那一层挂类，并被六块裁出来', () => {
    const svg = mark(<BrandMark size={32} motion="idle" idleStyle="sheen" />)
    expect(rects(svg).every((r) => r.getAttribute('class') === null)).toBe(true)
    expect(svg.querySelectorAll('linearGradient[gradientUnits="userSpaceOnUse"]')).toHaveLength(1)
    const band = screen.getByTestId('brand-mark-sheen')
    expect(band.getAttribute('clip-path')).toMatch(/^url\(#.+-clip\)$/)
    expect(band.querySelector('rect')?.getAttribute('class')).toBe('ws-bm-idle-sheen')
    expect(svg.querySelectorAll('clipPath rect')).toHaveLength(6)
  })
})

describe('reduce / 设置项', () => {
  it('系统开了「少一点动效」：待机一个类都不挂', () => {
    reduceMotion(true)
    const svg = mark(<BrandMark size={32} motion="idle" />)
    expect(svg.getAttribute('data-motion')).toBe('none')
    expect(svg.querySelector('[class^="ws-bm-"]')).toBeNull()
  })

  it('设置里选「关」：系统没开也不动', () => {
    setMotionPref('off')
    const svg = mark(<BrandMark size={32} motion="idle" />)
    expect(svg.getAttribute('data-motion')).toBe('none')
    expect(document.documentElement.dataset.wsMotion).toBe('off')
  })

  it('设置里选「开」：系统开着「少一点动效」也照动（人在这里明说了）', () => {
    reduceMotion(true)
    setMotionPref('on')
    const svg = mark(<BrandMark size={32} motion="idle" />)
    expect(svg.getAttribute('data-motion')).toBe('idle')
  })

  it('选择存在本机，刷新后还在', () => {
    setMotionPref('off')
    resetMotionPrefForTest()
    expect(globalThis.localStorage.getItem('agentsws.motion')).toBe('off')
    expect(mark(<BrandMark size={32} motion="idle" />).getAttribute('data-motion')).toBe('none')
  })

  it('「设置 → 通用」里三选一，默认跟随系统，点了就生效', () => {
    renderWithProviders(<SettingsPage />, '/settings', '')
    const group = screen.getByTestId('settings-motion')
    const buttons = [...group.querySelectorAll('button')]
    expect(buttons.map((b) => b.textContent)).toEqual(['跟随系统', '开', '关'])
    expect(buttons[0]?.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(buttons[2] as HTMLButtonElement)
    expect(buttons[2]?.getAttribute('aria-pressed')).toBe('true')
    expect(document.documentElement.dataset.wsMotion).toBe('off')
  })
})

describe('页面隐藏时暂停', () => {
  it('切走挂 ws-bm-paused，切回来摘掉', () => {
    const svg = mark(<BrandMark size={32} motion="idle" />)
    expect(svg.classList.contains('ws-bm-paused')).toBe(false)
    act(() => {
      hidden = true
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(svg.classList.contains('ws-bm-paused')).toBe(true)
    act(() => {
      hidden = false
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(svg.classList.contains('ws-bm-paused')).toBe(false)
  })

  it('本来就不动的标记不挂（没什么可停的）', () => {
    hidden = true
    const svg = mark(<BrandMark size={32} />)
    expect(svg.classList.contains('ws-bm-paused')).toBe(false)
  })
})

describe('悬停播一次一变一队', () => {
  it('移上去 → split；播完（SPLIT_TOTAL_MS）→ 回待机', () => {
    vi.useFakeTimers()
    const svg = mark(<BrandMark size={24} motion="idle" playOnHover />)
    expect(svg.getAttribute('data-motion')).toBe('idle')
    fireEvent.mouseEnter(svg)
    expect(svg.getAttribute('data-motion')).toBe('split')
    expect(svg.querySelectorAll('.ws-bm-split')).toHaveLength(5)
    expect(svg.querySelectorAll('.ws-bm-split-lead')).toHaveLength(1)
    // 播的时候再移进来不重头来
    fireEvent.mouseEnter(svg)
    act(() => {
      vi.advanceTimersByTime(SPLIT_TOTAL_MS - 1)
    })
    expect(svg.getAttribute('data-motion')).toBe('split')
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(svg.getAttribute('data-motion')).toBe('idle')
  })

  it('小图标（单色）平时静态，悬停也能播一次，播完回静态', () => {
    vi.useFakeTimers()
    const svg = mark(<BrandMark size={16} playOnHover />)
    expect(svg.getAttribute('data-variant')).toBe('mono')
    fireEvent.mouseEnter(svg)
    expect(svg.getAttribute('data-motion')).toBe('split')
    act(() => {
      vi.advanceTimersByTime(SPLIT_TOTAL_MS)
    })
    expect(svg.getAttribute('data-motion')).toBe('none')
  })

  it('没开 playOnHover 的不理悬停；reduce 时也不播', () => {
    const plain = mark(<BrandMark size={32} motion="idle" />)
    fireEvent.mouseEnter(plain)
    expect(plain.getAttribute('data-motion')).toBe('idle')
    reduceMotion(true)
    const quiet = mark(<BrandMark size={32} motion="idle" playOnHover />)
    fireEvent.mouseEnter(quiet)
    expect(quiet.getAttribute('data-motion')).toBe('none')
  })
})

describe('单色（太小）不挂待机', () => {
  it('门槛就是渐变的门槛（产品界面 24，见 MIN_GRADIENT_PX）', () => {
    expect(MIN_IDLE_PX).toBe(MIN_GRADIENT_PX)
  })

  it('20px：退单色，待机不挂', () => {
    const svg = mark(<BrandMark size={20} motion="idle" />)
    expect(svg.getAttribute('data-variant')).toBe('mono')
    expect(svg.getAttribute('data-motion')).toBe('none')
    expect(svg.querySelector('.ws-bm-idle-wave')).toBeNull()
  })

  it('明写 mono 的大标记也不挂', () => {
    const svg = mark(<BrandMark size={48} variant="mono" motion="idle" />)
    expect(svg.getAttribute('data-motion')).toBe('none')
  })

  it('刚好 24（左栏顶部那个）挂', () => {
    expect(mark(<BrandMark size={24} motion="idle" />).getAttribute('data-motion')).toBe('idle')
  })
})

describe('index.css：待机那几段与 @agentsws/brand 的数字一致', () => {
  function block(selector: string): string {
    const at = CSS.indexOf(`${selector} {`)
    expect(at).toBeGreaterThan(-1)
    let depth = 0
    for (let i = CSS.indexOf('{', at); i < CSS.length; i += 1) {
      if (CSS[i] === '{') depth += 1
      if (CSS[i] === '}') {
        depth -= 1
        if (depth === 0) return CSS.slice(at, i + 1)
      }
    }
    throw new Error(`${selector} 没闭合`)
  }

  /** `.<cls> {` 那几处里**带 animation 的那一条**（共用 transform-box 那组的末项也是 `.<cls> {`）。 */
  function rule(cls: string): string {
    const found: string[] = []
    let at = CSS.indexOf(`.${cls} {`)
    while (at > -1) {
      found.push(CSS.slice(at, CSS.indexOf('}', at)))
      at = CSS.indexOf(`.${cls} {`, at + 1)
    }
    const hits = found.filter((b) => b.includes('animation:') && !b.includes('animation: none'))
    expect(hits).toHaveLength(1)
    return hits[0] as string
  }

  it('三个类都在 transform-box: fill-box 那一组里（§4.1 坑 1）', () => {
    const at = CSS.indexOf('.ws-bm-assemble,')
    const group = CSS.slice(at, CSS.indexOf('}', at))
    for (const cls of [
      '.ws-bm-idle-ws',
      '.ws-bm-idle-ws-band',
      '.ws-bm-idle-wave',
      '.ws-bm-idle-sheen',
      '.ws-bm-idle-blink',
    ]) {
      expect(group).toContain(cls)
    }
  })

  it('五段 keyframes 只动 transform', () => {
    for (const name of [
      'ws-bm-idle-ws',
      'ws-bm-idle-ws-band',
      'ws-bm-idle-wave',
      'ws-bm-idle-sheen',
      'ws-bm-idle-blink',
    ]) {
      const body = block(`@keyframes ${name}`)
      const props = [...body.matchAll(/([a-z-]+):\s/g)].map((m) => m[1])
      expect(new Set(props)).toEqual(new Set(['transform']))
    }
  })

  it('波 + 流光：8s；块 3.5% 抬到 -3px、9.25% 落回；亮带匀速、1.6s 后起、25% 扫完、走 ±45.5', () => {
    const w = IDLE_WAVE_SHEEN
    expect(rule('ws-bm-idle-ws')).toContain(`${w.periodMs / 1000}s`)
    const lift = block('@keyframes ws-bm-idle-ws')
    expect(lift).toContain(`${idlePercent(w.riseMs, w.periodMs)} {`)
    expect(lift).toContain(`translateY(-${w.lift}px)`)
    expect(lift).toContain(`${idlePercent(w.riseMs + w.fallMs, w.periodMs)},`)
    const band = rule('ws-bm-idle-ws-band')
    expect(band).toContain(`${w.periodMs / 1000}s linear ${IDLE_START_MS}ms`)
    const far = Number((65 * w.travel).toFixed(2))
    const kf = block('@keyframes ws-bm-idle-ws-band')
    expect(kf).toContain(`${idlePercent(w.sweepMs, w.periodMs)},`)
    expect(kf).toContain(`translate(-${far}px, ${far}px)`)
    expect(kf).toContain(`translate(${far}px, -${far}px)`)
  })

  it('波：7.2s、5% 抬到 -4px、12.5% 落回', () => {
    expect(rule('ws-bm-idle-wave')).toContain(`${IDLE_WAVE.periodMs / 1000}s`)
    const kf = block('@keyframes ws-bm-idle-wave')
    expect(kf).toContain(`${(IDLE_WAVE.riseMs / IDLE_WAVE.periodMs) * 100}% {`)
    expect(kf).toContain(`translateY(-${IDLE_WAVE.lift}px)`)
    expect(kf).toContain(`${((IDLE_WAVE.riseMs + IDLE_WAVE.fallMs) / IDLE_WAVE.periodMs) * 100}%,`)
  })

  it('流光：8s、1.6s 后起、18.75% 扫完', () => {
    const sheen = rule('ws-bm-idle-sheen')
    expect(sheen).toContain(`${IDLE_SHEEN.periodMs / 1000}s`)
    expect(sheen).toContain(`${IDLE_START_MS}ms`)
    expect(block('@keyframes ws-bm-idle-sheen')).toContain(
      `${(IDLE_SHEEN.sweepMs / IDLE_SHEEN.periodMs) * 100}%,`,
    )
  })

  it('眨眼：9s、1.6s 后起、3% 探出 (3, -3)、8% 归位，缓动是领头那条回弹', () => {
    const blink = rule('ws-bm-idle-blink')
    expect(blink).toContain(`${IDLE_BLINK.periodMs / 1000}s`)
    expect(blink).toContain(`${IDLE_START_MS}ms`)
    expect(blink).toContain('cubic-bezier(0.34, 1.56, 0.64, 1)')
    const kf = block('@keyframes ws-bm-idle-blink')
    expect(kf).toContain(`${(IDLE_BLINK.outMs / IDLE_BLINK.periodMs) * 100}% {`)
    expect(kf).toContain(`translate(${IDLE_BLINK.dx}px, ${IDLE_BLINK.dy}px)`)
    expect(kf).toContain(
      `${((IDLE_BLINK.outMs + IDLE_BLINK.backMs) / IDLE_BLINK.periodMs) * 100}%,`,
    )
  })

  it('页面隐藏那条：animation-play-state: paused', () => {
    expect(block('.ws-bm-paused,\n  .ws-bm-paused *')).toContain('animation-play-state: paused')
  })

  it('reduce 兜底层与「关」那一层都列了待机三个类', () => {
    const reduce = block('@media (prefers-reduced-motion: reduce)')
    for (const cls of [
      'ws-bm-idle-ws',
      'ws-bm-idle-ws-band',
      'ws-bm-idle-wave',
      'ws-bm-idle-blink',
      'ws-bm-idle-sheen',
    ]) {
      expect(reduce).toContain(`:root:not([data-ws-motion="on"]) .${cls}`)
      expect(CSS).toContain(`:root[data-ws-motion="off"] .${cls}`)
    }
  })
})

describe('WP200：浅色主题那道光调淡，深色不变', () => {
  /** `:root {` / `.dark {` 那一段（第一次出现的那个，花括号配对）。 */
  function scope(selector: string): string {
    const at = CSS.indexOf(`${selector} {`)
    expect(at).toBeGreaterThan(-1)
    let depth = 0
    for (let i = CSS.indexOf('{', at); i < CSS.length; i += 1) {
      if (CSS[i] === '{') depth += 1
      if (CSS[i] === '}') {
        depth -= 1
        if (depth === 0) return CSS.slice(at, i + 1)
      }
    }
    throw new Error(`${selector} 没闭合`)
  }
  const sheenVars = (selector: string): { color: string; strength: number } => {
    const body = scope(selector)
    const color = body.match(/--ws-brand-sheen:\s*(#[0-9a-f]{6});/)?.[1]
    const strength = body.match(/--ws-brand-sheen-strength:\s*([\d.]+);/)?.[1]
    if (color === undefined || strength === undefined) throw new Error(`${selector} 缺亮带变量`)
    return { color: color.toUpperCase(), strength: Number(strength) }
  }

  it('浅色主题 = SHEEN_ON_LIGHT，深色主题 = SHEEN_ON_DARK（逐个相等）', () => {
    expect(sheenVars(':root')).toEqual(SHEEN_ON_LIGHT)
    expect(sheenVars('.dark')).toEqual(SHEEN_ON_DARK)
  })

  it('力度乘在两种亮带那一层的 opacity 上', () => {
    for (const cls of ['ws-bm-idle-ws-band', 'ws-bm-idle-sheen']) {
      const at = CSS.indexOf(`.${cls} {\n    opacity`)
      expect(at).toBeGreaterThan(-1)
      expect(CSS.slice(at, CSS.indexOf('}', at))).toContain(
        'opacity: var(--ws-brand-sheen-strength, 1)',
      )
    }
  })

  it('组件里亮带的颜色走变量，不再写死纯白', () => {
    for (const style of ['wave-sheen', 'sheen'] as const) {
      const svg = mark(<BrandMark size={40} motion="idle" idleStyle={style} />)
      const stops = [...svg.querySelectorAll('linearGradient[id$="-sheen"] stop')]
      expect(stops).toHaveLength(3)
      for (const st of stops) expect(st.getAttribute('stop-color')).toBe('var(--ws-brand-sheen)')
    }
  })
})
