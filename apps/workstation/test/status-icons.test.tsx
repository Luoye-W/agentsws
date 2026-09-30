/**
 * WP214（36 §7 第四档）：通用状态图标 `StatusIcons`。
 *
 * - 四态（通 / 不通 / 没测 / 测试中）颜色 + 形状双编码：每态的角标图形不一样（色弱可辨）；
 * - tooltip 一句写进 `aria-label` 与 `data-hint`（读屏与 jsdom 都拿得到）；
 * - 可键盘聚焦（Tab 到它就出 tooltip）；
 * - 数字 / 名字（余额、账号）跟在图标旁常显；
 * - `useFresh`：刚点完测试的两分钟内为 true，到点自己翻回 false。
 */
import { act, renderHook, screen } from '@testing-library/react'
import { Eye, Plug, Wallet, Wrench } from 'lucide-react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FRESH_MS, StatusIcons, type StatusItem, useFresh } from '@/components/design'
import { renderWithProviders } from './helpers'

const ITEMS: StatusItem[] = [
  {
    key: 'connect',
    label: '连通',
    state: 'ok',
    icon: Plug,
    detail: '上次测 9月30日 14:00 · 2099ms',
  },
  { key: 'vision', label: '看图', state: 'fail', icon: Eye },
  { key: 'tools', label: '工具', state: 'unknown', icon: Wrench },
  { key: 'balance', label: '余额', state: 'pending', icon: Wallet, value: '¥28.11' },
]

describe('StatusIcons', () => {
  it('四态各一种形状：角标图形两两不同，data-state 对得上', () => {
    renderWithProviders(<StatusIcons items={ITEMS} label="验证结果" />)
    const icons = screen.getAllByTestId('status-icon')
    expect(icons.map((i) => i.dataset.state)).toEqual(['ok', 'fail', 'unknown', 'pending'])
    // 角标里的 svg（lucide 的 class 带图标名）：勾 / 叉 / 横 / 转圈，四种都不一样
    const marks = icons.map((i) => i.querySelector('span[aria-hidden] svg')?.getAttribute('class'))
    expect(new Set(marks).size).toBe(4)
    // 没测：虚线框、没有底色（不只靠颜色）
    expect(icons[2]?.className).toContain('border-dashed')
  })

  it('tooltip 一句进 aria-label / data-hint：这一项 + 状态 + 细节', () => {
    renderWithProviders(<StatusIcons items={ITEMS} />)
    const [connect, vision, tools, balance] = screen.getAllByTestId('status-icon')
    expect(connect?.getAttribute('aria-label')).toBe('连通：通\n上次测 9月30日 14:00 · 2099ms')
    expect(vision?.getAttribute('data-hint')).toBe('看图：不通')
    expect(tools?.getAttribute('aria-label')).toBe('工具：没测')
    expect(balance?.getAttribute('aria-label')).toBe('余额：测试中 ¥28.11')
  })

  it('每个图标都能用键盘聚焦；数字跟在图标旁常显；整排标为状态', () => {
    renderWithProviders(<StatusIcons items={ITEMS} label="验证结果" />)
    const icons = screen.getAllByTestId('status-icon')
    for (const icon of icons) expect(icon.tabIndex).toBe(0)
    act(() => {
      icons[0]?.focus()
    })
    expect(document.activeElement).toBe(icons[0])
    expect(screen.getByTestId('status-value').textContent).toBe('¥28.11')
    const row = screen.getByTestId('status-icons')
    expect(row.dataset.slot).toBe('status')
    expect(row.getAttribute('aria-label')).toBe('验证结果')
  })

  it('状态词可换：插件的「已装」、账号的「已登录」', () => {
    renderWithProviders(
      <StatusIcons
        items={[{ key: 'p', label: '定时任务', state: 'ok', stateText: '已装', icon: Plug }]}
      />,
    )
    expect(screen.getByTestId('status-icon').getAttribute('aria-label')).toBe('定时任务：已装')
  })

  it('空数组不画', () => {
    renderWithProviders(<StatusIcons items={[]} />)
    expect(screen.queryByTestId('status-icons')).toBeNull()
  })
})

describe('useFresh：刚点完测试的两分钟', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('没点过 → false；点过 → true，两分钟后自己翻回 false', () => {
    vi.useFakeTimers()
    const { result, rerender } = renderHook(({ at }: { at: number | undefined }) => useFresh(at), {
      initialProps: { at: undefined as number | undefined },
    })
    expect(result.current).toBe(false)
    rerender({ at: Date.now() })
    expect(result.current).toBe(true)
    act(() => {
      vi.advanceTimersByTime(FRESH_MS - 1000)
    })
    expect(result.current).toBe(true)
    act(() => {
      vi.advanceTimersByTime(2000)
    })
    expect(result.current).toBe(false)
  })
})
