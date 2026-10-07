/**
 * WP253：建站岗位页「让 AI 改网站还差哪一步」那一行 + 时间线上的「打开预览」。
 *
 * 1. 没装 → 一句话 +「一键安装」（点了就跑 WP245 的一键安装，卡在下面展开看进度）；
 * 2. 没登录 →「登录 Shopify」；不知道店 → 一格店铺地址，填了就存；都好了 / 不是 Shopify → 什么都不画；
 * 3. 不是网页模板岗位（没有那条职责）→ 不问服务端、不画。
 */
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SiteThemeBanner } from '@/components/position/site-theme-banner'
import type { PlatformKitView, SiteThemeView } from '@/lib/api'
import { renderWithProviders } from './helpers'

const api = {
  view: undefined as SiteThemeView | undefined,
  gets: [] as string[],
  runs: [] as string[],
  stores: [] as string[],
}

const view = (next: SiteThemeView['next'], extra: Partial<SiteThemeView> = {}): SiteThemeView => ({
  applicable: true,
  cli: next === 'install_cli' ? 'missing' : next === 'login' ? 'needs_login' : 'ready',
  workspace: { files: 0 },
  ...(next === undefined ? {} : { next }),
  ...extra,
})

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getSiteTheme: async (assignment: string) => {
      api.gets.push(assignment)
      return api.view
    },
    setSiteThemeStore: async (store: string) => {
      api.stores.push(store)
      api.view = view(undefined, { store: '6suegp-md.myshopify.com' })
      return api.view
    },
    runPlatformCli: async (action: string) => {
      api.runs.push(action)
      return { platform: 'shopify', kit: null } satisfies PlatformKitView
    },
    getPlatformKit: async () => ({ platform: 'shopify', kit: null }) satisfies PlatformKitView,
  }
})

beforeEach(() => {
  api.view = view('install_cli')
  api.gets = []
  api.runs = []
  api.stores = []
})

const SITE = [{ role_id: 'site.shopify-theme', assignment_id: 'asg_theme' }]

describe('WP253 建站岗位页引导', () => {
  it('没装：一句话 + 一键安装（用网页模板那条分配）', async () => {
    renderWithProviders(<SiteThemeBanner positionId="site" duties={SITE} />)
    const banner = await screen.findByTestId('site-theme-banner')
    expect(banner.getAttribute('data-next')).toBe('install_cli')
    expect(banner.textContent).toContain('让 AI 改网站，要先装 Shopify CLI')
    await userEvent.click(screen.getByTestId('site-theme-install'))
    await waitFor(() => expect(api.runs).toEqual(['install']))
    expect(api.gets[0]).toBe('asg_theme')
    // 界面里没有命令行、没有终端的字眼
    expect(banner.textContent ?? '').not.toMatch(/npm|终端|terminal/i)
  })

  it('没登录：登录 Shopify', async () => {
    api.view = view('login')
    renderWithProviders(<SiteThemeBanner positionId="site" duties={SITE} />)
    await userEvent.click(await screen.findByTestId('site-theme-login'))
    await waitFor(() => expect(api.runs).toEqual(['login']))
  })

  it('不知道店：填地址保存，好了这一行就消失', async () => {
    api.view = view('store')
    renderWithProviders(<SiteThemeBanner positionId="site" duties={SITE} />)
    await userEvent.type(await screen.findByTestId('site-theme-store-input'), '6suegp-md')
    await userEvent.click(screen.getByTestId('site-theme-store-save'))
    await waitFor(() => expect(api.stores).toEqual(['6suegp-md']))
    await waitFor(() => expect(screen.queryByTestId('site-theme-banner')).toBeNull())
  })

  it('都好了 / 不是 Shopify / 没有网页模板那条职责：什么都不画', async () => {
    api.view = view(undefined)
    const { unmount } = renderWithProviders(<SiteThemeBanner positionId="site" duties={SITE} />)
    await waitFor(() => expect(api.gets).toHaveLength(1))
    expect(screen.queryByTestId('site-theme-banner')).toBeNull()
    unmount()
    api.view = { ...view('install_cli'), applicable: false }
    renderWithProviders(<SiteThemeBanner positionId="site" duties={SITE} />)
    await waitFor(() => expect(api.gets).toHaveLength(2))
    expect(screen.queryByTestId('site-theme-banner')).toBeNull()
    renderWithProviders(
      <SiteThemeBanner
        positionId="care"
        duties={[{ role_id: 'dtc.support', assignment_id: 'a' }]}
      />,
    )
    expect(api.gets).toHaveLength(2)
  })
})
