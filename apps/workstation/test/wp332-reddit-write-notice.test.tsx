/**
 * WP332（决策 762）：社媒岗位页「没发出去」提醒条——只在出问题时出；一条写一行（原因照实一句）；
 * 「再填一次」/ 收起；没有社媒职责、全都正常时一个字都不画。
 * WP491：「修改」= 还原成原来那张审核卡（卡片流里翻到它），不再就地改字；「再填一次」点了就有「在发…」、
 * 接着显示走哪条路（ego / 插件）。
 */
import type { RedditWriteView } from '@agentsws/contracts'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RedditWriteNotice, redditWriteAssignment } from '@/components/social/reddit-write-notice'
import { renderWithProviders } from './helpers'

const at = (): string => new Date(Date.now() - 60_000).toISOString()

const row = (
  over: { [K in keyof RedditWriteView]?: RedditWriteView[K] | undefined } = {},
): RedditWriteView =>
  ({
    approval_item_id: 'ap_1',
    job_id: 'rdw_1',
    kind: 'reply',
    subreddit: 'ivraxr',
    state: 'failed',
    message: '你点了停止，已停下。',
    outcome: 'stopped',
    can_refill: true,
    label: '回复 alice（Reddit · r/ivraxr）',
    queued_at: at(),
    finished_at: at(),
    ...over,
  }) as RedditWriteView

const state = {
  rows: [] as RedditWriteView[],
  refill: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({})),
  revise: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ approval_item_id: 'ap_9' })),
  dismiss: vi.fn(async (..._a: unknown[]) => ({})),
  jump: vi.fn((..._a: unknown[]) => {}),
}

vi.mock('@/lib/reddit-write-api', () => ({
  REDDIT_WRITES_KEY: ['reddit-writes'],
  listRedditWrites: async () => ({ rows: state.rows }),
  refillRedditWrite: (...a: unknown[]) => state.refill(...a),
  reviseRedditWrite: (...a: unknown[]) => state.revise(...a),
  dismissRedditWrite: (...a: unknown[]) => state.dismiss(...a),
}))

vi.mock('@/components/reports/position-bridge', () => ({
  requestCardJump: (...a: unknown[]) => state.jump(...a),
}))

const duties = [
  { role_id: 'social.instagram', assignment_id: 'asg_ig' },
  { role_id: 'social.reddit', assignment_id: 'asg_reddit' },
]

beforeEach(() => {
  state.rows = []
  state.refill.mockReset()
  state.refill.mockImplementation(async () => ({}))
  state.revise.mockClear()
  state.dismiss.mockClear()
  state.jump.mockClear()
})

describe('WP332 没发出去提醒条', () => {
  it('一条没发出去：哪一条 + 原因一句；「再填一次」交回同一条、收起', async () => {
    state.rows = [
      row(),
      row({ approval_item_id: 'ap_2', job_id: 'rdw_2', state: 'sent', outcome: undefined }),
    ]
    renderWithProviders(<RedditWriteNotice duties={duties} />)
    const rows = await screen.findAllByTestId('reddit-write-notice-row')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.textContent).toContain('没发出去：回复 alice（Reddit · r/ivraxr）')
    expect(rows[0]?.textContent).toContain('你点了停止')
    fireEvent.click(screen.getByTestId('reddit-write-refill'))
    await waitFor(() => expect(state.refill).toHaveBeenCalledWith('asg_reddit', 'rdw_1'))
    fireEvent.click(screen.getByTestId('reddit-write-dismiss'))
    await waitFor(() => expect(state.dismiss).toHaveBeenCalledWith('asg_reddit', 'rdw_1'))
  })

  it('WP491 修改：还原成原来那张卡（卡片流里翻到它），不再就地改字', async () => {
    state.rows = [row({ text: '原来的草稿' })]
    renderWithProviders(<RedditWriteNotice duties={duties} position="pos_social" />)
    const edit = await screen.findByTestId('reddit-write-edit')
    expect(edit.getAttribute('title')).toContain('原来那张卡')
    fireEvent.click(edit)
    await waitFor(() => expect(state.revise).toHaveBeenCalledWith('asg_reddit', 'rdw_1'))
    await waitFor(() => expect(state.jump).toHaveBeenCalledWith('pos_social', 'ap_9'))
    expect(screen.queryByTestId('reddit-write-edit-text')).toBeNull()
    expect(state.refill).not.toHaveBeenCalled()
    const x = screen.getByTestId('reddit-write-dismiss')
    expect(x.getAttribute('aria-label')).toBe('不发了')
    expect(x.getAttribute('title')).toContain('不再提醒')
  })

  it('WP491 再填一次：点了按钮进「在发…」，之后那一行说正在 ego 里发；发出去了照实变', async () => {
    state.rows = [row({ text: '原来的草稿' })]
    let finish: (v: unknown) => void = () => {}
    state.refill.mockImplementation(
      () =>
        new Promise((r) => {
          finish = r
        }),
    )
    renderWithProviders(<RedditWriteNotice duties={duties} />)
    fireEvent.click(await screen.findByTestId('reddit-write-refill'))
    await waitFor(() => expect(screen.getByTestId('reddit-write-refill').textContent).toBe('在发…'))
    expect(screen.getByTestId('reddit-write-edit')).toHaveProperty('disabled', true)
    const going = row({
      job_id: 'rde_2',
      state: 'queued',
      route: 'ego',
      message: '工坊正在 ego 里发',
      outcome: undefined,
      refills: 1,
    })
    state.rows = [going]
    finish(going)
    const line = await screen.findByTestId('reddit-write-going')
    expect(line.getAttribute('data-route')).toBe('ego')
    expect(line.textContent).toBe('正在 ego 里发：回复 alice（Reddit · r/ivraxr）')
    expect(screen.queryByTestId('reddit-write-notice-row')).toBeNull()
  })

  it('WP491 再填一次落到插件（ego 用不了）：那一行说交给插件了，带那一句原因', async () => {
    state.rows = [row()]
    const going = row({
      job_id: 'rdw_2',
      state: 'awaiting',
      outcome: undefined,
      message: 'ego 这会儿用不了，这一次改交给插件',
      route_note: 'ego 这会儿用不了，这一次改交给插件',
    })
    state.refill.mockImplementation(async () => {
      state.rows = [going]
      return going
    })
    renderWithProviders(<RedditWriteNotice duties={duties} />)
    fireEvent.click(await screen.findByTestId('reddit-write-refill'))
    const line = await screen.findByTestId('reddit-write-going')
    expect(line.getAttribute('data-route')).toBe('plugin')
    expect(line.textContent).toBe('回复 alice（Reddit · r/ivraxr） · ego 这会儿用不了，这一次改交给插件')
    expect(line.textContent).toContain('ego 这会儿用不了')
  })

  it('WP491 再填一次失败：照实一句原因', async () => {
    state.rows = [row()]
    state.refill.mockImplementation(async () => {
      throw new Error('Reddit 还没接上')
    })
    renderWithProviders(<RedditWriteNotice duties={duties} />)
    fireEvent.click(await screen.findByTestId('reddit-write-refill'))
    expect((await screen.findByTestId('reddit-write-error')).textContent).toBe('Reddit 还没接上')
  })

  it('WP478 没记下草稿的：没有「修改」，只有「再填一次」', async () => {
    state.rows = [row()]
    renderWithProviders(<RedditWriteNotice duties={duties} />)
    await screen.findByTestId('reddit-write-refill')
    expect(screen.queryByTestId('reddit-write-edit')).toBeNull()
  })

  it('收起了的、正常的都不出；不能再填的只给收起', async () => {
    state.rows = [row({ dismissed: true }), row({ state: 'queued' })]
    const { container } = renderWithProviders(<RedditWriteNotice duties={duties} />)
    await waitFor(() => expect(container.textContent).toBe(''))
    state.rows = [row({ can_refill: undefined, label: undefined })]
    renderWithProviders(<RedditWriteNotice duties={[duties[1] as (typeof duties)[number]]} />)
    const r = await screen.findByTestId('reddit-write-notice-row')
    expect(r.textContent).toContain('回复（r/ivraxr）')
    expect(screen.queryByTestId('reddit-write-refill')).toBeNull()
  })

  it('用担 Reddit 的那条社媒职责去问；没有社媒职责就不问', () => {
    expect(redditWriteAssignment(duties)).toBe('asg_reddit')
    expect(redditWriteAssignment([{ role_id: 'social.x', assignment_id: 'a' }])).toBe('a')
    expect(redditWriteAssignment([{ role_id: 'pr.reddit', assignment_id: 'b' }])).toBeUndefined()
  })
})

describe('WP332 公关回评论卡：被回的那一条点得开', () => {
  it('卡上带「原评论」链接（发布版式）', async () => {
    const { DeckCardView } = await import('@/components/deck/deck-card')
    const { draftCard } = await import('./fixtures')
    const base = draftCard()
    const card = draftCard({
      id: 'ap_pr',
      kind: 'staged_change',
      layout: 'publish',
      detail: {
        ...base.detail,
        payload: {
          kind: 'community_post',
          after: {
            platform: 'reddit',
            venue: 'r/smartglasses',
            body: 'We have an anti-fog insert for that.',
            parent_external_id: 't1_k7',
            parent_url: 'https://www.reddit.com/r/smartglasses/comments/p9/fog/k7/',
          },
        },
      },
    })
    renderWithProviders(
      <DeckCardView card={card} mode="zh_summary" onDecide={() => {}} onOpen={() => {}} />,
    )
    const link = screen.getByTestId('deck-parent-link') as HTMLAnchorElement
    expect(link.textContent).toContain('原评论')
    expect(link.href).toBe('https://www.reddit.com/r/smartglasses/comments/p9/fog/k7/')
  })
})
