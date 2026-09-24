/**
 * WP137：聊天窗设置页「转发方式」自建那一项能填留言密钥。
 *
 * 转发器现在「留言密钥没签发就不收留言」，自建 Docker 打印的留言密钥、自建 Worker 的
 * `MESSAGE_KEY` 都得有地方填回本机——否则留言永远收不到、收到了也开不了箱。
 */
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ChatWindowPage } from '@/pages/chat-window'
import { renderWithProviders } from './helpers'

const saved: Record<string, unknown>[] = []

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getChatWidgetSettings: async () => ({ allowed_origins: ['https://shop.example.com'] }),
    getChatRelaySettings: async () => ({
      endpoint: 'https://relay.example.com/relay/ws_x',
      has_pairing_token: true,
      has_message_key: false,
      configured: true,
    }),
    getChatRelayStatus: async () => ({ state: 'online', online: true }),
    listChatSessions: async () => [],
    getChatRelayHosted: async () => ({
      available: false,
      linked: false,
      subscription: { status: 'none' },
    }),
    setChatRelaySettings: async (input: Record<string, unknown>) => {
      saved.push(input)
      return {
        endpoint: 'https://relay.example.com/relay/ws_x',
        has_pairing_token: true,
        has_message_key: true,
        configured: true,
      }
    },
  }
})

describe('聊天窗 · 自建转发填留言密钥（WP137）', () => {
  it('只填留言密钥也能保存，且只送这一格', async () => {
    renderWithProviders(<ChatWindowPage />)
    const input = await screen.findByTestId('relay-message-key')
    expect((input as HTMLInputElement).type).toBe('password')
    await userEvent.type(input, 'mkk_from_docker_logs')
    await userEvent.click(screen.getByTestId('relay-save'))
    await waitFor(() => expect(saved).toEqual([{ message_key: 'mkk_from_docker_logs' }]))
  })
})
