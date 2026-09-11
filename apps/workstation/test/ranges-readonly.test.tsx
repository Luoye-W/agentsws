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
