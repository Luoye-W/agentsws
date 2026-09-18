/**
 * WP112：标记与动效**摆在哪儿**。
 *
 * `brand-mark.test.tsx` 管的是标记本身画得对不对；这一份管的是"哪一处该出哪种姿态"。
 * 每处只有一种，写在 docs/36 §12 那张表里——摆错位置的动效比没有动效更吵。
 */
import { act, cleanup, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppShell } from '@/components/app-shell'
import { BootSplash } from '@/components/boot-splash'
import { ChatTranscript } from '@/components/chat/transcript'
import { PositionCard } from '@/components/design'
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
    // 读屏听到的是「Agents 工坊」，眼睛看到的是标记 + 同一个名字
    expect(home.getAttribute('aria-label')).toBe('Agents 工坊')
    expect(home.textContent).toBe('Agents 工坊')

    const svg = home.querySelector('svg[data-testid="brand-mark"]')
    expect(svg).not.toBeNull()
    // logo 是**静态**的：一直在动的 logo 是噪音
    expect((svg as SVGElement).getAttribute('data-motion')).toBe('none')
    // 规范 §1.3 的最小可用尺寸，再小方块间的缝会并起来
    expect((svg as SVGElement).getAttribute('width')).toBe('24')
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

describe('呼吸 = 「Agent 正在替你干活」，全站只此一个语义', () => {
  it('岗位卡：有活在跑才出那个点，不跑的时候整个不出', () => {
    const card = (open: number): HTMLElement => {
      const { container } = renderWithProviders(
        <PositionCard
          name="客服"
          pending={2}
          pendingLabel="张待审"
          line="待回复 2"
          entryLabel="交给它一件事"
          {...(open > 0
            ? { running: true, runningLabel: '运行中', runningHint: `运行中 · ${open} 件在办` }
            : {})}
        />,
      )
      return container
    }
    const idle = card(0)
    expect(idle.querySelector('[data-testid="ws-position-running"]')).toBeNull()

    cleanup()
    const busy = card(3)
    const dot = busy.querySelector('[data-testid="ws-position-running"]')
    expect(dot).not.toBeNull()
    // 一个**状态点**：几件在办只在 hover 与读屏里说，卡面上不再印一遍那个数
    expect((dot as HTMLElement).getAttribute('title')).toBe('运行中 · 3 件在办')
    expect(dot?.querySelector('svg')?.getAttribute('data-motion')).toBe('breathe')
    // 14px < 28px，按规范 §1.3 自己退单色：跟着文字颜色走，不跳出来抢戏
    expect(dot?.querySelector('svg')?.getAttribute('data-variant')).toBe('mono')
  })

  it('对话线程：交出去了还没回来才出那一行', () => {
    const quiet = renderWithProviders(<ChatTranscript messages={[]} />)
    expect(quiet.container.querySelector('[data-testid="chat-thinking"]')).toBeNull()

    cleanup()
    const busy = renderWithProviders(<ChatTranscript messages={[]} busy />)
    const row = busy.container.querySelector('[data-testid="chat-thinking"]')
    expect(row?.textContent).toContain('客服 AI 正在判这一轮')
    expect(row?.querySelector('svg')?.getAttribute('data-motion')).toBe('breathe')
  })

  it('普通的加载转圈不换成呼吸：按钮里的 Loader2 还在，标记不进按钮', async () => {
    const { readFileSync } = await import('node:fs')
    const { dirname, join } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const here = dirname(fileURLToPath(import.meta.url))
    for (const rel of [
      'src/components/settings/browser-card.tsx',
      'src/components/models/model-form.tsx',
      'src/components/connections/standby-wizard.tsx',
    ]) {
      const src = readFileSync(join(here, '..', rel), 'utf8')
      expect(src).toContain('Loader2')
      expect(src).not.toContain('BrandMark')
      expect(src).not.toContain('AgentBusyMark')
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
    expect(html).toContain('<title>Agents 工坊</title>')
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
