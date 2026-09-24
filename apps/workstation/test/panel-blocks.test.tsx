/**
 * WP96 交付 3：「不是卡」的两块——报表块与告警块。
 *
 * 钉三件事：报表块出数、两块都**没有批准 / 驳回**（它们不要人决定）、
 * 两块都有右下角那个 → 圆钮（看完想细看就点它）。
 */
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { AlertBlocks, ReportBlocks } from '@/components/deck/panel-blocks'
import { draftCard } from './fixtures'
import { renderWithProviders } from './helpers'

const noop = (): void => {}

const report = draftCard({
  id: 'ap_report',
  kind: 'daily_report',
  layout: 'aftermath',
  title: '昨天店里：销售额 US$8,412',
  summary: '订单 61 单，库存告急 3 个 SKU',
  detail: {
    ...draftCard().detail,
    payload: { orders: 61, low_stock: 3, pending: 0 },
  },
})

const alert = draftCard({
  id: 'ap_alert',
  kind: 'system_alert',
  layout: 'aftermath',
  priority_band: 'P0',
  title: 'Meta 像素 24 小时没有回传事件',
})

describe('报表块', () => {
  it('出标题、摘要与几个数', () => {
    renderWithProviders(<ReportBlocks reports={[report]} onOpen={noop} />)
    const block = screen.getByTestId('report-block')
    expect(block.textContent).toContain('销售额 US$8,412')
    const figures = within(block).getByTestId('report-figures')
    expect(figures.textContent).toContain('61')
    expect(figures.textContent).toContain('3')
    // WP141：列头是人话，不是字段名
    expect(figures.textContent).toContain('订单')
    expect(figures.textContent).toContain('库存告急')
    expect(figures.textContent).not.toMatch(/low_stock|orders/)
  })

  it('没有批准 / 驳回——它不要人决定', () => {
    renderWithProviders(<ReportBlocks reports={[report]} onOpen={noop} />)
    const block = screen.getByTestId('report-block')
    expect(block.textContent).not.toContain('批准')
    expect(block.textContent).not.toContain('驳回')
    expect(screen.queryByTestId('deck-action-bar')).toBeNull()
  })

  it('一条都没有时整块不出（不出空标题）', () => {
    renderWithProviders(<ReportBlocks reports={[]} onOpen={noop} />)
    expect(screen.queryByTestId('panel-reports')).toBeNull()
  })

  it('右下角的 → 圆钮点了进这件事', async () => {
    const onOpen = vi.fn()
    renderWithProviders(<ReportBlocks reports={[report]} onOpen={onOpen} />)
    await userEvent.click(screen.getByTestId('ws-go'))
    expect(onOpen).toHaveBeenCalledWith(report)
  })
})

describe('告警块', () => {
  it('一条一行，带档位胶囊，没有决定按钮', () => {
    renderWithProviders(<AlertBlocks alerts={[alert]} onOpen={noop} />)
    const block = screen.getByTestId('alert-block')
    expect(block.textContent).toContain('像素')
    expect(within(block).getByTestId('ws-status-pill').dataset.tone).toBe('bad')
    expect(block.textContent).not.toContain('批准')
  })

  it('一条都没有时整块不出', () => {
    renderWithProviders(<AlertBlocks alerts={[]} onOpen={noop} />)
    expect(screen.queryByTestId('alerts')).toBeNull()
  })
})
