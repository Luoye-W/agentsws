/**
 * WP131：价目页——没核过的挂「未核」，核过的写日期；来历原样印出来。
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { translate } from '../src/lib/i18n'

vi.mock('@/lib/app', () => ({
  useApp: () => ({
    t: (key: string, vars?: Record<string, string | number>) => translate('zh', key as never, vars),
  }),
  useQuery: () => ({ data: undefined, error: undefined, loading: false, reload: () => {} }),
}))

const { PricingTable } = await import('../src/pages/pricing')

describe('WP131 价目页', () => {
  it('未核的挂「未核」，核过的写「已核 日期」；来历原样印', () => {
    render(
      <PricingTable
        data={{
          as_of: '2026-09-19',
          version: 2,
          unreviewed: 1,
          rows: [
            {
              capability: 'data.kol.audit',
              label_zh: '红人体检报告（按次）',
              unit: 'call',
              credits_per_unit: 3,
              basis: '早期拍的数（WP59）：体检是自家库里的 k-匿名计算',
              reviewed_at: null,
              needs_review: true,
            },
            {
              capability: 'kol.service.monthly',
              label_zh: '红人营销增值服务（每月）',
              unit: 'month',
              credits_per_unit: 30,
              basis: 'Luoye 09-19 定',
              reviewed_at: '2026-09-30',
              needs_review: false,
            },
          ],
        }}
      />,
    )
    expect(screen.getAllByTestId('pricing-row')).toHaveLength(2)
    expect(screen.getByText('未核')).toBeDefined()
    expect(screen.getByText('已核 2026-09-30')).toBeDefined()
    expect(screen.getByText('早期拍的数（WP59）：体检是自家库里的 k-匿名计算')).toBeDefined()
  })
})
