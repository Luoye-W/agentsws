/**
 * WP374（决策 980）：设置里「Anthropic 兼容（自定义）」那张卡与表单。
 *
 * - 「拉取模型列表」把这张卡的种类交上去（服务端据此按 Anthropic 口去拉）；
 * - 拉回来的清单照样能勾进 AI 钮；
 * - 卡有自己的一句话、首字母徽标、教程（与 OpenAI 兼容同一篇）。
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { hasBrandIcon } from '@/components/brand-icons'
import { ModelForm, type ModelFormValues } from '@/components/models/model-form'
import { groupTemplates } from '@/components/models/models-panel'
import type { ModelProviderTemplate } from '@/lib/api'
import { HELP_BY_VENDOR } from '@/lib/help'
import { translate } from '@/lib/i18n'
import { renderWithProviders } from './helpers'

const template = {
  kind: 'anthropic_compatible',
  label: 'Anthropic 兼容（自定义）',
  summary: '任何"Anthropic 格式"的服务都能接。',
  vendor: 'anthropic-compatible',
  vendor_label: 'Anthropic 兼容（自定义）',
  plan_label: '自己填地址与 key',
  default_base_url: 'https://api.anthropic.com',
  default_model: 'claude-sonnet-4-5',
  region: 'global',
  steps: [],
  links: [],
} as unknown as ModelProviderTemplate

describe('WP374 Anthropic 兼容那张卡', () => {
  it('拉清单时把种类交上去；拉回来的能勾进 AI 钮', async () => {
    const probes: unknown[] = []
    const saved: ModelFormValues[] = []
    renderWithProviders(
      <ModelForm
        template={template}
        busy={false}
        onCancel={() => undefined}
        onSubmit={(v) => saved.push(v)}
        onDiscover={async (probe) => {
          probes.push(probe)
          return {
            ok: true,
            models: ['claude-sonnet-4-5', 'relay-claude-special'],
            checked_at: '',
          }
        }}
      />,
    )
    fireEvent.click(screen.getByTestId('model-discover'))
    await waitFor(() => expect(probes).toHaveLength(1))
    expect(probes[0]).toMatchObject({
      kind: 'anthropic_compatible',
      base_url: 'https://api.anthropic.com',
    })
    const box = await screen.findByTestId('model-picker-models')
    const options = within(box).getAllByTestId('model-picker-option')
    expect(options.map((o) => o.getAttribute('data-model'))).toEqual(['relay-claude-special'])
    fireEvent.click(options[0] as HTMLElement)
    fireEvent.submit(screen.getByTestId('model-form'))
    expect(saved[0]?.picker_models).toEqual(['relay-claude-special'])
  })

  it('自己一张卡、有一句话（中英）、首字母徽标、教程', () => {
    const cards = groupTemplates([template])
    expect(cards.map((c) => c.id)).toEqual(['anthropic-compatible'])
    for (const lang of ['zh', 'en'] as const) {
      const key = 'models.vendor.anthropic-compatible'
      expect(translate(lang, key)).not.toBe(key)
    }
    expect(hasBrandIcon('anthropic-compatible')).toBe(true)
    expect(hasBrandIcon('anthropic_compatible')).toBe(true)
    expect(HELP_BY_VENDOR['anthropic-compatible']).toBe('model-openai-compatible')
  })
})
