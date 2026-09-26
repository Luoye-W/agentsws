/**
 * WP155：连接页「搜索数据」一行。
 *
 * 三组断言：
 * 1. 三档按钮：没选过时高亮「现在实际走的那一档」；点了就发 setChoice；
 * 2. 官方那一档常显单价（从状态里读，不写死）；
 * 3. **key 零泄漏**：原生表单取出来只进 `setSearchDataByo` 那一次调用，不进 console、
 *    不进 localStorage，提交后 DOM 里也不留；读视图只说「已设置」。
 */
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SearchDataSettingsView } from '@/lib/api'
import { renderWithProviders } from './helpers'

const KEY = 'my-login:never-leaks-9c1e'

const state = { view: undefined as unknown as SearchDataSettingsView }
const choices: string[] = []
const saved: { provider: string; api_key?: string }[] = []
const tests: { provider?: string; api_key?: string }[] = []

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getSearchDataSettings: async () => state.view,
    setSearchDataChoice: async (choice: SearchDataSettingsView['choice']) => {
      choices.push(choice)
      state.view = { ...state.view, choice }
      return state.view
    },
    setSearchDataByo: async (input: {
      provider: 'dataforseo' | 'serpapi' | 'serper'
      api_key?: string
    }) => {
      saved.push(input)
      state.view = {
        choice: 'byo',
        byo: { provider: input.provider, has_key: true, updated_at: '2026-09-26T00:00:00.000Z' },
        status: { configured: true, route: 'byo', provider: input.provider },
      }
      return state.view
    },
    testSearchDataByo: async (input: { provider?: string; api_key?: string }) => {
      tests.push(input)
      return { ok: true, message: '通了。这把 key 能用。' }
    },
    clearSearchDataByo: async () => ({ cleared: true }),
  }
})

const { SearchDataSection } = await import('@/components/connections/search-data')

beforeEach(() => {
  state.view = {
    choice: 'auto',
    status: { configured: true, route: 'official', prices: { serp: 0.2, ai_answer: 0.4 } },
  }
  choices.length = 0
  saved.length = 0
  tests.length = 0
})

describe('搜索数据一行', () => {
  it('没选过：高亮实际走的官方那一档，常显单价', async () => {
    renderWithProviders(<SearchDataSection assignment="asg_owner" />, '/connections')
    const official = await screen.findByTestId('search-data-choice-official')
    expect(official.getAttribute('aria-checked')).toBe('true')
    expect(screen.getByTestId('search-data-price').textContent).toMatch(/0\.2 积分/)
    expect(screen.getByTestId('search-data-price').textContent).toMatch(/0\.4 积分/)
    // 官方那一档不说用的是哪家
    expect(document.body.textContent).not.toMatch(/DataForSEO|SerpApi|Serper/)
  })

  it('没选过、也什么都没接：一个按钮都不亮（用户并没有选「不接」），下面一句人话', async () => {
    state.view = {
      choice: 'auto',
      status: { configured: false, route: 'none', reason: '搜索数据接口还没接' },
    }
    renderWithProviders(<SearchDataSection assignment="asg_owner" />, '/connections')
    expect((await screen.findByTestId('search-data-status')).textContent).toMatch(/还没接/)
    for (const c of ['official', 'byo', 'none'])
      expect(screen.getByTestId(`search-data-choice-${c}`).getAttribute('aria-checked')).toBe(
        'false',
      )
  })

  it('选「不接」就发一次 setChoice', async () => {
    const user = userEvent.setup()
    renderWithProviders(<SearchDataSection assignment="asg_owner" />, '/connections')
    await user.click(await screen.findByTestId('search-data-choice-none'))
    await waitFor(() => expect(choices).toEqual(['none']))
  })

  it('自带 key：原生表单、password 字段；key 只进那一次调用，提交后 DOM 里不留', async () => {
    const log = vi.spyOn(console, 'log')
    const user = userEvent.setup()
    state.view = {
      choice: 'byo',
      status: { configured: false, route: 'none', reason: '你选了自带 key，但 key 还没填好。' },
    }
    renderWithProviders(<SearchDataSection assignment="asg_owner" />, '/connections')
    const form = await screen.findByTestId('search-data-byo')
    expect(form.tagName).toBe('FORM')
    const input = form.querySelector('input[name="api_key"]') as HTMLInputElement
    expect(input.type).toBe('password')
    expect(input.getAttribute('autocomplete')).toBe('off')
    await user.selectOptions(form.querySelector('select') as HTMLSelectElement, 'serpapi')
    await user.type(input, KEY)
    await user.click(screen.getByRole('button', { name: '测试连接' }))
    await waitFor(() => expect(tests).toEqual([{ provider: 'serpapi', api_key: KEY }]))
    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(saved).toEqual([{ provider: 'serpapi', api_key: KEY }]))
    await waitFor(() =>
      expect(screen.getByTestId('search-data-result').textContent).toMatch(/已保存/),
    )
    expect(document.body.innerHTML).not.toContain(KEY)
    expect(JSON.stringify({ ...localStorage })).not.toContain(KEY)
    expect(log.mock.calls.flat().join(' ')).not.toContain(KEY)
    await waitFor(() =>
      expect(
        (
          screen
            .getByTestId('search-data-byo')
            .querySelector('input[name="api_key"]') as HTMLInputElement
        ).placeholder,
      ).toMatch(/已设置/),
    )
  })
})
