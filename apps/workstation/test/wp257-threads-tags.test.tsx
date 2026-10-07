/**
 * WP257（决策 152 / 156）：「群里的帖子」按标签筛、模型复核开关、Telegram 群登记与隐私模式提示。
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SocialThreads } from '@/components/social/social-threads'
import { parseTelegramGroup, type SocialIngestData } from '@/lib/social-ingest-api'
import type { SocialThreadRowData } from '@/lib/social-reply-api'
import { renderWithProviders } from './helpers'

const state = {
  ingest: undefined as SocialIngestData | undefined,
  rows: [] as SocialThreadRowData[],
  registerTg: vi.fn(async () => ({ id: 'sa_new' })),
  review: vi.fn(async (on: boolean) => ({ model_review: on, model_ready: true })),
}

vi.mock('@/lib/social-reply-api', () => ({
  getSocialThreads: async () => ({ rows: state.rows }),
  ownSubThread: async () => ({ thread_id: 'x' }),
  draftSocialReply: async () => ({ text: '', source: 'template' }),
  replySocialThread: async () => ({ staged: true }),
}))
vi.mock('@/lib/social-ingest-api', async (orig) => ({
  ...(await orig<typeof import('@/lib/social-ingest-api')>()),
  getSocialIngest: async () => state.ingest,
  registerTelegramGroup: (...a: unknown[]) => state.registerTg(...(a as [])),
  setSocialTagReview: (...a: unknown[]) => state.review(...(a as [boolean])),
}))

const tg = (over: Partial<SocialIngestData> = {}): SocialIngestData => ({
  channel: 'telegram_group',
  auto: true,
  connected: true,
  every_minutes: 15,
  accounts: [{ account_id: 'sa_tg', name: 'INMO 用户群', state: 'ok' }],
  tags: { model_review: false, model_ready: true },
  ...over,
})

const row = (id: string, text: string, triage?: SocialThreadRowData['triage']) =>
  ({
    id,
    account_id: 'sa_tg',
    account_name: 'INMO 用户群',
    channel: 'telegram_group',
    external_id: id,
    surface: 'thread',
    author_external_id: 'u',
    author_handle: 'fan',
    text,
    created_at: '2026-10-07T10:00:00.000Z',
    status: 'open',
    ...(triage === undefined ? {} : { triage, triage_by: 'rule' }),
  }) as SocialThreadRowData

beforeEach(() => {
  state.rows = []
  state.registerTg.mockClear()
  state.review.mockClear()
})

describe('WP257 按标签筛', () => {
  it('一排标签带条数、只列有帖子的类；点一类只看这一类，点「全部」回来', async () => {
    state.ingest = tg()
    state.rows = [
      row('1', '我的订单什么时候到', 'customer_question'),
      row('2', '怎么退货', 'customer_question'),
      row('3', '加微信领福利', 'spam'),
      row('4', '大家早', 'other'),
    ]
    renderWithProviders(<SocialThreads assignment="asg" channel="telegram_group" />)
    const bar = await screen.findByTestId('threads-tags')
    const tags = within(bar).getAllByTestId('threads-tag')
    expect(tags.map((t) => t.getAttribute('data-tag'))).toEqual([
      'all',
      'customer_question',
      'spam',
      'other',
    ])
    expect(tags[1]?.textContent).toBe('客户问题2')
    fireEvent.click(tags[1] as HTMLElement)
    await waitFor(() => {
      expect(screen.getAllByTestId('social-thread')).toHaveLength(2)
    })
    expect(tags[1]?.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(within(bar).getByText('全部'))
    await waitFor(() => {
      expect(screen.getAllByTestId('social-thread')).toHaveLength(4)
    })
  })

  it('没有一条带标签：不出标签那一排', async () => {
    state.ingest = tg()
    state.rows = [row('1', 'hello')]
    renderWithProviders(<SocialThreads assignment="asg" channel="telegram_group" />)
    await screen.findByTestId('social-thread')
    expect(screen.queryByTestId('threads-tags')).toBeNull()
  })
})

describe('WP257 模型复核开关', () => {
  it('默认关；拨开调设置口；老服务进程没有 tags 就不出开关', async () => {
    state.ingest = tg()
    renderWithProviders(<SocialThreads assignment="asg" channel="telegram_group" />)
    const sw = await screen.findByTestId('threads-review-switch')
    expect(sw.getAttribute('aria-checked')).toBe('false')
    expect(screen.getByTestId('threads-review').textContent).toContain('模型复核')
    fireEvent.click(sw)
    await waitFor(() => {
      expect(state.review).toHaveBeenCalledWith(true, 'asg')
    })
  })

  it('老服务进程（视图里没有 tags）：不出开关', async () => {
    const { tags: _t, ...old } = tg()
    state.ingest = old
    renderWithProviders(<SocialThreads assignment="asg" channel="telegram_group" />)
    await screen.findByTestId('threads-empty')
    expect(screen.queryByTestId('threads-review')).toBeNull()
  })
})

describe('WP257 Telegram 群：登记与隐私模式', () => {
  it('连上了还没登记：粘贴群链接登记；邀请链接认不出、照实说', async () => {
    state.ingest = tg({ accounts: [] })
    renderWithProviders(<SocialThreads assignment="asg" channel="telegram_group" />)
    const form = await screen.findByTestId('threads-register')
    expect(form.getAttribute('data-channel')).toBe('telegram_group')
    expect(form.textContent).toContain('还没登记要读的群')
    const input = screen.getByTestId('threads-register-link')
    fireEvent.change(input, { target: { value: 'https://t.me/+AbCdEf' } })
    fireEvent.click(screen.getByText('登记'))
    expect((await screen.findByTestId('threads-register-invalid')).textContent).toContain(
      '复制消息链接',
    )
    expect(state.registerTg).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: 'https://t.me/c/1234567890/55' } })
    fireEvent.click(screen.getByText('登记'))
    await waitFor(() => {
      expect(state.registerTg).toHaveBeenCalledWith('-1001234567890', 'asg')
    })
  })

  it('隐私模式开着：那个群一行照实说', async () => {
    state.ingest = tg({
      accounts: [
        {
          account_id: 'sa_tg',
          name: 'INMO 用户群',
          state: 'missing_permissions',
          missing: ['privacy_mode'],
          message:
            'Telegram 机器人开着隐私模式，在群里只看得到 @它的话：找 @BotFather 发 /setprivacy → 选这个机器人 → Disable。',
        },
      ],
    })
    renderWithProviders(<SocialThreads assignment="asg" channel="telegram_group" />)
    const issue = await screen.findByTestId('threads-issue')
    expect(issue.getAttribute('data-state')).toBe('missing_permissions')
    expect(issue.textContent).toContain('INMO 用户群')
    expect(issue.textContent).toContain('/setprivacy')
  })

  it('认群地址', () => {
    expect(parseTelegramGroup('https://t.me/c/1234567890/55')).toBe('-1001234567890')
    expect(parseTelegramGroup('https://t.me/inmo_users')).toBe('@inmo_users')
    expect(parseTelegramGroup('@inmo_users')).toBe('@inmo_users')
    expect(parseTelegramGroup('-1001234567890')).toBe('-1001234567890')
    expect(parseTelegramGroup('https://t.me/+AbCd')).toBeUndefined()
    expect(parseTelegramGroup('hello')).toBeUndefined()
  })
})
