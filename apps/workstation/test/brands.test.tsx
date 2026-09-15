/**
 * 52 O1–O4（WP65）工作台这一侧：顶栏品牌切换器、⌘K 搜品牌、公司页品牌一览、
 * 设置页那张"公司"卡，以及第 ① 步拆成的两块。
 *
 * 贯穿的一条：**个人用户（一个人、一个品牌）界面上一律看不到"公司"这两个字**
 * （52 O1）。切换器不出、⌘K 里那一组不出、设置页那张卡不出——他的工作台与
 * 这一版上线前一模一样。
 */
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AppShell } from '@/components/app-shell'
import { ProfileForm } from '@/components/onboarding/profile-form'
import { BrandsTab } from '@/components/org/brands-tab'
import type { BrandView, OrganizationView, PositionSummary } from '@/lib/api'
import { SettingsPage } from '@/pages/settings'
import { renderWithProviders } from './helpers'

const T0 = '2026-09-15T09:00:00.000Z'

const SOLO: OrganizationView = {
  id: 'org_1',
  legal_name: '深圳诺伏特科技',
  domain: 'nordvolt.cn',
  discoverable: true,
  owner_id: 'per_wang',
  role: 'owner',
  brands: 1,
  members: 1,
  solo: true,
  created_at: T0,
}

const COMPANY: OrganizationView = { ...SOLO, brands: 2, members: 3, solo: false }

const BRAND_A: BrandView = {
  workspace_id: 'ws_a',
  name: '诺伏特户外',
  current: true,
  vertical: 'goods',
  storefront_platform: 'shopify',
  pending_approvals: 4,
  alerts: 1,
  sales_today: { amount: 1280.5, currency: 'USD' },
}

const BRAND_B: BrandView = {
  workspace_id: 'ws_b',
  name: '诺伏特课程',
  current: false,
  vertical: 'digital',
  storefront_platform: 'other',
  pending_approvals: 0,
  alerts: 0,
}

const state: { orgs: OrganizationView[]; brands: BrandView[] } = { orgs: [], brands: [] }
const switched: { org: string; workspace: string }[] = []
const created: unknown[] = []
const copied: { org: string; to: string; from: string }[] = []

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    listOrganizations: async () => state.orgs,
    listBrands: async () => state.brands,
    switchBrand: async (org: string, workspace: string) => {
      switched.push({ org, workspace })
      return { workspace_id: workspace, name: workspace }
    },
    createBrand: async (_org: string, input: unknown) => {
      created.push(input)
      return { ...BRAND_B, workspace_id: 'ws_new', name: '新品牌' }
    },
    copyBrandSettings: async (org: string, to: string, from: string) => {
      copied.push({ org, to, from })
      return { from, to, copied_assignments: 2, dropped_ranges: 3, models_shared: true }
    },
    // 设置页还会拉这两条；这组题不关心它们
    getPositions: async () => ({ positions: [], tile_library: [], max_tiles: 6 }),
    getOnboardingState: async () => {
      throw new Error('这组题不看向导')
    },
    listCatalog: async () => [],
  }
})

const POSITIONS: PositionSummary[] = [
  {
    position_id: 'asg_1',
    role_id: 'common.owner',
    role_name: '工作区所有者',
    ranges: [],
    ready: true,
    missing_connectors: [],
    tile_ids: [],
    range: 'yesterday',
    show_tiles: true,
  },
]

function renderShell(): void {
  renderWithProviders(
    <AppShell positions={POSITIONS} cards={[]} tileLibrary={[]} onAddTile={() => {}}>
      <div>主区</div>
    </AppShell>,
  )
}

beforeEach(() => {
  state.orgs = []
  state.brands = []
  switched.length = 0
  created.length = 0
  copied.length = 0
})

describe('52 O2 顶栏品牌切换器', () => {
  it('个人用户（一个人一个品牌）不出切换器', async () => {
    state.orgs = [SOLO]
    state.brands = [BRAND_A]
    renderShell()
    await screen.findByText('主区')
    expect(screen.queryByTestId('brand-switcher')).toBeNull()
  })

  it('两个品牌：显示当前品牌名，下拉里两个都在，另一个带待审数', async () => {
    state.orgs = [COMPANY]
    state.brands = [BRAND_A, BRAND_B]
    renderShell()
    expect((await screen.findByTestId('brand-current')).textContent).toContain('诺伏特户外')
    // Radix 的下拉在 jsdom 里要关掉 pointer-events 检查（与 work.test.tsx 同一条）
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 })
    await user.click(screen.getByLabelText('切换品牌'))
    expect((await screen.findByTestId('brand-option-ws_a')).textContent).toContain('诺伏特户外')
    expect(screen.getByTestId('brand-option-ws_b').textContent).toContain('诺伏特课程')
    // 当前品牌那一行把待审数显出来（4 张）；空的那个不显 0
    expect(screen.getByTestId('brand-option-ws_a').textContent).toContain('4')
  })

  it('点另一个品牌 = 换一张绑它的会话票（整站重载由 location 负责）', async () => {
    state.orgs = [COMPANY]
    state.brands = [BRAND_A, BRAND_B]
    const reload = vi.fn()
    vi.spyOn(globalThis, 'location', 'get').mockReturnValue({
      ...globalThis.location,
      reload,
    } as Location)
    renderShell()
    await screen.findByTestId('brand-current')
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 })
    await user.click(screen.getByLabelText('切换品牌'))
    await user.click(await screen.findByTestId('brand-option-ws_b'))
    await waitFor(() => {
      expect(switched).toEqual([{ org: 'org_1', workspace: 'ws_b' }])
    })
    await waitFor(() => {
      expect(reload).toHaveBeenCalled()
    })
    vi.restoreAllMocks()
  })

  it('⌘K 里能搜品牌名切换；个人用户那一组不出', async () => {
    state.orgs = [COMPANY]
    state.brands = [BRAND_A, BRAND_B]
    renderShell()
    await screen.findByTestId('brand-current')
    await userEvent.click(screen.getByLabelText('命令面板 (⌘K)'))
    expect(await screen.findByText('品牌')).not.toBeNull()
    // 面板里两个品牌都列出来（当前那个点不动）
    expect(await screen.findAllByText('诺伏特课程')).not.toHaveLength(0)
  })
})

describe('52 O2 / O4 公司页品牌一览', () => {
  it('每个品牌一行：待审卡 / 告警 / 今日销售；别的品牌的销售明说"切过去才看得到"', async () => {
    state.orgs = [COMPANY]
    state.brands = [BRAND_A, BRAND_B]
    renderWithProviders(<BrandsTab org_id="org_1" assignment="asg_owner" />)
    const rowA = await screen.findByTestId('brand-row-ws_a')
    expect(rowA.textContent).toContain('诺伏特户外')
    expect(rowA.textContent).toContain('当前')
    expect(rowA.textContent).toContain('1280.50 USD')
    const rowB = screen.getByTestId('brand-row-ws_b')
    // 活数据源是按当前工作区装配的：别的品牌不画一个 0，明说没有（36 §3）
    expect(rowB.textContent).toContain('切过去才看得到')
    // 当前那一行没有"切到这个品牌"的按钮
    expect(screen.queryByTestId('brand-open-ws_a')).toBeNull()
    expect(screen.getByTestId('brand-open-ws_b')).not.toBeNull()
  })

  it('只有一个品牌时也在，说的是"要做第二个品牌就在这里加"', async () => {
    state.orgs = [SOLO]
    state.brands = [BRAND_A]
    renderWithProviders(<BrandsTab org_id="org_1" />)
    expect(await screen.findByTestId('org-brands-solo')).not.toBeNull()
  })

  it('加一个品牌 + 从某品牌复制：先建再复制，回执说真搬了几条', async () => {
    state.orgs = [COMPANY]
    state.brands = [BRAND_A, BRAND_B]
    renderWithProviders(<BrandsTab org_id="org_1" assignment="asg_owner" />)
    await screen.findByTestId('new-brand-name')
    await userEvent.type(screen.getByTestId('new-brand-name'), '诺伏特配件')
    await userEvent.selectOptions(screen.getByTestId('new-brand-copy'), 'ws_a')
    await userEvent.click(screen.getByTestId('new-brand-submit'))
    await waitFor(() => {
      expect(created).toEqual([{ name: '诺伏特配件' }])
    })
    expect(copied).toEqual([{ org: 'org_1', to: 'ws_new', from: 'ws_a' }])
    expect((await screen.findByTestId('org-brands-receipt')).textContent).toContain('2')
  })

  it('不选复制就只建一个空白品牌，没有复制那一跳', async () => {
    state.orgs = [COMPANY]
    state.brands = [BRAND_A, BRAND_B]
    renderWithProviders(<BrandsTab org_id="org_1" />)
    await screen.findByTestId('new-brand-name')
    await userEvent.type(screen.getByTestId('new-brand-name'), '诺伏特配件')
    await userEvent.click(screen.getByTestId('new-brand-submit'))
    await waitFor(() => {
      expect(created).toHaveLength(1)
    })
    expect(copied).toHaveLength(0)
    expect(screen.queryByTestId('org-brands-receipt')).toBeNull()
  })
})

describe('52 O1 设置页那张"公司"卡', () => {
  it('个人用户看不到它', async () => {
    state.orgs = [SOLO]
    state.brands = [BRAND_A]
    renderWithProviders(<SettingsPage />)
    await screen.findByText('设置')
    expect(screen.queryByTestId('settings-org')).toBeNull()
  })

  it('有第二个品牌 / 第二个人之后才出现，只说公司名与几个品牌几个人', async () => {
    state.orgs = [COMPANY]
    state.brands = [BRAND_A, BRAND_B]
    renderWithProviders(<SettingsPage />)
    const card = await screen.findByTestId('settings-org')
    expect(card.textContent).toContain('深圳诺伏特科技')
    expect(card.textContent).toContain('2 个品牌')
    expect(card.textContent).toContain('3 个人')
    expect(screen.getByTestId('settings-org-manage').getAttribute('href')).toBe('/org?tab=brands')
  })
})

describe('52 O4 第 ① 步拆两块', () => {
  it('上半块是公司（进组织），下半块是品牌（进这个工作区）', async () => {
    const saved: unknown[] = []
    renderWithProviders(
      <ProfileForm
        emailHint="wang@nordvolt.cn"
        verticals={[
          { key: 'goods', label: '实物商品', hint: '寄得出去的东西' },
          { key: 'digital', label: '虚拟产品与服务', hint: '课程、订阅、软件' },
        ]}
        storefrontPlatforms={[{ key: 'shopify', label: 'Shopify', supported: true }]}
        firstBrand
        busy={false}
        saved={false}
        onSave={(draft) => {
          saved.push(draft)
        }}
      />,
    )
    // 两块各有标题，公司那三样在上面，品牌那三样在下面
    expect(screen.getByText('公司')).not.toBeNull()
    expect(screen.getByText('第一个品牌')).not.toBeNull()
    const company = screen.getByTestId('profile-company-block')
    expect(company.contains(screen.getByTestId('company-legal-name'))).toBe(true)
    expect(company.contains(screen.getByTestId('company-domain'))).toBe(true)
    expect(company.contains(screen.getByTestId('company-discoverable'))).toBe(true)
    const brand = screen.getByTestId('profile-brand-block')
    expect(brand.contains(screen.getByTestId('brand-name'))).toBe(true)
    expect(brand.contains(screen.getByTestId('company-vertical'))).toBe(true)
    expect(brand.contains(screen.getByTestId('company-platform'))).toBe(true)

    await userEvent.type(screen.getByTestId('company-legal-name'), '深圳诺伏特科技')
    await userEvent.type(screen.getByTestId('brand-name'), '诺伏特户外')
    await userEvent.click(screen.getByTestId('company-save'))
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({
      legal_name: '深圳诺伏特科技',
      brand_name: '诺伏特户外',
    })
  })

  it('设置页里下半块说的是"这个品牌"，不是"第一个品牌"', () => {
    renderWithProviders(<ProfileForm busy={false} saved={false} onSave={() => {}} />)
    expect(screen.getByText('这个品牌')).not.toBeNull()
    expect(screen.queryByText('第一个品牌')).toBeNull()
  })
})
