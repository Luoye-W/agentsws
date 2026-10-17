/**
 * WP362（Luoye 10-16）：输入框的 AI 钮学 Proma——搜索、按来源分组、每行厂商图标 + 模型名 + 右边那一格。
 *
 * 钉的：组的顺序与名字；工坊那组标题挂余额 / 本月还剩、问号里说消耗速率怎么算（基准对不上时照实说）；
 * 每行右边：消耗速率 / 限免 / 订阅额度 / 用你自己的 key；搜索按模型名与厂商过滤；钮上「来源 · 模型名」，
 * 工坊那组只画标记、悬停出全名；ChatGPT 订阅的模型能选。
 */
import { fireEvent, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ModelPicker } from '@/components/free-chat/model-picker'
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
    id: 'agentsws/qwen3.8-max',
    label: 'Agents 工坊（用积分）',
    official: true,
    vision: 'ok',
    group: 'workshop',
    vendor: 'qwen',
    price: { kind: 'rate', rate: 2.34, source: 'list_price' },
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
  {
    id: 'openai-codex/gpt-5.5',
    label: 'ChatGPT 订阅',
    official: false,
    vision: 'ok',
    group: 'subscription',
    vendor: 'openai',
    price: { kind: 'subscription' },
  },
  {
    id: 'mine/gpt-4o-mini',
    label: 'OpenAI（我的 key）',
    official: false,
    vision: 'unchecked',
    group: 'own',
    vendor: 'openai',
    price: { kind: 'own_key' },
  },
]

function open(value: string, extra: Partial<Parameters<typeof ModelPicker>[0]> = {}) {
  const picked: string[] = []
  renderWithProviders(
    <ModelPicker
      choices={CHOICES}
      value={value}
      onChange={(id) => picked.push(id)}
      defaultId="agentsws/deepseek-v4-pro"
      {...extra}
    />,
  )
  const pick = screen.getByTestId('model-pick')
  fireEvent.click(pick)
  return { pick, picked, menu: screen.getByTestId('model-pick-menu') }
}

describe('WP362 AI 钮：按来源分组、每行右边那一格', () => {
  it('组：工坊积分 → ChatGPT 订阅 → 自己接的；每行右边是消耗速率 / 限免 / 订阅额度 / 用你自己的 key', () => {
    const { menu } = open('agentsws/deepseek-v4-pro')
    const groups = within(menu).getAllByTestId('model-pick-group')
    expect(groups.map((g) => g.dataset.group)).toEqual(['workshop', 'subscription', 'own'])
    expect(groups[0]?.textContent).toContain('Agents 工坊（积分）')
    expect(groups[1]?.textContent).toContain('ChatGPT 订阅')
    expect(groups[2]?.textContent).toContain('OpenAI（我的 key）')
    const price = (id: string) =>
      within(
        within(menu)
          .getAllByTestId('model-pick-option')
          .find((o) => o.dataset.model === id) as HTMLElement,
      ).getByTestId('model-pick-price').textContent
    expect(price('agentsws/deepseek-v4-pro')).toBe('1.0x')
    expect(price('agentsws/qwen3.8-max')).toBe('2.3x')
    expect(price('agentsws/deepseek-v4-flash-0731')).toBe('限免')
    expect(price('openai-codex/gpt-5.5')).toBe('订阅额度')
    expect(price('mine/gpt-4o-mini')).toBe('用你自己的 key')
    // 底部「管理模型…」开设置弹窗的「AI → 模型」（WP356）
    expect(within(menu).getByTestId('model-pick-manage').getAttribute('href')).toBe(
      '/settings/models',
    )
    // 厂商图标（LobeHub 那几张）
    expect(menu.querySelector('[data-testid="vendor-icon"][data-vendor="qwen"]')).not.toBeNull()
  })

  it('工坊那组：标题挂余额；公司模式写本月还剩；问号里说消耗速率怎么算，基准对不上时照实说', () => {
    const { menu } = open('agentsws/deepseek-v4-pro', {
      balance: { kind: 'balance', credits: 96.059 },
      rateBase: { model: 'qwen3.8-max', fallback: true },
    })
    expect(within(menu).getByTestId('model-pick-balance').textContent).toBe('余额 96.06 积分')
    const note = within(menu).getByTestId('model-pick-rate-note').getAttribute('data-hint') ?? ''
    expect(note).toContain('DeepSeek v4 Pro 官方原价的几倍')
    expect(note).toContain('按 qwen3.8-max 算 1x')
  })

  it('公司模式：本月还剩', () => {
    const { menu } = open('agentsws/deepseek-v4-pro', {
      balance: { kind: 'member_left', credits: 320 },
    })
    expect(within(menu).getByTestId('model-pick-balance').textContent).toBe('本月还剩 320 积分')
  })

  it('搜索按模型名与厂商过滤；对不上就说没有', () => {
    const { menu } = open('agentsws/deepseek-v4-pro')
    const search = within(menu).getByTestId('model-pick-search')
    fireEvent.change(search, { target: { value: 'qwen' } })
    expect(
      within(menu)
        .getAllByTestId('model-pick-option')
        .map((o) => o.dataset.model),
    ).toEqual(['agentsws/qwen3.8-max'])
    fireEvent.change(search, { target: { value: 'openai' } })
    expect(
      within(menu)
        .getAllByTestId('model-pick-option')
        .map((o) => o.dataset.model),
    ).toEqual(['openai-codex/gpt-5.5', 'mine/gpt-4o-mini'])
    fireEvent.change(search, { target: { value: 'zzz' } })
    expect(within(menu).queryAllByTestId('model-pick-option')).toHaveLength(0)
    expect(within(menu).getByTestId('model-pick-empty').textContent).toBe('没有对得上的模型')
  })

  it('钮上：订阅是「ChatGPT 订阅 · gpt-5.5」；工坊那组只画标记、悬停出全名；订阅的模型能选', () => {
    const sub = open('openai-codex/gpt-5.5')
    expect(sub.pick.textContent).toBe('ChatGPT 订阅 · gpt-5.5')
    fireEvent.click(
      within(sub.menu)
        .getAllByTestId('model-pick-option')
        .find((o) => o.dataset.model === 'agentsws/qwen3.8-max') as HTMLElement,
    )
    expect(sub.picked).toEqual(['agentsws/qwen3.8-max'])
  })

  it('工坊那组：钮上没有字，title 是「Agents 工坊（积分） · 模型名」', () => {
    renderWithProviders(
      <ModelPicker choices={CHOICES} value="agentsws/qwen3.8-max" onChange={() => undefined} />,
    )
    const pick = screen.getByTestId('model-pick')
    expect(pick.textContent).toBe('')
    expect(pick.getAttribute('title')).toContain('Agents 工坊（积分） · qwen3.8-max')
    expect(pick.getAttribute('aria-label')).toBe('这次用的 AI：工坊')
  })
})
