import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createRoleStore, RoleError } from '../src/index.js'
import { aftersales, dtcOps, fixedClock, member, owner, stubRole } from './helpers.js'

const dirs: string[] = []
function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'agentsws-roles-'))
  dirs.push(dir)
  return join(dir, 'roles.db')
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const roles = () => [aftersales(), member(), owner()]

describe('createRoleStore 内存后端', () => {
  it('lists assignments by person and by role, hiding revoked ones', () => {
    const s = createRoleStore({ clock: fixedClock(), roles: roles() })
    const cs = s.assignments.create({
      person_id: 'p_cs',
      workspace_id: 'ws_1',
      role_id: 'dtc.aftersales',
      ranges: [{ kind: 'store', id: 'shop_a' }],
      granted_by: 'p_owner',
    })
    s.assignments.create({
      person_id: 'p_cs',
      workspace_id: 'ws_1',
      role_id: 'common.member',
      granted_by: 'p_owner',
    })
    s.assignments.create({
      person_id: 'p_boss',
      workspace_id: 'ws_1',
      role_id: 'dtc.aftersales',
      ranges: [{ kind: 'store', id: 'shop_b' }],
      granted_by: 'p_owner',
    })

    expect(s.assignments.listByPerson('p_cs')).toHaveLength(2)
    expect(s.assignments.listByRole('dtc.aftersales')).toHaveLength(2)
    s.assignments.revoke(cs.id, { handover_to: 'p_boss' })
    expect(s.assignments.listByPerson('p_cs')).toHaveLength(1)
    expect(s.assignments.listByRole('dtc.aftersales')).toHaveLength(1)
    expect(s.assignments.listByRole('dtc.aftersales', { include_revoked: true })).toHaveLength(2)
    expect(s.assignments.get(cs.id)?.revoked_at).toBe('2026-09-09T00:00:00.000Z')
    s.close()
  })

  it('refuses double revocation and unknown ids', () => {
    const s = createRoleStore({ clock: fixedClock(), roles: roles() })
    const a = s.assignments.create({
      person_id: 'p_cs',
      workspace_id: 'ws_1',
      role_id: 'common.member',
      granted_by: 'p_owner',
    })
    s.assignments.revoke(a.id)
    expect(() => s.assignments.revoke(a.id)).toThrow(/already revoked/)
    expect(() => s.assignments.require('asg_nope')).toThrow(RoleError)
    expect(() =>
      s.assignments.create({
        person_id: 'p_cs',
        workspace_id: 'ws_1',
        role_id: 'dtc.catalog',
        granted_by: 'p_owner',
      }),
    ).toThrow(/is not loaded/)
    s.close()
  })

  it('refuses to grant a role version other than the loaded one (05 §3)', () => {
    const s = createRoleStore({ clock: fixedClock(), roles: roles() })
    expect(() =>
      s.assignments.create({
        person_id: 'p_cs',
        workspace_id: 'ws_1',
        role_id: 'dtc.aftersales',
        granted_by: 'p_owner',
        role_version: '2.0.0',
      }),
    ).toThrow(/cannot grant/)
    s.close()
  })

  it('applies a position through the store', () => {
    const s = createRoleStore({ clock: fixedClock(), roles: roles() })
    for (const id of [
      'dtc.presales',
      'dtc.store-config',
      'dtc.catalog',
      'dtc.content',
      'dtc.promotions',
      'dtc.analytics',
      'dtc.email-marketing',
    ])
      s.roles.register(stubRole(id))
    const created = s.assignments.applyPosition(dtcOps(), 'p_ops', 'ws_1', [], {
      granted_by: 'p_owner',
    })
    expect(created).toHaveLength(8)
    expect(s.assignments.listByPerson('p_ops')).toHaveLength(8)
    expect(s.roles.list()).toHaveLength(10)
    expect(s.roles.get('dtc.aftersales')?.version).toBe('1.0.0')
    s.close()
  })

  it('stores and reads workspace policies', () => {
    const s = createRoleStore({ clock: fixedClock(), roles: roles() })
    expect(s.policies.get('ws_1')).toBeUndefined()
    s.policies.set({
      workspace_id: 'ws_1',
      mandates: { stage_refund: { caps: { max_auto_refund_amount: 80 } } },
      global_caps: { max_daily_spend_total: 300 },
      separation_of_duties: ['stage_refund'],
    })
    expect(s.policies.get('ws_1')?.global_caps.max_daily_spend_total).toBe(300)
    s.close()
  })
})

describe('createRoleStore SQLite 后端', () => {
  it('round-trips assignments and policies across store instances', () => {
    const dbPath = tempDb()
    const first = createRoleStore({ clock: fixedClock(), dbPath, roles: roles() })
    const a = first.assignments.create({
      person_id: 'p_cs',
      workspace_id: 'ws_1',
      role_id: 'dtc.aftersales',
      ranges: [{ kind: 'store', id: 'shop_a' }],
      granted_by: 'p_owner',
    })
    first.policies.set({
      workspace_id: 'ws_1',
      mandates: { stage_refund: { caps: { max_auto_refund_amount: 80 } } },
      global_caps: {},
    })
    first.recordDecision(a.id, 'reply_customer', 'accepted')
    first.close()

    const second = createRoleStore({ clock: fixedClock(), dbPath, roles: roles() })
    const reloaded = second.assignments.require(a.id)
    expect(reloaded.ranges).toEqual([{ kind: 'store', id: 'shop_a' }])
    expect(reloaded.automation_state.reply_customer?.adoption.accepted).toBe(1)
    // 策略行在新进程里按需重建
    expect(second.can(a.id, 'order', 'read', { range: 'assigned', sensitivity: 'internal' })).toBe(
      true,
    )
    expect(
      second
        .effectiveConfig(a.id, { connected: ['email', 'shopify'] })
        .actions.find((x) => x.id === 'stage_refund')?.mandate.caps.max_auto_refund_amount,
    ).toBe(80)
    second.assignments.revoke(a.id)
    expect(second.can(a.id, 'order', 'read', { range: 'assigned', sensitivity: 'internal' })).toBe(
      false,
    )
    expect(second.assignments.listByPerson('p_cs')).toHaveLength(0)
    second.close()
  })

  it('mints distinct ids without a random source', () => {
    const dbPath = tempDb()
    const s = createRoleStore({ clock: fixedClock(), dbPath, roles: roles() })
    const ids = new Set<string>()
    for (let i = 0; i < 5; i += 1)
      ids.add(
        s.assignments.create({
          person_id: 'p_cs',
          workspace_id: 'ws_1',
          role_id: 'common.member',
          granted_by: 'p_owner',
        }).id,
      )
    expect(ids.size).toBe(5)
    expect([...ids].every((id) => id.startsWith('asg_'))).toBe(true)
    s.close()
  })
})
