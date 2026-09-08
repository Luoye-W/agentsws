import type { RoleId } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { applyPosition, RoleError } from '../src/index.js'
import { aftersales, dtcOps, fixedClock, stubRole } from './helpers.js'

const DEFAULTS: RoleId[] = [
  'dtc.presales',
  'dtc.aftersales',
  'dtc.store-config',
  'dtc.catalog',
  'dtc.content',
  'dtc.promotions',
  'dtc.analytics',
  'dtc.email-marketing',
]

function resolver() {
  const real = aftersales()
  return (id: RoleId) => (id === real.id ? real : stubRole(id))
}

function options(overrides: Partial<Parameters<typeof applyPosition>[4]> = {}) {
  let n = 0
  return {
    clock: fixedClock(),
    newId: () => `asg_${++n}`,
    granted_by: 'p_owner',
    roles: resolver(),
    ...overrides,
  }
}

describe('applyPosition (05 §2 / 04 §1.11)', () => {
  it('expands only the 8 default roles of the dtc-ops position', () => {
    const created = applyPosition(
      dtcOps(),
      'p_ops',
      'ws_1',
      [{ kind: 'store', id: 'shop_a' }],
      options(),
    )
    expect(created).toHaveLength(8)
    expect(created.map((a) => a.role_id)).toEqual(DEFAULTS)
    expect(created.every((a) => a.person_id === 'p_ops' && a.workspace_id === 'ws_1')).toBe(true)
    expect(created.every((a) => a.granted_by === 'p_owner')).toBe(true)
    expect(created.every((a) => a.granted_at === '2026-09-09T00:00:00.000Z')).toBe(true)
    expect(new Set(created.map((a) => a.id)).size).toBe(8)
    expect(created[0]?.ranges).toEqual([{ kind: 'store', id: 'shop_a' }])
  })

  it('records the role version at grant time and the initial automation level', () => {
    const created = applyPosition(dtcOps(), 'p_ops', 'ws_1', [], options())
    const after = created.find((a) => a.role_id === 'dtc.aftersales')
    expect(after?.role_version).toBe('1.0.0')
    expect(after?.automation_state.stage_refund?.level).toBe('L1')
    expect(after?.automation_state.stage_refund?.adoption).toEqual({
      accepted: 0,
      edited: 0,
      rejected: 0,
      since: '2026-09-09T00:00:00.000Z',
    })
  })

  it('adds explicitly ticked optional roles only', () => {
    const created = applyPosition(
      dtcOps(),
      'p_ops',
      'ws_1',
      [],
      options({ include: ['dtc.reviews'] }),
    )
    expect(created).toHaveLength(9)
    expect(created.map((a) => a.role_id)).toContain('dtc.reviews')
    expect(created.map((a) => a.role_id)).not.toContain('dtc.fulfillment')
  })

  it('refuses roles the position does not offer', () => {
    expect(() =>
      applyPosition(dtcOps(), 'p_ops', 'ws_1', [], options({ include: ['amz.listing'] })),
    ).toThrow(RoleError)
  })

  it('refuses to grant a role whose definition is not loaded', () => {
    expect(() =>
      applyPosition(dtcOps(), 'p_ops', 'ws_1', [], options({ roles: () => undefined })),
    ).toThrow(/is not loaded/)
  })
})
