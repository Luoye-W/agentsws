/**
 * WP154：职责页上「买家会问的问题」那一块。
 *
 * 钉三条（WP155 提醒）：每周花多少写在明处、数是服务端给的；关得掉；问几个调得动。
 */
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { renderWithProviders } from './helpers'

const view = {
  questions: [
    { id: 'gq_1', text: 'Is NordVolt worth it?', origin: 'brand' as const, enabled: true },
    {
      id: 'gq_2',
      text: 'What is the best USB-C charger?',
      origin: 'brand' as const,
      enabled: true,
    },
  ],
  settings: { enabled: true, max_questions: 6 },
  estimate: { questions: 2, platforms: 4, route: 'official' as const, credits_per_week: 3.2 },
}
const getGeoQuestions = vi.fn(async () => view)
const setGeoQuestions = vi.fn(async (input: { settings?: { enabled?: boolean } }) => ({
  ...view,
  settings: { ...view.settings, ...(input.settings ?? {}) },
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getGeoQuestions: () => getGeoQuestions(),
    setGeoQuestions: (input: never) => setGeoQuestions(input),
  }
})

const { GeoQuestions } = await import('@/components/seo/geo-questions')

describe('买家会问的问题', () => {
  it('花多少写在明处（服务端给的数，界面不自己乘）', async () => {
    renderWithProviders(<GeoQuestions assignment="asg_content" />)
    const cost = await screen.findByTestId('geo-cost')
    expect(cost.textContent).toContain('2')
    expect(cost.textContent).toContain('4')
    expect(cost.textContent).toContain('3.2')
    expect(screen.getByDisplayValue('Is NordVolt worth it?')).toBeDefined()
  })

  it('WP157 减字守卫：卡上可见说明不超上限，扣钱那句算状态', async () => {
    const { reportCard, CARD_TEXT_LIMIT } = await import('./less-text-guard')
    renderWithProviders(<GeoQuestions assignment="asg_content" />)
    await screen.findByTestId('geo-cost')
    const report = reportCard(screen.getByTestId('geo-questions'))
    expect(report.weight, report.text).toBeLessThanOrEqual(CARD_TEXT_LIMIT)
    expect(report.ordered).toBe(0)
  })

  it('关掉：发一次 settings.enabled = false，文案换成不问不花钱', async () => {
    renderWithProviders(<GeoQuestions assignment="asg_content" />)
    const toggle = await screen.findByTestId('geo-enabled')
    await userEvent.click(toggle)
    await waitFor(() => expect(setGeoQuestions).toHaveBeenCalled())
    expect(setGeoQuestions.mock.calls[0]?.[0]).toEqual({ settings: { enabled: false } })
    await waitFor(() => expect(screen.getByTestId('geo-cost').textContent).not.toContain('3.2'))
  })
})
