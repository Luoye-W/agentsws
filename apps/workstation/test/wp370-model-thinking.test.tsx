/**
 * WP370（Luoye 10-17，照官方 dsh alpha.5 的模型选择）：AI 钮的思考程度、显示名、能力小标、搜索；
 * 设置里自定义接口「也在 AI 钮里显示」。
 *
 * 钉的：有档的模型才出「思考：快 / 标准 / 深度」，点了回调这一档 + 当前模型；不是默认档时钮上多「· 深度」；
 * 没档的模型（OpenAI 兼容 / 工坊积分）不出这一行；每行用目录里的显示名；订阅那一行有「自带联网」「长上下文」小标；
 * 模型不多于 4 个不出搜索，多于 4 个出、而且不连续的字也对得上；设置表单勾的模型随保存交上去。
 */
import { fireEvent, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ModelPicker, matchScore } from '@/components/free-chat/model-picker'
import { ModelForm, type ModelFormValues } from '@/components/models/model-form'
import type { ModelProviderTemplate, ModelProviderView } from '@/lib/api'
import type { FreeChatModelChoice, ReasoningEffort } from '@/lib/free-chat'
import { renderWithProviders } from './helpers'

const SUB: FreeChatModelChoice = {
  id: 'openai-codex/gpt-5.5',
  label: 'ChatGPT 订阅',
  official: false,
  vision: 'ok',
  group: 'subscription',
  vendor: 'openai',
  price: { kind: 'subscription' },
  name: 'GPT-5.5',
  context_window: 272_000,
  native_search: true,
  thinking: {
    options: [
      { level: 'fast', effort: 'low' },
      { level: 'standard', effort: 'medium' },
      { level: 'deep', effort: 'high' },
    ],
    default: 'medium',
  },
}
const OWN: FreeChatModelChoice = {
  id: 'mine/gpt-4o-mini',
  label: 'OpenAI（我的 key）',
  official: false,
  vision: 'unchecked',
  group: 'own',
  vendor: 'openai',
  price: { kind: 'own_key' },
}

function open(
  choices: FreeChatModelChoice[],
  value: string,
  effort?: ReasoningEffort,
): { picks: string[]; efforts: string[]; trigger: HTMLElement } {
  const picks: string[] = []
  const efforts: string[] = []
  renderWithProviders(
    <ModelPicker
      choices={choices}
      value={value}
      onChange={(id) => picks.push(id)}
      effort={effort}
      onEffortChange={(e, model) => efforts.push(`${model}:${e}`)}
    />,
  )
  const trigger = screen.getByTestId('model-pick')
  fireEvent.click(trigger)
  return { picks, efforts, trigger }
}

describe('WP370 AI 钮：思考程度（WP373 起挪成钮右边的独立小钮）', () => {
  it('有档的模型出三档白话，默认标准；点「深度」回调 high + 当前模型', () => {
    const { efforts } = open([SUB, OWN], SUB.id)
    fireEvent.click(screen.getByTestId('model-pick'))
    fireEvent.click(screen.getByTestId('model-pick-thinking'))
    const menu = screen.getByTestId('model-pick-thinking-menu')
    expect(within(menu).getByTestId('model-pick-thinking-fast').textContent).toBe('快')
    expect(
      within(menu).getByTestId('model-pick-thinking-standard').getAttribute('aria-checked'),
    ).toBe('true')
    fireEvent.click(within(menu).getByTestId('model-pick-thinking-deep'))
    expect(efforts).toEqual(['openai-codex/gpt-5.5:high'])
  })

  it('当前这一档直接写在小钮上；AI 钮上不再多写「· 深度」', () => {
    open([SUB, OWN], SUB.id, 'high')
    expect(screen.getByTestId('model-pick-thinking').textContent).toContain('深度')
    expect(screen.queryByTestId('model-pick-effort-tag')).toBeNull()
    expect(screen.getByTestId('model-pick').textContent).not.toContain('深度')
  })

  it('默认档写「标准」', () => {
    open([SUB, OWN], SUB.id, 'medium')
    expect(screen.getByTestId('model-pick-thinking').textContent).toContain('标准')
  })

  it('没声明档位的模型（自己接的 OpenAI 兼容口）不出思考那个钮', () => {
    open([SUB, OWN], OWN.id)
    expect(screen.queryByTestId('model-pick-thinking')).toBeNull()
  })
})

describe('WP370 AI 钮：显示名、能力小标、搜索', () => {
  it('每行用目录里的显示名；能力小标只标组里的例外（WP426：人人都有的不逐行写）', () => {
    // 订阅组里另有一个没自带联网、上下文短的：有的那一行才标「自带联网」「长上下文」
    const plain: FreeChatModelChoice = {
      ...SUB,
      id: 'openai-codex/gpt-mini',
      name: 'GPT mini',
      native_search: false,
      context_window: 32_000,
    }
    open([SUB, plain, OWN], SUB.id)
    const rows = screen.getAllByTestId('model-pick-option')
    expect(rows[0]?.textContent).toContain('GPT-5.5')
    expect(rows[2]?.textContent).toContain('gpt-4o-mini')
    expect(within(rows[0] as HTMLElement).getByTestId('model-pick-cap-web').textContent).toBe(
      '自带联网',
    )
    expect(within(rows[0] as HTMLElement).getByTestId('model-pick-cap-long')).toBeTruthy()
    expect(within(rows[1] as HTMLElement).queryByTestId('model-pick-cap-web')).toBeNull()
    expect(within(rows[2] as HTMLElement).queryByTestId('model-pick-cap-web')).toBeNull()
  })

  it('WP426：组里人人都有的能力不逐行标（订阅组只有它一个）', () => {
    open([SUB, OWN], SUB.id)
    expect(screen.queryByTestId('model-pick-cap-web')).toBeNull()
    expect(screen.queryByTestId('model-pick-cap-long')).toBeNull()
  })

  it('不多于 4 个不出搜索框', () => {
    open([SUB, OWN], SUB.id)
    expect(screen.queryByTestId('model-pick-search')).toBeNull()
  })

  it('多于 4 个出搜索；不连续的字按顺序也对得上（gpt55 → GPT-5.5），前缀对上的排前', () => {
    const more = ['a1', 'a2', 'a3'].map((m) => ({ ...OWN, id: `mine/${m}` }))
    open([SUB, OWN, ...more], SUB.id)
    fireEvent.change(screen.getByTestId('model-pick-search'), { target: { value: 'gpt55' } })
    const rows = screen.getAllByTestId('model-pick-option')
    expect(rows.map((r) => r.getAttribute('data-model'))).toEqual(['openai-codex/gpt-5.5'])
    expect(matchScore('gpt', 'GPT-5.5')).toBe(0)
    expect(matchScore('55', 'GPT-5.5')).toBeGreaterThan(0)
    expect(matchScore('zz', 'GPT-5.5')).toBeUndefined()
  })
})

describe('WP370 设置：自定义接口「也在 AI 钮里显示」', () => {
  const template = {
    kind: 'openai_compatible',
    label: 'OpenAI 兼容',
    summary: '',
    default_base_url: 'https://api.example.com/v1',
    default_model: 'gpt-4o-mini',
    region: 'global',
  } as unknown as ModelProviderTemplate
  const existing = {
    id: 'mine',
    kind: 'openai_compatible',
    label: 'OpenAI（我的 key）',
    base_url: 'https://api.example.com/v1',
    model: 'gpt-4o-mini',
    region: 'global',
    has_key: true,
    active: true,
    models: ['gpt-4o-mini', 'gpt-4.1', 'o4-mini'],
    picker_models: ['o4-mini'],
  } as unknown as ModelProviderView

  it('拉到的清单可勾；保存时把勾的交上去（主模型不算）', () => {
    const saved: ModelFormValues[] = []
    renderWithProviders(
      <ModelForm
        template={template}
        existing={existing}
        busy={false}
        onCancel={() => undefined}
        onSubmit={(v) => saved.push(v)}
        onDiscover={async () => ({ ok: true, models: [], checked_at: '' })}
      />,
    )
    const box = screen.getByTestId('model-picker-models')
    const options = within(box).getAllByTestId('model-picker-option')
    // 主模型（gpt-4o-mini）总在 AI 钮里，清单里不再列它
    expect(options.map((o) => o.getAttribute('data-model'))).toEqual(['gpt-4.1', 'o4-mini'])
    fireEvent.click(options[0] as HTMLElement)
    fireEvent.submit(screen.getByTestId('model-form'))
    expect(saved[0]?.picker_models).toEqual(['o4-mini', 'gpt-4.1'])
  })

  it('没拉到清单就手填，一行一个', () => {
    const saved: ModelFormValues[] = []
    renderWithProviders(
      <ModelForm
        template={template}
        existing={{ ...existing, models: [], picker_models: [] } as ModelProviderView}
        busy={false}
        onCancel={() => undefined}
        onSubmit={(v) => saved.push(v)}
        onDiscover={async () => ({ ok: false, models: [], checked_at: '' })}
      />,
    )
    fireEvent.change(screen.getByTestId('model-picker-manual'), {
      target: { value: 'qwen-max\n\nqwen-plus ' },
    })
    fireEvent.submit(screen.getByTestId('model-form'))
    expect(saved[0]?.picker_models).toEqual(['qwen-max', 'qwen-plus'])
  })
})
