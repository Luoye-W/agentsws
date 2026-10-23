/**
 * WP414（Luoye 10-19 真机，Reddit 回信卡）：审批卡底部操作重排 +「不要」理由可选 + 同类卡跟着前一个决定。
 *
 * - 按钮样式：主按钮 +「修改 / 不要 / 稍后」都是按钮，「稍后」外露，没有「需要补素材」与 `···`；
 * - 「不要」一下就生效；卡流顶上出一行可选的快捷理由（不相关 / 时机不对 / 不想回 / 其他…）；
 * - 10-19 更正：**没理由只处理这一张**；点了理由才按理由找同类——「按你的理由「X」，另外 N 张也一并不发了」，
 *   清单摊开（标题 + AI 说为什么属于这个理由 + 单张恢复）+ 全部撤回；「稍后」同理；
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
const undoFollow = vi.fn(async (_leader: string, ids: string[]) => ({
  restored: ids.map((id) => ({ id })),
  skipped: [],
}))
let reasonOut: unknown = { followers: 0 }
const addDecisionReason = vi.fn(async () => reasonOut)
const approveBatch = vi.fn(async () => ({ results: [{ id: 'ap_2' }, { id: 'ap_3' }] }))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getHome: (...args: unknown[]) => getHome(...(args as [])),
    decide: (...args: unknown[]) => decide(...(args as [])),
    undoFollow: (...args: unknown[]) => undoFollow(...(args as [string, string[]])),
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
    ...(key === 'applied' ? { reason: '不相关' } : {}),
    applied: [],
    suggested: [],
    [key]: [
      {
        id: 'ap_2',
        title: '回复 u/bob（r/Smartphones）',
        why:
          key === 'applied'
            ? '也是换手机的帖子，和眼镜无关'
            : '同在 r/Smartphones，AI 出卡的理由相近',
        basis: key === 'applied' ? ['same_reason'] : ['same_source', 'same_judgement'],
        source: 'r/Smartphones',
      },
      {
        id: 'ap_3',
        title: '回复 u/cat（r/Smartphones）',
        why:
          key === 'applied'
            ? '也是问手机电池，和我们无关'
            : '同在 r/Smartphones，AI 出卡的理由相近',
        basis: key === 'applied' ? ['same_reason'] : ['same_source', 'same_judgement'],
        source: 'r/Smartphones',
      },
    ],
  },
})

beforeEach(() => {
  home = three()
  decideOut = {}
  reasonOut = { followers: 0 }
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

describe('WP414「不要」不强制写理由；没理由只处理这一张', () => {
  it('点「不发」一下就生效；没给理由就不带动任何一张（没有跟随那一行）', async () => {
    const user = userEvent.setup()
    renderWithProviders(<DeckSection onOpen={() => {}} />)
    await user.click(await screen.findByText('不发'))
    await waitFor(() => {
      expect(decide).toHaveBeenCalledWith('ap_1', { action: 'reject', version: 1 }, 'asg_1')
    })
    const reasons = await screen.findByTestId('deck-drop-reasons')
    expect(reasons.textContent).toContain('已不发')
    for (const r of ['不相关', '时机不对', '不想回', '其他…'])
      expect(within(reasons).getByText(r)).toBeDefined()
    expect(screen.queryByTestId('deck-follow-applied')).toBeNull()
    expect(addDecisionReason).not.toHaveBeenCalled()
  })

  it('「其他…」开一个可选的输入框；写了就补记', async () => {
    const user = userEvent.setup()
    renderWithProviders(<DeckSection onOpen={() => {}} />)
    await user.click(await screen.findByText('不发'))
    const reasons = await screen.findByTestId('deck-drop-reasons')
    await user.click(within(reasons).getByText('其他…'))
    await user.type(within(reasons).getByRole('textbox'), '这个用户在钓鱼')
    await user.click(within(reasons).getByText('记下'))
    await waitFor(() => {
      expect(addDecisionReason).toHaveBeenCalledWith(
        'ap_1',
        { reason: '这个用户在钓鱼', follower_ids: [] },
        'asg_1',
      )
    })
    expect((await screen.findByTestId('deck-drop-reason-saved')).textContent).toContain('钓鱼')
  })
})

describe('WP414 按理由跟着处理（10-19 更正）', () => {
  it('点了理由才去找：「按你的理由「不相关」，另外 2 张也一并不发了」，清单摊开写为什么，单张恢复、全部撤回', async () => {
    const user = userEvent.setup()
    reasonOut = { followers: 0, ...follow('reject', 'applied') }
    renderWithProviders(<DeckSection onOpen={() => {}} />)
    await user.click(await screen.findByText('不发'))
    const reasons = await screen.findByTestId('deck-drop-reasons')
    await user.click(within(reasons).getByText('不相关'))
    await waitFor(() => {
      expect(addDecisionReason).toHaveBeenCalledWith(
        'ap_1',
        { reason: '不相关', follower_ids: [] },
        'asg_1',
      )
    })
    const line = await screen.findByTestId('deck-follow-applied')
    expect(line.textContent).toContain('按你的理由「不相关」，另外 2 张也一并不发了')
    // 清单直接摊开：标题 + AI 说为什么属于这个理由
    const list = within(line).getByTestId('deck-follow-list')
    expect(list.textContent).toContain('回复 u/bob')
    expect(list.textContent).toContain('也是换手机的帖子，和眼镜无关')
    // 单张恢复
    const items = within(list).getAllByTestId('deck-follow-item')
    await user.click(within(items[0] as HTMLElement).getByTestId('deck-follow-restore'))
    await waitFor(() => {
      expect(undoFollow).toHaveBeenCalledWith('ap_1', ['ap_2'], 'asg_1')
    })
    expect(await within(line).findByTestId('deck-follow-restored')).toBeDefined()
    expect(line.textContent).toContain('另外 1 张也一并不发了')
    // 全部撤回（只撤还没恢复的那张）
    await user.click(within(line).getByTestId('deck-follow-undo'))
    await waitFor(() => {
      expect(undoFollow).toHaveBeenLastCalledWith('ap_1', ['ap_3'], 'asg_1')
    })
    expect((await screen.findByTestId('deck-follow-undone')).textContent).toContain(
      '2 张放回待处理',
    )
  })

  it('「稍后」：有一个可选的小框，写了理由才去找同类', async () => {
    const user = userEvent.setup()
    reasonOut = { followers: 0, ...follow('snooze', 'applied') }
    renderWithProviders(<DeckSection onOpen={() => {}} />)
    await user.click(await screen.findByText('稍后'))
    const reasons = await screen.findByTestId('deck-drop-reasons')
    expect(reasons.textContent).toContain('已稍后')
    expect(screen.queryByTestId('deck-follow-applied')).toBeNull()
    await user.type(within(reasons).getByRole('textbox'), '等产品资料')
    await user.click(within(reasons).getByText('记下'))
    await waitFor(() => {
      expect(addDecisionReason).toHaveBeenCalledWith(
        'ap_1',
        { reason: '等产品资料', follower_ids: [] },
        'asg_1',
      )
    })
    expect((await screen.findByTestId('deck-follow-applied')).textContent).toContain('一并稍后了')
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
  it('卡身里点「发送」→ 同类卡也报到顶上那一行「要一起发送吗」；卡底一排是「批准 / 修改 / 不发 / 稍后」（WP478）', async () => {
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
      // WP478：卡身里的「批准」并进卡底这一排，排第一颗
    ).toEqual(['批准', '修改', '不发', '稍后'])
    await user.click(screen.getByTestId('reddit-write-send'))
    const line = await screen.findByTestId('deck-follow-suggested')
    expect(line.textContent).toContain('要一起发送吗')
    expect(approveBatch).not.toHaveBeenCalled()
  })
})
