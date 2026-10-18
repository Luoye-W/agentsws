/**
 * WP414（Luoye 10-19 真机，INMO Reddit 回信卡）：审批卡底部操作重排 +「不要」理由可选 + 同类卡跟着前一个决定。
 *
 * - 按钮样式：主按钮 +「修改 / 不要 / 稍后」都是按钮，「稍后」外露，没有「需要补素材」与 `···`；
 * - 「不要」一下就生效；卡流顶上出一行可选的快捷理由（不相关 / 时机不对 / 不想回 / 其他…），点了补记；
 * - 同类卡跟着处理了：「另外 N 张也一并不发了 · 看是哪几张 · 撤回」；
 * - 「发送」之后：「这 N 张和刚才那张类似，要一起发送吗？」——一起发要再点一次，逐张看翻到第一张。
 */
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DecideFollowData, HomeData } from '@/lib/api'
import { draftCard, homeData } from './fixtures'
import { renderWithProviders } from './helpers'

let home: HomeData = homeData()
let decideOut: unknown = {}

const getHome = vi.fn(async () => home)
const decide = vi.fn(async () => decideOut)
const undoFollow = vi.fn(async () => ({ restored: [{ id: 'ap_2' }, { id: 'ap_3' }], skipped: [] }))
const addDecisionReason = vi.fn(async () => ({ followers: 2 }))
const approveBatch = vi.fn(async () => ({ results: [{ id: 'ap_2' }, { id: 'ap_3' }] }))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getHome: (...args: unknown[]) => getHome(...(args as [])),
    decide: (...args: unknown[]) => decide(...(args as [])),
    undoFollow: (...args: unknown[]) => undoFollow(...(args as [])),
    addDecisionReason: (...args: unknown[]) => addDecisionReason(...(args as [])),
    approveBatch: (...args: unknown[]) => approveBatch(...(args as [])),
  }
})

const { DeckSection } = await import('@/components/deck')

const three = (): HomeData =>
  homeData({
    queue: [
      draftCard({ id: 'ap_1', title: '回复 u/alice（r/Smartphones）' }),
      draftCard({ id: 'ap_2', title: '回复 u/bob（r/Smartphones）' }),
      draftCard({ id: 'ap_3', title: '回复 u/cat（r/Smartphones）' }),
    ],
  })

const follow = (action: DecideFollowData['action'], key: 'applied' | 'suggested') => ({
  follow: {
    action,
    leader_id: 'ap_1',
    leader_title: '回复 u/alice（r/Smartphones）',
    applied: [],
    suggested: [],
    [key]: [
      {
        id: 'ap_2',
        title: '回复 u/bob（r/Smartphones）',
        why: '同在 r/Smartphones，AI 出卡的理由相近',
        basis: ['same_source', 'same_judgement'],
        source: 'r/Smartphones',
      },
      {
        id: 'ap_3',
        title: '回复 u/cat（r/Smartphones）',
        why: '同在 r/Smartphones，AI 出卡的理由相近',
        basis: ['same_source', 'same_judgement'],
        source: 'r/Smartphones',
      },
    ],
  },
})

beforeEach(() => {
  home = three()
  decideOut = {}
  for (const f of [getHome, decide, undoFollow, addDecisionReason, approveBatch]) f.mockClear()
})

describe('WP414 卡底部按钮', () => {
  it('主按钮 +「修改 / 不发 / 稍后」都是按钮，没有 ··· 与「需要补素材」', async () => {
    renderWithProviders(<DeckSection onOpen={() => {}} />)
    const bar = await screen.findByTestId('deck-action-bar')
    const labels = within(bar)
      .getAllByRole('button')
      .map((b) => b.textContent?.trim())
    expect(labels).toEqual(['发送', '修改', '不发', '稍后'])
    expect(screen.queryByTestId('deck-more')).toBeNull()
    expect(screen.queryByText('需要补素材')).toBeNull()
  })
})

describe('WP414「不要」不强制写理由', () => {
  it('点「不发」一下就生效；快捷理由可选，点了补记（跟着的那几张一起）', async () => {
    const user = userEvent.setup()
    decideOut = follow('reject', 'applied')
    renderWithProviders(<DeckSection onOpen={() => {}} />)
    await user.click(await screen.findByText('不发'))
    await waitFor(() => {
      expect(decide).toHaveBeenCalledWith('ap_1', { action: 'reject', version: 1 }, 'asg_1')
    })
    const reasons = await screen.findByTestId('deck-drop-reasons')
    expect(reasons.textContent).toContain('已不发')
    for (const r of ['不相关', '时机不对', '不想回', '其他…'])
      expect(within(reasons).getByText(r)).toBeDefined()
    await user.click(within(reasons).getByText('不相关'))
    await waitFor(() => {
      expect(addDecisionReason).toHaveBeenCalledWith(
        'ap_1',
        { reason: '不相关', follower_ids: ['ap_2', 'ap_3'] },
        'asg_1',
      )
    })
    expect((await screen.findByTestId('deck-drop-reason-saved')).textContent).toContain('不相关')
  })

  it('「其他…」开一个可选的输入框；不填也不影响那次「不发」', async () => {
    const user = userEvent.setup()
    renderWithProviders(<DeckSection onOpen={() => {}} />)
    await user.click(await screen.findByText('不发'))
    const reasons = await screen.findByTestId('deck-drop-reasons')
    await user.click(within(reasons).getByText('其他…'))
    const box = within(reasons).getByRole('textbox')
    await user.type(box, '这个用户在钓鱼')
    await user.click(within(reasons).getByText('记下'))
    await waitFor(() => {
      expect(addDecisionReason).toHaveBeenCalledWith(
        'ap_1',
        { reason: '这个用户在钓鱼', follower_ids: [] },
        'asg_1',
      )
    })
  })
})

describe('WP414 同类卡跟着前一个决定', () => {
  it('否掉第一张 → 顶上一行「另外 2 张也一并不发了」，能看是哪几张、能整批撤回', async () => {
    const user = userEvent.setup()
    decideOut = follow('reject', 'applied')
    renderWithProviders(<DeckSection onOpen={() => {}} />)
    await user.click(await screen.findByText('不发'))
    const line = await screen.findByTestId('deck-follow-applied')
    expect(line.textContent).toContain('另外 2 张也一并不发了')
    expect(line.textContent).toContain('回复 u/alice')
    await user.click(within(line).getByTestId('deck-follow-list-toggle'))
    const list = within(line).getByTestId('deck-follow-list')
    expect(list.textContent).toContain('回复 u/bob')
    // 每张为什么算同类（一句话）
    expect(list.textContent).toContain('同在 r/Smartphones')
    expect(list.textContent).toContain('AI 出卡的理由相近')
    await user.click(within(line).getByTestId('deck-follow-undo'))
    await waitFor(() => {
      expect(undoFollow).toHaveBeenCalledWith('ap_1', ['ap_2', 'ap_3'], 'asg_1')
    })
    expect((await screen.findByTestId('deck-follow-undone')).textContent).toContain(
      '2 张放回待处理',
    )
  })

  it('「发送」之后只问要不要一起发：一起发要再点一次确认；绝不自动发', async () => {
    const user = userEvent.setup()
    decideOut = follow('approve', 'suggested')
    renderWithProviders(<DeckSection onOpen={() => {}} />)
    await user.click(await screen.findByText('发送'))
    const line = await screen.findByTestId('deck-follow-suggested')
    expect(line.textContent).toContain('这 2 张和刚才那张类似，要一起发送吗？')
    expect(approveBatch).not.toHaveBeenCalled()
    const all = within(line).getByTestId('deck-follow-all')
    await user.click(all)
    expect(approveBatch).not.toHaveBeenCalled()
    expect(all.dataset.armed).toBe('true')
    await user.click(all)
    await waitFor(() => {
      expect(approveBatch).toHaveBeenCalledWith(['ap_2', 'ap_3'], 'asg_1')
    })
    expect((await screen.findByTestId('deck-follow-sent')).textContent).toContain('2')
  })

  it('「逐张看」翻到第一张同类卡，那一行收起', async () => {
    const user = userEvent.setup()
    decideOut = follow('approve', 'suggested')
    renderWithProviders(<DeckSection onOpen={() => {}} />)
    await user.click(await screen.findByText('发送'))
    await user.click(await screen.findByTestId('deck-follow-one-by-one'))
    expect(screen.queryByTestId('deck-follow-suggested')).toBeNull()
  })
})

describe('WP414 Reddit「发出去」卡（「发送」在卡身里）', () => {
  it('卡身里点「发送」→ 同类卡也报到顶上那一行「要一起发送吗」；底下那排是「修改 / 不发 / 稍后」', async () => {
    const user = userEvent.setup()
    const base = draftCard()
    home = homeData({
      queue: [
        draftCard({
          id: 'ap_1',
          title: '回复 u/alice（r/Smartphones）',
          detail: {
            ...base.detail,
            payload: {
              form: 'reddit_write',
              channel: 'reddit',
              channel_label: 'Reddit · r/Smartphones',
              reddit: {
                kind: 'comment',
                subreddit: 'Smartphones',
                parent_fullname: 't3_p1',
                permalink: '/r/Smartphones/comments/p1/x/',
              },
              body: { text: 'Thanks for sharing.' },
            },
          },
        }),
        draftCard({ id: 'ap_2', title: '回复 u/bob（r/Smartphones）' }),
      ],
    })
    decideOut = follow('approve', 'suggested')
    renderWithProviders(<DeckSection onOpen={() => {}} />)
    const bar = await screen.findByTestId('deck-action-bar')
    expect(
      within(bar)
        .getAllByRole('button')
        .map((b) => b.textContent?.trim()),
    ).toEqual(['修改', '不发', '稍后'])
    await user.click(screen.getByTestId('reddit-write-send'))
    const line = await screen.findByTestId('deck-follow-suggested')
    expect(line.textContent).toContain('要一起发送吗')
    expect(approveBatch).not.toHaveBeenCalled()
  })
})
