/**
 * WP332（决策 762）：社媒岗位页「没发出去」提醒条——只在出问题时出；一条写一行（原因照实一句）；
 * 「再填一次」/ 收起；没有社媒职责、全都正常时一个字都不画。
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
  refill: vi.fn(async (..._a: unknown[]) => ({})),
  dismiss: vi.fn(async (..._a: unknown[]) => ({})),
}

vi.mock('@/lib/reddit-write-api', () => ({
  REDDIT_WRITES_KEY: ['reddit-writes'],
  listRedditWrites: async () => ({ rows: state.rows }),
  refillRedditWrite: (...a: unknown[]) => state.refill(...a),
  dismissRedditWrite: (...a: unknown[]) => state.dismiss(...a),
}))

const duties = [
  { role_id: 'social.instagram', assignment_id: 'asg_ig' },
  { role_id: 'social.reddit', assignment_id: 'asg_reddit' },
]

beforeEach(() => {
  state.rows = []
  state.refill.mockClear()
  state.dismiss.mockClear()
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
    await waitFor(() => expect(state.refill).toHaveBeenCalledWith('asg_reddit', 'rdw_1', undefined))
    fireEvent.click(screen.getByTestId('reddit-write-dismiss'))
    await waitFor(() => expect(state.dismiss).toHaveBeenCalledWith('asg_reddit', 'rdw_1'))
  })

  it('WP478 修改：就地摊开草稿，改好了再填一次 → 交的是改过的字', async () => {
    state.rows = [row({ text: '原来的草稿' })]
    renderWithProviders(<RedditWriteNotice duties={duties} />)
    fireEvent.click(await screen.findByTestId('reddit-write-edit'))
    const box = screen.getByTestId('reddit-write-edit-text') as HTMLTextAreaElement
    expect(box.value).toBe('原来的草稿')
    // 编辑时那一行上不再出「再填一次」（按钮一排：改好了，再填一次 + 取消）
    expect(screen.queryByTestId('reddit-write-refill')).toBeNull()
    fireEvent.change(box, { target: { value: '改过的草稿' } })
    fireEvent.click(screen.getByTestId('reddit-write-edit-save'))
    await waitFor(() =>
      expect(state.refill).toHaveBeenCalledWith('asg_reddit', 'rdw_1', '改过的草稿'),
    )
    await waitFor(() => expect(screen.queryByTestId('reddit-write-editor')).toBeNull())
  })

  it('WP478 修改后取消：原样不动、不交；× 写「不发了」', async () => {
    state.rows = [row({ text: '原来的草稿' })]
    renderWithProviders(<RedditWriteNotice duties={duties} />)
    fireEvent.click(await screen.findByTestId('reddit-write-edit'))
    fireEvent.change(screen.getByTestId('reddit-write-edit-text'), { target: { value: '乱改' } })
    fireEvent.click(screen.getByTestId('reddit-write-edit-cancel'))
    expect(screen.queryByTestId('reddit-write-editor')).toBeNull()
    expect(state.refill).not.toHaveBeenCalled()
    // 再点修改：还是原来的字
    fireEvent.click(screen.getByTestId('reddit-write-edit'))
    expect((screen.getByTestId('reddit-write-edit-text') as HTMLTextAreaElement).value).toBe(
      '原来的草稿',
    )
    const x = screen.getByTestId('reddit-write-dismiss')
    expect(x.getAttribute('aria-label')).toBe('不发了')
    expect(x.getAttribute('title')).toContain('不再提醒')
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
