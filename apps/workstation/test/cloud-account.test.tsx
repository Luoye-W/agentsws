/**
 * 49 M1 / M5 设置页「账号与积分」的账号卡。
 *
 * 四组断言：
 * 1. 没关联时是一句人话 + WP231 的注册 / 登录表单（默认注册；登录走验证码或密码）；
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
  codes: [] as string[],
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
    // WP231：登录验证码 / 密码登录
    cloudLoginCode: async (input: { email: string }) => {
      state.linked.push(input.email)
      return { expires_at: '2026-09-15T00:05:00.000Z', delivered: 'email' as const }
    },
    cloudLoginCodeVerify: async (input: { email: string; code: string }) => {
      state.codes.push(input.code)
      state.view = LINKED
      return LINKED
    },
    cloudPasswordLogin: async () => {
      throw new actual.ApiClientError(400, {
        code: 'invalid_input',
        message: '邮箱或密码不对',
        details: { reason: 'bad_credentials' },
      })
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
  state.codes = []
  state.unlinked = 0
})

describe('49 M1 设置页账号卡', () => {
  it('没关联：一句人话 + 邮箱框 + 发登录邮件；按完只提示去邮箱点', async () => {
    renderWithProviders(<CloudAccountCard assignment="asg_1" />)
    await screen.findByTestId('cloud-account-unlinked')
    expect(screen.getByText(/关联后能一键用 Agents 工坊的模型/)).toBeTruthy()
    // WP195：卡头是待机的品牌标记（关联的就是「Agents 工坊」账号），不再是一朵云
    expect(
      screen
        .getByTestId('cloud-account')
        .querySelector('svg[data-testid="brand-mark"]')
        ?.getAttribute('data-motion'),
    ).toBe('idle')
    // WP156：「不关联也照常用、一分不扣」那半句进了问号
    expect(
      screen
        .getByTestId('cloud-account-unlinked')
        .querySelector('[data-slot="hint"]')
        ?.getAttribute('data-hint'),
    ).toContain('一分不扣')

    // WP231：默认「注册新账号」；切到「已有账号，登录」→ 邮箱验证码
    expect(screen.getByTestId('cloud-account-auth').getAttribute('data-tab')).toBe('signup')
    await userEvent.click(screen.getByTestId('cloud-account-tab-login'))
    await userEvent.type(screen.getByLabelText('邮箱'), 'luoye@example.com')
    await userEvent.click(screen.getByRole('button', { name: '发验证码' }))

    await screen.findByTestId('cloud-account-sent')
    expect(state.linked).toEqual(['luoye@example.com'])
    await userEvent.type(screen.getByTestId('cloud-account-code'), '246810')
    await userEvent.click(screen.getByTestId('cloud-account-verify'))
    await screen.findByTestId('cloud-account-linked')
    expect(state.codes).toEqual(['246810'])
    // 一次性的东西不留在页面上
    expect(document.body.textContent ?? '').not.toMatch(/cml_|wst_|246810/)
  })

  it('邮箱没填时按钮点不动', async () => {
    renderWithProviders(<CloudAccountCard assignment="asg_1" />)
    await screen.findByTestId('cloud-account-unlinked')
    await userEvent.click(screen.getByTestId('cloud-account-tab-login'))
    const button = screen.getByRole('button', { name: '发验证码' })
    expect(button.hasAttribute('disabled')).toBe(true)
  })

  it('WP231 密码登录不对：说人话 + 一键换成验证码登录；密码不留在页面上', async () => {
    renderWithProviders(<CloudAccountCard assignment="asg_1" />)
    await screen.findByTestId('cloud-account-unlinked')
    await userEvent.click(screen.getByTestId('cloud-account-tab-login'))
    await userEvent.click(screen.getByTestId('cloud-account-via-password'))
    await userEvent.type(screen.getByLabelText('邮箱'), 'luoye@example.com')
    await userEvent.type(screen.getByTestId('cloud-account-password'), 'wrong-pass-1')
    await userEvent.click(screen.getByRole('button', { name: '登录' }))
    const failed = await screen.findByTestId('cloud-account-failed')
    expect(failed.textContent).toContain('邮箱或密码不对')
    expect(document.body.innerHTML).not.toContain('wrong-pass-1')
    await userEvent.click(screen.getByTestId('cloud-account-switch-code'))
    expect(screen.getByRole('button', { name: '发验证码' })).toBeTruthy()
  })

  it('已关联：邮箱、到期、动作集都在，且没有令牌', async () => {
    state.view = LINKED
    renderWithProviders(<CloudAccountCard assignment="asg_1" />)
    await screen.findByTestId('cloud-account-linked')
    const text = screen.getByTestId('cloud-account').textContent ?? ''
    // WP214：卡面上是「已关联」图标 + 邮箱；到期、动作集、云端地址进这个图标的 tooltip
    expect(text).toContain('luoye@example.com')
    expect(text).not.toContain('2026-12-14')
    const hint = screen.getByTestId('status-icon').getAttribute('data-hint') ?? ''
    expect(hint).toContain('已关联')
    expect(hint).toContain('2026-12-14')
    expect(hint).toContain('ai · wallet:read')
    expect(text).not.toMatch(/wst_/)
    expect(hint).not.toMatch(/wst_/)
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
    expect(screen.getByRole('button', { name: '注册' }).hasAttribute('disabled')).toBe(true)
  })

  it('积分那块是 WP59 的空插槽，现在不渲染任何东西', () => {
    const { container } = renderWithProviders(<CreditsPanel />)
    expect(container.textContent).toBe('')
  })
})
