/**
 * 公司页「并进来」Tab（45 H2）。
 *
 * 四条断言，都是 45 里明写的规矩：
 * 1. **按类分组**，每类一个"全部采纳"；
 * 2. **相似的给三个选项**，界面不替人决定；一样的只给合并 / 保留两条；
 * 3. **凭据默认不交**——提交出去的 `transfer` 全是 false，除非人点开；
 * 4. 提交带上每一条的 `chosen`（没点过的按 `suggested`）。
 */
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { JoinTab } from '@/components/org/join-tab'
import type { JoinMappingView } from '@/lib/api'
import { renderWithProviders } from './helpers'

const MAPPING: JoinMappingView = {
  join_id: 'join_1',
  source_workspace_id: 'ws_solo',
  target_workspace_id: 'ws_co',
  person_id: 'p_sun',
  counts: { same: 1, similar: 1, missing: 1 },
  objects: [
    {
      kind: 'range_group',
      unique_key: 'brand:品牌乙',
      verdict: 'similar',
      mine: { id: 'rg_solo_b', name: '品牌乙', summary: '店 A、店 B' },
      theirs: { id: 'rg_b', name: '品牌B', summary: '店 A、店 C', holders: 2 },
      similarity: 0.5,
      reasons: ['名字不一样（「品牌乙」/「品牌B」），但成员重合 50%（store_a）'],
      suggested: 'merge_union',
      options: ['merge_union', 'adopt_company', 'keep_both'],
    },
    {
      kind: 'product_line',
      unique_key: 'line:store:store_a|shopify|tag=kitchen',
      verdict: 'missing',
      mine: { id: 'pl_solo_kitchen', name: '厨房线', summary: '挂在 store_a：标签 kitchen' },
      reasons: ['公司里还没有这一条'],
      suggested: 'create_in_company',
      options: ['create_in_company', 'skip'],
    },
    {
      kind: 'store_range',
      unique_key: 'store:other:store_a',
      verdict: 'same',
      mine: { id: 'store_a', name: '店 A', summary: 'Shopify：store_a' },
      theirs: { id: 'store_a', name: 'store_a', summary: 'Shopify：store_a', holders: 1 },
      reasons: ['同一个店铺 / 账号 id（store_a）'],
      suggested: 'adopt_company',
      options: ['adopt_company', 'keep_both'],
    },
  ],
  connections: [
    {
      connection_id: 'conn_1',
      service: 'shopify_admin',
      label: 'Shopify · 店 B',
      transfer: false,
      company_has_same_service: true,
    },
  ],
}

describe('45 H2：Join 对照页', () => {
  it('三类分组，每类一个「全部采纳」；相似的给三个选项', async () => {
    renderWithProviders(<JoinTab mapping={MAPPING} busy={false} onComplete={vi.fn()} />)
    for (const kind of ['range_group', 'product_line', 'store_range'])
      expect(screen.getByTestId(`join-group-${kind}`)).toBeTruthy()
    expect(screen.getAllByText('这一类全部采纳')).toHaveLength(3)

    const brand = screen.getByTestId('join-group-range_group')
    expect(
      within(brand)
        .getAllByTestId('join-option')
        .map((b) => b.getAttribute('data-option')),
    ).toEqual(['merge_union', 'adopt_company', 'keep_both'])
    expect(within(brand).getByTestId('join-verdict').textContent).toBe('像，但不确定')
    // 一样的那条不给"以公司为准"（它本来就是公司那条）
    const store = screen.getByTestId('join-group-store_range')
    expect(
      within(store)
        .getAllByTestId('join-option')
        .map((b) => b.getAttribute('data-option')),
    ).toEqual(['adopt_company', 'keep_both'])
  })

  it('没点过的按建议走；点了就按点的来；「同一个」时还要问用哪个名字', async () => {
    const onComplete = vi.fn()
    const user = userEvent.setup()
    renderWithProviders(<JoinTab mapping={MAPPING} busy={false} onComplete={onComplete} />)

    // 品牌那条改成"保留两条"
    const brand = screen.getByTestId('join-group-range_group')
    const keepBoth = within(brand)
      .getAllByTestId('join-option')
      .find((b) => b.getAttribute('data-option') === 'keep_both')
    await user.click(keepBoth as HTMLElement)

    await user.click(screen.getByTestId('join-complete'))
    expect(onComplete).toHaveBeenCalledTimes(1)
    const choice = onComplete.mock.calls[0]?.[0] as {
      objects: { unique_key: string; chosen: string }[]
      connections: { transfer: boolean }[]
    }
    expect(choice.objects.map((o) => o.chosen)).toEqual([
      'keep_both',
      'create_in_company',
      'adopt_company',
    ])
    // 45 H2 第三条：凭据开关默认是关的
    expect(choice.connections.every((c) => !c.transfer)).toBe(true)
  })

  it('凭据要本人一条条打开才交给公司', async () => {
    const onComplete = vi.fn()
    const user = userEvent.setup()
    renderWithProviders(<JoinTab mapping={MAPPING} busy={false} onComplete={onComplete} />)
    const toggle = screen.getByTestId('join-transfer')
    expect(toggle.getAttribute('data-on')).toBe('no')
    expect(screen.getByText('公司里已经有同一类连接了，交过来要选主。')).toBeTruthy()
    await user.click(toggle)
    await user.click(screen.getByTestId('join-complete'))
    const choice = onComplete.mock.calls[0]?.[0] as { connections: { transfer: boolean }[] }
    expect(choice.connections[0]?.transfer).toBe(true)
  })

  it('「同一个，取并集」时问用哪个名字，选了个人那边就带上 name_choice', async () => {
    const onComplete = vi.fn()
    const user = userEvent.setup()
    renderWithProviders(<JoinTab mapping={MAPPING} busy={false} onComplete={onComplete} />)
    const personal = screen
      .getAllByTestId('join-name-choice')
      .find((b) => b.getAttribute('data-which') === 'personal')
    await user.click(personal as HTMLElement)
    await user.click(screen.getByTestId('join-complete'))
    const choice = onComplete.mock.calls[0]?.[0] as {
      objects: { unique_key: string; name_choice?: string }[]
    }
    expect(choice.objects[0]?.name_choice).toBe('personal')
  })

  it('没有等着并进来的工作区时说一句人话，不是空白', () => {
    renderWithProviders(<JoinTab busy={false} onComplete={vi.fn()} />)
    expect(screen.getByTestId('join-empty').textContent).toContain('现在没有等着并进来的工作区')
  })
})
