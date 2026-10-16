/**
 * WP363（决策 954）：AI 钮在消耗速率旁边写折扣——价目带了 `discount` 才写，没有不显示。
 *
 * 钉的：「1 折」挨着倍率、悬停说按原价几成收；没有折扣的那一行没有这一格；限免不带折扣；
 * 折数的写法（1 折 / 8.5 折 / 英文 90% off）与越界不显示。
 */
import { fireEvent, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { discountLabel, ModelPicker } from '@/components/free-chat/model-picker'
import type { FreeChatModelChoice } from '@/lib/free-chat'
import { renderWithProviders } from './helpers'

const CHOICES: FreeChatModelChoice[] = [
  {
    id: 'agentsws/deepseek-v4-pro',
    label: 'Agents 工坊（用积分）',
    official: true,
    vision: 'no',
    group: 'workshop',
    vendor: 'deepseek',
    price: { kind: 'rate', rate: 1, source: 'stats' },
  },
  {
    id: 'agentsws/kimi-k3',
    label: 'Agents 工坊（用积分）',
    official: true,
    vision: 'ok',
    group: 'workshop',
    vendor: 'moonshot',
    price: { kind: 'rate', rate: 1.3, source: 'stats', discount: 0.1 },
  },
  {
    id: 'agentsws/qwen3.8-max',
    label: 'Agents 工坊（用积分）',
    official: true,
    vision: 'ok',
    group: 'workshop',
    vendor: 'qwen',
    price: { kind: 'rate', rate: 2.34, source: 'list_price', discount: 0.85 },
  },
  {
    id: 'agentsws/deepseek-v4-flash-0731',
    label: 'Agents 工坊（用积分）',
    official: true,
    vision: 'no',
    group: 'workshop',
    vendor: 'deepseek',
    price: { kind: 'free' },
  },
]

function openMenu() {
  renderWithProviders(
    <ModelPicker
      choices={CHOICES}
      value="agentsws/deepseek-v4-pro"
      onChange={() => undefined}
      defaultId="agentsws/deepseek-v4-pro"
    />,
  )
  fireEvent.click(screen.getByTestId('model-pick'))
  const menu = screen.getByTestId('model-pick-menu')
  const row = (id: string) =>
    within(menu)
      .getAllByTestId('model-pick-option')
      .find((o) => o.dataset.model === id) as HTMLElement
  return { row }
}

describe('WP363 AI 钮：倍率旁边写折扣', () => {
  it('有折扣：倍率旁边写「1 折」「8.5 折」，悬停说按原价几成收；倍率照旧', () => {
    const { row } = openMenu()
    const kimi = row('agentsws/kimi-k3')
    expect(within(kimi).getByTestId('model-pick-price').textContent).toBe('1.3x')
    const off = within(kimi).getByTestId('model-pick-discount')
    expect(off.textContent).toBe('1 折')
    expect(off.getAttribute('title')).toBe('现在按原价的 10% 收；实际消耗以用量记录为准')
    // 折扣那一格挨在倍率前面（同一个右侧区域里）
    expect(off.nextElementSibling?.getAttribute('data-testid')).toBe('model-pick-price')
    expect(within(row('agentsws/qwen3.8-max')).getByTestId('model-pick-discount').textContent).toBe(
      '8.5 折',
    )
  })

  it('没有折扣不显示；限免那一行也不显示', () => {
    const { row } = openMenu()
    expect(within(row('agentsws/deepseek-v4-pro')).queryByTestId('model-pick-discount')).toBeNull()
    const free = row('agentsws/deepseek-v4-flash-0731')
    expect(within(free).queryByTestId('model-pick-discount')).toBeNull()
    expect(within(free).getByTestId('model-pick-price').textContent).toBe('限免')
  })

  it('折数写法：中文「N 折」、英文「N% off」；0 / 1 / 越界 / 不是数都不显示', () => {
    expect(discountLabel(0.1, 'zh')).toEqual({ text: '1 折', pct: 10 })
    expect(discountLabel(0.85, 'zh')).toEqual({ text: '8.5 折', pct: 85 })
    expect(discountLabel(0.05, 'zh')).toEqual({ text: '0.5 折', pct: 5 })
    expect(discountLabel(0.333, 'zh')).toEqual({ text: '3.3 折', pct: 33 })
    expect(discountLabel(0.1, 'en')).toEqual({ text: '90% off', pct: 10 })
    expect(discountLabel(0.001, 'zh')?.text).toBe('0.1 折')
    for (const bad of [0, 1, 1.5, -0.2, Number.NaN])
      expect(discountLabel(bad, 'zh')).toBeUndefined()
  })
})
