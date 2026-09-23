/**
 * WP131：插件深链 `/influencer/creators?batch=…&channel=…` 的落点。
 *
 * 带了 `channel` 就落到那条渠道的红人职责上（插件那一批来自 TikTok，就不该在 YouTube
 * 的面板里找它）；没带或找不到就退回第一条，与 WP119c 的老行为一样。
 */
import { screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { renderWithProviders } from './helpers'

const getPositions = vi.fn(async () => ({
  positions: [
    { position_id: 'asg_yt', role_id: 'kol.youtube' },
    { position_id: 'asg_tt', role_id: 'kol.tiktok' },
  ],
}))
const getKolCreators = vi.fn(async () => ({ rows: [] }))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getPositions: () => getPositions(),
    getKolCreators: (...a: unknown[]) => getKolCreators(...(a as [])),
    getKolSandbox: vi.fn(async () => ({ on: false })),
  }
})

const { InfluencerPage } = await import('@/pages/influencer')

describe('WP131 插件深链落点', () => {
  it('?channel=tiktok 落到 TikTok 那条职责，并按批次取', async () => {
    renderWithProviders(<InfluencerPage />, '/influencer/creators?batch=bt_abc123x&channel=tiktok')
    const panel = await screen.findByTestId('kol-panel')
    expect(panel.getAttribute('data-channel')).toBe('tiktok')
    expect(getKolCreators).toHaveBeenCalledWith(
      { channel: 'tiktok', batch: 'bt_abc123x' },
      'asg_tt',
    )
  })

  it('没带 channel：退回第一条职责（老行为）', async () => {
    renderWithProviders(<InfluencerPage />, '/influencer/creators?batch=bt_abc123x')
    const panel = await screen.findByTestId('kol-panel')
    expect(panel.getAttribute('data-channel')).toBe('youtube')
  })
})
