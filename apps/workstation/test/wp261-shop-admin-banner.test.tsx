/**
 * WP261：岗位页「授权管理商品和页面」那一行。
 *
 * 1. 没授权 → 一句话 +「授权管理商品和页面」（按这个岗位上的职责要权限）；
 * 2. 等浏览器 → 转圈 +「没弹出来？」+ 取消；CLI 开不了浏览器时由工作台开一次；
 * 3. 过期 / 被收回 / 缺权限 →「重新授权」并说缺哪项（人话，不出 scope 原名）；
 * 4. 授权好了 → 岗位页上不占一行（WP288：标题旁一个绿勾，悬停「Shopify 已连接 · 会自动续期」，点了去连接页）；
 *    那一行淡色「已授权 · 到几点」在「岗位设置 → 连接」里；没装 CLI / 不知道店：网页模板岗位上不重复出；
 * 5. 没有登记的职责 → 不问服务端、不画。
 */
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ConnectionTick } from '@/components/position/connection-tick'
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
  state: NonNullable<ShopAdminView['state']>,
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
    getPositionConnections: async () => ({
      position_id: 'pos_site',
      position_name: '网站运营',
      ready: true,
      missing_required: [],
      items: [],
    }),
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

  it('授权好了：岗位页上不占一行；设置里淡色一行「已授权 · 到几点」；失败原因说人话', async () => {
    api.view = view('authorized', {
      scopes_granted: ['read_products', 'write_products'],
      expires_at: '2026-10-09T09:00:00.000Z',
      refreshable: false,
    })
    const page = renderWithProviders(<ShopAdminBanner duties={STORE} />)
    await waitFor(() => expect(api.gets.length).toBeGreaterThan(0))
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.queryByTestId('shop-admin-banner')).toBeNull()
    page.unmount()
    const { unmount } = renderWithProviders(<ShopAdminBanner duties={STORE} variant="settings" />)
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

describe('WP288 连接正常 = 标题旁一个绿勾', () => {
  it('授权好了：绿勾，悬停「Shopify 已连接 · 会自动续期」，点了去连接页 Shopify 那张卡', async () => {
    api.view = view('authorized', {
      scopes_granted: ['read_products', 'write_products'],
      refreshable: true,
    })
    renderWithProviders(<ConnectionTick id="asg_store" duties={STORE} />)
    const tick = await screen.findByTestId('position-connected')
    expect(tick.getAttribute('data-hint')).toBe('Shopify 已连接 · 会自动续期')
    expect(tick.getAttribute('href')).toBe('/connections?service=shopify_admin')
  })

  it('过期 / 缺权限 / 没授权：不画勾（由页上那一行醒目提示带「重新授权」）', async () => {
    for (const state of ['expired', 'missing_scopes', 'unauthorized'] as const) {
      api.view = view(state, state === 'missing_scopes' ? { missing: ['write_products'] } : {})
      const { unmount } = renderWithProviders(
        <>
          <ConnectionTick id="asg_store" duties={STORE} />
          <ShopAdminBanner duties={STORE} />
        </>,
      )
      await screen.findByTestId('shop-admin-banner')
      expect(screen.queryByTestId('position-connected')).toBeNull()
      unmount()
    }
  })
})
