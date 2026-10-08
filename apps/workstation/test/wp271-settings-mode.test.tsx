/**
 * WP271（docs/95 §2.3，决策 233 / 234）：设置页按模式。
 *
 * - ① 个人：「公司档案」叫「品牌档案」，品牌那几格在上；公司全称与地址挪到下面「主体信息」、选填；
 *   「公司邮箱后缀」与「公司」卡不出；「让同事找到我」没设过 = 关着；整页一个公司概念词都不出。
 * - ③ 公司集体：照旧（公司档案、公司邮箱后缀、「公司」卡）。
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ProfileForm } from '@/components/onboarding/profile-form'
import type { OnboardingStateView, OrganizationView } from '@/lib/api'
import { SettingsPage } from '@/pages/settings'
import { renderWithProviders } from './helpers'
import { COMPANY_ORG, companyWordsIn, SOLO_ORG } from './mode-words'

const T0 = '2026-10-08T09:00:00.000Z'

const STATE: OnboardingStateView = {
  needs_setup: false,
  workspace_name: '小店',
  brand_name: 'Nordvolt',
  profile: {
    legal_name: '深圳诺伏特科技有限公司',
    discoverable: false,
    brand_name: 'Nordvolt',
    vertical: 'goods',
    storefront_platform: 'shopify',
    postal_address: '8 Keji Rd, Shenzhen',
    currency: 'USD',
    set_at: T0,
  },
  person: { name: '王岚', email: 'wang@nordvolt.example' },
  other_assignments: 0,
  is_owner: true,
  discovery: { available: true, enabled: false },
  verticals: [{ key: 'goods', label: '实物商品', hint: '要发货的东西。' }],
  storefront_platforms: [{ key: 'shopify', label: 'Shopify', supported: true }],
}

const state: { orgs: OrganizationView[]; saved: { legal_name: string }[] } = {
  orgs: [],
  saved: [],
}

vi.mock('@/components/connections/bridge', () => ({ openExternal: () => undefined }))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    listOrganizations: async () => state.orgs,
    getOnboardingState: async () => STATE,
    // 不给所有者岗位：下面那几张（浏览器 / 模型…）与模式无关，这里只看档案与「公司」卡
    getPositions: async () => ({ positions: [] }),
    getCloudAccount: async () => ({ linked: false, cloud_base_url: 'https://cloud.example' }),
    getCloudCredits: async () => ({ linked: false }),
    getCloudUsage: async () => null,
    latestBrandIntake: async () => null,
  }
})

beforeEach(() => {
  state.orgs = []
  state.saved = []
})

describe('WP271 三种模式：设置页', () => {
  it('① 个人：品牌档案 + 主体信息（选填），没有公司邮箱后缀与「公司」卡；一个公司概念词都不出', async () => {
    state.orgs = [SOLO_ORG]
    renderWithProviders(<SettingsPage />, '/settings', '')
    const card = await screen.findByTestId('settings-company')
    await waitFor(() => {
      expect(card.textContent).toContain('品牌档案')
    })
    const company = within(card).getByTestId('profile-company-block')
    expect(company.textContent).toContain('主体信息')
    expect(company.textContent).toContain('营业执照上的全称')
    expect(company.textContent).toContain('实体地址')
    expect(within(card).queryByTestId('company-domain')).toBeNull()
    // 「让同事找到我」没设过 = 关着；开关还在（设置里可开，决策 234）
    expect(within(card).getByTestId('company-discoverable').getAttribute('aria-checked')).toBe(
      'false',
    )
    expect(screen.queryByTestId('settings-org')).toBeNull()
    expect(companyWordsIn(document.body)).toEqual([])
  })

  it('① 个人：账号页签也不提所有者 / 成员', async () => {
    state.orgs = [SOLO_ORG]
    renderWithProviders(<SettingsPage defaultTab="account" />, '/settings', '')
    await screen.findByTestId('credits-panel')
    await waitFor(() => {
      expect(companyWordsIn(document.body)).toEqual([])
    })
  })

  it('③ 公司集体：照旧——公司档案、公司邮箱后缀、「公司」卡', async () => {
    state.orgs = [COMPANY_ORG]
    renderWithProviders(<SettingsPage />, '/settings', '')
    const card = await screen.findByTestId('settings-company')
    await waitFor(() => {
      expect(screen.getByTestId('settings-org')).toBeTruthy()
    })
    expect(card.textContent).toContain('公司档案')
    expect(within(card).getByTestId('company-domain')).toBeTruthy()
    expect(within(card).getByTestId('profile-company-block').textContent).toContain('公司全称')
  })
})

describe('WP271 主体信息选填（决策 233）', () => {
  it('① 里全称清空也能存：沿用原来那个名字，不让组织落成空名', async () => {
    state.orgs = [SOLO_ORG]
    const saved: { legal_name: string }[] = []
    renderWithProviders(
      <ProfileForm
        {...(STATE.profile === undefined ? {} : { profile: STATE.profile })}
        busy={false}
        saved={false}
        onSave={(draft) => {
          saved.push(draft)
        }}
      />,
    )
    await waitFor(() => {
      expect(screen.getByTestId('profile-company-block').textContent).toContain('主体信息')
    })
    fireEvent.change(screen.getByTestId('company-legal-name'), { target: { value: '' } })
    const save = screen.getByTestId('company-save') as HTMLButtonElement
    expect(save.disabled).toBe(false)
    fireEvent.click(save)
    expect(saved[0]?.legal_name).toBe('深圳诺伏特科技有限公司')
  })

  it('③ 里全称还是必填', async () => {
    state.orgs = [COMPANY_ORG]
    renderWithProviders(
      <ProfileForm
        {...(STATE.profile === undefined ? {} : { profile: STATE.profile })}
        busy={false}
        saved={false}
        onSave={() => undefined}
      />,
    )
    await waitFor(() => {
      expect(screen.getByTestId('profile-company-block').textContent).toContain('公司全称')
    })
    fireEvent.change(screen.getByTestId('company-legal-name'), { target: { value: '' } })
    expect((screen.getByTestId('company-save') as HTMLButtonElement).disabled).toBe(true)
  })
})
