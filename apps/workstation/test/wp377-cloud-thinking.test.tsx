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
    options: [
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
  it('价目写了档：出小钮，默认「标准」，点「深度」回调 max', () => {
    const efforts = mount(PRO.id)
    const btn = screen.getByTestId('model-pick-thinking')
    expect(btn.getAttribute('data-level')).toBe('standard')
    fireEvent.click(btn)
    expect(screen.queryByTestId('model-pick-thinking-fast')).toBeNull()
    fireEvent.click(screen.getByTestId('model-pick-thinking-deep'))
    expect(efforts).toEqual([`${PRO.id}:max`])
  })

  it('价目没写：不出', () => {
    mount(GLM.id)
    expect(screen.queryByTestId('model-pick-thinking')).toBeNull()
  })
})
