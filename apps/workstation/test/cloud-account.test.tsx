/**
 * 49 M1 / M5 设置页「账号与积分」的账号卡。
 *
 * 四组断言：
 * 1. 没关联时是一句人话 + 邮箱框 + 「发登录邮件」，按完只提示"去邮箱点"；
 * 2. 已关联时出邮箱、到期、动作集与「解除关联」；
 * 3. **这一页任何时候都看不到令牌**（服务端也不回它）；
 * 4. 积分那块是 WP59 的空插槽，现在什么都不渲染。
 */
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CloudAccountCard } from '@/components/settings/cloud-account'
import { CreditsPanel } from '@/components/settings/credits-panel'
import type { CloudAccountView } from '@/lib/api'
import { renderWithProviders } from './helpers'

const UNLINKED: CloudAccountView = {
  linked: false,
  cloud_base_url: 'https://cloud.agentsws.com',
}

const LINKED: CloudAccountView = {
  linked: true,
  email: 'luoye@example.com',
  org_name: 'luoye@example.com',
  expires_at: '2026-12-14T00:00:00.000Z',
  scopes: ['ai', 'wallet:read'],
  linked_at: '2026-09-15T00:00:00.000Z',
  cloud_base_url: 'https://cloud.agentsws.com',
}

const state = {
  view: UNLINKED as CloudAccountView,
  linked: [] as string[],
  unlinked: 0,
}

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getCloudAccount: async () => state.view,
    linkCloudAccount: async (email: string) => {
      state.linked.push(email)
      return { expires_at: '2026-09-15T00:15:00.000Z', delivered: 'email' as const }
    },
    // WP142：积分卡按账号状态回（解除关联之后要换成「没关联」那一面）
    getCloudCredits: async () =>
      state.view.linked
        ? {
            linked: true,
            month_credits: 0,
            balance: {
              org_id: 'org_1',
              purchased: 140,
              granted: 10,
              available: 150,
              reserved: 0,
              expiring: [],
              low_balance_threshold: 50,
              low_balance: false,
              at: '2026-09-15T00:00:00.000Z',
            },
          }
        : { linked: false, reason: '还没关联' },
    getCloudUsage: async () => null,
    getCloudPricing: async () => ({ version: 1, as_of: '2026-09-15', entries: [] }),
    getTopupTiers: async () => ({ version: 1, as_of: '2026-09-15', credits_per_usd: 7, tiers: [] }),
    unlinkCloudAccount: async () => {
      state.unlinked += 1
      state.view = UNLINKED
      return { unlinked: true, revoked_on_cloud: true }
    },
  }
})

beforeEach(() => {
  state.view = UNLINKED
  state.linked = []
  state.unlinked = 0
})

describe('49 M1 设置页账号卡', () => {
  it('没关联：一句人话 + 邮箱框 + 发登录邮件；按完只提示去邮箱点', async () => {
    renderWithProviders(<CloudAccountCard assignment="asg_1" />)
    await screen.findByTestId('cloud-account-unlinked')
    expect(screen.getByText(/关联 Agents 工坊云账号后可以一键用/)).toBeTruthy()

    const input = screen.getByLabelText('邮箱')
    await userEvent.type(input, 'luoye@example.com')
    await userEvent.click(screen.getByRole('button', { name: '发登录邮件' }))

    await screen.findByTestId('cloud-account-sent')
    expect(state.linked).toEqual(['luoye@example.com'])
    // 一次性 token 只进邮件：这一页不出现任何 token 形状的串
    expect(document.body.textContent ?? '').not.toMatch(/cml_|wst_/)
  })

  it('邮箱没填时按钮点不动', async () => {
    renderWithProviders(<CloudAccountCard assignment="asg_1" />)
    await screen.findByTestId('cloud-account-unlinked')
    const button = screen.getByRole('button', { name: '发登录邮件' })
    expect(button.hasAttribute('disabled')).toBe(true)
  })

  it('已关联：邮箱、到期、动作集都在，且没有令牌', async () => {
    state.view = LINKED
    renderWithProviders(<CloudAccountCard assignment="asg_1" />)
    await screen.findByTestId('cloud-account-linked')
    const text = screen.getByTestId('cloud-account').textContent ?? ''
    expect(text).toContain('luoye@example.com')
    expect(text).toContain('2026-12-14')
    expect(text).toContain('ai · wallet:read')
    expect(text).not.toMatch(/wst_/)
  })

  it('解除关联之后回到未关联那一档', async () => {
    state.view = LINKED
    renderWithProviders(<CloudAccountCard assignment="asg_1" />)
    await screen.findByTestId('cloud-account-linked')
    await userEvent.click(screen.getByRole('button', { name: '解除关联' }))
    await screen.findByTestId('cloud-account-unlinked')
    expect(state.unlinked).toBe(1)
  })

  it('WP142：解除关联之后，下面的积分卡当场换成「没关联」那一面（不再摆着余额）', async () => {
    state.view = LINKED
    renderWithProviders(
      <>
        <CloudAccountCard assignment="asg_1" />
        <CreditsPanel assignment="asg_1" />
      </>,
    )
    await screen.findByTestId('credits-balance')
    await userEvent.click(screen.getByRole('button', { name: '解除关联' }))
    await screen.findByTestId('cloud-account-unlinked')
    expect(await screen.findByTestId('credits-link-first')).toBeTruthy()
    expect(screen.queryByTestId('credits-balance')).toBeNull()
  })

  it('这台机器没有秘密库密钥时：说清楚为什么，按钮点不动', async () => {
    state.view = { ...UNLINKED, blocked_reason: '这台机器还没有秘密库密钥，令牌无处安全存放' }
    renderWithProviders(<CloudAccountCard assignment="asg_1" />)
    await screen.findByTestId('cloud-account-unlinked')
    expect(screen.getByText(/这台机器还没有秘密库密钥/)).toBeTruthy()
    expect(screen.getByRole('button', { name: '发登录邮件' }).hasAttribute('disabled')).toBe(true)
  })

  it('积分那块是 WP59 的空插槽，现在不渲染任何东西', () => {
    const { container } = renderWithProviders(<CreditsPanel />)
    expect(container.textContent).toBe('')
  })
})
