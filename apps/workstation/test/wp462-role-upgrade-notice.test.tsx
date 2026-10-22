/**
 * WP462：职责升了大版本、自动接不上的那一条——主区顶上就地一张确认卡（人话，不出英文、不出分配号），
 * 点「确认」走 `POST /v1/assignments/:id/reconfirm`；别的岗位照常、没有要确认的就不画。
 */
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RoleUpgradeNotice } from '@/components/role-upgrade-notice'
import type { PositionSummary } from '@/lib/api'
import { renderWithProviders } from './helpers'

const calls: string[] = []
let fail = false

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    reconfirmAssignment: async (id: string) => {
      calls.push(id)
      if (fail) throw new Error('boom')
      return { assignment_id: id }
    },
  }
})

const position = (role_id: string, role_name: string, stale: boolean): PositionSummary => ({
  position_id: `asg_${role_id}`,
  role_id,
  role_name,
  ranges: [],
  ready: !stale,
  missing_connectors: [],
  tile_ids: [],
  range: 'yesterday',
  show_tiles: false,
  ...(stale
    ? {
        needs_reconfirm: {
          reason: 'role_major_upgraded' as const,
          assignment_id: `asg_${role_id}`,
          role_id,
          role_name,
          from: '1.0.0',
          to: '2.0.0',
        },
      }
    : {}),
})

beforeEach(() => {
  calls.length = 0
  fail = false
})

describe('WP462 职责升级确认卡', () => {
  it('只给要确认的那一条出一行；点「确认」确认的是那一条', async () => {
    renderWithProviders(
      <RoleUpgradeNotice
        positions={[
          position('dtc.store', '店铺管理', true),
          position('dtc.content', '内容与博客', false),
        ]}
      />,
    )
    const rows = screen.getAllByTestId('role-upgrade-notice')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.textContent).toContain('「店铺管理」这条职责升级了，点一下确认就能接着用')
    expect(rows[0]?.textContent).not.toMatch(/asg_|re-confirm/)
    await userEvent.click(screen.getByTestId('role-upgrade-confirm'))
    await waitFor(() => {
      expect(calls).toEqual(['asg_dtc.store'])
    })
  })

  it('没确认成：照实说一句，按钮还在', async () => {
    fail = true
    renderWithProviders(<RoleUpgradeNotice positions={[position('dtc.store', '店铺管理', true)]} />)
    await userEvent.click(screen.getByTestId('role-upgrade-confirm'))
    await waitFor(() => {
      expect(screen.getByTestId('role-upgrade-notice').textContent).toContain('没确认成')
    })
    expect(screen.getByTestId('role-upgrade-confirm')).toBeTruthy()
  })

  it('没有要确认的：什么都不画', () => {
    renderWithProviders(
      <RoleUpgradeNotice positions={[position('dtc.store', '店铺管理', false)]} />,
    )
    expect(screen.queryByTestId('role-upgrade-notices')).toBeNull()
  })
})
