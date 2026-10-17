/**
 * WP376（决策 1031）：Anthropic 本家的 key 有了自己的方案，「Anthropic 兼容（自定义）」那张卡不再预填地址——
 * 表单里地址必填、框里给个样子；有默认地址的卡照旧预填、不强制。
 */
import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ModelForm } from '@/components/models/model-form'
import type { ModelProviderTemplate } from '@/lib/api'
import { renderWithProviders } from './helpers'

const templateOf = (default_base_url: string) =>
  ({
    kind: 'anthropic_compatible',
    label: 'Anthropic 兼容（自定义）',
    summary: '',
    default_base_url,
    default_model: 'claude-sonnet-4-5',
    region: 'global',
    steps: [],
    links: [],
  }) as unknown as ModelProviderTemplate

const render = (url: string) =>
  renderWithProviders(
    <ModelForm
      template={templateOf(url)}
      busy={false}
      onCancel={() => undefined}
      onSubmit={() => undefined}
      onDiscover={async () => ({ ok: false, models: [], checked_at: '' })}
    />,
  )

describe('WP376 没有默认地址的卡', () => {
  it('地址必填、框里有样子', () => {
    render('')
    const input = screen.getByTestId('model-base-url') as HTMLInputElement
    expect(input.value).toBe('')
    expect(input.required).toBe(true)
    expect(input.placeholder).toContain('https://')
  })

  it('有默认地址的卡照旧预填、不强制', () => {
    render('https://api.anthropic.com')
    const input = screen.getByTestId('model-base-url') as HTMLInputElement
    expect(input.value).toBe('https://api.anthropic.com')
    expect(input.required).toBe(false)
  })
})
