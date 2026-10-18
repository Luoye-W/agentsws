/**
 * WP218：左下角「有新版本」按钮。替身桥接演四条路：
 * 普通浏览器 / 没新版本不出现；有新版 → 点了下载（进度）→ 重启并更新；下载失败给人话、点了重试；
 * mac 未签名那一档按钮点了走「去下载」（同一个 download 口，壳决定开下载页）。
 */
import { act, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UPDATE_POLL_MS, UpdateButton, type UpdateStatusView } from '@/components/update-button'
import { renderWithProviders } from './helpers'

function fakeBridge(initial: UpdateStatusView) {
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
    push: (s: UpdateStatusView) => {
      act(() => {
        listener?.(s)
      })
    },
    listening: () => listener !== undefined,
  }
  ;(window as unknown as { agentsws?: unknown }).agentsws = { update: bridge }
  return bridge
}

afterEach(() => {
  delete (window as unknown as { agentsws?: unknown }).agentsws
})

describe('UpdateButton', () => {
  it('普通浏览器里（没有桌面壳）不出现', () => {
    renderWithProviders(<UpdateButton />)
    expect(screen.queryByTestId('update-button')).toBeNull()
  })

  it('没有新版本不出现；旧壳（桥上没有 update）也不出现', async () => {
    const bridge = fakeBridge({ state: 'idle' })
    const { unmount } = renderWithProviders(<UpdateButton />)
    await waitFor(() => {
      expect(bridge.status).toHaveBeenCalled()
    })
    expect(screen.queryByTestId('update-button')).toBeNull()
    unmount()
    expect(bridge.listening()).toBe(false)
    ;(window as unknown as { agentsws?: unknown }).agentsws = {}
    renderWithProviders(<UpdateButton />)
    expect(screen.queryByTestId('update-button')).toBeNull()
  })

  it('有新版 → 点了后台下载、显示进度 → 下好变「重启并更新」→ 点了交给壳装', async () => {
    const bridge = fakeBridge({
      state: 'available',
      version: '0.2.0',
      mode: 'auto',
      source: 'primary',
    })
    bridge.download.mockImplementation(async () => {
      bridge.push({ state: 'downloading', version: '0.2.0', percent: 42, source: 'primary' })
      return { state: 'downloading', version: '0.2.0', percent: 42, source: 'primary' }
    })
    renderWithProviders(<UpdateButton />)
    const button = await screen.findByTestId('update-button')
    expect(button.textContent).toContain('有新版本')
    expect(button.getAttribute('title')).toBe('新版本 0.2.0，点一下在后台下载')

    await userEvent.click(button)
    expect(bridge.download).toHaveBeenCalledOnce()
    expect(screen.getByTestId('update-percent').textContent).toContain('42%')
    expect((screen.getByTestId('update-button') as HTMLButtonElement).disabled).toBe(true)

    bridge.push({ state: 'ready', version: '0.2.0', source: 'primary' })
    const ready = screen.getByTestId('update-button')
    expect(ready.textContent).toContain('重启并更新')
    expect((ready as HTMLButtonElement).disabled).toBe(false)
    await userEvent.click(ready)
    expect(bridge.install).toHaveBeenCalledOnce()

    bridge.push({ state: 'installing', version: '0.2.0' })
    expect(screen.getByTestId('update-button').textContent).toContain('正在重启')
    await userEvent.click(screen.getByTestId('update-button'))
    expect(bridge.install).toHaveBeenCalledOnce()
  })

  it('下载失败：一句人话，点了重试', async () => {
    const bridge = fakeBridge({
      state: 'error',
      stage: 'download',
      code: 'network',
      version: '0.2.0',
    })
    renderWithProviders(<UpdateButton />)
    const button = await screen.findByTestId('update-button')
    expect(button.textContent).toContain('下载断了 · 重试')
    expect(button.getAttribute('title')).toContain('点这里接着下')
    await userEvent.click(button)
    expect(bridge.download).toHaveBeenCalledOnce()
    // 旧壳（桥上没有 openDownloadPage）：不出「去下载页」
    expect(screen.queryByTestId('update-download-page')).toBeNull()
  })

  it('WP409：下载断了——「重试」旁边给「去下载页」，点了交给壳开下载页', async () => {
    const bridge = fakeBridge({
      state: 'error',
      stage: 'download',
      code: 'network',
      version: '0.2.1',
    })
    const openDownloadPage = vi.fn(async () => true)
    ;(bridge as unknown as { openDownloadPage: typeof openDownloadPage }).openDownloadPage =
      openDownloadPage
    renderWithProviders(<UpdateButton />)
    const page = await screen.findByTestId('update-download-page')
    expect(page.textContent).toBe('去下载页')
    await userEvent.click(page)
    expect(openDownloadPage).toHaveBeenCalledOnce()
    expect(bridge.download).not.toHaveBeenCalled()
    // 别的下载错误（不是断线）仍说「下载没成功」，照样给去下载页
    bridge.push({ state: 'error', stage: 'download', code: 'checksum', version: '0.2.1' })
    expect(screen.getByTestId('update-button').textContent).toContain('下载没成功')
    expect(screen.getByTestId('update-download-page')).toBeTruthy()
    // 安装失败不给（那是重试安装，不是重下）
    bridge.push({ state: 'error', stage: 'install', code: 'smoke', version: '0.2.1' })
    expect(screen.queryByTestId('update-download-page')).toBeNull()
  })

  it('安装前自检没过：点了重试安装（不是重下）', async () => {
    const bridge = fakeBridge({ state: 'error', stage: 'install', code: 'smoke', version: '0.2.0' })
    renderWithProviders(<UpdateButton />)
    const button = await screen.findByTestId('update-button')
    await userEvent.click(button)
    expect(bridge.install).toHaveBeenCalledOnce()
    expect(bridge.download).not.toHaveBeenCalled()
  })

  it('mac 未签名：提示说去下载页，点了走同一个口（壳开下载页）', async () => {
    const bridge = fakeBridge({
      state: 'available',
      version: '0.2.0',
      mode: 'notify',
      source: 'primary',
    })
    renderWithProviders(<UpdateButton />)
    const button = await screen.findByTestId('update-button')
    expect(button.getAttribute('title')).toContain('去下载页')
    await userEvent.click(button)
    expect(bridge.download).toHaveBeenCalledOnce()
  })

  it('WP351：没进度事件只说「正在下载…」不写 0%；下完在摆新版说「正在准备新版…」', async () => {
    const bridge = fakeBridge({
      state: 'downloading',
      version: '0.2.0',
      percent: 0,
      source: 'primary',
    })
    renderWithProviders(<UpdateButton />)
    const button = await screen.findByTestId('update-button')
    expect(button.textContent).toContain('正在下载…')
    expect(button.textContent).not.toContain('0%')
    expect(screen.queryByTestId('update-percent')).toBeNull()
    bridge.push({
      state: 'downloading',
      version: '0.2.0',
      percent: 92,
      source: 'primary',
      phase: 'prepare',
    })
    expect(screen.getByTestId('update-button').textContent).toContain('正在准备新版…')
    expect(screen.queryByTestId('update-percent')).toBeNull()
    bridge.push({ state: 'ready', version: '0.2.0', source: 'primary' })
    expect(screen.getByTestId('update-button').textContent).toContain('重启并更新')
  })

  it('WP351：每 10 秒补拉一次状态——漏了事件也不会一直停在「正在下载」', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const bridge = fakeBridge({
        state: 'downloading',
        version: '0.2.0',
        percent: 0,
        source: 'primary',
      })
      renderWithProviders(<UpdateButton />)
      await screen.findByTestId('update-button')
      // 壳里早就 ready 了，但事件没送到
      bridge.status.mockResolvedValue({ state: 'ready', version: '0.2.0', source: 'primary' })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(UPDATE_POLL_MS)
      })
      await waitFor(() => {
        expect(screen.getByTestId('update-button').textContent).toContain('重启并更新')
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('桥问状态失败也不炸（当作没新版本）', async () => {
    const bridge = fakeBridge({ state: 'idle' })
    bridge.status.mockRejectedValueOnce(new Error('ipc gone'))
    renderWithProviders(<UpdateButton />)
    await waitFor(() => {
      expect(bridge.status).toHaveBeenCalled()
    })
    expect(screen.queryByTestId('update-button')).toBeNull()
  })
})
