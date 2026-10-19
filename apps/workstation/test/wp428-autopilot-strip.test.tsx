/**
 * WP428（决策 1244 改）：「全自动」那一条——只在开着 / 够条件了的时候出；点了开、点了关。
 */
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AutopilotScopeView } from '@/lib/api'
import { renderWithProviders } from './helpers'

const state = vi.hoisted(() => ({ rows: [] as AutopilotScopeView[], sets: [] as string[] }))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getAutopilot: async () => state.rows,
    setAutopilot: async (scope: string, on: boolean) => {
      state.sets.push(`${scope}:${on}`)
      state.rows = state.rows.map((r) => (r.scope_id === scope ? { ...r, on } : r))
      return state.rows[0]
    },
  }
})

const { AutopilotStrip } = await import('@/components/autopilot/autopilot-strip')

const ROW: AutopilotScopeView = {
  scope_id: 'kol.advance_stage',
  title: '红人合作推进到「谈成 / 已寄样」',
  grants: 'AI 可以自己推进',
  keeps: '花钱的照旧出卡',
  on: false,
  eligible: false,
  streak: 3,
  needed: 10,
  why: '还差 7 张',
}

beforeEach(() => {
  state.sets = []
})

describe('WP428 全自动那一条', () => {
  it('没开也不够条件：一个字都不出', async () => {
    state.rows = [ROW]
    renderWithProviders(<AutopilotStrip assignment="asg_1" />)
    await new Promise((r) => setTimeout(r, 50))
    expect(screen.queryByTestId('autopilot-strip')).toBeNull()
  })

  it('够条件了 → 「开全自动」；开着 → 「关掉」', async () => {
    state.rows = [{ ...ROW, eligible: true, streak: 10, why: '最近 10 张都原样批了' }]
    renderWithProviders(<AutopilotStrip assignment="asg_1" />)
    const row = await screen.findByTestId('autopilot-row')
    expect(row.textContent).toContain('够条件了')
    fireEvent.click(screen.getByTestId('autopilot-toggle'))
    await waitFor(() => {
      expect(screen.getByTestId('autopilot-row').dataset.on).toBe('true')
    })
    expect(screen.getByTestId('autopilot-toggle').textContent).toContain('关掉')
    expect(state.sets).toEqual(['kol.advance_stage:true'])
  })
})
