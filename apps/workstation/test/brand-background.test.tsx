/**
 * WP215：每个品牌一套后台——工作台这一侧的三处可见性。
 *
 * 1. 后台状态小件（`BrandBackgroundBadge`）：图标 + 数字，tooltip「最近一次巡检 / 下一次」，
 *    出错红点，急停是暂停样子，没有 `background` 就不画；
 * 2. 顶栏品牌切换器每一行、公司页「品牌一览」每一行都用它；品牌一览行尾「停后台 / 放开」；
 * 3. 设置页「后台」一张小卡：改「同时最多跑几件」调 PUT。
 */
import { fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BrandBackgroundBadge } from '@/components/brand-background-badge'
import { BrandSwitcher } from '@/components/brand-switcher'
import { BrandsTab } from '@/components/org/brands-tab'
import { BackgroundCard } from '@/components/settings/background-card'
import {
  ApiClientError,
  type BackgroundSettingsView,
  type BrandBackgroundView,
  type BrandView,
  type OrganizationView,
} from '@/lib/api'
import { formatDateTime } from '@/lib/format'
import { renderWithProviders } from './helpers'
import { CARD_TEXT_LIMIT, reportCard } from './less-text-guard'

const LAST = '2026-10-05T01:30:00.000Z'
const NEXT = '2026-10-05T02:00:00.000Z'

const RUNNING: BrandBackgroundView = {
  workspace_id: 'ws_b',
  state: 'running',
  scheduled: 3,
  last_run_at: LAST,
  next_run_at: NEXT,
  errors: 0,
  halted: false,
  global_halted: false,
}

const COMPANY: OrganizationView = {
  id: 'org_1',
  legal_name: '深圳诺伏特科技',
  discoverable: true,
  owner_id: 'per_wang',
  role: 'owner',
  brands: 2,
  members: 2,
  solo: false,
  created_at: '2026-09-15T09:00:00.000Z',
}

const BRAND_A: BrandView = {
  workspace_id: 'ws_a',
  name: '诺伏特户外',
  current: true,
  pending_approvals: 0,
  alerts: 0,
}

const BRAND_B: BrandView = {
  workspace_id: 'ws_b',
  name: '变形金刚耳机',
  current: false,
  pending_approvals: 0,
  alerts: 0,
  background: RUNNING,
}

const SETTINGS: BackgroundSettingsView = {
  max_concurrent: 2,
  limits: { min: 1, max: 4 },
  global_halted: false,
  brands: [{ ...RUNNING, name: '变形金刚耳机', current: false }],
  runs_on: 'this_device',
}

const state: { brands: BrandView[]; haltError?: unknown } = { brands: [] }
const halts: { ws: string; input: unknown; assignment?: string }[] = []
const concurrency: { input: unknown; assignment?: string }[] = []

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    listOrganizations: async () => [COMPANY],
    listBrands: async () => state.brands,
    setBrandBackgroundHalt: async (ws: string, input: { halted: boolean }, assignment?: string) => {
      halts.push({ ws, input, ...(assignment === undefined ? {} : { assignment }) })
      if (state.haltError !== undefined) throw state.haltError
      return { ...RUNNING, workspace_id: ws, halted: input.halted }
    },
    getBackgroundSettings: async () => SETTINGS,
    setBackgroundSettings: async (input: { max_concurrent: number }, assignment?: string) => {
      concurrency.push({ input, ...(assignment === undefined ? {} : { assignment }) })
      return { ...SETTINGS, max_concurrent: input.max_concurrent }
    },
  }
})

beforeEach(() => {
  state.brands = [BRAND_A, BRAND_B]
  delete state.haltError
  halts.length = 0
  concurrency.length = 0
})

describe('后台状态小件', () => {
  it('在跑：图标 + 数字，tooltip 写最近一次巡检与下一次（本地时间）', () => {
    renderWithProviders(<BrandBackgroundBadge background={RUNNING} />)
    const badge = screen.getByTestId('brand-bg')
    expect(badge.getAttribute('data-bg-state')).toBe('running')
    expect(screen.getByTestId('brand-bg-count').textContent).toBe('3')
    const hint = badge.getAttribute('data-hint') ?? ''
    expect(hint).toContain('3 条定时任务')
    expect(hint).toContain(`最近一次巡检 ${formatDateTime(LAST, 'zh')}`)
    expect(hint).toContain(`下一次 ${formatDateTime(NEXT, 'zh')}`)
    // 同一句也进读屏
    expect(badge.getAttribute('aria-label')).toBe(hint)
    expect(screen.queryByTestId('brand-bg-error-dot')).toBeNull()
  })

  it('还没跑过就明说', () => {
    const { last_run_at: _l, next_run_at: _n, ...fresh } = RUNNING
    renderWithProviders(<BrandBackgroundBadge background={fresh} />)
    expect(screen.getByTestId('brand-bg').getAttribute('data-hint')).toContain('还没跑过')
  })

  it('出错：右上角红点，tooltip 带最近那条的标题与原因', () => {
    renderWithProviders(
      <BrandBackgroundBadge
        background={{
          ...RUNNING,
          errors: 2,
          last_error: { task_id: 'tsk_1', title: 'Reddit 巡检', message: '令牌过期了' },
        }}
      />,
    )
    expect(screen.getByTestId('brand-bg-error-dot')).toBeTruthy()
    const hint = screen.getByTestId('brand-bg').getAttribute('data-hint') ?? ''
    expect(hint).toContain('2 条出错')
    expect(hint).toContain('Reddit 巡检')
    expect(hint).toContain('令牌过期了')
  })

  it('急停：暂停的样子；全局急停另一句', () => {
    const { unmount } = renderWithProviders(
      <BrandBackgroundBadge background={{ ...RUNNING, state: 'halted', halted: true }} />,
    )
    const badge = screen.getByTestId('brand-bg')
    expect(badge.getAttribute('data-bg-state')).toBe('halted')
    expect(badge.getAttribute('data-hint')).toContain('这个品牌的后台停了')
    // 停着的时候「下一次」没有意义，不说
    expect(badge.getAttribute('data-hint')).not.toContain('下一次')
    unmount()
    renderWithProviders(
      <BrandBackgroundBadge
        background={{ ...RUNNING, state: 'halted', halted: false, global_halted: true }}
      />,
    )
    expect(screen.getByTestId('brand-bg').getAttribute('data-hint')).toContain('全部品牌急停中')
  })

  it('品牌停用：灰掉', () => {
    renderWithProviders(<BrandBackgroundBadge background={{ ...RUNNING, state: 'stopped' }} />)
    const badge = screen.getByTestId('brand-bg')
    expect(badge.getAttribute('data-bg-state')).toBe('stopped')
    expect(badge.getAttribute('data-hint')).toContain('品牌停用了')
  })

  it('没有 background 就不渲染', () => {
    const { container } = renderWithProviders(<BrandBackgroundBadge background={undefined} />)
    expect(screen.queryByTestId('brand-bg')).toBeNull()
    expect(container.textContent).toBe('')
  })
})

describe('顶栏品牌切换器', () => {
  it('每个品牌一行带后台小件；没有 background 的那一行不画', async () => {
    renderWithProviders(<BrandSwitcher />)
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 })
    await user.click(await screen.findByLabelText('切换品牌'))
    const b = await screen.findByTestId('brand-bg-ws_b')
    expect(b.getAttribute('data-hint')).toContain('最近一次巡检')
    // 在按钮里不再套一个可聚焦的东西
    expect(b.getAttribute('tabindex')).toBeNull()
    expect(screen.getByTestId('brand-option-ws_b').textContent).toContain('3')
    expect(screen.queryByTestId('brand-bg-ws_a')).toBeNull()
  })
})

describe('公司页「品牌一览」', () => {
  it('每行一格后台状态；「停后台」只停这一个品牌（拿所有者岗位发）', async () => {
    renderWithProviders(<BrandsTab org_id="org_1" assignment="asg_owner" />)
    const badge = await screen.findByTestId('brand-row-bg-ws_b')
    expect(badge.getAttribute('data-hint')).toContain('3 条定时任务')
    expect(screen.queryByTestId('brand-row-bg-ws_a')).toBeNull()
    // 没有后台字段的品牌也没有按钮
    expect(screen.queryByTestId('brand-bg-toggle-ws_a')).toBeNull()
    const toggle = screen.getByTestId('brand-bg-toggle-ws_b')
    expect(toggle.textContent).toContain('停后台')
    fireEvent.click(toggle)
    await waitFor(() => {
      expect(halts).toEqual([{ ws: 'ws_b', input: { halted: true }, assignment: 'asg_owner' }])
    })
  })

  it('停着的品牌按钮是「放开」', async () => {
    state.brands = [
      BRAND_A,
      { ...BRAND_B, background: { ...RUNNING, state: 'halted', halted: true } },
    ]
    renderWithProviders(<BrandsTab org_id="org_1" assignment="asg_owner" />)
    const toggle = await screen.findByTestId('brand-bg-toggle-ws_b')
    expect(toggle.textContent).toContain('放开')
    fireEvent.click(toggle)
    await waitFor(() => {
      expect(halts[0]?.input).toEqual({ halted: false })
    })
  })

  it('服务端回 403：按钮整个收起', async () => {
    state.haltError = new ApiClientError(403, { code: 'forbidden', message: '没有权限' })
    renderWithProviders(<BrandsTab org_id="org_1" assignment="asg_owner" />)
    fireEvent.click(await screen.findByTestId('brand-bg-toggle-ws_b'))
    await waitFor(() => {
      expect(screen.queryByTestId('brand-bg-toggle-ws_b')).toBeNull()
    })
    // 状态那一格还在
    expect(screen.getByTestId('brand-row-bg-ws_b')).toBeTruthy()
  })

  it('公司管理员（没有所有者岗位）也能按：拿他自己那条岗位发（Fable 10-05）', async () => {
    renderWithProviders(<BrandsTab org_id="org_1" haltAssignment="asg_admin_ops" />)
    fireEvent.click(await screen.findByTestId('brand-bg-toggle-ws_b'))
    await waitFor(() => {
      expect(halts).toEqual([{ ws: 'ws_b', input: { halted: true }, assignment: 'asg_admin_ops' }])
    })
  })

  it('没有所有者岗位：只看状态，不出按钮', async () => {
    renderWithProviders(<BrandsTab org_id="org_1" />)
    await screen.findByTestId('brand-row-bg-ws_b')
    expect(screen.queryByTestId('brand-bg-toggle-ws_b')).toBeNull()
  })
})

describe('设置页「后台」', () => {
  it('改「同时最多跑几件」调 PUT；卡上说明字不超', async () => {
    renderWithProviders(<BackgroundCard assignment="asg_owner" />)
    const card = await screen.findByTestId('settings-background')
    expect(screen.getByTestId('settings-background-device').textContent).toContain('这台电脑')
    const select = screen.getByTestId('settings-background-concurrency') as HTMLSelectElement
    expect(select.value).toBe('2')
    expect([...select.options].map((o) => o.value)).toEqual(['1', '2', '3', '4'])
    fireEvent.change(select, { target: { value: '3' } })
    await waitFor(() => {
      expect(concurrency).toEqual([{ input: { max_concurrent: 3 }, assignment: 'asg_owner' }])
    })
    await waitFor(() => {
      expect(select.value).toBe('3')
    })
    expect(reportCard(card).weight).toBeLessThanOrEqual(CARD_TEXT_LIMIT)
    expect(reportCard(card).ordered).toBe(0)
  })
})
