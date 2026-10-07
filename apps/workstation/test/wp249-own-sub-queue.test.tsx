/**
 * WP249「自家版待处理」快捷视图：
 * - 按类型分组，每条一句摘要 + 举报原因 + AI 建议（引用版规）；入群申请读不到照实说；
 * - 按钮只出卡（移除带选中的版规），出完那一行说「卡已出」；先不管只在本页藏起来；
 * - 没登录官方号：页头「登录官方号 / 我登录好了」；没登记自家版：一行登记。
 */
import type { OwnSubQueueView } from '@agentsws/contracts'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { OwnSubQueue } from '@/components/social/own-sub-queue'
import { renderWithProviders } from './helpers'

const NOW = '2026-10-07T08:00:00.000Z'

const fullView = (): OwnSubQueueView => ({
  subreddits: [{ account_id: 'sa_1', name: 'inmoxr', display_name: 'INMO XR' }],
  channel: 'browser',
  browser: {
    state: 'logged_in',
    username: 'inmo_official',
    writes_last_day: 0,
    max_writes_per_day: 30,
  },
  sources: [
    { subreddit: 'inmoxr', source: 'modqueue', status: 'ok', count: 2 },
    { subreddit: 'inmoxr', source: 'unmoderated', status: 'ok', count: 1 },
    {
      subreddit: 'inmoxr',
      source: 'join_requests',
      status: 'unsupported',
      message: 'Reddit 没有公开的「入群申请」读口',
    },
  ],
  items: [
    {
      id: 't3_spam1',
      account_id: 'sa_1',
      subreddit: 'inmoxr',
      kind: 'reported',
      thing: 'post',
      title: 'Cheap INMO Air3, DM me on telegram',
      excerpt: 'wholesale https://bit.ly/x',
      author: 'spammer1',
      report_reasons: ['No spam or self-promotion'],
      url: 'https://www.reddit.com/r/inmoxr/comments/spam1/x/',
      suggestion: {
        verdict: 'remove',
        reason: '像广告 / 引流：出现「dm me」，违反版规「No spam or self-promotion」。',
        rule: 'No spam or self-promotion',
      },
    },
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
      suggestion: {
        verdict: 'approve',
        reason: '被 Reddit 自动过滤扣下了，但没看到广告或骂人的话；建议放出来。',
      },
      last_failure: '页面要做人机验证，我们不绕，已停下。',
    },
    {
      id: 't3_new1',
      account_id: 'sa_1',
      subreddit: 'inmoxr',
      kind: 'new_post',
      thing: 'post',
      title: 'Hello from Berlin',
      excerpt: 'Just got mine!',
      author: 'carol',
      report_reasons: [],
      url: '',
      suggestion: { verdict: 'ignore', reason: '正常新帖，不用管。' },
    },
  ],
  rules: [{ subreddit: 'inmoxr', rules: ['No spam or self-promotion', 'Be civil'] }],
  observed_at: NOW,
})

const state: {
  view: OwnSubQueueView
  stage: ReturnType<typeof vi.fn>
  login: ReturnType<typeof vi.fn>
  register: ReturnType<typeof vi.fn>
} = {
  view: fullView(),
  stage: vi.fn(async () => ({ staged: true, approval_item_id: 'ap_1', level: 'L2' })),
  login: vi.fn(async () => ({
    state: 'login_window_open',
    writes_last_day: 0,
    max_writes_per_day: 30,
  })),
  register: vi.fn(async () => ({ id: 'sa_2' })),
}

vi.mock('@/lib/own-sub-api', () => ({
  getOwnSubQueue: async () => state.view,
  stageOwnSub: (...a: unknown[]) => state.stage(...a),
  openRedditBrowserLogin: (...a: unknown[]) => state.login(...a),
  checkRedditBrowserLogin: async () => state.view.browser,
  registerOwnSub: (...a: unknown[]) => state.register(...a),
}))

beforeEach(() => {
  state.view = fullView()
  state.stage.mockClear()
  state.login.mockClear()
  state.register.mockClear()
})

describe('WP249 自家版待处理', () => {
  it('按类型分组，每条摘要 + 举报原因 + 建议（引用版规）；入群申请读不到照实说', async () => {
    renderWithProviders(<OwnSubQueue assignment="asg_social" />)
    const groups = await screen.findAllByTestId('own-sub-group')
    expect(groups.map((g) => g.getAttribute('data-group'))).toEqual([
      'reported',
      'held',
      'new_post',
    ])
    expect(screen.getByTestId('own-sub-via').textContent).toContain('官方号 u/inmo_official')
    const spam = screen.getAllByTestId('own-sub-item')[0] as HTMLElement
    expect(within(spam).getByTestId('own-sub-reports').textContent).toContain(
      'No spam or self-promotion',
    )
    expect(within(spam).getByTestId('own-sub-suggestion').textContent).toContain('建议移除')
    expect(within(spam).getByTestId('own-sub-reason').textContent).toContain(
      '违反版规「No spam or self-promotion」',
    )
    expect(screen.getByTestId('own-sub-failed').textContent).toContain('人机验证')
    expect(screen.getByTestId('own-sub-join').textContent).toContain('读不到')
  })

  it('移除只出卡（带选中的版规），出完那一行说卡已出；先不管只在本页藏起来', async () => {
    renderWithProviders(<OwnSubQueue assignment="asg_social" />)
    const spam = (await screen.findAllByTestId('own-sub-item'))[0] as HTMLElement
    // 默认选的是建议引用的那条版规
    expect((within(spam).getByTestId('own-sub-rule') as HTMLSelectElement).value).toBe(
      'No spam or self-promotion',
    )
    fireEvent.click(within(spam).getByTestId('own-sub-remove'))
    await waitFor(() => {
      expect(state.stage).toHaveBeenCalledWith(
        {
          account_id: 'sa_1',
          item_id: 't3_spam1',
          action: 'remove',
          removal_rule: 'No spam or self-promotion',
        },
        'asg_social',
      )
    })
    expect((await within(spam).findByTestId('own-sub-staged')).textContent).toContain('卡已出')
    const fresh = screen
      .getAllByTestId('own-sub-item')
      .find((el) => el.getAttribute('data-id') === 't3_new1') as HTMLElement
    fireEvent.click(within(fresh).getByTestId('own-sub-ignore'))
    expect(screen.getAllByTestId('own-sub-item').map((el) => el.getAttribute('data-id'))).toEqual([
      't3_spam1',
      't3_held1',
    ])
  })

  it('没登录官方号：页头给「登录官方号」；没登记自家版：一行登记', async () => {
    state.view = {
      ...fullView(),
      subreddits: [],
      items: [],
      sources: [],
      channel: 'none',
      browser: { state: 'not_logged_in', writes_last_day: 0, max_writes_per_day: 30 },
    }
    renderWithProviders(<OwnSubQueue assignment="asg_social" />)
    fireEvent.click(await screen.findByTestId('own-sub-login'))
    await waitFor(() => {
      expect(state.login).toHaveBeenCalled()
    })
    const reg = screen.getByTestId('own-sub-register')
    fireEvent.change(within(reg).getByRole('textbox'), { target: { value: 'r/inmoxr' } })
    fireEvent.click(within(reg).getByRole('button', { name: '登记' }))
    await waitFor(() => {
      expect(state.register).toHaveBeenCalledWith('r/inmoxr', 'asg_social')
    })
  })
})
