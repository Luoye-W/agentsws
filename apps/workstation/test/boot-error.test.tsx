/**
 * WP139（docs/78 阻断 #2 第 5 条）：整页错误保留左栏 + 「重试」，不再是白底一行红字。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '@/App'
import { ApiClientError } from '@/lib/api'
import { AppProvider } from '@/lib/app-context'

const mocks = vi.hoisted(() => ({ ensureSession: vi.fn() }))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return { ...actual, ensureSession: mocks.ensureSession }
})

beforeEach(() => {
  mocks.ensureSession.mockReset()
})

describe('整页错误', () => {
  it('会话取不回来（限流）：左栏还在，主区一句人话 + 重试', async () => {
    mocks.ensureSession.mockRejectedValue(
      new ApiClientError(429, { code: 'budget_exhausted', message: '请求过于频繁' }),
    )
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <AppProvider initialTheme="light" initialLang="zh">
          <MemoryRouter initialEntries={['/']}>
            <App />
          </MemoryRouter>
        </AppProvider>
      </QueryClientProvider>,
    )
    const text = await screen.findByTestId('boot-error-text')
    expect(text.textContent).toContain('等几秒再试')
    expect(screen.getByTestId('main-nav')).toBeTruthy()
    const calls = mocks.ensureSession.mock.calls.length
    fireEvent.click(screen.getByTestId('boot-error-retry'))
    await waitFor(() => {
      expect(mocks.ensureSession.mock.calls.length).toBeGreaterThan(calls)
    })
  })
})
