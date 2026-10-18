/**
 * WP413：插件里批 = 工坊里批，发出记录那一行看得出「在插件里批的」（工坊里批的不标）。
 */
import { screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { OutboundPanel } from '@/components/rail/panels/outbound-panel'
import type { OutboundRecord } from '@/lib/outbound-api'
import { renderWithProviders } from './helpers'

const T0 = '2026-10-18T02:30:00.000Z'
const row = (id: string, content: string, via?: 'extension'): OutboundRecord => ({
  id,
  workspace_id: 'ws_1' as never,
  source_key: `approval:${id}`,
  sent_at: T0,
  channel: 'reddit',
  action: 'reply',
  kind: 'reddit_write',
  destination: 'r/ivraxr',
  content,
  status: 'sent',
  follow_ups: [],
  ...(via === undefined ? {} : { approved_via: via }),
})

vi.mock('@/lib/outbound-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/outbound-api')>('@/lib/outbound-api')
  return {
    ...actual,
    listOutbound: async () => [
      row('ob_1', 'Approved in Chrome.', 'extension'),
      row('ob_2', 'Approved in the workshop.'),
    ],
    listSinks: async () => [],
  }
})

describe('WP413 发出记录标出「在插件里批的」', () => {
  it('只有在插件里批的那一行带这一句', async () => {
    renderWithProviders(<OutboundPanel tier="position" pathname="/" />)
    await screen.findByTestId('outbound-records')
    const rows = screen.getAllByTestId('outbound-row')
    expect(rows[0]?.textContent).toContain('在插件里批的')
    expect(rows[1]?.textContent).not.toContain('在插件里批的')
    expect(screen.getAllByTestId('outbound-via-extension')).toHaveLength(1)
  })
})
