/**
 * WP261：岗位页「授权管理商品和页面」那一行。
 *
 * 1. 没授权 → 一句话 +「授权管理商品和页面」（按这个岗位上的职责要权限）；
 * 2. 等浏览器 → 转圈 +「没弹出来？」+ 取消；CLI 开不了浏览器时由工作台开一次；
 * 3. 过期 / 被收回 / 缺权限 →「重新授权」并说缺哪项（人话，不出 scope 原名）；
 * 4. 授权好了 → 一行淡色「已授权 · 到几点」；没装 CLI / 不知道店：网页模板岗位上不重复出；
 * 5. 没有登记的职责 → 不问服务端、不画。
 */
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ShopAdminBanner } from '@/components/position/shop-admin-banner'
import type { ShopAdminView } from '@/lib/api'
import { renderWithProviders } from './helpers'

const api = {
  view: undefined as ShopAdminView | undefined,
  gets: [] as { assignment: string; roles: string[] }[],
  runs: [] as { action: string; roles: string[] }[],
  opened: [] as string[],
}

const view = (
  state: ShopAdminView['state'],
  extra: Partial<ShopAdminView> = {},
): ShopAdminView => ({
  applicable: true,
  state,
  store: 'rollout-test.myshopify.com',
  scopes_needed: ['write_products', 'write_discounts'],
  scopes_granted: [],
  missing: [],
  ...extra,
})

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getShopAdmin: async (assignment: string, roles: string[]) => {
      api.gets.push({ assignment, roles: [...roles] })
      return api.view
    },
    runShopAdmin: async (action: string, _assignment: string, roles: string[]) => {
      api.runs.push({ action, roles: [...roles] })
      api.view = view('authorizing', {
        job: {
          action: 'authorize',
          phase: 'waiting_browser',
          started_at: 't1',
          auth_url: 'https://rollout-test.myshopify.com/admin/oauth/authorize?x=1',
          browser_opened: false,
        },
      })
      return api.view
    },
    cancelShopAdmin: async () => {
      api.view = view('unauthorized')
      return api.view
    },
  }
})
vi.mock('@/components/connections/bridge', () => ({
  openExternal: (url: string) => api.opened.push(url),
}))

beforeEach(() => {
  api.view = view('unauthorized')
  api.gets = []
  api.runs = []
  api.opened = []
})

const STORE = [{ role_id: 'dtc.store', assignment_id: 'asg_store' }]

describe('WP261 授权管理商品和页面', () => {
  it('没授权：一个按钮；点了按这个岗位的职责起授权，CLI 开不了浏览器时由工作台开一次', async () => {
    renderWithProviders(
      <ShopAdminBanner duties={[...STORE, { role_id: 'support.inbox', assignment_id: 'asg_x' }]} />,
    )
    const banner = await screen.findByTestId('shop-admin-banner')
    expect(banner.getAttribute('data-state')).toBe('unauthorized')
    expect(banner.textContent).toContain('要先授权')
    expect(api.gets[0]).toEqual({ assignment: 'asg_store', roles: ['dtc.store'] })
    await userEvent.click(screen.getByTestId('shop-admin-authorize'))
    await waitFor(() => expect(api.runs).toEqual([{ action: 'authorize', roles: ['dtc.store'] }]))
    await waitFor(() =>
      expect(screen.getByTestId('shop-admin-banner').getAttribute('data-state')).toBe(
        'authorizing',
      ),
    )
    expect(screen.getByTestId('shop-admin-open')).toBeTruthy()
    await waitFor(() => expect(api.opened).toHaveLength(1))
    expect(banner.textContent ?? '').not.toMatch(/npm|终端|terminal|scope/i)
  })

  it('缺权限 / 过期 / 被收回：重新授权，缺哪项说人话', async () => {
    api.view = view('missing_scopes', {
      missing: ['write_discounts', 'write_online_store_navigation'],
    })
    const { unmount } = renderWithProviders(<ShopAdminBanner duties={STORE} />)
    const banner = await screen.findByTestId('shop-admin-banner')
    expect(banner.textContent).toContain('店铺授权还缺：建折扣、改菜单')
    expect(screen.getByTestId('shop-admin-authorize').textContent).toContain('重新授权')
    unmount()
    api.view = view('expired', { problem: { code: 'revoked', at: 't' } })
    renderWithProviders(<ShopAdminBanner duties={STORE} />)
    expect((await screen.findByTestId('shop-admin-banner')).textContent).toContain(
      '店铺授权被收回了',
    )
  })

  it('授权好了：淡色一行「已授权 · 到几点」；失败原因说人话', async () => {
    api.view = view('authorized', {
      scopes_granted: ['read_products', 'write_products'],
      expires_at: '2026-10-09T09:00:00.000Z',
      refreshable: false,
    })
    const { unmount } = renderWithProviders(<ShopAdminBanner duties={STORE} />)
    const banner = await screen.findByTestId('shop-admin-banner')
    expect(banner.textContent).toContain('已授权管理商品和页面 · 到')
    unmount()
    api.view = view('unauthorized', {
      job: { action: 'authorize', phase: 'failed', started_at: 't', error: { code: 'denied' } },
    })
    renderWithProviders(<ShopAdminBanner duties={STORE} />)
    expect((await screen.findByTestId('shop-admin-error')).textContent).toContain(
      '刚才在浏览器里没批准',
    )
  })

  it('网页模板岗位上：没装 CLI / 不知道店由那一行带，这里不重复；没有登记的职责不问服务端', async () => {
    api.view = view('no_cli')
    const { container, unmount } = renderWithProviders(
      <ShopAdminBanner
        duties={[
          { role_id: 'site.shopify-theme', assignment_id: 'asg_theme' },
          { role_id: 'site.shopify-build', assignment_id: 'asg_build' },
        ]}
      />,
    )
    await waitFor(() => expect(api.gets).toHaveLength(1))
    expect(api.gets[0]?.roles).toEqual(['site.shopify-build', 'site.shopify-theme'])
    expect(container.querySelector('[data-testid="shop-admin-banner"]')).toBeNull()
    unmount()
    api.gets = []
    renderWithProviders(
      <ShopAdminBanner duties={[{ role_id: 'kol.discovery', assignment_id: 'asg_kol' }]} />,
    )
    await new Promise((r) => setTimeout(r, 30))
    expect(api.gets).toEqual([])
  })
})
