/**
 * 登录页与邀请（WP28 交付 B）。
 *
 * 三条：
 * 1. 邀请链接进来先接受、再登录——同事在这之前在这个工作区里什么都不是；
 * 2. 本地档把一次性登录 token 直接给页面（一按就进），托管档只说"去收件箱"——
 *    **两条路都不会把 token 显示出来**；
 * 3. 无效 / 过期的邀请给一句人话，不是一段错误码。
 */
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LoginPage } from '@/pages/login'
import { renderWithProviders } from './helpers'

const LOGIN_TOKEN = 'ml_secret_one_time'

const state = {
  acceptFails: false,
  issue: { token: LOGIN_TOKEN, expires_at: '2026-09-10T09:15:00.000Z' } as {
    token?: string
    expires_at: string
  },
}

const asked: string[] = []
const entered: string[] = []
const accepted: string[] = []

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    bootstrapHint: async () => ({ owner_email: 'wang@nordvolt.example', demo: false }),
    acceptInvitation: async (token: string) => {
      accepted.push(token)
      if (state.acceptFails)
        throw new actual.ApiClientError(404, { code: 'not_found', message: '邀请链接无效或已过期' })
      return {
        workspace_id: 'ws_dtc3c',
        workspace_name: 'NordVolt Gear',
        email: 'chen@nordvolt.example',
        person_id: 'per_chen',
        assignments: [],
      }
    },
    requestMagicLink: async (email: string) => {
      asked.push(email)
      return state.issue
    },
    signInWithToken: async (token: string) => {
      entered.push(token)
      return {
        person: { id: 'per_chen', email: 'chen@nordvolt.example', name: '陈晓' },
        workspace: { id: 'ws_dtc3c', name: 'NordVolt Gear' },
        assignments: [],
      }
    },
  }
})

beforeEach(() => {
  asked.length = 0
  entered.length = 0
  accepted.length = 0
  state.acceptFails = false
  state.issue = { token: LOGIN_TOKEN, expires_at: '2026-09-10T09:15:00.000Z' }
})

const renderInvite = (token = 'inv_tok'): void => {
  renderWithProviders(
    <Routes>
      <Route path="/invite/:token" element={<LoginPage />} />
    </Routes>,
    `/invite/${token}`,
  )
}

describe('邀请链接', () => {
  it('先接受邀请（说清加入了哪家），再用同一个邮箱登录', async () => {
    const user = userEvent.setup()
    renderInvite('inv_tok')
    expect((await screen.findByTestId('invite-joined')).textContent).toContain('NordVolt Gear')
    expect(accepted).toEqual(['inv_tok'])

    const email = screen.getByLabelText('你的邮箱') as HTMLInputElement
    await waitFor(() => {
      expect(email.value).toBe('chen@nordvolt.example')
    })

    await user.click(screen.getByRole('button', { name: '给我一个登录链接' }))
    await user.click(await screen.findByTestId('login-enter'))
    await waitFor(() => {
      expect(entered).toEqual([LOGIN_TOKEN])
    })
    // 一次性 token 不显示在页面上
    expect(document.body.textContent ?? '').not.toContain(LOGIN_TOKEN)
  })

  it('无效 / 过期的邀请给一句人话', async () => {
    state.acceptFails = true
    renderInvite('inv_dead')
    expect((await screen.findByTestId('invite-error')).textContent).toContain('无效')
  })
})

describe('登录页', () => {
  it('本机单人档把邮箱填好，一按就进', async () => {
    const user = userEvent.setup()
    renderWithProviders(<LoginPage />, '/login')
    const email = (await screen.findByLabelText('你的邮箱')) as HTMLInputElement
    await waitFor(() => {
      expect(email.value).toBe('wang@nordvolt.example')
    })
    await user.click(screen.getByRole('button', { name: '给我一个登录链接' }))
    expect(await screen.findByTestId('login-enter')).toBeTruthy()
    expect(asked).toEqual(['wang@nordvolt.example'])
  })

  it('托管档只说去收件箱点链接（token 走邮件，不进页面）', async () => {
    const user = userEvent.setup()
    state.issue = { expires_at: '2026-09-10T09:15:00.000Z' }
    renderWithProviders(<LoginPage />, '/login')
    await screen.findByLabelText('你的邮箱')
    await user.click(screen.getByRole('button', { name: '给我一个登录链接' }))
    expect(await screen.findByTestId('login-mailed')).toBeTruthy()
    expect(screen.queryByTestId('login-enter')).toBeNull()
  })
})
