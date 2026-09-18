/**
 * WP112：`BrandMark` 与那段 keyframes 有没有照母品牌规范走。
 *
 * 一半断言打在渲染出来的 SVG 上，另一半**直接读 `src/index.css`**——
 * 规范 §4.1 的三个坑里有两个是 CSS 层面的（渐变单位、基类 opacity 与 keyframes
 * 对不上），只看组件看不出来。
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ALL_BLOCKS,
  BLOCK_RADIUS,
  BLOCK_SIZE,
  MIN_GRADIENT_PX,
  MOTION_GRADIENTS_ON_DARK,
  MOTION_GRADIENTS_ON_LIGHT,
  STOPS_ON_DARK,
  STOPS_ON_LIGHT,
} from '@agentsws/brand'
import { render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrandMark } from '@/components/design'

/**
 * 直接读那份真 CSS。
 *
 * 两个坑绕开了：`import '@/index.css?raw'` 不行——vitest 默认把 CSS import 掐成空串，
 * 于是断言会全部"通过"在一个空字符串上；`new URL('../x', import.meta.url)` 也不行——
 * jsdom 把全局 `URL` 换成了它自己那个实现，相对路径会被解到 `http://localhost:3000/`
 * 上去。所以走 `dirname()` 拼。
 */
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

/** 让 `prefers-reduced-motion: reduce` 在这一条用例里为真。 */
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

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('§1.1 六块摆在规范说的位置上', () => {
  it('坐标、边长、圆角逐块对上，一块不多一块不少', () => {
    const rects = [...mark(<BrandMark size={48} />).querySelectorAll('rect')]
    expect(rects).toHaveLength(6)
    rects.forEach((r, i) => {
      const block = ALL_BLOCKS[i]
      expect(r.getAttribute('x')).toBe(String(block?.x))
      expect(r.getAttribute('y')).toBe(String(block?.y))
      expect(r.getAttribute('width')).toBe(String(BLOCK_SIZE))
      expect(r.getAttribute('height')).toBe(String(BLOCK_SIZE))
      expect(r.getAttribute('rx')).toBe(String(BLOCK_RADIUS))
    })
  })

  it('viewBox 就是 65×65 的外框——不是 100×100 画布（§1.1 那个坑）', () => {
    expect(mark(<BrandMark size={48} />).getAttribute('viewBox')).toBe('14 12 65 65')
  })

  it('§1.5：不描边、不投影、不发光、不旋转', () => {
    const svg = mark(<BrandMark size={48} motion="assemble" />)
    expect(svg.outerHTML).not.toMatch(/stroke=|<filter|feGaussianBlur|rotate\(|skew\(/)
  })
})

describe('§1.2 / §3.0 两种渐变，别混', () => {
  it('静态：一条 userSpaceOnUse 渐变铺满整个标记，六块共用', () => {
    const svg = mark(<BrandMark size={48} />)
    const grads = [...svg.querySelectorAll('linearGradient')]
    expect(grads).toHaveLength(1)
    expect(grads[0]?.getAttribute('gradientUnits')).toBe('userSpaceOnUse')
    expect(grads[0]?.getAttribute('x1')).toBe('14')
    expect(grads[0]?.getAttribute('y1')).toBe('77')
    expect(grads[0]?.getAttribute('x2')).toBe('79')
    expect(grads[0]?.getAttribute('y2')).toBe('12')
    const id = grads[0]?.getAttribute('id')
    for (const r of svg.querySelectorAll('rect')) {
      expect(r.getAttribute('fill')).toBe(`url(#${id})`)
    }
  })

  it('动效：每块自己一条渐变，六块六条，一条 userSpaceOnUse 都没有', () => {
    for (const motion of ['assemble', 'breathe', 'split'] as const) {
      const svg = mark(<BrandMark size={48} motion={motion} />)
      const grads = [...svg.querySelectorAll('linearGradient')]
      expect(grads).toHaveLength(6)
      for (const g of grads) expect(g.getAttribute('gradientUnits')).toBeNull()
      // 从块的左下到右上，与整体渐变同向
      for (const g of grads) {
        expect([g.getAttribute('x1'), g.getAttribute('y1')]).toEqual(['0', '1'])
        expect([g.getAttribute('x2'), g.getAttribute('y2')]).toEqual(['1', '0'])
      }
      const ids = grads.map((g) => g.getAttribute('id'))
      expect(new Set(ids).size).toBe(6)
      const fills = [...svg.querySelectorAll('rect')].map((r) => r.getAttribute('fill'))
      expect(fills).toEqual(ids.map((id) => `url(#${id})`))
    }
  })

  it('端点走 CSS 变量，所以明暗主题自动取对应的一套', () => {
    const svg = mark(<BrandMark size={48} />)
    const stops = [...svg.querySelectorAll('stop')].map((s) => s.getAttribute('stop-color'))
    expect(stops).toEqual([
      'var(--ws-brand-mark-0)',
      'var(--ws-brand-mark-1)',
      'var(--ws-brand-mark-2)',
    ])
  })
})

describe('§1.3 小于 28px 退单色', () => {
  it('27px 自己退成单色，写的是 gradient 也一样', () => {
    const svg = mark(<BrandMark size={MIN_GRADIENT_PX - 1} variant="gradient" />)
    expect(svg.dataset.variant).toBe('mono')
    expect(svg.querySelectorAll('linearGradient')).toHaveLength(0)
    for (const r of svg.querySelectorAll('rect')) {
      expect(r.getAttribute('fill')).toBe('currentColor')
    }
  })

  it('刚好 28px 还是渐变', () => {
    expect(mark(<BrandMark size={MIN_GRADIENT_PX} />).dataset.variant).toBe('gradient')
  })

  it('明写 mono 的时候多大都单色', () => {
    const svg = mark(<BrandMark size={96} variant="mono" />)
    expect(svg.dataset.variant).toBe('mono')
    expect(svg.querySelectorAll('linearGradient')).toHaveLength(0)
  })
})

describe('动效类名与延迟', () => {
  it('集结：五块按 0/100/160/240/300 错开，领头块单独一个类（延迟写在 CSS 里）', () => {
    const rects = [...mark(<BrandMark size={48} motion="assemble" />).querySelectorAll('rect')]
    expect(rects.slice(0, 5).map((r) => r.getAttribute('class'))).toEqual(
      Array.from({ length: 5 }, () => 'ws-bm-assemble'),
    )
    expect(rects.slice(0, 5).map((r) => (r as SVGRectElement).style.animationDelay)).toEqual([
      '0ms',
      '100ms',
      '160ms',
      '240ms',
      '300ms',
    ])
    expect(rects[5]?.getAttribute('class')).toBe('ws-bm-assemble-lead')
  })

  it('呼吸：六块同一个类，相位差 46ms 递增（负延迟 = 一上来就错开）', () => {
    const rects = [...mark(<BrandMark size={48} motion="breathe" />).querySelectorAll('rect')]
    expect(rects.map((r) => r.getAttribute('class'))).toEqual(
      Array.from({ length: 6 }, () => 'ws-bm-breathe'),
    )
    expect(rects.map((r) => (r as SVGRectElement).style.animationDelay)).toEqual([
      '-0ms',
      '-46ms',
      '-92ms',
      '-138ms',
      '-184ms',
      '-230ms',
    ])
  })

  it('一变一队：领头先出现，五块从它那儿分出去（位移 = 领头减自己）', () => {
    const rects = [...mark(<BrandMark size={48} motion="split" />).querySelectorAll('rect')]
    expect(rects[5]?.getAttribute('class')).toBe('ws-bm-split-lead')
    const moved = rects.slice(0, 5) as SVGRectElement[]
    expect(moved.map((r) => r.style.getPropertyValue('--ws-bm-dx'))).toEqual([
      '48px',
      '24px',
      '24px',
      '0px',
      '0px',
    ])
    expect(moved.map((r) => r.style.getPropertyValue('--ws-bm-dy'))).toEqual([
      '-32px',
      '-40px',
      '-16px',
      '-48px',
      '-24px',
    ])
    expect(moved.map((r) => r.style.animationDelay)).toEqual([
      '300ms',
      '400ms',
      '500ms',
      '600ms',
      '700ms',
    ])
  })
})

describe('prefers-reduced-motion: reduce', () => {
  it('开了就一律静态：一个 animation 类都不挂，渐变也退回 userSpaceOnUse 那一条', () => {
    reduceMotion(true)
    for (const motion of ['assemble', 'breathe', 'split'] as const) {
      const svg = mark(<BrandMark size={48} motion={motion} />)
      expect(svg.dataset.motion).toBe('none')
      for (const r of svg.querySelectorAll('rect')) expect(r.getAttribute('class')).toBeNull()
      expect(svg.querySelectorAll('linearGradient')).toHaveLength(1)
    }
  })

  it('没开就照常动', () => {
    reduceMotion(false)
    expect(mark(<BrandMark size={48} motion="breathe" />).dataset.motion).toBe('breathe')
  })
})

describe('可达性', () => {
  it('不给 label 就是装饰（aria-hidden，没有 title）', () => {
    const svg = mark(<BrandMark size={48} />)
    expect(svg.getAttribute('aria-hidden')).toBe('true')
    expect(svg.querySelector('title')).toBeNull()
  })

  it('给了 label 就是图（role=img + title）', () => {
    const svg = mark(<BrandMark size={48} label="出海Agents工坊" />)
    expect(svg.getAttribute('role')).toBe('img')
    expect(svg.getAttribute('aria-label')).toBe('出海Agents工坊')
    expect(svg.querySelector('title')?.textContent).toBe('出海Agents工坊')
  })
})

describe('index.css：规范 §4.1 的三个坑', () => {
  /** 抠出 `@keyframes <name>` 那一对花括号里的内容。 */
  function keyframes(name: string): string {
    const at = CSS.indexOf(`@keyframes ${name} {`)
    expect(at).toBeGreaterThan(-1)
    let depth = 0
    for (let i = CSS.indexOf('{', at); i < CSS.length; i += 1) {
      if (CSS[i] === '{') depth += 1
      if (CSS[i] === '}') {
        depth -= 1
        if (depth === 0) return CSS.slice(at, i + 1)
      }
    }
    throw new Error(`@keyframes ${name} 没闭合`)
  }

  /**
   * 抠出 `.<class>` 那条**带 animation 的**规则的声明块。
   *
   * 同一个类名在文件里出现三处：共用的 `transform-box` 那一组、自己这一条、
   * 以及 reduce 那一档里的 `animation: none`。要看的是中间那条。
   */
  function rule(cls: string): string {
    const blocks: string[] = []
    let at = CSS.indexOf(`.${cls} {`)
    while (at > -1) {
      blocks.push(CSS.slice(at, CSS.indexOf('}', at)))
      at = CSS.indexOf(`.${cls} {`, at + 1)
    }
    const found = blocks.filter((b) => b.includes('animation:') && !b.includes('animation: none'))
    expect(found).toHaveLength(1)
    return found[0] as string
  }

  it('坑 1：五个动效类都写了 transform-box: fill-box 与 transform-origin: center', () => {
    const at = CSS.indexOf('.ws-bm-assemble,')
    const block = CSS.slice(at, CSS.indexOf('}', at))
    for (const cls of [
      '.ws-bm-assemble',
      '.ws-bm-assemble-lead',
      '.ws-bm-breathe',
      '.ws-bm-split',
      '.ws-bm-split-lead',
    ]) {
      expect(block).toContain(cls)
    }
    expect(block).toContain('transform-box: fill-box')
    expect(block).toContain('transform-origin: center')
  })

  it('坑 3：基类 opacity:0 的，它的 keyframes 每一帧都动 opacity', () => {
    const pairs = [
      ['ws-bm-assemble', 'ws-bm-assemble'],
      ['ws-bm-assemble-lead', 'ws-bm-assemble-lead'],
      ['ws-bm-split', 'ws-bm-split'],
      ['ws-bm-split-lead', 'ws-bm-split-lead'],
    ] as const
    for (const [cls, kf] of pairs) {
      expect(rule(cls)).toContain('opacity: 0;')
      const body = keyframes(kf)
      // 每一个帧选择器（`0% {` / `58% {` / `100% {` …）里都要有 opacity
      const frames = body.split(/\d+%[\s,\d%]*\{/).slice(1)
      expect(frames.length).toBeGreaterThan(1)
      for (const f of frames) expect(f).toContain('opacity:')
    }
  })

  it('呼吸的基类不是 opacity:0（它常驻，0 会先闪一下），幅度按 §3.4 压住', () => {
    expect(rule('ws-bm-breathe')).toContain('opacity: 0.55;')
    expect(rule('ws-bm-breathe')).toContain('2.6s')
    expect(rule('ws-bm-breathe')).toContain('infinite')
    const body = keyframes('ws-bm-breathe')
    expect(body).toContain('scale(0.94)')
    expect(body).toContain('opacity: 0.55')
    expect(body).toContain('opacity: 1')
  })

  it('缓动照 §3.1 那三条', () => {
    expect(rule('ws-bm-assemble')).toContain('cubic-bezier(0.22, 1, 0.36, 1)')
    expect(rule('ws-bm-assemble-lead')).toContain('cubic-bezier(0.34, 1.56, 0.64, 1)')
    expect(rule('ws-bm-assemble-lead')).toContain('380ms')
    expect(rule('ws-bm-split-lead')).toContain('cubic-bezier(0.34, 1.56, 0.64, 1)')
    expect(rule('ws-bm-split')).toContain('cubic-bezier(0.22, 1, 0.36, 1)')
  })

  it('reduce 那一档在 CSS 里也兜了一层', () => {
    const at = CSS.indexOf('@media (prefers-reduced-motion: reduce)')
    expect(at).toBeGreaterThan(-1)
    expect(CSS.slice(at, at + 400)).toContain('animation: none')
  })
})

describe('index.css：渐变端点明暗两套齐全，且与 @agentsws/brand 逐格相等', () => {
  /** 抠出 `:root {` / `.dark {` 那一段里定义的所有品牌标记变量。 */
  function varsIn(selector: string): Map<string, string> {
    const at = CSS.indexOf(`${selector} {`)
    expect(at).toBeGreaterThan(-1)
    let depth = 0
    let end = CSS.length
    for (let i = CSS.indexOf('{', at); i < CSS.length; i += 1) {
      if (CSS[i] === '{') depth += 1
      if (CSS[i] === '}') {
        depth -= 1
        if (depth === 0) {
          end = i
          break
        }
      }
    }
    const out = new Map<string, string>()
    for (const m of CSS.slice(at, end).matchAll(/(--ws-brand-mark-[\w-]+):\s*(#[0-9a-f]{6});/g)) {
      out.set(m[1] as string, (m[2] as string).toUpperCase())
    }
    return out
  }

  const expected = (
    stops: typeof STOPS_ON_DARK,
    motion: typeof MOTION_GRADIENTS_ON_DARK,
  ): Map<string, string> => {
    const out = new Map<string, string>()
    stops.forEach((s, i) => {
      out.set(`--ws-brand-mark-${i}`, s.color)
    })
    motion.forEach((g, i) => {
      out.set(`--ws-brand-mark-b${i + 1}-from`, g.from)
      out.set(`--ws-brand-mark-b${i + 1}-to`, g.to)
    })
    return out
  }

  it('浅色主题 = 规范那套压暗端点（§1.2「浅底的坑」）', () => {
    expect(varsIn(':root')).toEqual(expected(STOPS_ON_LIGHT, MOTION_GRADIENTS_ON_LIGHT))
  })

  it('深色主题 = 规范那套亮端点', () => {
    expect(varsIn('.dark')).toEqual(expected(STOPS_ON_DARK, MOTION_GRADIENTS_ON_DARK))
  })

  it('两套的键完全一样：一边有一边没有就会在某个主题下画出黑块', () => {
    expect([...varsIn(':root').keys()].sort()).toEqual([...varsIn('.dark').keys()].sort())
    // 3 个静态端点 + 6 块 × 起止 2 个
    expect(varsIn(':root').size).toBe(3 + 12)
  })
})
