/**
 * WP96 交付 3：「不是卡」的报表块。
 *
 * 钉三件事：报表块出数、**没有批准 / 驳回**（不要人决定）、右下角那个 → 圆钮（看完想细看就点它）。
 * 告警块 WP466 起并进了右上铃铛（见 `wp466-alerts-to-bell.test.tsx`），这里只留系统卡去处的那条。
 */
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ReportBlocks } from '@/components/deck/panel-blocks'
import { matterUrl } from '@/lib/work'
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

describe('WP169 店铺校正的通知：点开到设置页公司档案', () => {
  const notice = draftCard({
    id: 'mkt_notice_1',
    kind: 'system_alert',
    layout: 'aftermath',
    priority_band: 'P3',
    title: '目标市场按店铺后台改了：加上了 英国',
    detail: {
      ...draftCard().detail,
      payload: { kind: 'markets_store_sync', open_path: '/settings#company' },
    },
  })

  it('点开去 /settings#company（铃铛那条与卡上的去处同一个）', () => {
    expect(matterUrl(notice)).toBe('/settings#company')
  })

  it('只认站内路径：外链与 // 开头的不跟，退回岗位页', () => {
    const outside = (open_path: string) =>
      draftCard({ ...notice, detail: { ...notice.detail, payload: { open_path } } })
    expect(matterUrl(outside('https://evil.example/'))).toBe(`/positions/${notice.position_id}`)
    expect(matterUrl(outside('//evil.example/'))).toBe(`/positions/${notice.position_id}`)
  })
})
