import type { PermissionScope } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  accessWhere,
  admittingGrants,
  CasbinGate,
  compilePolicies,
  DataError,
  decryptValue,
  ERASED,
  encryptValue,
  fieldCeiling,
  isEncryptedField,
  maxSensitivity,
  newSubjectKey,
  sensitivitiesUpTo,
  sensitivityLte,
  sensitivityRank,
} from '../src/index.js'
import { actor, SHOP_EU, SHOP_US, stepClock } from './fixtures.js'

const read = (over: Partial<PermissionScope> = {}): PermissionScope => ({
  domain: 'order',
  ops: ['read'],
  range: 'assigned',
  max_sensitivity: 'internal',
  ...over,
})

describe('sensitivity lattice', () => {
  it('orders public < internal < confidential < restricted', () => {
    expect(sensitivityRank('public')).toBe(0)
    expect(sensitivityLte('internal', 'confidential')).toBe(true)
    expect(sensitivityLte('restricted', 'confidential')).toBe(false)
    expect(sensitivitiesUpTo('confidential')).toEqual(['public', 'internal', 'confidential'])
    expect(maxSensitivity(['public', 'restricted', 'internal'])).toBe('restricted')
    expect(maxSensitivity([])).toBeUndefined()
    // biome-ignore lint/suspicious/noExplicitAny: 运行时校验用例
    expect(() => sensitivityRank('nope' as any)).toThrow(RangeError)
  })
})

// 21 §3 / §6.5：过滤下推到 SQL —— 这里直接断言生成的 WHERE 片段与参数
describe('SQL push-down (21 §3)', () => {
  const a = actor({ grants: [read()], ranges: [SHOP_US, SHOP_EU] })

  it('assigned grants compile to a correlated json_each scope match plus a sensitivity IN list', () => {
    const w = accessWhere('order', a, 'order', ['read'])
    expect(w).toBeDefined()
    expect(w?.sql).toContain('json_each("order".scope)')
    expect(w?.sql).toContain('"order".sensitivity IN (?, ?)')
    expect(w?.params).toEqual(['store:shop_us', 'store:shop_eu', 'public', 'internal'])
  })

  it('own grants compile to an owners[] membership test', () => {
    const own = actor({ person_id: 'p_bob', grants: [read({ range: 'own' })], ranges: [] })
    const w = accessWhere('order', own, 'order', ['read'])
    expect(w?.sql).toContain('json_each("order".owners)')
    expect(w?.params[0]).toBe('p_bob')
  })

  it('workspace grants drop the range predicate but keep the sensitivity ceiling', () => {
    const ws = actor({ grants: [read({ range: 'workspace' })], ranges: [] })
    const w = accessWhere('order', ws, 'order', ['read'])
    expect(w?.sql).toContain('1 = 1')
    expect(w?.params).toEqual(['public', 'internal'])
  })

  it('several grants OR whole tuples together — never a per-dimension union', () => {
    const two = actor({
      grants: [
        read({ range: 'own', max_sensitivity: 'restricted' }),
        read({ range: 'assigned', max_sensitivity: 'internal' }),
      ],
      ranges: [SHOP_US],
    })
    const w = accessWhere('order', two, 'order', ['read'])
    expect(w?.sql.split(' OR ')).toHaveLength(2)
    // own 那条给 restricted，但只对自己拥有的记录；assigned 那条只给 internal
    const foreignConfidential = {
      owners: ['p_zoe'],
      scope: [SHOP_US],
      sensitivity: 'confidential' as const,
    }
    expect(admittingGrants(two, 'order', ['read'], foreignConfidential)).toHaveLength(0)
    expect(fieldCeiling(two, 'order', ['read'], foreignConfidential)).toBeUndefined()
    const ownConfidential = { ...foreignConfidential, owners: ['p_amy'] }
    expect(fieldCeiling(two, 'order', ['read'], ownConfidential)).toBe('restricted')
  })

  it('an assigned grant with no ranges produces no clause at all', () => {
    const none = actor({ grants: [read()], ranges: [] })
    expect(accessWhere('order', none, 'order', ['read'])).toBeUndefined()
    expect(
      admittingGrants(none, 'order', ['read'], {
        owners: [],
        scope: [SHOP_US],
        sensitivity: 'internal',
      }),
    ).toHaveLength(0)
  })

  it('a domain or op mismatch produces no clause', () => {
    const a2 = actor({ grants: [read()], ranges: [SHOP_US] })
    expect(accessWhere('product', a2, 'product', ['read'])).toBeUndefined()
    expect(accessWhere('order', a2, 'order', ['stage', 'agent_auto'])).toBeUndefined()
  })
})

describe('casbin second gate (21 §3)', () => {
  it('compiles one policy per (assignment, domain, op) and dedupes', () => {
    const rules = compilePolicies('as_1', [
      read({ ops: ['read', 'stage'] }),
      read({ ops: ['read'], range: 'workspace' }),
      read({ domain: 'customer', ops: ['read'] }),
    ])
    expect(rules).toEqual([
      ['as_1', 'order', 'read'],
      ['as_1', 'order', 'stage'],
      ['as_1', 'customer', 'read'],
    ])
  })

  it('allows only the compiled domain × op pairs', async () => {
    const gate = new CasbinGate()
    const a = actor({ assignment_id: 'as_1', grants: [read({ ops: ['read'] })], ranges: [SHOP_US] })
    expect(await gate.allows(a, 'order', ['read'])).toBe(true)
    expect(await gate.allows(a, 'order', ['stage', 'agent_auto'])).toBe(false)
    expect(await gate.allows(a, 'product', ['read'])).toBe(false)
    // 缓存命中走同一个 enforcer
    expect(await gate.enforcerFor(a)).toBe(await gate.enforcerFor(a))
  })

  it('an actor with no grants gets an empty policy set', async () => {
    const gate = new CasbinGate()
    const a = actor({ grants: [], ranges: [] })
    expect(compilePolicies('as_x', [])).toEqual([])
    expect(await gate.allows(a, 'order', ['read'])).toBe(false)
  })
})

describe('subject-key crypto (21 §4)', () => {
  it('round-trips a value and is recognisable at rest', () => {
    const key = newSubjectKey()
    expect(key).toHaveLength(32)
    const enc = encryptValue(key, 'customer:c1', { phone: '+1' })
    expect(isEncryptedField(enc)).toBe(true)
    expect(JSON.stringify(enc)).not.toContain('+1')
    expect(decryptValue(key, enc)).toEqual({ phone: '+1' })
  })

  it('every subject gets an independent key that cannot decrypt another subject', () => {
    const a = newSubjectKey()
    const b = newSubjectKey()
    expect(a.equals(b)).toBe(false)
    const enc = encryptValue(a, 'customer:c1', 'secret')
    expect(() => decryptValue(b, enc)).toThrow()
  })

  it('rejects non-encrypted shapes', () => {
    expect(isEncryptedField(null)).toBe(false)
    expect(isEncryptedField({ __enc: 'aes-256-gcm' })).toBe(false)
    expect(isEncryptedField('x')).toBe(false)
    expect(ERASED).toBe('[erased]')
  })
})

describe('subject keyring (21 §4)', () => {
  it('issues one key per subject, destroys it once and never re-issues', async () => {
    const { default: Database } = await import('better-sqlite3')
    const { SubjectKeyring } = await import('../src/index.js')
    const db = new Database(':memory:')
    const ring = new SubjectKeyring(db, stepClock())
    const k1 = ring.ensure('customer:c1')
    expect(ring.ensure('customer:c1').equals(k1)).toBe(true)
    expect(ring.get('customer:c1')?.equals(k1)).toBe(true)
    expect(ring.isDestroyed('customer:c1')).toBe(false)
    expect(ring.get('customer:c2')).toBeUndefined()

    const at = ring.destroy('customer:c1')
    expect(ring.isDestroyed('customer:c1')).toBe(true)
    expect(ring.get('customer:c1')).toBeUndefined()
    expect(ring.destroy('customer:c1')).toBe(at)
    expect(() => ring.ensure('customer:c1')).toThrow(DataError)

    // 从未发过钥的主体也能记销毁（墓碑先到、备份后到）
    ring.destroy('customer:c9', '2026-01-01T00:00:00.000Z')
    expect(ring.isDestroyed('customer:c9')).toBe(true)
    expect(() => ring.ensure('customer:c9')).toThrow(DataError)
    db.close()
  })
})
