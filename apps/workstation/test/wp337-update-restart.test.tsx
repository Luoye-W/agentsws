/**
 * WP337：有任务在做时点「重启并更新」——页面上三选一（一句 + 三个按钮，展开看清单）；
 * 没任务直接重启；「等空闲后重启」点一下取消；旧壳（桥上没有 readiness）退回 install()。
 */
import { act, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UpdateButton, type UpdateStatusView } from '@/components/update-button'
import type { RestartReadinessView } from '@/components/update-restart-dialog'
import { renderWithProviders } from './helpers'

const BUSY: RestartReadinessView = {
  total: 3,
  idle: false,
  counts: { output: 1, background: 0, scheduled: 2 },
  items: [
    { kind: 'output', title: '回复客户 Anna 的退货' },
    { kind: 'scheduled', title: '每天出周报' },
    { kind: 'scheduled', title: '每小时看一眼 Reddit' },
  ],
}

function fakeBridge(initial: UpdateStatusView, readiness?: RestartReadinessView) {
  let listener: ((s: UpdateStatusView) => void) | undefined
  const bridge = {
    status: vi.fn(async () => initial),
    onChange: vi.fn((cb: (s: UpdateStatusView) => void) => {
      listener = cb
      return () => {
        listener = undefined
      }
    }),
    download: vi.fn(async (): Promise<UpdateStatusView> => ({ state: 'idle' })),
    install: vi.fn(async () => 'installing' as const),
    restart: vi.fn(async (_c: 'now' | 'idle') => 'installing'),
    cancelWait: vi.fn(async () => true),
    ...(readiness === undefined ? {} : { readiness: vi.fn(async () => readiness) }),
    push: (s: UpdateStatusView) => {
      act(() => {
        listener?.(s)
      })
    },
  }
  ;(window as unknown as { agentsws?: unknown }).agentsws = { update: bridge }
  return bridge
}

afterEach(() => {
  delete (window as unknown as { agentsws?: unknown }).agentsws
})

const READY: UpdateStatusView = { state: 'ready', version: '0.2.2', source: 'primary' }

describe('WP337 重启并更新：有任务在做时三选一', () => {
  it('有任务：弹框一句「还有 3 件在做」，清单折着；展开看得到每件；选「现在重启」交给壳', async () => {
    const bridge = fakeBridge(READY, BUSY)
    renderWithProviders(<UpdateButton />)
    await userEvent.click(await screen.findByTestId('update-button'))
    const dialog = await screen.findByTestId('update-restart-dialog')
    expect(dialog.textContent).toContain('还有 3 件在做')
    expect(screen.queryByTestId('update-restart-items')).toBeNull()
    await userEvent.click(screen.getByTestId('update-restart-toggle'))
    expect(screen.getByTestId('update-restart-items').textContent).toContain('回复客户 Anna 的退货')
    await userEvent.click(screen.getByTestId('update-restart-now'))
    expect(bridge.restart).toHaveBeenCalledWith('now')
    expect(bridge.install).not.toHaveBeenCalled()
    await waitFor(() => {
      expect(screen.queryByTestId('update-restart-dialog')).toBeNull()
    })
  })

  it('选「空闲时重启」→ 按钮变「等空闲后重启」，点一下取消', async () => {
    const bridge = fakeBridge(READY, BUSY)
    renderWithProviders(<UpdateButton />)
    await userEvent.click(await screen.findByTestId('update-button'))
    await userEvent.click(await screen.findByTestId('update-restart-idle'))
    expect(bridge.restart).toHaveBeenCalledWith('idle')
    bridge.push({ state: 'waiting', version: '0.2.2', source: 'primary' })
    const button = screen.getByTestId('update-button')
    expect(button.textContent).toContain('等空闲后重启')
    expect(button.getAttribute('title')).toContain('点一下取消')
    await userEvent.click(button)
    expect(bridge.cancelWait).toHaveBeenCalledOnce()
  })

  it('稍后：关框，什么都不动', async () => {
    const bridge = fakeBridge(READY, BUSY)
    renderWithProviders(<UpdateButton />)
    await userEvent.click(await screen.findByTestId('update-button'))
    await userEvent.click(await screen.findByTestId('update-restart-later'))
    expect(bridge.restart).not.toHaveBeenCalled()
    expect(bridge.install).not.toHaveBeenCalled()
  })

  it('没任务：不弹框，直接重启', async () => {
    const bridge = fakeBridge(READY, {
      total: 0,
      idle: true,
      counts: { output: 0, background: 0, scheduled: 0 },
      items: [],
    })
    renderWithProviders(<UpdateButton />)
    await userEvent.click(await screen.findByTestId('update-button'))
    await waitFor(() => {
      expect(bridge.restart).toHaveBeenCalledWith('now')
    })
    expect(screen.queryByTestId('update-restart-dialog')).toBeNull()
  })

  it('旧壳（桥上没有 readiness）：照旧交给 install()（壳自己弹原生框）', async () => {
    const bridge = fakeBridge(READY)
    renderWithProviders(<UpdateButton />)
    await userEvent.click(await screen.findByTestId('update-button'))
    await waitFor(() => {
      expect(bridge.install).toHaveBeenCalledOnce()
    })
  })
})
