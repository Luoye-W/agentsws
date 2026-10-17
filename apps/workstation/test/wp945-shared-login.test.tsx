/**
 * 决策 945：服务开给局域网（bootstrap 里 `login: 'shared'`）时的登录页。
 *
 * - 不出邮箱框（填主人邮箱一按就进那条洞在页面上也不留入口）；
 * - 主人输入日志里的设置码 → 拿到一次性登录 token → 「进去」，token 不显示在页面上；
 * - 同事的邀请接受完直接带 token，一按就进，不用再填邮箱；
 * - 本机档（没有 `login` 键）照旧，见 login.test.tsx。
 */
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LoginPage } from '@/pages/login'
import { renderWithProviders } from './helpers'

const SETUP_TOKEN = 'ml_from_setup_code'
const INVITE_TOKEN = 'ml_from_invite'

const redeemed: string[] = []
const entered: string[] = []
const asked: string[] = []
const state = { codeOk: true }

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    bootstrapHint: async () => ({ login: 'shared', demo: false }),
    redeemSetupCode: async (code: string) => {
      redeemed.push(code)
      if (!state.codeOk)
        throw new actual.ApiClientError(401, {
          code: 'unauthenticated',
          message: '设置码不对或已经用过，请看服务日志里最新的那一个',
        })
      return { token: SETUP_TOKEN, expires_at: '2026-10-16T10:15:00.000Z' }
    },
    acceptInvitation: async () => ({
      workspace_id: 'ws_1',
      workspace_name: 'NordVolt Gear',
      email: 'chen@nordvolt.example',
      person_id: 'per_chen',
      assignments: [],
      login_token: INVITE_TOKEN,
    }),
    requestMagicLink: async (email: string) => {
      asked.push(email)
      return { expires_at: '2026-10-16T10:15:00.000Z', delivered: 'email' }
    },
    signInWithToken: async (token: string) => {
      entered.push(token)
      return {
        person: { id: 'per_x', email: 'x@nordvolt.example', name: 'x' },
        workspace: { id: 'ws_1', name: 'NordVolt Gear' },
        assignments: [],
      }
    },
  }
})

beforeEach(() => {
  redeemed.length = 0
  entered.length = 0
  asked.length = 0
  state.codeOk = true
})

describe('局域网档登录页', () => {
  it('不出邮箱框；主人输设置码就能进，token 不显示', async () => {
    const user = userEvent.setup()
    renderWithProviders(<LoginPage />, '/login')
    await screen.findByTestId('login-shared')
    expect(screen.queryByLabelText('你的邮箱')).toBeNull()
    expect(screen.queryByRole('button', { name: '给我一个登录链接' })).toBeNull()
    expect(screen.getByTestId('login-shared-colleague').textContent).toContain('邀请链接')

    await user.type(screen.getByLabelText(/设置码/), 'abcd-efgh')
    await user.click(screen.getByRole('button', { name: '用设置码进入' }))
    await user.click(await screen.findByTestId('login-enter'))
    await waitFor(() => {
      expect(entered).toEqual([SETUP_TOKEN])
    })
    expect(redeemed).toEqual(['abcd-efgh'])
    expect(asked).toEqual([])
    expect(document.body.textContent ?? '').not.toContain(SETUP_TOKEN)
  })

  it('设置码不对给一句人话', async () => {
    state.codeOk = false
    const user = userEvent.setup()
    renderWithProviders(<LoginPage />, '/login')
    await user.type(await screen.findByLabelText(/设置码/), 'ZZZZ-ZZZZ')
    await user.click(screen.getByRole('button', { name: '用设置码进入' }))
    expect((await screen.findByTestId('setup-code-error')).textContent).toContain('服务日志')
    expect(screen.queryByTestId('login-enter')).toBeNull()
  })

  it('同事点邀请链接：接受完一按就进，不用填邮箱', async () => {
    const user = userEvent.setup()
    renderWithProviders(
      <Routes>
        <Route path="/invite/:token" element={<LoginPage />} />
      </Routes>,
      '/invite/inv_tok',
    )
    expect((await screen.findByTestId('invite-joined')).textContent).toContain('NordVolt Gear')
    await waitFor(() => {
      expect(screen.queryByLabelText('你的邮箱')).toBeNull()
    })
    await user.click(await screen.findByTestId('login-enter'))
    await waitFor(() => {
      expect(entered).toEqual([INVITE_TOKEN])
    })
    expect(asked).toEqual([])
    expect(document.body.textContent ?? '').not.toContain(INVITE_TOKEN)
  })
})
