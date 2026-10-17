/**
 * WP377（决策 1051）：工坊积分的模型**云端价目写了思考档**就和别的来源一样出 WP373 的小钮（服务端已按价目算好
 * `thinking`），没写不出；选了哪档回调哪档的 id（决策 1032「显示什么就发什么」）。
 */
import { fireEvent, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ModelPicker } from '@/components/free-chat/model-picker'
import type { FreeChatModelChoice } from '@/lib/free-chat'
import { renderWithProviders } from './helpers'

const PRO: FreeChatModelChoice = {
  id: 'agentsws/deepseek-v4-pro',
  label: 'Agents 工坊（积分）',
  official: true,
  vision: 'no',
  group: 'workshop',
  vendor: 'deepseek',
  thinking: {
    // 决策 1054：v4 Pro 的「快」= 关掉思考
    options: [
      { level: 'fast', effort: 'off' },
      { level: 'standard', effort: 'high' },
      { level: 'deep', effort: 'max' },
    ],
    default: 'high',
  },
}
const GLM: FreeChatModelChoice = {
  id: 'agentsws/glm-5.3',
  label: 'Agents 工坊（积分）',
  official: true,
  vision: 'no',
  group: 'workshop',
  vendor: 'zhipu',
}

function mount(value: string): string[] {
  const efforts: string[] = []
  renderWithProviders(
    <ModelPicker
      choices={[PRO, GLM]}
      value={value}
      defaultId={PRO.id}
      onChange={() => undefined}
      onEffortChange={(e, model) => efforts.push(`${model}:${e}`)}
    />,
  )
  return efforts
}

describe('WP377 工坊积分的思考小钮', () => {
  it('价目写了档：出三档小钮，默认「标准」；点「深度」回调 max，点「快」回调 off（决策 1054）', () => {
    const efforts = mount(PRO.id)
    const btn = screen.getByTestId('model-pick-thinking')
    expect(btn.getAttribute('data-level')).toBe('standard')
    expect(btn.hasAttribute('data-toggle')).toBe(false)
    fireEvent.click(btn)
    fireEvent.click(screen.getByTestId('model-pick-thinking-deep'))
    fireEvent.click(screen.getByTestId('model-pick-thinking'))
    fireEvent.click(screen.getByTestId('model-pick-thinking-fast'))
    expect(efforts).toEqual([`${PRO.id}:max`, `${PRO.id}:off`])
  })

  it('价目没写：不出', () => {
    mount(GLM.id)
    expect(screen.queryByTestId('model-pick-thinking')).toBeNull()
  })
})
