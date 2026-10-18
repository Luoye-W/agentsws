/**
 * WP331：通用的报告报表块——周期（第 2 版起带版号）、正文（安全 Markdown，长的先收着）、复制整份、导出 .md。
 * 不认平台、不认是周报还是日报；不出图片（安全 Markdown 只留图的说明字）。
 */
import type { ReportPayload } from '@agentsws/contracts'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { isReport, ReportBody, reportFilename } from '@/components/deck/report-body'
import { renderWithProviders } from './helpers'

const payload: ReportPayload = {
  kind: 'report',
  series: 'r/ivraxr 周报',
  title: 'r/ivraxr 周报（10/11 – 10/16）',
  period: '10/11 – 10/16',
  period_start: '2026-10-11',
  markdown:
    '# r/ivraxr 周报\n\n## 1. 外部舆情\n\n### 1. 和别家对比（post × 1 / comment × 2）\n\n评估：需跟进\n\n> Anyone compared?\n\nhttps://www.reddit.com/r/ar/comments/9/\n\n![截图](https://example.test/x.png)\n',
  published_at: '2026-10-16T09:00:00.000Z',
  version: 2,
}

describe('报告报表块', () => {
  it('认形状、周期带版号、正文按 Markdown 排、不出图片', () => {
    expect(isReport(payload)).toBe(true)
    expect(isReport({ kind: 'reddit_weekly', markdown: '', title: '' })).toBe(false)
    renderWithProviders(<ReportBody payload={payload} />)
    expect(screen.getByText('10/11 – 10/16 · 第 2 版')).toBeTruthy()
    expect(screen.getByText(/和别家对比（post × 1 \/ comment × 2）/)).toBeTruthy()
    expect(screen.getByTestId('report-markdown').querySelector('img')).toBeNull()
    // 短的不收
    expect(screen.queryByTestId('report-toggle')).toBeNull()
  })

  it('复制整份、导出 .md（文件名用标题）', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    const created = vi.fn(() => 'blob:x')
    Object.assign(URL, { createObjectURL: created, revokeObjectURL: vi.fn() })
    renderWithProviders(<ReportBody payload={payload} />)
    fireEvent.click(screen.getByTestId('report-copy'))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(payload.markdown))
    fireEvent.click(screen.getByTestId('report-export'))
    expect(created).toHaveBeenCalledTimes(1)
    expect(reportFilename(payload)).toBe('r ivraxr 周报（10 11 – 10 16）.md')
  })

  it('长的先收着一截，点开看全', () => {
    const long = { ...payload, version: 1, markdown: `# 长\n\n${'很长的一段。'.repeat(400)}\n` }
    renderWithProviders(<ReportBody payload={long} />)
    expect(screen.getByText('10/11 – 10/16')).toBeTruthy()
    const toggle = screen.getByTestId('report-toggle')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
  })
})
