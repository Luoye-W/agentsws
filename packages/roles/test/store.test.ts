import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createRoleStore, loadBundledRole, RoleError } from '../src/index.js'
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
  it('没显式传 connected 时用 options.connected 提供的实时连接表算 ready', () => {
    let live: string[] = []
    const s = createRoleStore({ clock: fixedClock(), roles: roles(), connected: () => live })
    const a = s.assignments.create({
      person_id: 'p_cs',
      workspace_id: 'ws_1',
      role_id: 'dtc.support',
      granted_by: 'p_owner',
    })
    expect(s.effectiveConfig(a.id).ready).toBe(false)
    expect(s.effectiveConfig(a.id).missing_connectors).toEqual(['email', 'shopify'])
    live = ['email', 'shopify']
    expect(s.effectiveConfig(a.id).ready).toBe(true)
    expect(s.effectiveConfig(a.id).missing_connectors).toEqual([])
    // 显式传的优先
    expect(s.effectiveConfig(a.id, { connected: ['email'] }).missing_connectors).toEqual([
      'shopify',
    ])
  })

  it('lists assignments by person and by role, hiding revoked ones', () => {
    const s = createRoleStore({ clock: fixedClock(), roles: roles() })
    const cs = s.assignments.create({
      person_id: 'p_cs',
      workspace_id: 'ws_1',
      role_id: 'dtc.support',
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
      role_id: 'dtc.support',
      ranges: [{ kind: 'store', id: 'shop_b' }],
      granted_by: 'p_owner',
    })

    expect(s.assignments.listByPerson('p_cs')).toHaveLength(2)
    expect(s.assignments.listByRole('dtc.support')).toHaveLength(2)
    s.assignments.revoke(cs.id, { handover_to: 'p_boss' })
    expect(s.assignments.listByPerson('p_cs')).toHaveLength(1)
    expect(s.assignments.listByRole('dtc.support')).toHaveLength(1)
    expect(s.assignments.listByRole('dtc.support', { include_revoked: true })).toHaveLength(2)
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
        role_id: 'dtc.support',
        granted_by: 'p_owner',
        role_version: '1.0.0',
      }),
    ).toThrow(/cannot grant/)
    s.close()
  })

  it('applies a position through the store', () => {
    const s = createRoleStore({ clock: fixedClock(), roles: roles() })
    for (const id of [
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
    expect(created).toHaveLength(7)
    expect(s.assignments.listByPerson('p_ops')).toHaveLength(7)
    expect(s.roles.list()).toHaveLength(9)
    expect(s.roles.get('dtc.support')?.version).toBe('2.0.0')
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
      role_id: 'dtc.support',
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

// WP54（48 v2 L1）：职责改名 / 合并——旧 id 读得到，已有分配迁得动
describe('旧职责 id 的别名与迁移（WP54 / 48 v2 L1）', () => {
  it('用旧 id 建分配，落到新 id 上', () => {
    const s = createRoleStore({ clock: fixedClock(), roles: roles() })
    const a = s.assignments.create({
      person_id: 'p_cs',
      workspace_id: 'ws_1',
      role_id: 'dtc.aftersales',
      ranges: [{ kind: 'store', id: 'shop_a' }],
      granted_by: 'p_owner',
    })
    expect(a.role_id).toBe('dtc.support')
    expect(s.roles.get('dtc.presales')?.id).toBe('dtc.support')
    expect(s.roles.require('dtc.aftersales').id).toBe('dtc.support')
    s.close()
  })

  it('pack 自带的同名定义仍然优先于别名表', () => {
    const own = { ...stubRole('dtc.aftersales'), domain: 'dtc' as const }
    const s = createRoleStore({ clock: fixedClock(), roles: [...roles(), own] })
    expect(s.roles.get('dtc.aftersales')?.description).toBe('stub dtc.aftersales')
    s.close()
  })

  // WP62（51 §2）：`dtc.ops` → `dtc.store`
  it('老库里的 `dtc.ops` 分配迁到 `dtc.store`，范围与自动化状态一个字不动', () => {
    const dbPath = tempDb()
    const store = loadBundledRole('dtc.store')
    const s = createRoleStore({ clock: fixedClock(), dbPath, roles: [...roles(), store] })
    const live = s.assignments.create({
      person_id: 'p_ops',
      workspace_id: 'ws_1',
      role_id: 'dtc.store',
      ranges: [{ kind: 'store', id: 'shop_a' }],
      granted_by: 'p_owner',
    })
    s.close()

    // 伪造一条"改名前写下的"行（`create` 那一侧已经被别名归一过了）
    const require_ = createRequire(import.meta.url)
    const Database = require_('better-sqlite3') as new (
      path: string,
    ) => {
      prepare(sql: string): { run(...args: string[]): void }
      close(): void
    }
    const raw = new Database(dbPath)
    raw
      .prepare(
        'UPDATE assignments SET role_id = ?, doc = replace(doc, \'"dtc.store"\', \'"dtc.ops"\') WHERE id = ?',
      )
      .run('dtc.ops', live.id)
    raw.close()

    const reopened = createRoleStore({
      clock: fixedClock(),
      dbPath,
      roles: [...roles(), store],
    })
    const before = reopened.assignments.require(live.id)
    expect(before.role_id).toBe('dtc.ops')
    const migrated = reopened.assignments.migrateRoleIds()
    expect(migrated).toEqual([
      expect.objectContaining({ from: 'dtc.ops', to: 'dtc.store', person_id: 'p_ops' }),
    ])
    const after = reopened.assignments.require(live.id)
    expect(after.role_id).toBe('dtc.store')
    expect(after.ranges).toEqual(before.ranges)
    expect(after.automation_state).toEqual(before.automation_state)
    reopened.close()
  })

  it('迁移改 role_id 与 role_version，别的一个字不动；已撤销的不动；幂等', () => {
    const dbPath = tempDb()
    const s = createRoleStore({ clock: fixedClock(), dbPath, roles: roles() })
    // 造两条"老库里的"分配：直接写旧 id（建的时候会被别名归一，所以绕过 create）
    const live = s.assignments.create({
      person_id: 'p_cs',
      workspace_id: 'ws_1',
      role_id: 'dtc.support',
      ranges: [{ kind: 'store', id: 'shop_a' }],
      granted_by: 'p_owner',
    })
    const gone = s.assignments.create({
      person_id: 'p_chen',
      workspace_id: 'ws_1',
      role_id: 'dtc.support',
      granted_by: 'p_owner',
    })
    s.assignments.revoke(gone.id)
    s.close()

    // 伪造两条"改名前写下的"行：直接改库，因为 `create` 这一侧已经被别名归一过了
    const require_ = createRequire(import.meta.url)
    const Database = require_('better-sqlite3') as new (
      path: string,
    ) => {
      prepare(sql: string): { run(...args: string[]): void }
      close(): void
    }
    const raw = new Database(dbPath)
    for (const id of [live.id, gone.id]) {
      raw
        .prepare(
          'UPDATE assignments SET role_id = ?, doc = replace(replace(doc, \'"dtc.support"\', \'"dtc.aftersales"\'), \'"2.0.0"\', \'"1.0.0"\') WHERE id = ?',
        )
        .run('dtc.aftersales', id)
    }
    raw.close()

    const reopened = createRoleStore({ clock: fixedClock(), dbPath, roles: roles() })
    const before = reopened.assignments.require(live.id)
    const migrated = reopened.assignments.migrateRoleIds()
    expect(migrated).toHaveLength(1)
    expect(migrated[0]).toMatchObject({
      assignment_id: live.id,
      person_id: 'p_cs',
      from: 'dtc.aftersales',
      to: 'dtc.support',
      role_version: '2.0.0',
    })
    expect(before.role_id).toBe('dtc.aftersales')
    expect(before.role_version).toBe('1.0.0')
    expect(Object.keys(before.automation_state)).toContain('stage_refund')
    const after = reopened.assignments.require(live.id)
    expect(after.role_id).toBe('dtc.support')
    expect(after.role_version).toBe('2.0.0')
    // 范围、授予人、授予时间、自动化状态一个字没动
    expect(after.ranges).toEqual(before.ranges)
    expect(after.granted_at).toBe(before.granted_at)
    expect(after.automation_state).toEqual(before.automation_state)
    // 已撤销的那条不动（历史就是历史）
    expect(reopened.assignments.require(gone.id).role_id).toBe('dtc.aftersales')
    // 幂等：再跑一遍什么也不发生
    expect(reopened.assignments.migrateRoleIds()).toEqual([])
    reopened.close()
  })
})
