import { describe, expect, it } from 'vitest'
import { compilePolicies, createRoleStore, rangeCovers, sensAtMost } from '../src/index.js'
import { aftersales, fixedClock, owner } from './helpers.js'

function seeded() {
  const s = createRoleStore({ clock: fixedClock(), roles: [aftersales(), owner()] })
  const a = s.assignments.create({
    person_id: 'p_cs',
    workspace_id: 'ws_1',
    role_id: 'dtc.aftersales',
    ranges: [{ kind: 'store', id: 'shop_a' }],
    granted_by: 'p_owner',
  })
  return { s, a }
}

describe('compilePolicies (31 §3.1)', () => {
  it('emits one row per (scope, op) with the full tuple', () => {
    const { s, a } = seeded()
    const rows = s.compilePolicies(a.id)
    expect(rows).toContainEqual([a.id, 'order', 'read', 'assigned', 'internal'])
    expect(rows).toContainEqual([a.id, 'customer', 'stage', 'assigned', 'internal'])
    expect(rows).toContainEqual([a.id, 'approval', 'approve', 'own', 'internal'])
    // 6 个 scope，其中 customer 和 approval 各两个 op
    expect(rows).toHaveLength(8)
    expect(rows.every((r) => r[0] === a.id)).toBe(true)
  })

  it('drops assigned-range rows when the assignment has no ranges', () => {
    const s = createRoleStore({ clock: fixedClock(), roles: [aftersales()] })
    const a = s.assignments.create({
      person_id: 'p_cs',
      workspace_id: 'ws_1',
      role_id: 'dtc.aftersales',
      granted_by: 'p_owner',
    })
    const rows = s.compilePolicies(a.id)
    expect(rows.some((r) => r[3] === 'assigned')).toBe(false)
    // workspace / own 范围的 scope 仍然编译出来
    expect(rows).toContainEqual([a.id, 'knowledge', 'read', 'workspace', 'internal'])
  })

  it('emits nothing for a revoked assignment', () => {
    const { s, a } = seeded()
    const revoked = s.assignments.revoke(a.id)
    expect(compilePolicies(revoked, aftersales())).toEqual([])
  })
})

describe('can (05 §1.1 完整元组)', () => {
  it('refuses the after-sales role on confidential product fields', () => {
    const { s, a } = seeded()
    expect(s.can(a.id, 'product', 'read', { range: 'assigned', sensitivity: 'confidential' })).toBe(
      false,
    )
    // 连 internal 的 product 也没有：域本身不在 scopes 里
    expect(s.can(a.id, 'product', 'read', { range: 'assigned', sensitivity: 'internal' })).toBe(
      false,
    )
    // 有 order 域，但 confidential 超出 max_sensitivity
    expect(s.can(a.id, 'order', 'read', { range: 'assigned', sensitivity: 'confidential' })).toBe(
      false,
    )
  })

  it('allows order read at internal in the assigned range', () => {
    const { s, a } = seeded()
    expect(s.can(a.id, 'order', 'read', { range: 'assigned', sensitivity: 'internal' })).toBe(true)
    expect(s.can(a.id, 'order', 'read', { range: 'own', sensitivity: 'public' })).toBe(true)
    // 授予 assigned 不覆盖 workspace
    expect(s.can(a.id, 'order', 'read', { range: 'workspace', sensitivity: 'internal' })).toBe(
      false,
    )
    // 操作维不满足即拒
    expect(s.can(a.id, 'order', 'stage', { range: 'assigned', sensitivity: 'internal' })).toBe(
      false,
    )
  })

  it('denies everything after revocation', () => {
    const { s, a } = seeded()
    expect(s.can(a.id, 'order', 'read', { range: 'assigned', sensitivity: 'internal' })).toBe(true)
    s.assignments.revoke(a.id, { handover_to: 'p_boss' })
    expect(s.can(a.id, 'order', 'read', { range: 'assigned', sensitivity: 'internal' })).toBe(false)
    expect(s.can(a.id, 'knowledge', 'read', { range: 'workspace', sensitivity: 'internal' })).toBe(
      false,
    )
    expect(s.assignments.get(a.id)?.handover_to).toBe('p_boss')
  })

  it('does not leak one assignment’s rows to another', () => {
    const { s, a } = seeded()
    const other = s.assignments.create({
      person_id: 'p_cs',
      workspace_id: 'ws_1',
      role_id: 'common.owner',
      granted_by: 'p_owner',
    })
    expect(
      s.can(other.id, 'policy', 'approve', { range: 'workspace', sensitivity: 'restricted' }),
    ).toBe(true)
    expect(
      s.can(a.id, 'policy', 'approve', { range: 'workspace', sensitivity: 'restricted' }),
    ).toBe(false)
    expect(s.can(other.id, 'order', 'read', { range: 'assigned', sensitivity: 'internal' })).toBe(
      false,
    )
  })

  it('returns false for an unknown assignment', () => {
    const { s } = seeded()
    expect(s.can('asg_nope', 'order', 'read', { range: 'own', sensitivity: 'public' })).toBe(false)
  })
})

describe('维度比较', () => {
  it('range covering is hierarchical', () => {
    expect(rangeCovers('workspace', 'own')).toBe(true)
    expect(rangeCovers('assigned', 'own')).toBe(true)
    expect(rangeCovers('own', 'assigned')).toBe(false)
    expect(rangeCovers('assigned', 'workspace')).toBe(false)
  })

  it('sensitivity is capped by the role', () => {
    expect(sensAtMost('internal', 'internal')).toBe(true)
    expect(sensAtMost('public', 'internal')).toBe(true)
    expect(sensAtMost('confidential', 'internal')).toBe(false)
    expect(sensAtMost('restricted', 'confidential')).toBe(false)
  })
})
