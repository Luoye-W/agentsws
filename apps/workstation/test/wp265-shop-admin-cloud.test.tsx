/**
 * WP265（Fable 追加）：岗位页「授权管理商品和页面」那一行在**云端一键授权**那一路时——
 * 已授权照常一行淡色（WP288 起在「岗位设置 → 连接」里）；缺权限 / 重新授权**去连接页 Shopify 卡上做**，不起 CLI 授权。
 */
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ShopAdminBanner } from '@/components/position/shop-admin-banner'
import type { ShopAdminView } from '@/lib/api'
import { renderWithProviders } from './helpers'

const api = { view: undefined as ShopAdminView | undefined, runs: [] as string[] }

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getShopAdmin: async () => api.view,
    runShopAdmin: async (action: string) => {
      api.runs.push(action)
      return api.view
    },
  }
})

const base: ShopAdminView = {
  applicable: true,
  state: 'authorized',
  store: '6suegp-md.myshopify.com',
  scopes_needed: ['write_products', 'write_publications'],
  scopes_granted: ['read_products', 'write_products'],
  missing: [],
  refreshable: true,
  via: 'cloud',
}

beforeEach(() => {
  api.runs = []
})

const page = (variant: 'page' | 'settings' = 'page') =>
  renderWithProviders(
    <Routes>
      <Route
        path="/"
        element={
          <ShopAdminBanner
            duties={[{ role_id: 'dtc.store', assignment_id: 'asg_store' }]}
            variant={variant}
          />
        }
      />
      <Route path="/connections" element={<p data-testid="connections-page-stub">连接页</p>} />
    </Routes>,
  )

describe('WP265 云端那一路的授权行', () => {
  it('已授权：设置里照常一行淡色（岗位页上不画）', async () => {
    api.view = base
    page('settings')
    expect((await screen.findByTestId('shop-admin-banner')).getAttribute('data-state')).toBe(
      'authorized',
    )
  })

  it('缺权限：「重新授权」去连接页，不起 CLI 授权', async () => {
    api.view = { ...base, state: 'missing_scopes', missing: ['write_publications'] }
    page()
    await userEvent.click(await screen.findByTestId('shop-admin-authorize'))
    expect(await screen.findByTestId('connections-page-stub')).toBeTruthy()
    await waitFor(() => expect(api.runs).toEqual([]))
  })
})
