/**
 * WP255（决策 144）：「回复」按钮（自家版待处理每一条、社群线程列表每一条）。
 * - 点开一个小输入框；「AI 起草」填进去、人能改；没用 AI 照实说；起草的那句带承诺就地提示；
 * - 「出卡」走 `POST /v1/social/threads/:id/reply`，出完那一行说「回帖卡已出」，不直接发；
 * - 承诺话术被服务端打回（400）：原因就地显示，框还开着，不算出卡；
 * - 自家版那一条第一次起草 / 出卡前先记成线程（只取一次）；线程列表那一条直接用线程 id。
 */
import type { OwnSubQueueView } from '@agentsws/contracts'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { OwnSubQueue } from '@/components/social/own-sub-queue'
import { SocialThreads } from '@/components/social/social-threads'
import { ApiClientError } from '@/lib/api'
import type { SocialThreadRowData } from '@/lib/social-reply-api'
import { renderWithProviders } from './helpers'

const NOW = '2026-10-07T08:00:00.000Z'

const view = (): OwnSubQueueView => ({
  subreddits: [{ account_id: 'sa_1', name: 'inmoxr', display_name: 'INMO XR' }],
  channel: 'browser',
  browser: {
    state: 'logged_in',
    username: 'inmo_official',
    writes_last_day: 0,
    max_writes_per_day: 30,
  },
  sources: [{ subreddit: 'inmoxr', source: 'modqueue', status: 'ok', count: 1 }],
  items: [
    {
      id: 't3_held1',
      account_id: 'sa_1',
      subreddit: 'inmoxr',
      kind: 'held',
      thing: 'post',
      title: 'My review',
      excerpt: 'Display is sharp.',
      author: 'bob',
      report_reasons: [],
      url: '',
      suggestion: { verdict: 'approve', reason: '没看到广告或骂人的话。' },
    },
  ],
  rules: [{ subreddit: 'inmoxr', rules: [] }],
  observed_at: NOW,
})

const rows = (): SocialThreadRowData[] => [
  {
    id: 'ct_1',
    account_id: 'sa_dc',
    account_name: 'INMO 社群',
    channel: 'discord',
    external_id: 'dc_1',
    surface: 'thread',
    author_external_id: 'u_9',
    author_handle: 'linaw',
    text: '刚收到眼镜，佩戴很舒服！',
    created_at: NOW,
    status: 'open',
    triage: 'praise',
  },
]

const state = {
  threads: rows(),
  ownSubThread: vi.fn(async () => ({ thread_id: 'ct_reddit_t3_held1' })),
  draft: vi.fn(
    async (): Promise<{ text: string; source: 'ai' | 'template'; warning?: string }> => ({
      text: 'Hi u/bob, thanks for sharing this!',
      source: 'template',
    }),
  ),
  reply: vi.fn(
    async (): Promise<{ staged: boolean; approval_item_id?: string; message?: string }> => ({
      staged: true,
      approval_item_id: 'ap_1',
    }),
  ),
}

vi.mock('@/lib/own-sub-api', () => ({
  getOwnSubQueue: async () => view(),
  stageOwnSub: async () => ({ staged: true }),
  openRedditBrowserLogin: async () => view().browser,
  checkRedditBrowserLogin: async () => view().browser,
  registerOwnSub: async () => ({ id: 'sa_2' }),
}))
vi.mock('@/lib/social-reply-api', () => ({
  getSocialThreads: async () => ({ rows: state.threads }),
  ownSubThread: (...a: unknown[]) => state.ownSubThread(...(a as [])),
  draftSocialReply: (...a: unknown[]) => state.draft(...(a as [])),
  replySocialThread: (...a: unknown[]) => state.reply(...(a as [])),
}))

beforeEach(() => {
  state.threads = rows()
  state.ownSubThread.mockClear()
  state.draft.mockClear()
  state.reply.mockClear()
})

async function openOwnSubReply(): Promise<HTMLElement> {
  renderWithProviders(<OwnSubQueue assignment="asg_social" />)
  const item = (await screen.findAllByTestId('own-sub-item'))[0] as HTMLElement
  fireEvent.click(within(item).getByTestId('reply-open'))
  return item
}

describe('WP255 自家版待处理里的「回复」', () => {
  it('按钮一个词、说明进问号；AI 起草（这次没用 AI 照实说）→ 人改 → 出卡（先记成线程，只取一次）', async () => {
    const item = await openOwnSubReply()
    expect(within(item).getByTestId('reply-open').textContent).toBe('回复')
    const box = within(item).getByTestId('reply-box')
    expect(within(box).getByTestId('reply-draft').textContent).toBe('AI 起草')
    expect(box.querySelector('[data-slot="hint"]')?.getAttribute('data-hint')).toContain(
      '出一张回帖卡',
    )

    fireEvent.click(within(box).getByTestId('reply-draft'))
    const text = within(box).getByTestId('reply-text') as HTMLTextAreaElement
    await waitFor(() => {
      expect(text.value).toBe('Hi u/bob, thanks for sharing this!')
    })
    expect(state.ownSubThread).toHaveBeenCalledWith(
      { account_id: 'sa_1', item_id: 't3_held1' },
      'asg_social',
    )
    expect(state.draft).toHaveBeenCalledWith('ct_reddit_t3_held1', 'asg_social')
    expect(within(box).getByTestId('reply-template').textContent).toContain('这次没用 AI')

    fireEvent.change(text, { target: { value: 'Hi u/bob, glad the display works for you!' } })
    fireEvent.click(within(box).getByTestId('reply-submit'))
    await waitFor(() => {
      expect(state.reply).toHaveBeenCalledWith(
        'ct_reddit_t3_held1',
        'Hi u/bob, glad the display works for you!',
        'asg_social',
      )
    })
    expect((await within(item).findByTestId('reply-staged')).textContent).toContain('回帖卡已出')
    expect(within(item).queryByTestId('reply-box')).toBeNull()
    // 线程只记了一次（起草那一下），出卡复用
    expect(state.ownSubThread).toHaveBeenCalledTimes(1)
  })

  it('承诺话术被打回：原因就地显示、框还开着、不算出卡', async () => {
    state.reply.mockImplementationOnce(async () => {
      throw new ApiClientError(400, {
        code: 'invalid_input',
        message: '正文里有第一人称承诺或无依据让步（refund）。',
      } as never)
    })
    const item = await openOwnSubReply()
    const box = within(item).getByTestId('reply-box')
    fireEvent.change(within(box).getByTestId('reply-text'), {
      target: { value: 'We will refund you tomorrow.' },
    })
    fireEvent.click(within(box).getByTestId('reply-submit'))
    const err = await within(box).findByTestId('reply-error')
    expect(err.textContent).toBe('被打回：正文里有第一人称承诺或无依据让步（refund）。')
    expect(within(item).queryByTestId('reply-staged')).toBeNull()
    // 改一个字，提示收起来
    fireEvent.change(within(box).getByTestId('reply-text'), {
      target: { value: 'Thanks for the feedback!' },
    })
    expect(within(box).queryByTestId('reply-error')).toBeNull()
  })

  it('AI 起草的那句自己带承诺：填进去给人改，并提前说「这句会被打回」；空框不能出卡', async () => {
    state.draft.mockImplementationOnce(async () => ({
      text: 'We will send you a free replacement.',
      source: 'ai',
      warning: '正文里有第一人称承诺。',
    }))
    const item = await openOwnSubReply()
    const box = within(item).getByTestId('reply-box')
    expect((within(box).getByTestId('reply-submit') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(within(box).getByTestId('reply-draft'))
    expect((await within(box).findByTestId('reply-warning')).textContent).toContain('这句会被打回')
    expect(within(box).queryByTestId('reply-template')).toBeNull()
    expect((within(box).getByTestId('reply-text') as HTMLTextAreaElement).value).toBe(
      'We will send you a free replacement.',
    )
  })
})

describe('WP255 社群线程列表', () => {
  it('一行一条（谁、哪个群、判成哪类、原话）+「回复」直接用线程 id 出卡', async () => {
    renderWithProviders(<SocialThreads assignment="asg_dc" channel="discord" />)
    const row = (await screen.findAllByTestId('social-thread'))[0] as HTMLElement
    expect(row.textContent).toContain('linaw')
    expect(row.textContent).toContain('INMO 社群')
    expect(row.textContent).toContain('夸奖')
    expect(row.textContent).toContain('刚收到眼镜')
    fireEvent.click(within(row).getByTestId('reply-open'))
    fireEvent.change(within(row).getByTestId('reply-text'), { target: { value: '谢谢分享～' } })
    fireEvent.click(within(row).getByTestId('reply-submit'))
    await waitFor(() => {
      expect(state.reply).toHaveBeenCalledWith('ct_1', '谢谢分享～', 'asg_dc')
    })
    expect(state.ownSubThread).not.toHaveBeenCalled()
    expect((await within(row).findByTestId('reply-staged')).textContent).toContain('回帖卡已出')
  })

  it('没有要回的：照实说一句', async () => {
    state.threads = []
    renderWithProviders(<SocialThreads assignment="asg_dc" channel="discord" />)
    expect(await screen.findByText('还没有要回的帖子')).toBeTruthy()
  })
})
