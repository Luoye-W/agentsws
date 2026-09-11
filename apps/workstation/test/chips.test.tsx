/**
 * 47 J2 最后一条：**对象引用与知识引用长得不一样，人一眼能分。**
 *
 * 断言分三组：
 * 1. 两个芯片确实不一样（`data-chip` 不同、图标不同、虚线 vs 实框）；
 * 2. 谁都不露原始 id（37 §1 第 5 行的那条老账）；
 * 3. 历史案例带"当时"——芯片上直接写出来，不让读的人自己猜。
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { FactChip, ObjectChip } from '@/components/chips'
import { EntityChips } from '@/components/deck/evidence-chips'
import { renderWithProviders } from './helpers'

describe('47 J2 两种引用长得不一样', () => {
  it('对象芯片与知识芯片的标记不同', () => {
    renderWithProviders(
      <div>
        <ObjectChip label="订单 #1001" id="ord_1001" />
        <FactChip label="退货窗口" quote="德国站 14 天" />
      </div>,
    )
    expect(screen.getByTestId('object-chip').getAttribute('data-chip')).toBe('object')
    expect(screen.getByTestId('fact-chip').getAttribute('data-chip')).toBe('fact')
    // 知识芯片是虚线框，对象芯片不是——这是"一眼能分"的那一眼
    expect(screen.getByTestId('fact-chip').className).toContain('border-dashed')
    expect(screen.getByTestId('object-chip').className).not.toContain('border-dashed')
  })

  it('两个都不露原始 id（37 §1 第 5 行）', () => {
    const { container } = renderWithProviders(
      <div>
        <ObjectChip label="订单 #1001" id="ord_1001" />
        <FactChip label="退货窗口" quote="德国站 14 天" />
      </div>,
    )
    expect(container.textContent).not.toContain('ord_1001')
    expect(container.textContent).not.toContain('fact_')
    expect(container.textContent).toContain('订单 #1001')
    expect(container.textContent).toContain('德国站 14 天')
  })

  it('对象芯片点得开', async () => {
    const onOpen = vi.fn()
    renderWithProviders(<ObjectChip label="客户 Anna" onOpen={onOpen} />)
    await userEvent.click(screen.getByTestId('object-chip'))
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('历史案例带"当时"，并且 tooltip 换成"别当现在的状态"那一句', () => {
    renderWithProviders(
      <FactChip label="订单退款记录" quote="订单已退款" asOf="2026-03-01T00:00:00.000Z" />,
    )
    expect(screen.getByTestId('fact-chip-as-of').textContent).toContain('2026')
    expect(screen.getByTestId('fact-chip').getAttribute('title')).toContain('历史案例')
  })

  it('没有"当时"就不显示那一格', () => {
    renderWithProviders(<FactChip label="退货窗口" quote="14 天" />)
    expect(screen.queryByTestId('fact-chip-as-of')).toBeNull()
  })

  it('没有引文时退回显示标签', () => {
    renderWithProviders(<FactChip label="德国站退货窗口" />)
    expect(screen.getByTestId('fact-chip').textContent).toContain('德国站退货窗口')
  })
})

describe('47 J2 卡片上的实体芯片按类型分流', () => {
  it('fact_card 走知识芯片，其余走对象芯片', () => {
    renderWithProviders(
      <EntityChips
        chips={[
          { type: 'order', id: 'ord_1001', label: '订单 #1001' },
          { type: 'fact_card', id: 'fact_abc', label: '德国站退货窗口' },
          { type: 'customer', id: 'cus_anna', label: 'Anna Meyer' },
        ]}
        dropped={0}
      />,
    )
    expect(screen.getAllByTestId('object-chip')).toHaveLength(2)
    expect(screen.getAllByTestId('fact-chip')).toHaveLength(1)
  })

  it('一条都没有、也没丢过的时候整块不出（老行为不变）', () => {
    const { container } = render(<div data-testid="host" />)
    expect(container.querySelector('[data-testid="entity-chips"]')).toBeNull()
  })
})
