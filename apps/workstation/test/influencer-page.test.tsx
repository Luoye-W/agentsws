/**
 * WP131 / WP504：插件深链 `/influencer/creators?batch=…&channel=…`、`/influencer/setup` 的落点。
 *
 * WP504（决策 1765 / 1778 A）起红人库在红人营销岗位的第三栏：这两条路改成**跳转**到岗位页 `?panel=kol-library`，
 * `creator` / `batch` 原样带过去、`channel` 指着那条渠道的职责（插件那一批来自 TikTok，就不该在 YouTube 那条里找）；
 * 没带或找不到就退回第一条，与 WP119c 的老行为一样；一条红人职责都没有就跳首页、照样开那一格。
 */
import { screen } from '@testing-library/react'
import { Route, Routes, useLocation } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { renderWithProviders } from './helpers'

const getPositions = vi.fn(async () => ({
  positions: [
    { position_id: 'asg_yt', role_id: 'kol.youtube' },
    { position_id: 'asg_tt', role_id: 'kol.tiktok' },
  ],
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return { ...actual, getPositions: () => getPositions() }
})

const { InfluencerPage, influencerTarget } = await import('@/pages/influencer')

function Where(): React.ReactNode {
  const l = useLocation()
  return <p data-testid="where">{`${l.pathname}${l.search}`}</p>
}

function app(path: string, setup = false): void {
  renderWithProviders(
    <Routes>
      <Route path="/influencer/creators" element={<InfluencerPage />} />
      <Route path="/influencer/setup" element={<InfluencerPage setup={setup} />} />
      <Route path="*" element={<Where />} />
    </Routes>,
    path,
  )
}

const ROWS = [
  { position_id: 'asg_yt', role_id: 'kol.youtube' },
  { position_id: 'asg_tt', role_id: 'kol.tiktok' },
]

describe('WP131 / WP504 插件深链落点', () => {
  it('?channel=tiktok：跳到 TikTok 那条职责的岗位页，开红人库、带着这一批', async () => {
    app('/influencer/creators?batch=bt_abc123x&channel=tiktok')
    const where = await screen.findByTestId('where')
    const url = new URL(`http://x${where.textContent ?? ''}`)
    expect(url.pathname).toBe('/positions/asg_tt')
    expect(url.searchParams.get('panel')).toBe('kol-library')
    expect(url.searchParams.get('tab')).toBe('creators')
    expect(url.searchParams.get('batch')).toBe('bt_abc123x')
    expect(url.searchParams.get('channel')).toBe('tiktok')
  })

  it('没带 channel：退回第一条职责（老行为）；?creator= 原样带过去（库里叠开那个人）', () => {
    const to = influencerTarget(ROWS, new URLSearchParams('creator=@deskfixture'), false)
    const url = new URL(`http://x${to}`)
    expect(url.pathname).toBe('/positions/asg_yt')
    expect(url.searchParams.get('creator')).toBe('@deskfixture')
    expect(url.searchParams.get('channel')).toBe('youtube')
  })

  it('/influencer/setup → 「活动」那一格；老的 ?kol=threads → 「合作」那一格', () => {
    expect(
      new URL(`http://x${influencerTarget(ROWS, new URLSearchParams(), true)}`).searchParams.get(
        'tab',
      ),
    ).toBe('campaign')
    expect(
      new URL(
        `http://x${influencerTarget(ROWS, new URLSearchParams('kol=threads'), false)}`,
      ).searchParams.get('tab'),
    ).toBe('collab')
  })

  it('一条红人职责都没有：跳首页、照样开那一格（面板照实说）', () => {
    const to = influencerTarget(
      [{ position_id: 'asg_cs', role_id: 'cs.site' }],
      new URLSearchParams(),
      false,
    )
    expect(to.startsWith('/?')).toBe(true)
    expect(new URL(`http://x${to}`).searchParams.get('panel')).toBe('kol-library')
  })
})
