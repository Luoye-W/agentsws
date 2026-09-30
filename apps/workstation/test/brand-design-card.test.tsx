/**
 * WP208（Luoye 09-30）：设计规范从第三栏搬到「公司 → 品牌」。
 *
 * 钉住三件：卡上是原来那张速查表（色块、字体）；头上一个「查看 / 编辑」进 `/brand-design`；
 * 标题带当前品牌名（每个品牌一份，看的是当前那一份）。还没抓过时照旧说一句人话，不画空色板。
 */
import type { BrandDesignProfile } from '@agentsws/contracts'
import { screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { renderWithProviders } from './helpers'

const PROFILE: BrandDesignProfile = {
  colors: {
    primary: {
      value: '#b8422e',
      confidence: 'high',
      source: [{ origin: 'site', url: 'https://heritage.test/', locator: 'css-var:--brand' }],
    },
  },
  typography: {
    h1: {
      value: { fontFamily: 'Public Sans', fontSize: '48px', fontWeight: 600 },
      confidence: 'high',
      source: [{ origin: 'site', url: 'https://heritage.test/', locator: 'css:h1' }],
    },
  },
}

let profile: BrandDesignProfile | undefined = PROFILE

vi.mock('@/lib/api', async () => ({
  ...(await vi.importActual<typeof import('@/lib/api')>('@/lib/api')),
  getBrandDesign: async () => (profile === undefined ? null : { profile, markdown: '' }),
  listOrganizations: async () => [{ id: 'org_1', name: '远航', solo: false }],
  listBrands: async () => [
    { workspace_id: 'ws_1', name: '远航户外', current: true, pending_approvals: 0, alerts: 0 },
    { workspace_id: 'ws_2', name: '远航宠物', current: false, pending_approvals: 0, alerts: 0 },
  ],
}))

const { BrandDesignCard } = await import('@/components/org/brand-design-card')

describe('公司 → 品牌里的设计规范（WP208）', () => {
  it('速查表 + 「查看 / 编辑」；标题带当前品牌名', async () => {
    profile = PROFILE
    renderWithProviders(<BrandDesignCard />)
    expect(await screen.findByTestId('design-md-panel')).toBeDefined()
    expect(screen.getByText('Public Sans')).toBeDefined()
    expect(screen.getByTestId('org-brand-design-open').getAttribute('href')).toBe('/brand-design')
    expect(await screen.findByText('设计规范 · 远航户外')).toBeDefined()
    // 卡头已经有入口，速查表底下那一行不再重复
    expect(screen.getAllByRole('link')).toHaveLength(1)
  })

  it('还没抓过：说一句人话，不画空色板', async () => {
    profile = undefined
    renderWithProviders(<BrandDesignCard />)
    expect(await screen.findByTestId('design-md-panel-empty')).toBeDefined()
    expect(screen.getAllByRole('link')).toHaveLength(1)
  })
})
