import { describe, expect, it } from 'vitest'
import {
  adoptionRate,
  BUNDLED_POSITIONS_DIR,
  changeKindOf,
  collectUnknownKeys,
  compilePolicies,
  createPolicyEngine,
  effectiveConfig,
  initialAutomationState,
  loadPosition,
  loadRole,
  POSITION_SCHEMA,
  parsePosition,
  RoleError,
} from '../src/index.js'
import { buildAssignment } from '../src/position.js'
import { aftersales, fixedClock } from './helpers.js'

const role = aftersales()
const clock = fixedClock()
const assignment = buildAssignment(
  {
    person_id: 'p_cs',
    workspace_id: 'ws_1',
    role,
    ranges: [{ kind: 'store', id: 'shop_a' }],
    granted_by: 'p_owner',
  },
  { clock, newId: () => 'asg_1' },
)

describe('changeKindOf (15 §2)', () => {
  it('strips the staging prefix before looking up the change kind', () => {
    expect(changeKindOf('stage_refund')).toBe('refund')
    expect(changeKindOf('refund')).toBe('refund')
    expect(changeKindOf('propose_price_change')).toBe('price_change')
    expect(changeKindOf('reply_customer')).toBeUndefined()
    expect(changeKindOf('draft_chargeback_evidence')).toBeUndefined()
  })
})

describe('adoptionRate', () => {
  it('divides accepted by all decisions', () => {
    expect(adoptionRate({ accepted: 0, edited: 0, rejected: 0 })).toEqual({ rate: 0, samples: 0 })
    expect(adoptionRate({ accepted: 3, edited: 1, rejected: 0 })).toEqual({
      rate: 0.75,
      samples: 4,
    })
  })
})

describe('initialAutomationState (05 §1.4)', () => {
  it('starts every action at its declared initial level', () => {
    const state = initialAutomationState(role, '2026-09-09T00:00:00.000Z')
    expect(Object.keys(state)).toHaveLength(5)
    expect(state.reply_customer?.level).toBe('L1')
    expect(state.reply_customer?.last_change).toEqual({
      at: '2026-09-09T00:00:00.000Z',
      reason: 'assignment_created',
    })
  })
})

describe('createPolicyEngine', () => {
  it('sets, reads and removes rows for one assignment', () => {
    const engine = createPolicyEngine()
    engine.set(assignment.id, compilePolicies(assignment, role))
    expect(engine.rows(assignment.id)).toHaveLength(11)
    expect(
      engine.can(assignment.id, 'order', 'read', { range: 'assigned', sensitivity: 'internal' }),
    ).toBe(true)
    engine.remove(assignment.id)
    expect(engine.rows(assignment.id)).toEqual([])
    expect(
      engine.can(assignment.id, 'order', 'read', { range: 'assigned', sensitivity: 'internal' }),
    ).toBe(false)
  })

  it('compiles nothing when the assignment is for another role', () => {
    expect(compilePolicies({ ...assignment, role_id: 'common.member' }, role)).toEqual([])
  })
})

describe('effectiveConfig 前置校验', () => {
  it('refuses a role that does not match the assignment', () => {
    expect(() =>
      effectiveConfig({ assignment: { ...assignment, role_id: 'common.member' }, role }),
    ).toThrow(RoleError)
  })

  it('refuses an assignment granted at an older major version (05 §3)', () => {
    expect(() =>
      effectiveConfig({ assignment: { ...assignment, role_version: '0.9.0' }, role }),
    ).toThrow(/re-confirm/)
    // 同 major 的小版本升级不需要重新确认
    expect(
      effectiveConfig({ assignment: { ...assignment, role_version: '1.0.0' }, role }).role_version,
    ).toBe('1.0.0')
  })
})

describe('loadPosition / collectUnknownKeys', () => {
  it('loads a position from an explicit path', () => {
    expect(loadPosition(`${BUNDLED_POSITIONS_DIR}dtc-ops.yml`).id).toBe('dtc-ops')
  })

  it('rejects unknown position fields', () => {
    expect(() =>
      parsePosition('id: x\nversion: 1.0.0\nname: {zh: a, en: b}\nroles: []\nseats: 3\n', 'p.yml'),
    ).toThrow(/seats/)
  })

  it('reports every unknown key it finds', () => {
    expect(
      collectUnknownKeys(
        { id: 'x', roles: [{ role: 'a', default: true, extra: 1 }] },
        POSITION_SCHEMA,
      ),
    ).toEqual(['roles[0].extra'])
  })

  it('surfaces a missing file as a normal fs error', () => {
    expect(() => loadRole('/nonexistent/role.yml')).toThrow()
  })
})
