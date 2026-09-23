/**
 * WP128：聊天窗设置页「转发方式」第三项——客服增值服务（云端替你值守）。
 *
 * 断言盯的是商家看得懂的那几句话：没开 / 云端替你值守中 / 宽限中，最近心跳，
 * 开通与取消按钮点下去真的打了对的接口。界面上不许出现容器、镜像这类词。
 */
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatRelayHostedView } from '@/lib/api'
import { HostedRelayOption, hostedVerdict } from '@/pages/chat-window-hosted'
import { renderWithProviders } from './helpers'

const state = {
  view: {
    available: true,
    linked: true,
    subscription: { status: 'none' },
  } as ChatRelayHostedView,
  calls: [] as string[],
}

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getChatRelayHosted: async () => state.view,
    subscribeChatRelayHosted: async () => {
      state.calls.push('subscribe')
      state.view = {
        available: true,
        linked: true,
        subscription: { status: 'active' },
        hosted: {
          state: 'running',
          last_heartbeat_at: new Date(Date.now() - 120_000).toISOString(),
        },
      }
      return state.view
    },
    cancelChatRelayHosted: async () => {
      state.calls.push('cancel')
      state.view = { ...state.view, subscription: { status: 'cancelling' } }
      return state.view
    },
    seedChatRelayHosted: async () => {
      state.calls.push('seed')
      return { bytes: 10, message: '本机这一份已经推上去了。' }
    },
    bringHomeChatRelayHosted: async () => {
      state.calls.push('bring-home')
      return { saved_to: '/tmp/x.zip', bytes: 2, message: '云端那一份已经放进备份目录。' }
    },
  }
})

beforeEach(() => {
  state.view = { available: true, linked: true, subscription: { status: 'none' } }
  state.calls = []
})

describe('客服增值服务（云端替你值守）', () => {
  it('没开：一句「没开」+ 开通按钮；点开通 → 云端替你值守中 + 最近心跳', async () => {
    renderWithProviders(<HostedRelayOption />)
    expect((await screen.findByTestId('relay-hosted-verdict')).textContent).toContain('没开')
    await userEvent.click(await screen.findByTestId('relay-hosted-subscribe'))
    await waitFor(() =>
      expect(screen.getByTestId('relay-hosted-verdict').textContent).toContain('云端替你值守中'),
    )
    expect(state.calls).toEqual(['subscribe'])
    expect(screen.getByTestId('relay-hosted-heartbeat').textContent).toContain('2 分钟前还在线')
    // 同步两颗按钮只在订阅后出现
    await userEvent.click(screen.getByTestId('relay-hosted-seed'))
    expect((await screen.findByTestId('relay-hosted-note')).textContent).toContain('推上去了')
    await userEvent.click(screen.getByTestId('relay-hosted-bring-home'))
    await waitFor(() =>
      expect(screen.getByTestId('relay-hosted-note').textContent).toContain('备份目录'),
    )
    // 界面上不出现容器 / 镜像这种词（36：用户是非开发者）
    expect(document.body.textContent ?? '').not.toMatch(/容器|镜像|container/i)
  })

  it('没关联账号：没有开通按钮，只有那句人话', async () => {
    state.view = {
      available: false,
      linked: false,
      subscription: { status: 'none' },
      message: '还没关联 Agents 工坊账号。',
    }
    renderWithProviders(<HostedRelayOption />)
    expect((await screen.findByTestId('relay-hosted-message')).textContent).toContain('还没关联')
    expect(screen.queryByTestId('relay-hosted-subscribe')).toBeNull()
  })

  it('结论五档：宽限黄、宽限到期红、刚起蓝、没在跑黄', () => {
    const base = { available: true, linked: true } as const
    expect(hostedVerdict({ ...base, subscription: { status: 'grace' } }).tone).toBe('warn')
    expect(hostedVerdict({ ...base, subscription: { status: 'suspended' } }).tone).toBe('bad')
    expect(
      hostedVerdict({ ...base, subscription: { status: 'active' }, hosted: { state: 'starting' } })
        .key,
    ).toBe('chat.window.hosted.starting')
    expect(
      hostedVerdict({ ...base, subscription: { status: 'active' }, hosted: { state: 'sleeping' } })
        .tone,
    ).toBe('warn')
  })
})
