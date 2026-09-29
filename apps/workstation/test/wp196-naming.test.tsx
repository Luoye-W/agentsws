/**
 * WP196：用户看得到的地方不露 `agentsws`。
 *
 * 顶栏模型芯片：积分那一路的模型 id 是 `agentsws/型号`（id 不改），芯片上显示成
 * 「Agents 工坊 · 型号」；别家的照原样。
 */
import { screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ModelChip, modelChipLabel } from '@/components/top-chips'
import { renderWithProviders } from './helpers'

const state = { model: 'agentsws/deepseek-flash' }

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getModelDefaults: async () => ({
      default: state.model,
      by_purpose: {},
      data_residency: 'cn',
      choices: [],
    }),
  }
})

describe('WP196：模型芯片不露 agentsws', () => {
  it('积分那一路显示成「Agents 工坊 · 型号」；别家、没有来源前缀的照原样', () => {
    expect(modelChipLabel('agentsws/deepseek-flash', 'Agents 工坊')).toBe(
      'Agents 工坊 · deepseek-flash',
    )
    expect(modelChipLabel('agentsws/deepseek-flash', 'Agents Workshop')).toBe(
      'Agents Workshop · deepseek-flash',
    )
    expect(modelChipLabel('deepseek/deepseek-chat', 'Agents 工坊')).toBe('deepseek/deepseek-chat')
    expect(modelChipLabel('gpt-4o', 'Agents 工坊')).toBe('gpt-4o')
  })

  it('顶栏芯片上是品牌名，悬停说明里也是；链接照旧去设置 → 模型', async () => {
    renderWithProviders(<ModelChip />)
    const chip = await screen.findByTestId('model-chip')
    expect(chip.textContent).toBe('Agents 工坊 · deepseek-flash')
    expect(chip.getAttribute('title')).toContain('Agents 工坊 · deepseek-flash')
    expect(chip.textContent).not.toContain('agentsws')
    expect(chip.getAttribute('href')).toContain('/settings?tab=models')
  })
})
