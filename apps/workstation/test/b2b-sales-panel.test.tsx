/**
 * WP182（docs/84 §3）：「业务」职责页上那一块——事实卡、报价单、样品、交接提示。
 *
 * 钉三件事：
 * 1. 六类事实卡一眼看得见齐没齐；有缺的才有「按官网预填」；
 * 2. 在批的报价写清「谁批」，不给「发给客户」；批了的才能发（按下去只说出了一张卡）；
 * 3. 样品标已寄要填单号；超期的红字写「超 N 天」。
 */
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { B2bSalesData, B2bStagedData } from '@/lib/api'
import { renderWithProviders } from './helpers'

const cat = (category: string, name: string, status?: string) => ({
  category,
  name,
  description: '',
  covers: [],
  ...(status === undefined ? {} : { card: { id: `kc_${category}`, status, statement: name } }),
})

const DATA: B2bSalesData = {
  facts: {
    industry: '消费电子 / 3C',
    recommended_certifications: ['CE'],
    ready: 2,
    categories: [
      cat('product_lines', '产品线'),
      cat('pricing_moq', '价格与 MOQ', 'active'),
      cat('certifications', '认证清单', 'proposed'),
      cat('delivery', '交付能力', 'active'),
      cat('sample_policy', '样品政策'),
      cat('after_sales', '售后规则'),
    ],
  },
  quotes: [
    {
      id: 'quo_1',
      number: 'Q-01',
      account: 'Volthaus',
      version: 2,
      amount_usd: 18414,
      status: 'pending_approval',
      pending: { version: 2, approver: 'scope_manager', breaches: ['quote_amount_over_mandate'] },
    },
    {
      id: 'quo_2',
      number: 'Q-02',
      account: 'Harbor',
      version: 1,
      amount_usd: 8000,
      status: 'draft',
    },
  ],
  samples: [
    {
      id: 'smp_1',
      account: 'Harbor',
      items: 'TWS ×3',
      status: 'to_ship',
      due: '2026-09-25',
      overdue: 'ship_overdue',
      overdue_days: 4,
    },
  ],
  handovers: [{ id: 'hov_1', departing: '何佳', items: 4, unassigned: 1, status: 'pending' }],
}

const getB2bSales = vi.fn<() => Promise<B2bSalesData>>()
const sendB2bQuote = vi.fn<(id: string) => Promise<B2bStagedData>>()
const advanceB2bSample = vi.fn<(id: string, input: unknown) => Promise<B2bStagedData>>()
const setupB2bFacts = vi.fn<() => Promise<B2bSalesData['facts'] & { proposed: number }>>()

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getB2bSales: () => getB2bSales(),
    sendB2bQuote: (id: string) => sendB2bQuote(id),
    advanceB2bSample: (id: string, input: unknown) => advanceB2bSample(id, input),
    setupB2bFacts: () => setupB2bFacts(),
  }
})

const { B2bSalesPanel } = await import('@/components/b2b/sales-panel')

describe('业务面板', () => {
  beforeEach(() => {
    getB2bSales.mockReset()
    sendB2bQuote.mockReset()
    advanceB2bSample.mockReset()
    setupB2bFacts.mockReset()
    getB2bSales.mockResolvedValue(DATA)
  })

  it('事实卡齐没齐一眼看得见；缺的才给「按官网预填」', async () => {
    setupB2bFacts.mockResolvedValue({ ...DATA.facts, proposed: 3 })
    renderWithProviders(<B2bSalesPanel assignment="asg_sales" />)
    expect((await screen.findByTestId('b2b-facts')).textContent).toContain('价格与 MOQ 生效')
    expect(document.querySelector('[data-fact="certifications"]')?.textContent).toContain('待核')
    expect(document.querySelector('[data-fact="product_lines"]')?.textContent).toContain('没有')
    fireEvent.click(screen.getByTestId('b2b-facts-setup'))
    await waitFor(() => expect(setupB2bFacts).toHaveBeenCalled())
    expect((await screen.findByTestId('b2b-sales-note')).textContent).toContain('提了 3 张')
  })

  it('在批的报价写清谁批、不能发；批了的才能发，按下去只说出了一张卡', async () => {
    sendB2bQuote.mockResolvedValue({ staged: true, draft_id: '', approval_item_id: 'apr_1' })
    renderWithProviders(<B2bSalesPanel assignment="asg_sales" />)
    const rows = await screen.findAllByTestId('b2b-quote-row')
    expect(rows[0]?.textContent).toContain('V2 在批 · 上级批')
    expect(rows[0]?.querySelector('[data-testid="b2b-quote-send"]')).toBeNull()
    const send = rows[1]?.querySelector('[data-testid="b2b-quote-send"]') as HTMLElement
    fireEvent.click(send)
    await waitFor(() => expect(sendB2bQuote).toHaveBeenCalledWith('quo_2'))
    expect((await screen.findByTestId('b2b-sales-note')).textContent).toContain('批了才发')
  })

  it('样品：超期红字；标已寄带单号；交接提示', async () => {
    advanceB2bSample.mockResolvedValue({ staged: true, draft_id: 'd', approval_item_id: 'apr_s' })
    renderWithProviders(<B2bSalesPanel assignment="asg_sales" />)
    expect((await screen.findByTestId('b2b-sample-overdue')).textContent).toBe('超 4 天')
    fireEvent.click(screen.getByTestId('b2b-sample-open'))
    fireEvent.change(screen.getByTestId('b2b-sample-tracking'), { target: { value: 'DHL-1' } })
    fireEvent.click(screen.getByTestId('b2b-sample-submit'))
    await waitFor(() =>
      expect(advanceB2bSample).toHaveBeenCalledWith('smp_1', {
        status: 'shipped',
        tracking_no: 'DHL-1',
        carrier: 'DHL',
      }),
    )
    expect(screen.getByTestId('b2b-handover').textContent).toContain('何佳 的 5 条交接等老板批')
  })
})
