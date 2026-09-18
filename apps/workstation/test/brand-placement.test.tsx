/**
 * WP112：标记与动效**摆在哪儿**。
 *
 * `brand-mark.test.tsx` 管的是标记本身画得对不对；这一份管的是"哪一处该出哪种姿态"。
 * 每处只有一种，写在 docs/36 §12 那张表里——摆错位置的动效比没有动效更吵。
 */
import { act, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppShell } from '@/components/app-shell'
import { BootSplash } from '@/components/boot-splash'
import type { PositionSummary } from '@/lib/api'
import { renderWithProviders } from './helpers'

const positions: PositionSummary[] = [
  {
    position_id: 'asg_1',
    role_id: 'dtc.support',
    role_name: '独立站售后客服',
    ranges: [],
    ready: true,
    missing_connectors: [],
    tile_ids: [],
    range: 'yesterday',
    show_tiles: true,
  },
]

describe('左栏顶部：标记 + 字标，点了回首页', () => {
  it('是一条指向 / 的链接，里面一个静态标记加一个字标', () => {
    renderWithProviders(
      <AppShell positions={positions} cards={[]} tileLibrary={[]} onAddTile={() => {}}>
        <div>主区</div>
      </AppShell>,
    )
    const home = screen.getByTestId('brand-home')
    expect(home.getAttribute('href')).toBe('/')
    // 读屏听到的是整句"agentsws 工作台"，眼睛看到的是标记 + `agentsws`
    expect(home.getAttribute('aria-label')).toBe('agentsws 工作台')
    expect(home.textContent).toBe('agentsws')

    const svg = home.querySelector('svg[data-testid="brand-mark"]')
    expect(svg).not.toBeNull()
    // logo 是**静态**的：一直在动的 logo 是噪音
    expect((svg as SVGElement).getAttribute('data-motion')).toBe('none')
    // 规范 §1.3 的最小可用尺寸，再小方块间的缝会并起来
    expect((svg as SVGElement).getAttribute('width')).toBe('28')
    expect((svg as SVGElement).getAttribute('data-variant')).toBe('gradient')
  })
})

describe('冷启动首屏：集结', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('300ms 之内什么都不画——本机几十毫秒就回来了，闪一下比没有更烦', () => {
    renderWithProviders(<BootSplash />)
    expect(screen.queryByTestId('boot-splash')).toBeNull()
    act(() => {
      vi.advanceTimersByTime(299)
    })
    expect(screen.queryByTestId('boot-splash')).toBeNull()
  })

  it('等够了才出现，出的是集结那一姿态', () => {
    renderWithProviders(<BootSplash />)
    act(() => {
      vi.advanceTimersByTime(300)
    })
    const splash = screen.getByTestId('boot-splash')
    expect(splash.querySelector('svg[data-testid="brand-mark"]')?.getAttribute('data-motion')).toBe(
      'assemble',
    )
  })
})

describe('reduced-motion 下摆在各处的标记也一律静态', () => {
  it('系统开了「少一点动效」，首屏那一个也不动', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }))
    vi.useFakeTimers()
    try {
      renderWithProviders(<BootSplash />)
      act(() => {
        vi.advanceTimersByTime(300)
      })
      expect(
        screen.getByTestId('boot-splash').querySelector('svg')?.getAttribute('data-motion'),
      ).toBe('none')
    } finally {
      vi.useRealTimers()
      vi.unstubAllGlobals()
    }
  })
})

describe('index.html：标签页图标接上了', () => {
  it('SVG 主版 + 32px PNG 后备，标题没动', async () => {
    const { readFileSync } = await import('node:fs')
    const { dirname, join } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const html = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'index.html'),
      'utf8',
    )
    expect(html).toContain('<link rel="icon" type="image/svg+xml" href="/favicon.svg" />')
    expect(html).toContain('href="/favicon-32.png"')
    expect(html).toContain('<title>agentsws 工作台</title>')
  })
})

describe('public/favicon.svg：深色圆底 + 一条整体渐变', () => {
  it('圆底是墨色，渐变仍是 userSpaceOnUse 的那一条，六块共用', async () => {
    const { readFileSync } = await import('node:fs')
    const { dirname, join } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const { GRADIENT_AXIS, INK } = await import('@agentsws/brand')
    const svg = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'favicon.svg'),
      'utf8',
    )
    expect(svg).toContain(`fill="${INK}"`)
    expect(svg).toContain('<circle')
    expect(svg).toContain('gradientUnits="userSpaceOnUse"')
    expect(svg).toContain(
      `x1="${GRADIENT_AXIS.x1}" y1="${GRADIENT_AXIS.y1}" x2="${GRADIENT_AXIS.x2}" y2="${GRADIENT_AXIS.y2}"`,
    )
    expect(svg.match(/<rect/g) ?? []).toHaveLength(6)
    expect(svg.match(/<linearGradient/g) ?? []).toHaveLength(1)
  })
})
