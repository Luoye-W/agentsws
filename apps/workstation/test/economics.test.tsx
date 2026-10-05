/**
 * WP224（docs/91 §2.2 #1 / #3）：公司页的毛利率、投放表上的盈亏线一格与提示图标、
 * 止损卡上的盈亏线芯片、本周经营一页纸那张卡。
 */
import type { BlockData } from '@agentsws/deck'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { renderWithProviders } from './helpers'

let entries: { scope: 'brand' | 'category' | 'sku'; key?: string; margin_pct: number }[] = []
const saved: unknown[] = []

vi.mock('@/lib/api', async () => ({
  ...(await vi.importActual<typeof import('@/lib/api')>('@/lib/api')),
  getGrossMargins: async () => ({ entries }),
  saveGrossMargin: async (input: { scope: 'brand'; margin_pct: number | null }) => {
    saved.push(input)
    entries = input.margin_pct === null ? [] : [{ scope: 'brand', margin_pct: input.margin_pct }]
    return { entries }
  },
}))

const { GrossMarginCard } = await import('@/components/org/gross-margin-card')
const { BlockBody } = await import('@/components/blocks/block-view')
const { CardChips } = await import('@/components/deck/evidence-chips')
const { WeeklyReviewBody } = await import('@/components/deck/weekly-review-body')
const { ReportBlocks } = await import('@/components/deck/panel-blocks')

describe('公司 → 品牌 · 毛利率', () => {
  it('没填：写「没填」；填 40 保存 → 盈亏线 ROAS 2.5', async () => {
    entries = []
    renderWithProviders(<GrossMarginCard assignment="asg_owner" />)
    const input = await screen.findByTestId('org-gross-margin-brand')
    expect(screen.getByTestId('org-gross-margin-line').textContent).toBe('没填')
    fireEvent.change(input, { target: { value: '40' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => {
      expect(screen.getByTestId('org-gross-margin-line').textContent).toBe('盈亏线 ROAS 2.5')
    })
    expect(saved.at(-1)).toEqual({ scope: 'brand', margin_pct: 40 })
  })

  it('没有负责人那条分配：整张卡不出（只有负责人填）', () => {
    const { container } = renderWithProviders(<GrossMarginCard />)
    expect(container.textContent).toBe('')
  })
})

describe('投放表：盈亏线一格、提示图标、「没填毛利率 · 去填」', () => {
  const data = (footer?: object) =>
    ({
      block: { id: 'ads.meta.campaigns', component: 'table', source: 'ads', label: 'campaign' },
      range: 'yesterday',
      status: 'ok',
      payload: {
        columns: [
          { key: 'name', label: 'campaign' },
          { key: 'roas', label: 'ROAS（平台口径）', align: 'right', format: 'ratio' },
          { key: 'break_even', label: '盈亏线 ROAS', align: 'right', format: 'ratio' },
          { key: 'below_break_even', label: '', format: 'flag' },
        ],
        rows: [
          { name: '新品', roas: 1.8, break_even: 2.5, below_break_even: '低于盈亏线 2.5' },
          { name: '爆款', roas: 3.2, break_even: 2.5, below_break_even: '' },
        ],
        ...(footer === undefined ? {} : { footer }),
      },
    }) as unknown as BlockData

  it('ROAS 是倍数不是钱；只有那一行有提示图标，字在 tooltip 里', () => {
    renderWithProviders(<BlockBody data={data()} />)
    expect(screen.getByText('1.8')).toBeDefined()
    expect(screen.queryByText(/US\$1\.80/)).toBeNull()
    const flags = screen.getAllByTestId('table-flag')
    expect(flags).toHaveLength(1)
    expect(flags[0]?.getAttribute('aria-label')).toBe('低于盈亏线 2.5')
  })

  it('没填毛利率：表下一行带「去填」，链到公司页那一格', () => {
    renderWithProviders(
      <BlockBody
        data={data({
          text: '没填毛利率，算不出盈亏线',
          href: '/org?tab=brands&focus=gross-margin',
          link_label: '去填',
        })}
      />,
    )
    expect(screen.getByTestId('table-footer').textContent).toContain('没填毛利率')
    expect(screen.getByRole('link', { name: '去填' }).getAttribute('href')).toBe(
      '/org?tab=brands&focus=gross-margin',
    )
  })
})

describe('止损卡上的盈亏线芯片', () => {
  it('填了：一颗芯片；没填：芯片本身是去填的入口', () => {
    const { unmount } = renderWithProviders(
      <CardChips
        chips={[]}
        highlights={[{ type: 'break_even', text: '盈亏线 ROAS 2.5（毛利率 40%）' }]}
      />,
    )
    expect(screen.getByTestId('break-even-chip').textContent).toBe('盈亏线 ROAS 2.5（毛利率 40%）')
    unmount()
    renderWithProviders(
      <CardChips chips={[]} highlights={[{ type: 'break_even', text: '没填毛利率' }]} />,
    )
    expect(screen.getByRole('link').getAttribute('href')).toBe('/org?tab=brands&focus=gross-margin')
  })
})

describe('本周经营一页纸那张卡', () => {
  it('五段 + 没接；每条发现的数带出处 tooltip', () => {
    renderWithProviders(
      <WeeklyReviewBody
        payload={{
          kind: 'weekly_review',
          week_of: '2026-10-05',
          situation: '测试品牌 09-29 到 10-05：2 块面板有数，4 块没接。',
          findings: [
            {
              panel: 'store_sales',
              text: '销售额 USD 1,200、12 单，比前 7 天 +20%',
              value: 'USD 1,200',
              source: '网站运营 · 销售额 / 订单数（近 7 天，对比前 7 天）',
            },
          ],
          impact: ['1 条 campaign 按毛利算在亏钱，现在的止损线不会停它们。'],
          recommendations: ['让投放看一眼这 1 条（只提示，不会自动停）。'],
          next_steps: ['下周一自动再出一份（时间在定时任务里可改）。'],
          not_connected: [
            { panel: 'kol_attribution', label: '红人归因', reason: '没人担红人营销' },
          ],
          length: 120,
        }}
      />,
    )
    for (const id of [
      'weekly-situation',
      'weekly-findings',
      'weekly-impact',
      'weekly-recommendations',
      'weekly-next',
    ])
      expect(screen.getByTestId(id)).toBeDefined()
    const value = screen.getByTestId('weekly-finding-value')
    expect(value.textContent).toBe('USD 1,200')
    expect(value.getAttribute('data-hint')).toContain('网站运营 · 销售额')
    expect(screen.getByTestId('weekly-not-connected').textContent).toContain(
      '红人归因（没人担红人营销）',
    )
  })
})

describe('一页纸在岗位页上整张摊开（它不属于任何事项，没有「进详情」）', () => {
  it('报表区里这一张直接是五段，不是一行摘要 + →', () => {
    const card = {
      id: 'apr_1',
      kind: 'weekly_review',
      title: '本周经营一页纸 · 2026-10-05',
      summary: '测试品牌：1 块面板有数，0 块没接。',
      detail: {
        payload: {
          kind: 'weekly_review',
          week_of: '2026-10-05',
          situation: '测试品牌：1 块面板有数，0 块没接。',
          findings: [
            {
              panel: 'store_sales',
              text: '销售额 USD 10',
              value: 'USD 10',
              source: '网站运营 · 销售额',
            },
          ],
          impact: [],
          recommendations: [],
          next_steps: ['下周一自动再出一份。'],
          not_connected: [],
          length: 20,
        },
      },
    } as unknown as Parameters<typeof ReportBlocks>[0]['reports'][number]
    renderWithProviders(<ReportBlocks reports={[card]} onOpen={() => {}} />)
    expect(screen.getByTestId('weekly-review')).toBeDefined()
    expect(screen.queryByTestId('report-figures')).toBeNull()
  })
})
