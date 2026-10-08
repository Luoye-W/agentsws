/**
 * WP258：建站岗位页「还差店铺」那一行——登录后服务端自己找店，界面按找到的情况说：
 *
 * 1. 好几家 → 一个下拉框（店名 · 域名 · 套餐），选了即存（`source: 'list'`）；定了之后留一行「改哪家店」可以换；
 * 2. 一家都没有 → 照实说 +「换个账号登录」「去 Shopify 开店」；
 * 3. 没找成 → 手填那一格照旧 +「再找一次」；
 * 4. 「都不是？手动填」→ 手填（`source: 'manual'`）；只有一家自动定了 → 什么都不画。
 */
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SiteThemeBanner } from '@/components/position/site-theme-banner'
import type { PlatformKitView, SiteThemeStoreChoice, SiteThemeView } from '@/lib/api'
import { renderWithProviders } from './helpers'

const ROLLOUT = '6suegp-md.myshopify.com'
const STORES: SiteThemeStoreChoice[] = [
  { store: ROLLOUT, name: 'My Store', plan: 'basic', organization: 'Rollout' },
  { store: 'inmo-dev.myshopify.com', name: 'INMO Dev', plan: 'Development' },
]

const api = {
  view: undefined as SiteThemeView | undefined,
  gets: [] as boolean[],
  runs: [] as string[],
  saves: [] as { store: string; source?: string }[],
  opened: [] as string[],
}

const base = (extra: Partial<SiteThemeView>): SiteThemeView => ({
  applicable: true,
  cli: 'ready',
  workspace: { files: 0 },
  ...extra,
})

vi.mock('@/components/connections/bridge', async () => {
  const actual = await vi.importActual<typeof import('@/components/connections/bridge')>(
    '@/components/connections/bridge',
  )
  return { ...actual, openExternal: (url: string) => api.opened.push(url) }
})

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getSiteTheme: async (_assignment: string, fresh = false) => {
      api.gets.push(fresh)
      return api.view
    },
    setSiteThemeStore: async (store: string, _assignment: string, source?: string) => {
      api.saves.push({ store, ...(source === undefined ? {} : { source }) })
      api.view = base({
        store,
        store_source: source === 'list' ? 'cli' : 'manual',
        ...(source === 'list'
          ? { store_lookup: { status: 'ok', stores: STORES, checked_at: 'now' } }
          : {}),
      })
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
  api.view = undefined
  api.gets = []
  api.runs = []
  api.saves = []
  api.opened = []
})

const SITE = [{ role_id: 'site.shopify-theme', assignment_id: 'asg_theme' }]

describe('WP258 登录后自动找店', () => {
  it('好几家：下拉框（店名 · 域名 · 套餐），选了即存；定了留一行可以换', async () => {
    api.view = base({
      next: 'store',
      store_lookup: { status: 'ok', stores: STORES, checked_at: 'now' },
    })
    renderWithProviders(<SiteThemeBanner positionId="site" duties={SITE} />)
    const banner = await screen.findByTestId('site-theme-banner')
    expect(banner.getAttribute('data-store-mode')).toBe('pick')
    expect(banner.textContent).toContain('让 AI 改网站，选一下是哪家店')
    const select = screen.getByTestId('site-theme-store-pick') as HTMLSelectElement
    expect([...select.options].map((o) => o.textContent)).toEqual([
      '选一家店',
      'My Store · 6suegp-md.myshopify.com · basic',
      'INMO Dev · inmo-dev.myshopify.com · Development',
    ])
    // 没有手填那一格（要点「都不是？手动填」才出）
    expect(screen.queryByTestId('site-theme-store-input')).toBeNull()
    await userEvent.selectOptions(select, 'inmo-dev.myshopify.com')
    await waitFor(() =>
      expect(api.saves).toEqual([{ store: 'inmo-dev.myshopify.com', source: 'list' }]),
    )
    const row = await screen.findByTestId('site-theme-store-row')
    expect(row.textContent).toContain('改哪家店')
    expect(screen.queryByTestId('site-theme-banner')).toBeNull()
    const sw = screen.getByTestId('site-theme-store-switch') as HTMLSelectElement
    expect(sw.value).toBe('inmo-dev.myshopify.com')
    await userEvent.selectOptions(sw, ROLLOUT)
    await waitFor(() => expect(api.saves.at(-1)).toEqual({ store: ROLLOUT, source: 'list' }))
  })

  it('「都不是？手动填」：出手填那一格，存的是手填', async () => {
    api.view = base({
      next: 'store',
      store_lookup: { status: 'ok', stores: STORES, checked_at: 'now' },
    })
    renderWithProviders(<SiteThemeBanner positionId="site" duties={SITE} />)
    await userEvent.click(await screen.findByTestId('site-theme-manual'))
    await userEvent.type(screen.getByTestId('site-theme-store-input'), 'third-one')
    await userEvent.click(screen.getByTestId('site-theme-store-save'))
    await waitFor(() => expect(api.saves).toEqual([{ store: 'third-one', source: 'manual' }]))
    // 手填的不再出「改哪家店」那一行
    await waitFor(() => expect(screen.queryByTestId('site-theme-banner')).toBeNull())
    expect(screen.queryByTestId('site-theme-store-row')).toBeNull()
  })

  it('一家都没有：照实说 + 换个账号登录 + 去 Shopify 开店', async () => {
    api.view = base({
      next: 'store',
      store_lookup: { status: 'none', stores: [], checked_at: 'now' },
    })
    renderWithProviders(<SiteThemeBanner positionId="site" duties={SITE} />)
    const banner = await screen.findByTestId('site-theme-banner')
    expect(banner.textContent).toContain('这个 Shopify 账号下没有店铺')
    await userEvent.click(screen.getByTestId('site-theme-open-shopify'))
    expect(api.opened).toEqual(['https://www.shopify.com/'])
    await userEvent.click(screen.getByTestId('site-theme-relogin'))
    await waitFor(() => expect(api.runs).toEqual(['login']))
    expect(screen.getByTestId('site-theme-manual')).toBeTruthy()
  })

  it('没找成：手填照旧 + 再找一次（现查）', async () => {
    api.view = base({
      next: 'store',
      store_lookup: { status: 'failed', stores: [], checked_at: 'now', message: 'x' },
    })
    renderWithProviders(<SiteThemeBanner positionId="site" duties={SITE} />)
    const banner = await screen.findByTestId('site-theme-banner')
    expect(banner.textContent).toContain('让 AI 改网站，还差店铺地址')
    expect(screen.getByTestId('site-theme-store-input')).toBeTruthy()
    await userEvent.click(screen.getByTestId('site-theme-retry'))
    await waitFor(() => expect(api.gets).toContain(true))
  })

  it('只有一家、自动定了（或连了店 / 手填过）：什么都不画', async () => {
    api.view = base({
      store: ROLLOUT,
      store_source: 'cli',
      store_lookup: {
        status: 'ok',
        stores: [STORES[0] as SiteThemeStoreChoice],
        checked_at: 'now',
      },
    })
    renderWithProviders(<SiteThemeBanner positionId="site" duties={SITE} />)
    await waitFor(() => expect(api.gets).toHaveLength(1))
    expect(screen.queryByTestId('site-theme-banner')).toBeNull()
    expect(screen.queryByTestId('site-theme-store-row')).toBeNull()
  })
})

describe('WP267（决策 164）：只有一家但不是官网那家', () => {
  const ONE = [{ store: ROLLOUT, name: 'My Store', plan: 'basic' }]

  it('照实问「官网那家店不在这个账号下」+ 换个账号 / 就用这家；就用这家 = 从清单里选', async () => {
    api.view = base({
      next: 'store',
      site_store: 'inmo-official.myshopify.com',
      store_lookup: { status: 'ok', stores: ONE, checked_at: 'now' },
    })
    renderWithProviders(<SiteThemeBanner positionId="site" duties={SITE} />)
    const banner = await screen.findByTestId('site-theme-banner')
    expect(banner.getAttribute('data-store-mode')).toBe('mismatch')
    expect(banner.textContent).toContain('官网那家店（inmo-official.myshopify.com）不在这个账号下')
    expect(screen.queryByTestId('site-theme-store-pick')).toBeNull()
    await userEvent.click(screen.getByTestId('site-theme-mismatch-use'))
    await waitFor(() => expect(api.saves).toEqual([{ store: ROLLOUT, source: 'list' }]))
  })

  it('换个账号：起登录（登录卡在下面展开）', async () => {
    api.view = base({
      next: 'store',
      site_store: 'inmo-official.myshopify.com',
      store_lookup: { status: 'ok', stores: ONE, checked_at: 'now' },
    })
    renderWithProviders(<SiteThemeBanner positionId="site" duties={SITE} />)
    await userEvent.click(await screen.findByTestId('site-theme-mismatch-relogin'))
    await waitFor(() => expect(api.runs).toEqual(['login']))
  })

  it('官网没读到店：一家店照旧是「选一下」（服务端不会走到这里，界面也不瞎问）', async () => {
    api.view = base({
      next: 'store',
      store_lookup: { status: 'ok', stores: ONE, checked_at: 'now' },
    })
    renderWithProviders(<SiteThemeBanner positionId="site" duties={SITE} />)
    const banner = await screen.findByTestId('site-theme-banner')
    expect(banner.getAttribute('data-store-mode')).toBe('pick')
  })
})
