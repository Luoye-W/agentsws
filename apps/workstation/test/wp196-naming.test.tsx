/**
 * WP196：用户看得到的地方不露 `agentsws`。
 *
 * WP342（决策 853）：顶栏模型芯片拿掉了，AI 在输入框左下角选——积分那一路（`agentsws/型号`）
 * 钮上只画工坊标记、无障碍名称「工坊」，一个字母的 `agentsws` 都不露；别家写型号短名。
 */
import { fireEvent, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ModelPicker } from '@/components/free-chat/model-picker'
import { translate } from '@/lib/i18n'
import { renderWithProviders } from './helpers'

const CHOICES = [
  {
    id: 'agentsws/deepseek-flash',
    label: 'Agents 工坊（用积分）',
    official: true,
    vision: 'no' as const,
  },
  { id: 'deepseek/deepseek-chat', label: 'DeepSeek 官方', official: false, vision: 'ok' as const },
]

describe('WP196 / WP342：输入框里的 AI 钮不露 agentsws', () => {
  it('工坊的模型：钮上只有工坊标记，无障碍名称「工坊」，没有名字', () => {
    renderWithProviders(
      <ModelPicker choices={CHOICES} value="agentsws/deepseek-flash" onChange={() => undefined} />,
    )
    const pick = screen.getByTestId('model-pick')
    expect(pick.textContent).toBe('')
    expect(pick.getAttribute('aria-label')).toContain('工坊')
    expect(pick.querySelector('svg rect')).not.toBeNull()
    for (const seen of [
      pick.textContent,
      pick.getAttribute('aria-label'),
      pick.getAttribute('title'),
    ])
      expect(seen ?? '').not.toContain('agentsws')
    expect(screen.getByRole('button', { name: /工坊/ })).toBe(pick)
  })

  it('自接的模型：服务商图标 + 型号短名', () => {
    renderWithProviders(
      <ModelPicker choices={CHOICES} value="deepseek/deepseek-chat" onChange={() => undefined} />,
    )
    const pick = screen.getByTestId('model-pick')
    // WP362：钮上是「来源 · 模型名」，来源取短名，照样不露 agentsws
    expect(pick.textContent).toBe('DeepSeek 官方 · deepseek-chat')
    fireEvent.click(pick)
    expect(screen.getByTestId('model-pick-menu').textContent).not.toContain('agentsws/')
  })
})

describe('WP196（Fable 定）：账号菜单里的身份格', () => {
  it('中文界面叫「所有者」（不露英文，也不和岗位「负责人」混）；英文界面照旧 Owner', () => {
    expect(translate('zh', 'account.role.owner')).toBe('所有者')
    expect(translate('zh', 'account.role.member')).toBe('成员')
    expect(translate('en', 'account.role.owner')).toBe('Owner')
    for (const key of ['account.role.owner', 'account.role.member'])
      expect(translate('zh', key)).not.toMatch(/^[A-Za-z ]+$/)
  })
})
