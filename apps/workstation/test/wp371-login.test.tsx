/**
 * WP371 登录页（决策 942 / 943 / 1015）。
 *
 * - 942：地址 `#agentsws-enter=` 里的一次性 token 先从地址栏抹掉、再换会话；
 * - 943：本机档「用工坊账号进入」收在按钮后面，点开后发码 → 验码 → 「进去」；不是成员说人话；
 * - 943：局域网档工坊账号入口在最上面，设置码在下面；
 * - 1015：局域网档不出「确认你是哪一位」那句副标题，本机档也不再说「不是工坊账号登录」。
 */
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { consumeEntryToken, resetEntryTokenForTest, storedToken } from '@/lib/api'
import { LoginPage } from '@/pages/login'
import { renderWithProviders } from './helpers'

const state: { shared: boolean; member: boolean } = { shared: false, member: true }
const sent: string[] = []
const entered: string[] = []

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    bootstrapHint: async () =>
      state.shared
        ? { login: 'shared', demo: false }
        : { owner_email: 'wang@nordvolt.example', demo: false },
    sendAccountLoginCode: async (email: string) => {
      sent.push(email)
      return { expires_at: '2026-10-17T10:05:00.000Z', delivered: 'email' }
    },
    verifyAccountLoginCode: async (email: string, code: string) => {
      if (!state.member)
        throw new actual.ApiClientError(404, {
          code: 'not_found',
          message: `这个工作区里没有 ${email} 这位成员。`,
          details: { reason: 'not_member' },
        })
      return { token: `ml_account_${code}`, expires_at: '2026-10-17T10:15:00.000Z' }
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
  state.shared = false
  state.member = true
  sent.length = 0
  entered.length = 0
})

describe('决策 943：用工坊账号进入', () => {
  it('本机档：收在按钮后面；点开预填主人邮箱 → 发码 → 验码 → 进去', async () => {
    const user = userEvent.setup()
    renderWithProviders(<LoginPage />, '/login')
    expect(await screen.findByTestId('login-subtitle')).toBeTruthy()
    expect(screen.queryByTestId('login-account')).toBeNull()
    await waitFor(() => {
      expect((screen.getByLabelText('你在这个工作区里的邮箱') as HTMLInputElement).value).toBe(
        'wang@nordvolt.example',
      )
    })
    await user.click(screen.getByTestId('login-with-account'))
    const email = screen.getByLabelText('工坊账号邮箱') as HTMLInputElement
    expect(email.value).toBe('wang@nordvolt.example')
    await user.click(screen.getByTestId('login-account-send'))
    expect(await screen.findByTestId('login-account-sent')).toBeTruthy()
    expect(sent).toEqual(['wang@nordvolt.example'])
    await user.type(screen.getByTestId('login-account-code'), '13a5790')
    await user.click(screen.getByTestId('login-account-verify'))
    await user.click(await screen.findByTestId('login-enter'))
    await waitFor(() => {
      expect(entered).toEqual(['ml_account_135790'])
    })
  })

  it('码对了但不是成员：说人话、指路', async () => {
    state.member = false
    const user = userEvent.setup()
    renderWithProviders(<LoginPage />, '/login')
    await user.click(await screen.findByTestId('login-with-account'))
    const email = screen.getByLabelText('工坊账号邮箱')
    await user.clear(email)
    await user.type(email, 'jane@example.com')
    await user.click(screen.getByTestId('login-account-send'))
    await user.type(await screen.findByTestId('login-account-code'), '135790')
    await user.click(screen.getByTestId('login-account-verify'))
    const err = await screen.findByTestId('login-account-error')
    expect(err.textContent).toContain('jane@example.com 还不是这个工作区的成员')
    expect(screen.queryByTestId('login-enter')).toBeNull()
  })

  it('局域网档：工坊账号在上、设置码在下；不出副标题（决策 1015）', async () => {
    state.shared = true
    renderWithProviders(<LoginPage />, '/login')
    const account = await screen.findByTestId('login-account')
    const shared = screen.getByTestId('login-shared')
    expect(account.compareDocumentPosition(shared) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.queryByTestId('login-subtitle')).toBeNull()
    expect(screen.queryByLabelText('你在这个工作区里的邮箱')).toBeNull()
  })
})

describe('决策 942：地址里的一次性 token', () => {
  const fetchMock = vi.fn()
  beforeEach(() => {
    resetEntryTokenForTest()
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    window.history.replaceState(null, '', '/')
  })

  it('先抹掉地址栏里的 token，再换会话；只换一次', async () => {
    window.history.replaceState(null, '', '/?scenes=1#agentsws-enter=ml_tray&x=1')
    let hashWhenVerifying = ''
    fetchMock.mockImplementation(async (path: string) => {
      hashWhenVerifying = window.location.hash
      expect(path).toBe('/v1/auth/verify')
      return new Response(JSON.stringify({ data: { session_token: 'sess_30d' } }), { status: 200 })
    })
    await Promise.all([consumeEntryToken(), consumeEntryToken()])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ token: 'ml_tray' })
    expect(hashWhenVerifying).toBe('#x=1')
    expect(window.location.href).not.toContain('ml_tray')
    expect(window.location.search).toBe('?scenes=1')
    expect(storedToken()).toBe('sess_30d')
  })

  it('token 过期 / 用过：不报错，地址栏照样抹掉', async () => {
    window.history.replaceState(null, '', '/#agentsws-enter=ml_old')
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ code: 'unauthenticated', message: 'x' }), { status: 401 }),
    )
    await expect(consumeEntryToken()).resolves.toBeUndefined()
    expect(window.location.hash).toBe('')
  })

  it('地址里没有就什么都不做', async () => {
    window.history.replaceState(null, '', '/settings')
    await consumeEntryToken()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
