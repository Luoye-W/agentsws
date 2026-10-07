/**
 * WP256（决策 147）：「群里的帖子」空态按渠道照实说、缺权限照实说缺哪个、Discord 登记频道与读取频率。
 */
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SocialThreads } from '@/components/social/social-threads'
import { parseDiscordChannel, type SocialIngestData } from '@/lib/social-ingest-api'
import { renderWithProviders } from './helpers'

const state = {
  ingest: undefined as SocialIngestData | undefined,
  register: vi.fn(async () => ({ id: 'sa_new' })),
  every: vi.fn(async (_c: string, n: number) => ({
    ...(state.ingest as SocialIngestData),
    every_minutes: n,
  })),
}

vi.mock('@/lib/social-reply-api', () => ({
  getSocialThreads: async () => ({ rows: [] }),
  ownSubThread: async () => ({ thread_id: 'x' }),
  draftSocialReply: async () => ({ text: '', source: 'template' }),
  replySocialThread: async () => ({ staged: true }),
}))
vi.mock('@/lib/social-ingest-api', async (orig) => ({
  ...(await orig<typeof import('@/lib/social-ingest-api')>()),
  getSocialIngest: async () => state.ingest,
  registerDiscordChannel: (...a: unknown[]) => state.register(...(a as [])),
  setSocialIngestInterval: (...a: unknown[]) => state.every(...(a as [string, number])),
}))

const base = (over: Partial<SocialIngestData> = {}): SocialIngestData => ({
  channel: 'discord',
  auto: true,
  connected: true,
  every_minutes: 15,
  accounts: [{ account_id: 'sa_dc', name: '#general', state: 'ok' }],
  ...over,
})

beforeEach(() => {
  state.register.mockClear()
  state.every.mockClear()
})

describe('WP256 群里的帖子：空态照实说', () => {
  it('连上了、读得好好的：「这个群还没有新帖」', async () => {
    state.ingest = base()
    renderWithProviders(<SocialThreads assignment="asg" channel="discord" />)
    expect((await screen.findByTestId('threads-empty')).textContent).toContain('这个群还没有新帖')
  })

  it('没连上：「还没连上」+ 去连接页（落到这条渠道那张卡）', async () => {
    state.ingest = base({
      connected: false,
      accounts: [{ account_id: 'sa_dc', name: '#g', state: 'not_connected' }],
    })
    renderWithProviders(<SocialThreads assignment="asg" channel="discord" />)
    expect((await screen.findByTestId('threads-empty')).textContent).toContain('还没连上')
    const link = screen.getByTestId('threads-connect')
    expect(link.textContent).toBe('去连接页')
    expect(link.getAttribute('href')).toContain('/connections')
    expect(screen.queryByTestId('threads-every')).toBeNull()
  })

  it('这条渠道不会自动拉：照实说', async () => {
    // WP257 起 Telegram 群会自动拉了；WhatsApp 仍不会
    state.ingest = base({ channel: 'whatsapp', auto: false, accounts: [] })
    renderWithProviders(<SocialThreads assignment="asg" channel="whatsapp" />)
    expect((await screen.findByTestId('threads-empty')).textContent).toContain(
      '这条渠道还不会自动拉新帖',
    )
  })

  it('Reddit 没登记自家版：说去「自家版待处理」登记', async () => {
    state.ingest = base({ channel: 'reddit', every_minutes: undefined, accounts: [] } as never)
    renderWithProviders(<SocialThreads assignment="asg" channel="reddit" />)
    expect((await screen.findByTestId('threads-empty')).textContent).toContain('自家版待处理')
  })
})

describe('WP256 群里的帖子：缺权限 / 登记频道 / 读取频率', () => {
  it('缺权限：那个群一行说缺哪个，问号里说怎么开', async () => {
    state.ingest = base({
      accounts: [
        {
          account_id: 'sa_dc',
          name: '#general',
          state: 'missing_permissions',
          missing: ['read_message_history'],
          message: 'Discord 机器人还缺 「读取消息历史」权限，所以读不到这个频道的新消息。',
        },
      ],
    })
    renderWithProviders(<SocialThreads assignment="asg" channel="discord" />)
    const issue = await screen.findByTestId('threads-issue')
    expect(issue.getAttribute('data-state')).toBe('missing_permissions')
    expect(issue.textContent).toContain('#general')
    expect(issue.textContent).toContain('「读取消息历史」权限')
  })

  it('Discord 连上了还没登记频道：粘贴频道链接登记；认不出的链接照实说', async () => {
    state.ingest = base({ accounts: [] })
    renderWithProviders(<SocialThreads assignment="asg" channel="discord" />)
    const input = await screen.findByTestId('threads-register-link')
    fireEvent.change(input, { target: { value: 'https://example.com/x' } })
    fireEvent.click(screen.getByText('登记'))
    expect(await screen.findByTestId('threads-register-invalid')).toBeTruthy()
    expect(state.register).not.toHaveBeenCalled()
    fireEvent.change(input, {
      target: { value: 'https://discord.com/channels/900000000000000001/900000000000000002' },
    })
    fireEvent.click(screen.getByText('登记'))
    await waitFor(() => {
      expect(state.register).toHaveBeenCalledWith(
        { guild: '900000000000000001', channel: '900000000000000002' },
        'asg',
      )
    })
  })

  it('读取频率：默认每 15 分钟，改成 1 小时', async () => {
    state.ingest = base()
    renderWithProviders(<SocialThreads assignment="asg" channel="discord" />)
    const select = (await screen.findByTestId('threads-every')) as HTMLSelectElement
    expect(select.value).toBe('15')
    expect(select.selectedOptions[0]?.textContent).toBe('每 15 分钟')
    fireEvent.change(select, { target: { value: '60' } })
    await waitFor(() => {
      expect(state.every).toHaveBeenCalledWith('discord', 60, 'asg')
    })
  })

  it('解析频道链接', () => {
    expect(parseDiscordChannel('900000000000000001/900000000000000002')).toEqual({
      guild: '900000000000000001',
      channel: '900000000000000002',
    })
    expect(
      parseDiscordChannel(
        'https://discord.com/channels/900000000000000001/900000000000000002/900000000000000009',
      ),
    ).toEqual({ guild: '900000000000000001', channel: '900000000000000002' })
    expect(parseDiscordChannel('hello')).toBeUndefined()
  })
})
