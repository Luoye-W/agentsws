/**
 * WP358：一个人用桌面版不该看见「进工作台 / 你的邮箱」那一页；必须出现时说人话。
 *
 * 1. 会话丢了（过期 / 服务进程重启）→ 先让桌面壳给所有者重换一张，再问一次 `/v1/me`；
 * 2. 普通浏览器（没有桥）/ 壳换不到 → 照旧去登录页；
 * 3. 登录页说清这不是工坊账号；「未知邮箱」换成人话 + 两条出路。
 */
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ensureSession, NeedsLoginError } from '@/lib/api'
import { LoginPage } from '@/pages/login'
import { renderWithProviders } from './helpers'

const ME = {
  person: { id: 'per_owner', email: 'owner@localhost', name: 'owner' },
  workspace: { id: 'ws_1', name: 'NordVolt Gear' },
  assignments: [],
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('WP358 桌面壳里会话丢了自动重换', () => {
  let alive = false
  const renew = vi.fn(async () => {
    alive = true
    return true
  })

  beforeEach(() => {
    alive = false
    renew.mockClear()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url === '/v1/me')
          return alive
            ? json(200, { data: ME })
            : json(401, { code: 'unauthenticated', message: '会话过期' })
        if (url === '/app/bootstrap.json') return json(200, { owner_email: 'owner@localhost' })
        return json(404, { code: 'not_found', message: 'x' })
      }),
    )
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    delete (window as unknown as { agentsws?: unknown }).agentsws
  })

  it('开了 12 小时以上、/v1/me 回 401：问壳重换一张，接着用，不落登录页', async () => {
    ;(window as unknown as { agentsws: unknown }).agentsws = { session: { renew } }
    const me = await ensureSession()
    expect(me.person.id).toBe('per_owner')
    expect(renew).toHaveBeenCalledTimes(1)
  })

  it('壳换不到（remote 档 / 服务进程坏了）→ 照旧去登录页', async () => {
    ;(window as unknown as { agentsws: unknown }).agentsws = {
      session: { renew: async () => false },
    }
    await expect(ensureSession()).rejects.toBeInstanceOf(NeedsLoginError)
  })

  it('普通浏览器里没有桥 → 去登录页（不能凭打开网页就当主人）', async () => {
    await expect(ensureSession()).rejects.toBeInstanceOf(NeedsLoginError)
    expect(renew).not.toHaveBeenCalled()
  })
})

const asked: string[] = []

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    bootstrapHint: async () => ({ owner_email: 'wang@nordvolt.example', demo: false }),
    requestMagicLink: async (email: string) => {
      asked.push(email)
      if (email !== 'wang@nordvolt.example')
        throw new actual.ApiClientError(404, { code: 'not_found', message: '未知邮箱' })
      return { token: 'ml_x', expires_at: '2026-10-16T09:15:00.000Z' }
    },
  }
})

describe('WP358 登录页说人话', () => {
  beforeEach(() => {
    asked.length = 0
  })

  it('标题下面说清：这是进这个工作区，不是工坊账号登录', async () => {
    renderWithProviders(<LoginPage />, '/login')
    expect((await screen.findByTestId('login-subtitle')).textContent).toContain('不是工坊账号')
  })

  it('填了不是成员的邮箱：不只报「未知邮箱」，给主人一键换回、给同事指路', async () => {
    const user = userEvent.setup()
    renderWithProviders(<LoginPage />, '/login')
    const email = (await screen.findByLabelText('你在这个工作区里的邮箱')) as HTMLInputElement
    await waitFor(() => {
      expect(email.value).toBe('wang@nordvolt.example')
    })
    await user.clear(email)
    await user.type(email, 'jane@example.com')
    await user.click(screen.getByRole('button', { name: '给我一个进入链接' }))
    const box = await screen.findByTestId('login-unknown')
    expect(box.textContent).toContain('这个工作区里没有 jane@example.com')
    expect(box.textContent).toContain('邀请链接')
    expect(box.textContent).not.toBe('未知邮箱')

    await user.click(screen.getByTestId('login-use-owner'))
    expect(await screen.findByTestId('login-enter')).toBeTruthy()
    expect(asked).toEqual(['jane@example.com', 'wang@nordvolt.example'])
    expect(email.value).toBe('wang@nordvolt.example')
  })
})
