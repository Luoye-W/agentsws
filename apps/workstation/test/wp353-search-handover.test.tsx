/**
 * WP353：联网搜索要人介入的那一页——平时不出现；桌面壳交过来一页时第三栏「浏览器」顶上出现那一块，
 * 把位置给壳；「先不管了」交回壳收起；面板关了就收起（place(null)）。普通浏览器里（没有桥）什么都没有。
 */
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { SearchHandoverView, useSearchHandover } from '@/components/rail/panels/search-handover'
import { renderWithProviders } from './helpers'

type Listener = (h: unknown) => void

function installBridge(initial: unknown = null) {
  const calls: { place: unknown[]; dismiss: number } = { place: [], dismiss: 0 }
  let listener: Listener = () => undefined
  ;(globalThis as { agentsws?: unknown }).agentsws = {
    searchBrowser: {
      pending: async () => initial,
      onChange: (l: Listener) => {
        listener = l
        return () => undefined
      },
      place: async (r: unknown) => {
        calls.place.push(r)
        return true
      },
      dismiss: async () => {
        calls.dismiss += 1
        return true
      },
    },
  }
  return { calls, emit: (h: unknown) => listener(h) }
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'agentsws')
})

const HANDOVER = {
  workspace_id: 'ws_1',
  reason: 'captcha',
  message: '需要你在这页点一下验证（AI 不碰验证码）',
  url: 'https://www.google.com/search?q=x',
}

describe('WP353 搜索要人介入的那一页', () => {
  it('没有桌面壳：什么都不出现', () => {
    renderWithProviders(<SearchHandoverView />)
    expect(screen.queryByTestId('search-handover')).toBeNull()
  })

  it('平时不出现；壳交过来一页就出现一句话 + 一块地方（位置交给壳）；先不管了交回壳；卸掉就收起', async () => {
    const bridge = installBridge()
    const view = renderWithProviders(<SearchHandoverView />)
    expect(screen.queryByTestId('search-handover')).toBeNull()
    await act(async () => bridge.emit(HANDOVER))
    expect(screen.getByTestId('search-handover-message').textContent).toContain('点一下验证')
    expect(bridge.calls.place.at(-1)).toMatchObject({
      x: expect.any(Number),
      y: expect.any(Number),
    })
    await userEvent.click(screen.getByTestId('search-handover-dismiss'))
    expect(bridge.calls.dismiss).toBe(1)
    view.unmount()
    expect(bridge.calls.place.at(-1)).toBeNull()
  })

  it('启动时已经有一页在等：直接出现', async () => {
    installBridge(HANDOVER)
    function Probe() {
      const h = useSearchHandover()
      return <span data-testid="probe">{h === null ? 'none' : h.reason}</span>
    }
    render(<Probe />)
    expect(await screen.findByText('captcha')).toBeTruthy()
  })
})
