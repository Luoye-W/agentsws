/**
 * 公司页「品牌与产品线」Tab 的只读那一半（45 H3 / H5）。
 *
 * 三条断言：
 * 1. 并进公司之后那一份**只能看**——没有"改成员"与"删掉"，只有"提议修改"；
 * 2. 提议要写一句为什么（少于 8 个字提不上去，服务端也会 400，这里只是不让人白跑）；
 * 3. 它记着是谁从哪个工作区带进来的（45 H2 的 `origin`）。
 */
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { RangesTab } from '@/components/org/ranges-tab'
import type { ProductLineView, RangeGroupView } from '@/lib/api'
import { renderWithProviders } from './helpers'

const ALIAS: RangeGroupView = {
  id: 'rg_solo_b',
  name: '品牌乙',
  members: [{ kind: 'store', id: 'store_b' }],
  created_at: '2026-09-01T00:00:00.000Z',
  updated_at: '2026-09-07T00:00:00.000Z',
  holders: 1,
  superseded_by: 'rg_b',
  readonly: true,
  origin: { workspace_id: 'ws_solo', person_id: 'p_sun' },
}

const OWNED: RangeGroupView = {
  id: 'rg_b',
  name: '品牌B',
  members: [{ kind: 'store', id: 'store_a' }],
  created_at: '2026-09-01T00:00:00.000Z',
  updated_at: '2026-09-07T00:00:00.000Z',
  holders: 2,
}

const LINES: ProductLineView[] = []

function render(onPropose = vi.fn()): { onPropose: ReturnType<typeof vi.fn> } {
  renderWithProviders(
    <RangesTab
      groups={[ALIAS, OWNED]}
      lines={LINES}
      rangeOptions={[{ kind: 'store', id: 'store_a', label: '店 A' }]}
      busy={false}
      onCreateGroup={vi.fn()}
      onUpdateGroup={vi.fn()}
      onDeleteGroup={vi.fn()}
      onCreateLine={vi.fn()}
      onDeleteLine={vi.fn()}
      onPropose={onPropose}
    />,
  )
  return { onPropose }
}

describe('45 H3 / H5：并进公司的那一份只能看', () => {
  it('只读那张卡没有"改成员" / "删掉"，只有"提议修改"；能改的那张照旧', async () => {
    render()
    const cards = screen.getAllByTestId('brand-card')
    const alias = cards[0] as HTMLElement
    const owned = cards[1] as HTMLElement
    expect(within(alias).getByTestId('brand-readonly')).toBeTruthy()
    expect(within(alias).queryByTestId('brand-edit')).toBeNull()
    expect(within(alias).queryByTestId('brand-delete')).toBeNull()
    expect(within(alias).getByTestId('propose-open')).toBeTruthy()
    // 45 H2：说得出是谁带进来的
    expect(within(alias).getByTestId('brand-origin').textContent).toContain('p_sun')
    // 公司自己那条照旧能改
    expect(within(owned).queryByTestId('brand-readonly')).toBeNull()
    expect(within(owned).getByTestId('brand-edit')).toBeTruthy()
    expect(within(owned).queryByTestId('propose-open')).toBeNull()
  })

  it('提议要写一句为什么：太短提不上去，写够了出一张卡', async () => {
    const user = userEvent.setup()
    const { onPropose } = render()
    const alias = screen.getAllByTestId('brand-card')[0] as HTMLElement
    await user.click(within(alias).getByTestId('propose-open'))
    await user.type(within(alias).getByTestId('propose-reason'), '想改')
    expect((within(alias).getByTestId('propose-submit') as HTMLButtonElement).disabled).toBe(true)
    await user.type(within(alias).getByTestId('propose-reason'), '：店 D 也是这个品牌的')
    await user.click(within(alias).getByTestId('propose-submit'))
    expect(onPropose).toHaveBeenCalledWith('range_group', 'rg_solo_b', '想改：店 D 也是这个品牌的')
    expect(within(alias).getByTestId('propose-done')).toBeTruthy()
  })
})

describe('45 H4：新建品牌时的查重提示', () => {
  const HIT = {
    id: 'rg_b',
    kind: 'range_group' as const,
    name: '品牌B',
    verdict: 'same' as const,
    similarity: 1,
    reasons: ['名字归一化后一样（品牌b）'],
    created_by: 'per_wang',
    created_by_name: '王岚',
    holders: 3,
  }

  it('打字停下来才查；命中就说"已有：X（谁建的，几个岗位挂着）"，没写理由建不了', async () => {
    const user = userEvent.setup()
    const check = vi.fn(async () => [HIT])
    renderWithProviders(
      <RangesTab
        groups={[OWNED]}
        lines={LINES}
        rangeOptions={[{ kind: 'store', id: 'store_a', label: '店 A' }]}
        busy={false}
        onCreateGroup={vi.fn()}
        onUpdateGroup={vi.fn()}
        onDeleteGroup={vi.fn()}
        onCreateLine={vi.fn()}
        onDeleteLine={vi.fn()}
        onCheckDuplicate={check}
      />,
    )
    await user.type(screen.getByLabelText('品牌叫什么'), '品牌 B')
    const hit = await screen.findByTestId('dupe-hit')
    expect(hit.textContent).toContain('已有：品牌B（王岚 建，3 个岗位挂着）')
    expect(hit.textContent).toContain('名字归一化后一样')
    // 查重不改任何东西，只是问
    expect(check).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'range_group', name: '品牌 B' }),
    )
    // 没表态之前建不了
    expect((screen.getByTestId('brand-create') as HTMLButtonElement).disabled).toBe(true)
  })

  it('点"直接用它" = 引用已有那条，表单清空，一条都不新建', async () => {
    const user = userEvent.setup()
    const onCreateGroup = vi.fn()
    renderWithProviders(
      <RangesTab
        groups={[OWNED]}
        lines={LINES}
        rangeOptions={[{ kind: 'store', id: 'store_a', label: '店 A' }]}
        busy={false}
        onCreateGroup={onCreateGroup}
        onUpdateGroup={vi.fn()}
        onDeleteGroup={vi.fn()}
        onCreateLine={vi.fn()}
        onDeleteLine={vi.fn()}
        onCheckDuplicate={async () => [HIT]}
      />,
    )
    await user.type(screen.getByLabelText('品牌叫什么'), '品牌 B')
    await user.click(await screen.findByTestId('dupe-reuse'))
    expect((await screen.findByTestId('dupe-reused')).textContent).toContain('品牌B')
    expect(onCreateGroup).not.toHaveBeenCalled()
    expect((screen.getByLabelText('品牌叫什么') as HTMLInputElement).value).toBe('')
  })

  it('写够一句为什么 → 建得出来，`duplicate_ack` 带着候选一起发上去', async () => {
    const user = userEvent.setup()
    const onCreateGroup = vi.fn()
    renderWithProviders(
      <RangesTab
        groups={[OWNED]}
        lines={LINES}
        rangeOptions={[{ kind: 'store', id: 'store_a', label: '店 A' }]}
        busy={false}
        onCreateGroup={onCreateGroup}
        onUpdateGroup={vi.fn()}
        onDeleteGroup={vi.fn()}
        onCreateLine={vi.fn()}
        onDeleteLine={vi.fn()}
        onCheckDuplicate={async () => [HIT]}
      />,
    )
    await user.type(screen.getByLabelText('品牌叫什么'), '品牌 B')
    await user.type(await screen.findByTestId('dupe-reason'), '这是欧洲那个同名的牌子')
    await user.click(screen.getByTestId('brand-create'))
    expect(onCreateGroup).toHaveBeenCalledWith({
      name: '品牌 B',
      members: [],
      duplicate_ack: {
        decision: 'new',
        reason: '这是欧洲那个同名的牌子',
        similar_to: ['rg_b'],
      },
    })
  })
})
