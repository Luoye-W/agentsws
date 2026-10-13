/**
 * WP302（决策 406）：红人看板上的两种新画法与「没数就不出」。
 *
 * 1. 漏斗：一级一根条，右边人数 · 比上一级的转化率；
 * 2. 归因三态：没连店铺（给去处）/ 等第一单 / 有数（一排数）；
 * 3. `hide_when_empty` 的积木一行都没有就整块不出（交稿排期没有要催的稿是好事）。
 */
import type { BlockData, BlockDef } from '@agentsws/deck'
import { screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { renderWithProviders } from './helpers'

let blockPayload: unknown = { columns: [], rows: [] }
vi.mock('@/lib/api', async () => ({
  ...(await vi.importActual<object>('@/lib/api')),
  getBlockData: vi.fn(async (id: string) => ({
    block: { id, component: 'table', source: 'kol', label: id },
    range: 'last_7d',
    status: 'ok',
    payload: blockPayload,
  })),
}))

const { BlockBody, BlockCard } = await import('@/components/blocks/block-view')

const data = (component: string, payload: object): BlockData =>
  ({
    block: { id: `kol.${component}`, component, source: 'kol', label: component },
    range: 'last_7d',
    status: 'ok',
    payload,
  }) as unknown as BlockData

describe('漏斗', () => {
  it('每一级一根条，带比上一级的转化率', () => {
    renderWithProviders(
      <BlockBody
        data={data('funnel', {
          columns: [
            { key: 'stage', label: '阶段' },
            { key: 'count', label: '人数', format: 'count' },
          ],
          rows: [
            { stage: '进了名单', count: 20 },
            { stage: '已建联', count: 10 },
            { stage: '有回音', count: 4 },
          ],
        })}
      />,
    )
    const steps = screen.getAllByTestId('funnel-step')
    expect(steps).toHaveLength(3)
    expect(steps[0]?.textContent).not.toContain('%')
    expect(steps[1]?.textContent).toContain('50%')
    expect(steps[2]?.textContent).toContain('40%')
  })

  it('没有合作：一个「—」，不画五根空条', () => {
    renderWithProviders(
      <BlockBody
        data={data('funnel', {
          columns: [
            { key: 'stage', label: '阶段' },
            { key: 'count', label: '人数' },
          ],
          rows: [],
        })}
      />,
    )
    expect(screen.queryByTestId('block-funnel')).toBeNull()
    expect(screen.getByText('—')).toBeDefined()
  })
})

describe('归因三态', () => {
  const columns = [{ key: 'name', label: '红人' }]

  it('没连店铺：说算不出来，给去处', () => {
    renderWithProviders(
      <BlockBody
        data={data('conversion', {
          columns,
          rows: [],
          state: 'not_connected',
          footer: { text: '连上店铺才算得出谁带了货', href: '/connections', link_label: '去连接' },
        })}
      />,
    )
    expect(screen.getByTestId('block-conversion').getAttribute('data-state')).toBe('not_connected')
    expect(screen.getByRole('link', { name: '去连接' }).getAttribute('href')).toBe('/connections')
    expect(screen.queryAllByTestId('conversion-metric')).toHaveLength(0)
  })

  it('等第一单：一句话，没有去处', () => {
    renderWithProviders(
      <BlockBody
        data={data('conversion', {
          columns,
          rows: [],
          state: 'waiting',
          footer: { text: '追踪链接还没带来点击，第一单进来就有数' },
        })}
      />,
    )
    expect(screen.getByTestId('conversion-empty').textContent).toContain('第一单')
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('有数：一排数，回本是倍数不是钱', () => {
    renderWithProviders(
      <BlockBody
        data={data('conversion', {
          columns,
          rows: [],
          state: 'ready',
          metrics: [
            { label: '点击', value: 320, format: 'count' },
            { label: '订单', value: 12, format: 'count' },
            { label: '花费', value: 400, format: 'money', currency: 'USD' },
            { label: '回本', value: 1.6, format: 'ratio' },
          ],
        })}
      />,
    )
    const metrics = screen.getAllByTestId('conversion-metric')
    expect(metrics.map((m) => m.querySelector('dt')?.textContent)).toEqual([
      '点击',
      '订单',
      '花费',
      '回本',
    ])
    expect(metrics[3]?.textContent).not.toContain('$')
    expect(screen.queryByTestId('conversion-empty')).toBeNull()
  })
})

describe('hide_when_empty', () => {
  const block = (hide: boolean): BlockDef =>
    ({
      id: 'kol.schedule',
      component: 'table',
      title: '交稿排期',
      source: 'kol',
      query: 'kol.schedule',
      ...(hide ? { hide_when_empty: true } : {}),
    }) as unknown as BlockDef

  it('一行都没有：整块不出', async () => {
    blockPayload = { columns: [{ key: 'name', label: '红人' }], rows: [] }
    renderWithProviders(<BlockCard block={block(true)} range="last_7d" assignment="asg_yt" />)
    // 等取数回来再断言（取数时也不先画骨架）
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.queryByTestId('block')).toBeNull()
  })

  it('有一行：照常出', async () => {
    blockPayload = {
      columns: [{ key: 'name', label: '红人' }],
      rows: [{ name: 'Gadget Jonas' }],
    }
    renderWithProviders(<BlockCard block={block(true)} range="last_7d" assignment="asg_yt" />)
    await waitFor(() => {
      expect(screen.getByTestId('block').textContent).toContain('Gadget Jonas')
    })
  })

  it('没标 hide_when_empty 的空表照旧出（画一个「—」）', async () => {
    blockPayload = { columns: [{ key: 'name', label: '红人' }], rows: [] }
    renderWithProviders(<BlockCard block={block(false)} range="last_7d" assignment="asg_yt" />)
    await waitFor(() => {
      expect(screen.getByTestId('block').textContent).toContain('—')
    })
  })
})
