/**
 * 47 J1 的"给人看的那一份"：设置页的数据地图。
 *
 * 四组断言：
 * 1. 一行一类对象，四列都在（真源 / 新鲜度 / 我能看的范围 / 能做的）；
 * 2. 解释性文字进 tooltip，不占版面（36 §7）；
 * 3. 调用顺序那一段与 Agent 看到的是同一处生成的（`ORDER_RULE`）；
 * 4. 空的时候给一句人话，不是一张空表。
 */
import type { TailoredOntology } from '@agentsws/ontology/view'
import { ORDER_RULE } from '@agentsws/ontology/view'
import { screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DataMapPanel } from '@/components/data-map'
import { renderWithProviders } from './helpers'

const MAP: TailoredOntology = {
  assignment_id: 'asg_1',
  role_id: 'dtc.aftersales',
  objects: [
    {
      id: 'order',
      label: '订单',
      read_range: 'assigned',
      source_of_truth: 'platform_api',
      freshness: 'cached:300',
      read_via: ['shopify_admin.get_order'],
    },
    {
      id: 'fact_card',
      label: '事实卡',
      read_range: 'workspace',
      source_of_truth: 'human',
      freshness: 'authored',
      read_via: ['search_policies'],
    },
  ],
  actions: [
    {
      id: 'stage_refund',
      object: 'order',
      label: '提一笔退款（订单）',
      tool: 'stage_refund',
      change_kind: 'refund',
      risk_class: 'medium',
      requires_approval: true,
    },
  ],
  links: [],
}

const state = { map: MAP as TailoredOntology, fail: null as Error | null }

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getPositionOntology: async () => {
      if (state.fail !== null) throw state.fail
      return state.map
    },
  }
})

beforeEach(() => {
  state.map = MAP
  state.fail = null
})

describe('47 J1 设置页数据地图', () => {
  it('一行一类对象，真源 / 新鲜度 / 范围 / 能做的都写出来', async () => {
    renderWithProviders(<DataMapPanel position="asg_1" />)
    await screen.findByTestId('data-map-table')
    const rows = screen.getByTestId('data-map-table').querySelectorAll('tbody tr')
    expect(rows).toHaveLength(2)

    const order = rows[0]?.textContent ?? ''
    expect(order).toContain('订单')
    expect(order).toContain('平台')
    expect(order).toContain('缓存 5 分钟')
    expect(order).toContain('我负责的范围')
    expect(order).toContain('提一笔退款')

    const card = rows[1]?.textContent ?? ''
    expect(card).toContain('事实卡')
    expect(card).toContain('人写的')
    expect(card).toContain('整个工作区')
    // 事实卡上没有写动作 → 只能看
    expect(card).toContain('只能看')
  })

  it('解释性文字进 tooltip（36 §7），不占版面', async () => {
    renderWithProviders(<DataMapPanel position="asg_1" />)
    await screen.findByTestId('data-map-table')
    const hints = document.querySelectorAll('[data-hint]')
    expect(hints.length).toBeGreaterThanOrEqual(4)
    const texts = [...hints].map((h) => h.getAttribute('data-hint') ?? '').join(' ')
    expect(texts).toContain('真源')
    expect(texts).toContain('缓存')
  })

  it('调用顺序那一段与 Agent 看到的是同一处生成的', async () => {
    renderWithProviders(<DataMapPanel position="asg_1" />)
    expect((await screen.findByTestId('data-map-order')).textContent).toBe(ORDER_RULE)
  })

  it('一个对象都看不到时给一句人话', async () => {
    state.map = { ...MAP, objects: [], actions: [] }
    renderWithProviders(<DataMapPanel position="asg_1" />)
    await screen.findByText(/还没有任何看得到的对象/)
  })

  it('读不到就把原因原样说出来', async () => {
    state.fail = new Error('forbidden')
    renderWithProviders(<DataMapPanel position="asg_1" />)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('forbidden')
  })
})
