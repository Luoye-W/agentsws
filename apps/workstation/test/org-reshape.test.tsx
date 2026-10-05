/**
 * WP234（docs/54 §6.4 / §6.5）：公司页岗位卡上的合并 / 拆出 / 移动职责；负责人是身份。
 */
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { OwnerCard } from '@/components/org/owner-card'
import { PositionsTab } from '@/components/org/positions-tab'
import type { OrgPositionView } from '@/lib/api'
import { renderWithProviders } from './helpers'

const row = (id: string, name: string, roles: [string, string][]): OrgPositionView => ({
  id,
  name,
  name_en: name,
  version: '1.0.0',
  source: 'custom',
  roles: roles.map(([role_id, n]) => ({ role_id, name: n, default: true, loaded: true })),
  holders: [{ person_id: 'p_wang', name: '王岚', ranges: [] }],
})

const POSITIONS: OrgPositionView[] = [
  row('owner', '负责人', [['common.owner', '公司设置与授权']]),
  row('pos-reddit', 'Reddit 运营', [
    ['pr.reddit', 'Reddit 口碑'],
    ['social.reddit', 'Reddit 社区'],
  ]),
  row('social-media', '社媒运营', [
    ['social.tiktok', 'TikTok'],
    ['social.youtube', 'YouTube'],
  ]),
]

function renderTab(handlers: {
  onMerge?: (id: string, into: string, name: string) => void
  onMoveDuty?: (id: string, role_id: string, to: string) => void
  onSplit?: (id: string, input: { name: string; role_ids: string[] }) => void
}) {
  renderWithProviders(
    <PositionsTab
      positions={POSITIONS}
      roles={[]}
      busy={false}
      onAssign={() => {}}
      onCreate={() => {}}
      onSaveRoles={() => {}}
      onDelete={() => {}}
      onCopyRole={() => {}}
      onProposeRole={() => {}}
      onMerge={handlers.onMerge ?? (() => {})}
      onMoveDuty={handlers.onMoveDuty ?? (() => {})}
      onSplit={handlers.onSplit ?? (() => {})}
      notice="调好了：2 条分配、1 件事跟着走了"
    />,
  )
}

const card = (id: string): HTMLElement =>
  screen
    .getAllByTestId('position-card')
    .find((c) => c.getAttribute('data-position') === id) as HTMLElement

describe('WP234 公司页：岗位合并 / 拆出 / 移动职责', () => {
  it('「负责人」不在岗位清单里；回执照实说动了几条', () => {
    renderTab({})
    expect(
      screen.getAllByTestId('position-card').map((c) => c.getAttribute('data-position')),
    ).toEqual(['pos-reddit', 'social-media'])
    expect(screen.getByTestId('positions-reshaped').textContent).toContain('1 件事')
  })

  it('合并到…：只能选别的岗位（不含负责人），点了才发；名字预填目标的名字、可改', async () => {
    const user = userEvent.setup()
    const onMerge = vi.fn()
    renderTab({ onMerge })
    const reddit = within(card('pos-reddit'))
    await user.click(reddit.getByTestId('position-merge'))
    const target = reddit.getByTestId('position-merge-target') as HTMLSelectElement
    expect([...target.options].map((o) => o.value)).toEqual(['social-media'])
    const name = reddit.getByTestId('position-merge-name') as HTMLInputElement
    expect(name.value).toBe('社媒运营')
    await user.clear(name)
    await user.type(name, '内容与社区')
    await user.click(reddit.getByTestId('position-merge-go'))
    expect(onMerge).toHaveBeenCalledWith('pos-reddit', 'social-media', '内容与社区')
  })

  it('拆出…：要名字、要挑职责，全拆走不叫拆', async () => {
    const user = userEvent.setup()
    const onSplit = vi.fn()
    renderTab({ onSplit })
    const social = within(card('social-media'))
    await user.click(social.getByTestId('position-split'))
    const go = social.getByTestId('position-split-go') as HTMLButtonElement
    expect(go.disabled).toBe(true)
    await user.type(social.getByTestId('position-split-name'), '短视频')
    const duties = social.getAllByTestId('position-split-duty')
    await user.click(duties[0] as HTMLElement)
    await user.click(duties[1] as HTMLElement)
    expect(go.disabled).toBe(true)
    await user.click(duties[1] as HTMLElement)
    await user.click(go)
    expect(onSplit).toHaveBeenCalledWith('social-media', {
      name: '短视频',
      role_ids: ['social.tiktok'],
    })
  })

  it('移动职责：挑一条、挑去处', async () => {
    const user = userEvent.setup()
    const onMoveDuty = vi.fn()
    renderTab({ onMoveDuty })
    const reddit = within(card('pos-reddit'))
    await user.click(reddit.getByTestId('position-move'))
    await user.selectOptions(reddit.getByTestId('position-move-duty'), 'social.reddit')
    await user.click(reddit.getByTestId('position-move-go'))
    expect(onMoveDuty).toHaveBeenCalledWith('pos-reddit', 'social.reddit', 'social-media')
  })
})

describe('WP234 公司页：负责人是身份', () => {
  it('谁是负责人、「公司设置与授权」入口、转交给还不是负责人的人', async () => {
    const user = userEvent.setup()
    const onTransfer = vi.fn()
    const first = renderWithProviders(
      <OwnerCard
        title="负责人"
        holders={[{ person_id: 'p_wang', name: '王岚' }]}
        candidates={[{ person_id: 'p_li', name: '李默' }]}
        settingsHref="/positions/asg_owner"
        busy={false}
        onTransfer={onTransfer}
      />,
    )
    const box = screen.getByTestId('org-owner')
    expect(within(box).getByTestId('org-owner-holders').textContent).toContain('王岚')
    expect(within(box).getByText('公司设置与授权').closest('a')?.getAttribute('href')).toBe(
      '/positions/asg_owner',
    )
    const go = screen.getByTestId('org-owner-transfer-go') as HTMLButtonElement
    expect(go.disabled).toBe(true)
    await user.selectOptions(screen.getByTestId('org-owner-transfer-to'), 'p_li')
    await user.click(go)
    expect(onTransfer).toHaveBeenCalledWith('p_li')
    first.unmount()
    renderWithProviders(
      <OwnerCard
        title="负责人"
        holders={[
          { person_id: 'p_wang', name: '王岚' },
          { person_id: 'p_li', name: '李默' },
        ]}
        candidates={[]}
        busy={false}
        transferred="李默"
        onTransfer={onTransfer}
      />,
    )
    expect(screen.getByTestId('org-owner-transferred').textContent).toContain('你的负责人身份还在')
    expect(screen.queryByTestId('org-owner-transfer-to')).toBeNull()
  })
})

describe('WP235 公司页：你们的岗位 / 可以加的岗位（模板）', () => {
  const tpl = (
    id: string,
    name: string,
    roles: [string, string][],
    holders: OrgPositionView['holders'],
  ): OrgPositionView => ({ ...row(id, name, roles), source: 'bundled', holders })
  const ME = { person_id: 'p_luoye', name: 'Luoye', ranges: [] }
  // Luoye 的老工作区：公关里只做 Reddit、社媒里只做 Reddit；别的模板没人做
  const OLD: OrgPositionView[] = [
    tpl('owner', '负责人', [['common.owner', '公司设置与授权']], [{ ...ME, role_ids: [] }]),
    tpl(
      'pr',
      '公共关系',
      [
        ['pr.press', '新闻稿'],
        ['pr.reddit', 'Reddit 口碑'],
        ['pr.monitoring', '舆情'],
        ['common.member', '工作区成员'],
      ],
      [{ ...ME, role_ids: ['pr.reddit'] }],
    ),
    tpl(
      'social-media',
      '社媒运营',
      [
        ['social.tiktok', 'TikTok'],
        ['social.reddit', 'Reddit 社区'],
      ],
      [{ ...ME, role_ids: ['social.reddit'] }],
    ),
    tpl('customer-care', '客服', [['dtc.support', '售后']], []),
    tpl('member', '普通成员', [['common.member', '工作区成员']], []),
  ]
  const renderOld = (onMerge = vi.fn()) =>
    renderWithProviders(
      <PositionsTab
        positions={OLD}
        roles={[]}
        busy={false}
        onAssign={() => {}}
        onCreate={() => {}}
        onSaveRoles={() => {}}
        onDelete={() => {}}
        onCopyRole={() => {}}
        onProposeRole={() => {}}
        onMerge={onMerge}
        onMoveDuty={() => {}}
        onSplit={() => {}}
      />,
    )
  const ids = (box: HTMLElement) =>
    within(box)
      .queryAllByTestId('position-card')
      .map((c) => c.getAttribute('data-position'))

  it('有人在做的在上面，没人做的模板收在下面；「负责人」「普通成员」都不列', () => {
    renderOld()
    expect(ids(screen.getByTestId('positions-ours'))).toEqual(['pr', 'social-media'])
    const templates = screen.getByTestId('positions-templates')
    expect(templates.tagName).toBe('DETAILS')
    expect((templates as HTMLDetailsElement).open).toBe(false)
    expect(ids(templates)).toEqual(['customer-care'])
    // 模板卡上没有合并 / 拆出 / 移动
    expect(within(templates).queryByTestId('position-reshape')).toBeNull()
  })

  it('卡上写谁在做、他手上是哪几条；计数是「在做 N / 共 M」（不算工作区成员），模板卡照旧', () => {
    renderOld()
    const pr = within(card('pr'))
    expect(pr.getByTestId('position-duty-count').textContent).toBe('在做 1 / 共 3')
    expect(within(card('customer-care')).getByTestId('position-duty-count').textContent).toBe(
      '1 条职责',
    )
    expect(pr.getByTestId('position-holders').textContent).toContain('Luoye')
    const duties = pr.getByTestId('position-holder-duties').textContent ?? ''
    expect(duties).toContain('Reddit 口碑')
    expect(duties).not.toContain('pr.reddit')
  })

  it('合并：目标只列你们的岗位，名字按两边真在做的职责建议「Reddit 运营」；拆出 / 移动只给真在做的那几条', async () => {
    const user = userEvent.setup()
    const onMerge = vi.fn()
    renderOld(onMerge)
    const pr = within(card('pr'))
    // 公关只做一条：没有「拆出」
    expect(pr.queryByTestId('position-split')).toBeNull()
    await user.click(pr.getByTestId('position-move'))
    const duty = pr.getByTestId('position-move-duty') as HTMLSelectElement
    expect([...duty.options].map((o) => o.value)).toEqual(['pr.reddit'])
    await user.click(pr.getByTestId('position-merge'))
    const target = pr.getByTestId('position-merge-target') as HTMLSelectElement
    expect([...target.options].map((o) => o.value)).toEqual(['social-media'])
    expect((pr.getByTestId('position-merge-name') as HTMLInputElement).value).toBe('Reddit 运营')
    await user.click(pr.getByTestId('position-merge-go'))
    expect(onMerge).toHaveBeenCalledWith('pr', 'social-media', 'Reddit 运营')
  })
})
