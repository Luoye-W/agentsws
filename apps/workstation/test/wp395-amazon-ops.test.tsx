/**
 * WP395（docs/106 §13）：Amazon 运营岗位在工作台上的几样。
 *
 * - 面板四块（每日巡检 / 竞品动向 / Listing 体检 / 词库）都在，没数据的照实说、不出 0（docs/36 §3）；
 * - 每日巡检的「连上」只在连接目录里有能用的 Amazon 店铺连接时才出（现在 `amazon_sp` 是 planned → 不出）；
 * - 空块同一个样子；后面几单往块里填走 `registerAmazonBlockBody`；
 * - 职责层（亚马逊店铺运营）右侧「报表」里也是这块；
 * - 首次设置：分析到 Amazon 链接 → 推亚马逊店铺运营（目录里有它的时候）。
 */
import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  AMAZON_BLOCKS,
  AmazonOpsBoard,
  amazonConnectService,
  registerAmazonBlockBody,
} from '@/components/amazon/amazon-ops-board'
import { recommendFromIntake } from '@/components/onboarding/preset-roles'
import { DutyBoards, dutyHasBoards } from '@/components/reports/scope-boards'
import { DUTY_ICONS, POSITION_GLYPH_BY_ID } from '@/components/role-icons/duty-icons'
import { GLYPHS } from '@/components/role-icons/glyphs'
import { knowledgeGroupsForPosition } from '@/lib/library'
import { renderWithProviders } from './helpers'

describe('Amazon 运营面板', () => {
  it('四块都在；每日巡检三行照实说「连上后才有」；一个数字都不出', () => {
    renderWithProviders(<AmazonOpsBoard assignment="asg_amz" />)
    const blocks = screen.getAllByTestId('amzops-block').map((b) => b.getAttribute('data-block'))
    expect(blocks).toEqual([...AMAZON_BLOCKS])
    const rows = screen.getAllByTestId('amzops-daily-row')
    expect(rows).toHaveLength(3)
    for (const row of rows) expect(row.textContent).toContain('连上 Amazon 店铺后才有')
    expect(screen.getByTestId('amzops-empty-competitors').textContent).toBe('还没有在盯的竞品')
    expect(screen.getByTestId('amzops-empty-listing').textContent).toBe('还没体检过')
    expect(screen.getByTestId('amzops-empty-keywords').textContent).toBe('还没有词库')
    expect(screen.getByTestId('amzops-board').textContent).not.toMatch(/\d/)
  })

  it('Amazon 店铺连接还没上线（planned）→ 不放「连上」按钮', () => {
    expect(amazonConnectService()).toBeUndefined()
    renderWithProviders(<AmazonOpsBoard assignment="asg_amz" />)
    expect(screen.queryByTestId('amzops-connect')).toBeNull()
  })

  it('后面几单往块里填：换上之后不再是空块，撤销后回到空块', () => {
    const undo = registerAmazonBlockBody('listing', ({ assignment }) => (
      <p data-testid="listing-body">{assignment}</p>
    ))
    const first = renderWithProviders(<AmazonOpsBoard assignment="asg_amz" />)
    expect(screen.getByTestId('listing-body').textContent).toBe('asg_amz')
    expect(screen.queryByTestId('amzops-empty-listing')).toBeNull()
    first.unmount()
    undo()
    renderWithProviders(<AmazonOpsBoard assignment="asg_amz" />)
    expect(screen.getByTestId('amzops-empty-listing')).toBeTruthy()
  })

  it('职责层：亚马逊店铺运营右侧「报表」里就是这块', () => {
    expect(dutyHasBoards('amz.store')).toBe(true)
    renderWithProviders(<DutyBoards assignment="asg_amz" role_id="amz.store" />)
    expect(screen.getByTestId('amzops-board')).toBeTruthy()
  })
})

describe('图标与知识分组', () => {
  it('岗位图标是自己画的线描那枚；职责是店铺那枚 + Amazon 角标', () => {
    expect(POSITION_GLYPH_BY_ID['amazon-ops']).toBe('amazon-ops')
    expect(GLYPHS['amazon-ops']).toBeDefined()
    expect(DUTY_ICONS['amz.store']).toEqual({ glyph: 'dtc.store', badge: 'amazon' })
  })

  it('知识先看商品、政策与物流', () => {
    expect(knowledgeGroupsForPosition('amazon-ops')).toContain('policy')
  })
})

describe('首次设置：分析到 Amazon 链接', () => {
  it('目录里有 Amazon 运营 → 推亚马逊店铺运营与 Amazon 客服', () => {
    const out = recommendFromIntake({
      run: {
        inputs: [{ url: 'https://www.amazon.com/dp/B0TEST', kind: 'amazon_listing' }],
        profile: {},
      } as never,
      positions: [
        {
          id: 'customer-care',
          name: '客服',
          roles: [{ id: 'amz.support', name: 'Amazon 客服', default: true, what_it_does: '' }],
        },
        {
          id: 'amazon-ops',
          name: 'Amazon 运营',
          roles: [
            { id: 'amz.store', name: '亚马逊店铺运营', default: true, what_it_does: '' },
            { id: 'amz.support', name: 'Amazon 客服', default: false, what_it_does: '' },
          ],
        },
      ],
    })
    expect(out.map((r) => r.role_id)).toEqual(['amz.store', 'amz.support'])
  })
})
