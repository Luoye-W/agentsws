/**
 * WP381：体检块头的「现在体检」小钮——只有图标（字在 tooltip / 读屏里），点了 POST 块上写的地址、跑完重取块数据；
 * 没写 `rerun` 的块没有这个钮。
 */
import type { BlockDef } from '@agentsws/deck'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { renderWithProviders } from './helpers'

const calls: string[] = []
let fetched = 0
vi.mock('@/lib/api', async () => ({
  ...(await vi.importActual<object>('@/lib/api')),
  getBlockData: vi.fn(async (id: string) => {
    fetched += 1
    return {
      block: { id, component: 'table', source: 'site', title: id },
      range: 'last_7d',
      status: 'ok',
      payload: {
        columns: [{ key: 'bot', label: 'AI 爬虫' }],
        rows: [{ bot: fetched === 1 ? '还没体检' : 'GPTBot' }],
      },
    }
  }),
  rerunBlock: vi.fn(async (path: string) => {
    calls.push(path)
    return {}
  }),
}))

const { BlockCard } = await import('@/components/blocks/block-view')

const def = (rerun?: BlockDef['rerun']): BlockDef => ({
  id: 'site.health.crawlers',
  placement: 'role_view',
  component: 'table',
  title: 'AI 爬虫进不进得来',
  query: 'site.ai_crawlers',
  source: 'site',
  ...(rerun === undefined ? {} : { rerun }),
})

describe('WP381 块头「现在体检」', () => {
  it('点了 POST 体检地址，跑完重取这一块', async () => {
    renderWithProviders(
      <BlockCard
        block={def({ path: '/v1/site-health/run', label: '现在体检' })}
        range="last_7d"
        assignment="asg_1"
      />,
    )
    await screen.findByText('还没体检')
    const btn = screen.getByTestId('block-rerun')
    expect(btn.textContent).toBe('')
    expect(btn.getAttribute('aria-label')).toBe('现在体检')
    fireEvent.click(btn)
    await waitFor(() => expect(calls).toEqual(['/v1/site-health/run']))
    await screen.findByText('GPTBot')
  })

  it('没写 rerun 的块没有这个钮', async () => {
    renderWithProviders(<BlockCard block={def()} range="last_7d" assignment="asg_2" />)
    await screen.findByText(/还没体检|GPTBot/)
    expect(screen.queryByTestId('block-rerun')).toBeNull()
  })
})
