/**
 * WP179：模型页的「用你的 DeepSeek 账号搜索」开关。
 *
 * - 默认开着（数据接口路由 `web.search` 第一级就是官方那条）；
 * - 拨一下就把这一级关掉 / 打开，存的是 `web.search` 那一项路由（不碰别的能力）；
 * - 开着但手上没凭据：状态那一句说清"暂时搜不了"；细节在问号里。
 */
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSearchToggle } from '@/components/models/web-search-toggle'
import type { CapabilitySourceSettings, DataSourceRoute } from '@/lib/api'
import { renderWithProviders } from './helpers'

const state: { sources: CapabilitySourceSettings } = {
  sources: { workspace_id: 'ws_1', capability_sources: {} },
}
const writes: (Record<string, DataSourceRoute> | undefined)[] = []

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getCapabilitySources: async () => state.sources,
    setCapabilitySources: async (
      sources: CapabilitySourceSettings['capability_sources'],
      _assignment: string | undefined,
      routing?: Record<string, DataSourceRoute>,
    ) => {
      writes.push(routing)
      state.sources = {
        workspace_id: 'ws_1',
        capability_sources: sources,
        data_source_routing: { ...(state.sources.data_source_routing ?? {}), ...routing },
      }
      return state.sources
    },
  }
})

beforeEach(() => {
  state.sources = { workspace_id: 'ws_1', capability_sources: {} }
  writes.length = 0
})

describe('WP179 用你的 DeepSeek 账号搜索', () => {
  it('默认开着；有凭据时说"会上网搜索"', async () => {
    renderWithProviders(<WebSearchToggle assignment="asg_owner" ready />)
    const sw = await screen.findByTestId('web-search-switch')
    expect(sw.getAttribute('data-state')).toBe('checked')
    // WP214：开关已经说了开 / 关——状态那句进小图标的 tooltip，卡面上不再常显
    const icon = screen.getByTestId('status-icon')
    expect(icon.dataset.state).toBe('ok')
    expect(icon.getAttribute('data-hint')).toContain('会上网搜索')
    expect(screen.getByTestId('web-search-toggle').textContent).not.toContain('会上网搜索')
    expect(screen.getByTestId('web-search-toggle').textContent).toContain(
      '用你的 DeepSeek 账号搜索',
    )
  })

  it('拨一下：只改 web.search 那一项路由（关掉官方那一级）', async () => {
    renderWithProviders(<WebSearchToggle assignment="asg_owner" ready />)
    await userEvent.click(await screen.findByTestId('web-search-switch'))
    await waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0]).toEqual({
      'web.search': { order: ['deepseek_native'], disabled: ['deepseek_native'] },
    })
    await waitFor(() =>
      expect(screen.getByTestId('status-icon').getAttribute('data-hint')).toContain('不上网搜索'),
    )
  })

  it('开着但没登录账号、也没填官方 key：说清暂时搜不了', async () => {
    renderWithProviders(<WebSearchToggle assignment="asg_owner" ready={false} />)
    await screen.findByTestId('web-search-switch')
    expect(screen.getByTestId('web-search-toggle').textContent).toContain('暂时搜不了')
  })
})
