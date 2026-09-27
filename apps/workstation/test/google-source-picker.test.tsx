/**
 * WP158：Search Console / GA4「选一下是哪个站点 / 媒体资源」那张小卡。
 *
 * 钉四条：连上没选才出卡；选了发一次、回来就收起；已经选好 / 没连不画；卡上字数过减字守卫。
 */
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { GoogleSourcesData } from '@/lib/api'
import { renderWithProviders } from './helpers'

const off = { connected: false, options: [], needs_pick: false }
let view: GoogleSourcesData = {
  gsc: {
    connected: true,
    needs_pick: true,
    options: [
      { id: 'sc-domain:example-shop.com', label: 'example-shop.com（整个域名）' },
      { id: 'https://www.example-shop.com/', label: 'https://www.example-shop.com/' },
    ],
  },
  ga4: off,
}
const getGoogleSources = vi.fn(async () => view)
const setGoogleSources = vi.fn(async (input: { gsc_site?: string }) => {
  view = {
    ...view,
    gsc: {
      ...view.gsc,
      needs_pick: false,
      ...(input.gsc_site === undefined ? {} : { selected: input.gsc_site }),
    },
  }
  return view
})

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getGoogleSources: () => getGoogleSources(),
    setGoogleSources: (input: never) => setGoogleSources(input),
  }
})

const { GoogleSourcePicker } = await import('@/components/seo/google-source-picker')

describe('选一下是哪个站点', () => {
  it('连上没选：一句话 + 下拉；卡上字数过减字守卫', async () => {
    const { reportCard, CARD_TEXT_LIMIT } = await import('./less-text-guard')
    renderWithProviders(<GoogleSourcePicker assignment="asg_content" source="gsc" />)
    const card = await screen.findByTestId('google-source-picker-gsc')
    expect(screen.getByRole('option', { name: 'example-shop.com（整个域名）' })).toBeDefined()
    const report = reportCard(card)
    expect(report.weight, report.text).toBeLessThanOrEqual(CARD_TEXT_LIMIT)
  })

  it('选了发一次，回来卡就收起', async () => {
    renderWithProviders(<GoogleSourcePicker assignment="asg_content" source="gsc" />)
    const select = await screen.findByTestId('google-source-gsc')
    await userEvent.selectOptions(select, 'https://www.example-shop.com/')
    await userEvent.click(screen.getByRole('button', { name: '就用这个' }))
    await waitFor(() => expect(setGoogleSources).toHaveBeenCalled())
    expect(setGoogleSources.mock.calls[0]?.[0]).toEqual({
      gsc_site: 'https://www.example-shop.com/',
    })
    await waitFor(() => expect(screen.queryByTestId('google-source-picker-gsc')).toBeNull())
  })

  it('没连不画', async () => {
    renderWithProviders(<GoogleSourcePicker assignment="asg_content" source="ga4" />)
    await waitFor(() => expect(getGoogleSources).toHaveBeenCalled())
    expect(screen.queryByTestId('google-source-picker-ga4')).toBeNull()
  })
})
