/**
 * WP311（决策 507）：带品牌的工作台链接（IM 回复里的）。
 *
 * - 当前就是那个品牌 → 去掉 `brand`、照常开，不切；
 * - 本人进得去的另一个品牌 → 先切过去，再整站重载到链接里那一页（切的时候不画那一页）；
 * - 不存在 / 没权限 → 不切、回首页、顶上照实说一句；切的时候出错 → 说一句「没切到」。
 */
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrandLinkNote } from '@/components/brand-link-note'
import type { BrandView, OrganizationView } from '@/lib/api'
import { brandOfSearch, resetBrandLink, useBrandLink, withoutBrand } from '@/lib/brand-link'
import { renderWithProviders } from './helpers'

const ORG = { id: 'org_1', solo: false } as OrganizationView
const brand = (workspace_id: string, current = false): BrandView => ({
  workspace_id,
  name: workspace_id,
  current,
  pending_approvals: 0,
  alerts: 0,
})

const state: { brands: BrandView[]; fail: boolean } = { brands: [], fail: false }
const switched: { org: string; workspace: string }[] = []

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    listOrganizations: async () => [ORG],
    listBrands: async () => state.brands,
    switchBrand: async (org: string, workspace: string) => {
      if (state.fail) throw new Error('boom')
      switched.push({ org, workspace })
      return { workspace_id: workspace, name: workspace }
    },
  }
})

function Probe({ current }: { current: string }): ReactNode {
  const switching = useBrandLink(current)
  const loc = useLocation()
  return (
    <div>
      <span data-testid="where">{`${loc.pathname}${loc.search}`}</span>
      {switching ? <span data-testid="switching" /> : <span data-testid="page" />}
      <BrandLinkNote brand="Rollout" />
    </div>
  )
}

let assign: ReturnType<typeof vi.fn>

beforeEach(() => {
  state.brands = [brand('ws_a', true), brand('ws_b')]
  state.fail = false
  switched.length = 0
  resetBrandLink()
  assign = vi.fn()
  vi.spyOn(globalThis, 'location', 'get').mockReturnValue({
    ...globalThis.location,
    assign,
  } as Location)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('WP311 地址里的品牌', () => {
  it('取品牌、去掉品牌那一格（别的参数与 # 留着）', () => {
    expect(brandOfSearch('?brand=ws_b')).toBe('ws_b')
    expect(brandOfSearch('?brand=')).toBeUndefined()
    expect(brandOfSearch('?tab=view')).toBeUndefined()
    expect(withoutBrand({ pathname: '/matters/m1', search: '?brand=ws_b', hash: '' })).toBe(
      '/matters/m1',
    )
    expect(
      withoutBrand({ pathname: '/positions/p', search: '?tab=view&brand=ws_b', hash: '#x' }),
    ).toBe('/positions/p?tab=view#x')
  })
})

// 这台机器上同时有好几个代理在跑：给足时间
vi.setConfig({ testTimeout: 20_000 })

describe('WP311 打开带品牌的链接', () => {
  it('就是当前品牌：不切，地址里去掉 brand，照常画', async () => {
    renderWithProviders(<Probe current="ws_a" />, '/matters/m1?brand=ws_a')
    await waitFor(() => {
      expect(screen.getByTestId('where').textContent).toBe('/matters/m1')
    })
    expect(screen.getByTestId('page')).toBeTruthy()
    expect(switched).toEqual([])
    expect(assign).not.toHaveBeenCalled()
  })

  it('别的品牌（进得去）：先切过去，再整站重载到链接那一页；切的时候不画那一页', async () => {
    renderWithProviders(<Probe current="ws_a" />, '/matters/m1?brand=ws_b')
    expect(screen.getByTestId('switching')).toBeTruthy()
    await waitFor(() => {
      expect(assign).toHaveBeenCalledWith('/matters/m1')
    })
    expect(switched).toEqual([{ org: 'org_1', workspace: 'ws_b' }])
    expect(screen.queryByTestId('brand-link-note')).toBeNull()
  })

  it('品牌不存在 / 没权限：不切、回首页、照实说一句，能关掉', async () => {
    renderWithProviders(<Probe current="ws_a" />, '/positions/web-ops?brand=ws_zzz')
    const note = await screen.findByTestId('brand-link-note')
    expect(note.getAttribute('data-reason')).toBe('missing')
    expect(note.textContent).toContain('「Rollout」')
    await waitFor(() => {
      expect(screen.getByTestId('where').textContent).toBe('/')
    })
    expect(screen.getByTestId('page')).toBeTruthy()
    expect(switched).toEqual([])
    expect(assign).not.toHaveBeenCalled()
    act(() => {
      fireEvent.click(screen.getByLabelText('关掉'))
    })
    expect(screen.queryByTestId('brand-link-note')).toBeNull()
  })

  it('切的时候出错：回首页、说一句「没切到」', async () => {
    state.fail = true
    renderWithProviders(<Probe current="ws_a" />, '/matters/m1?brand=ws_b')
    const note = await screen.findByTestId('brand-link-note')
    expect(note.getAttribute('data-reason')).toBe('failed')
    await waitFor(() => {
      expect(screen.getByTestId('where').textContent).toBe('/')
    })
    expect(assign).not.toHaveBeenCalled()
  })

  it('没带品牌：什么都不做', () => {
    renderWithProviders(<Probe current="ws_a" />, '/matters/m1')
    expect(screen.getByTestId('page')).toBeTruthy()
    expect(screen.getByTestId('where').textContent).toBe('/matters/m1')
  })
})
