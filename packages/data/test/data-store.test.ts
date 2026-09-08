import type { PermissionScope } from '@agentsws/contracts'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  createDataStore,
  type DataActor,
  DataError,
  defineCollection,
  type PrivacyErasedEvent,
  type SqliteDataStore,
} from '../src/index.js'
import {
  AFTERSALES_SCOPES,
  ALL_COLLECTIONS,
  actor,
  customer,
  order,
  product,
  SHOP_EU,
  SHOP_US,
  stepClock,
} from './fixtures.js'

const ALL_DOMAINS_RESTRICTED: PermissionScope[] = [
  { domain: 'product', ops: ['read', 'stage'], range: 'workspace', max_sensitivity: 'restricted' },
  { domain: 'order', ops: ['read', 'stage'], range: 'workspace', max_sensitivity: 'restricted' },
  { domain: 'customer', ops: ['read', 'stage'], range: 'workspace', max_sensitivity: 'restricted' },
]

/** 播种用：工作区范围、restricted 密级的 owner。 */
const owner = actor({
  person_id: 'p_owner',
  assignment_id: 'as_owner',
  grants: ALL_DOMAINS_RESTRICTED,
  ranges: [SHOP_US, SHOP_EU],
})

const aftersales = actor({
  person_id: 'p_amy',
  assignment_id: 'as_aftersales',
  grants: AFTERSALES_SCOPES,
  ranges: [SHOP_US],
})

function newStore(): SqliteDataStore {
  return createDataStore({ dbPath: ':memory:', clock: stepClock(), collections: ALL_COLLECTIONS })
}

async function code(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn()
  } catch (e) {
    expect(e).toBeInstanceOf(DataError)
    return (e as DataError).code
  }
  throw new Error('expected a DataError')
}

let store: SqliteDataStore

beforeEach(() => {
  store = newStore()
})

// ── 21 §6 用例 1（本包份额）：无 workspace_id 的记录写入被拒 ────────────────
describe('envelope invariants (21 §6.3)', () => {
  it('rejects a record without workspace_id', async () => {
    expect(
      await code(() =>
        store.put(
          'product',
          {
            id: 'pr_1',
            schema_version: 1,
            workspace_id: '',
            owners: ['p_owner'],
            scope: [SHOP_US],
            sensitivity: 'internal',
          },
          owner,
        ),
      ),
    ).toBe('invalid_input')
    expect(
      await code(() =>
        store.put(
          'product',
          // biome-ignore lint/suspicious/noExplicitAny: 故意绕过类型检查，验证运行时校验
          { id: 'pr_2', schema_version: 1, owners: [], scope: [], sensitivity: 'internal' } as any,
          owner,
        ),
      ),
    ).toBe('invalid_input')
  })

  it('rejects an id-less record, a foreign workspace and a bad sensitivity', async () => {
    const base = {
      schema_version: 1,
      workspace_id: 'ws_1',
      owners: ['p_owner'],
      scope: [SHOP_US],
      sensitivity: 'internal' as const,
    }
    expect(await code(() => store.put('product', { ...base, id: '' }, owner))).toBe('invalid_input')
    expect(
      await code(() => store.put('product', { ...base, id: 'pr_x', workspace_id: 'ws_2' }, owner)),
    ).toBe('forbidden')
    expect(
      await code(() =>
        // biome-ignore lint/suspicious/noExplicitAny: 运行时校验用例
        store.put('product', { ...base, id: 'pr_y', sensitivity: 'top' as any }, owner),
      ),
    ).toBe('invalid_input')
    expect(await code(() => store.put('nope', { ...base, id: 'pr_z' }, owner))).toBe(
      'invalid_input',
    )
  })

  it('the data layer owns no event table: UPDATE/DELETE of events is kernel scope', () => {
    expect(
      store
        .collections()
        .map((c) => c.name)
        .sort(),
    ).toEqual(['customer', 'order', 'product'])
  })
})

// ── 21 §6 用例 2：写入旧版 schema 的记录被拒 ──────────────────────────────
describe('schema versioning (21 §6.2)', () => {
  it('rejects a write carrying a schema_version older than the collection', async () => {
    const v2 = defineCollection({
      name: 'thread',
      domain: 'content',
      schema_version: 2,
      fields: { subject: { sensitivity: 'internal' } },
    })
    store.register(v2)
    const rec = {
      id: 'th_1',
      workspace_id: 'ws_1',
      owners: ['p_owner'],
      scope: [SHOP_US],
      sensitivity: 'internal' as const,
      subject: 'hi',
    }
    const grants: PermissionScope[] = [
      {
        domain: 'content',
        ops: ['read', 'stage'],
        range: 'workspace',
        max_sensitivity: 'internal',
      },
    ]
    const a = actor({ person_id: 'p_owner', assignment_id: 'as_c', grants })
    expect(await code(() => store.put('thread', { ...rec, schema_version: 1 }, a))).toBe(
      'invalid_input',
    )
    expect(await code(() => store.put('thread', { ...rec, schema_version: 3 }, a))).toBe(
      'invalid_input',
    )
    const ok = await store.put('thread', { ...rec, schema_version: 2 }, a)
    expect(ok.schema_version).toBe(2)
  })

  it('defineCollection validates names, versions and envelope collisions', () => {
    expect(() => defineCollection({ name: 'Bad Name', domain: 'order', fields: {} })).toThrow(
      DataError,
    )
    expect(() =>
      defineCollection({ name: 'ok', domain: 'order', schema_version: 0, fields: {} }),
    ).toThrow(DataError)
    expect(() =>
      defineCollection({
        name: 'ok',
        domain: 'order',
        fields: { version: { sensitivity: 'internal' } },
      }),
    ).toThrow(DataError)
    expect(() =>
      defineCollection({
        name: 'ok',
        domain: 'order',
        fields: { 'no-dash': { sensitivity: 'internal' } },
      }),
    ).toThrow(DataError)
  })
})

// ── 21 §6 用例 6：乐观锁并发第二个 conflict ───────────────────────────────
describe('optimistic locking (21 §6.6)', () => {
  const base = {
    id: 'or_1',
    schema_version: 1,
    workspace_id: 'ws_1',
    owners: ['p_owner'],
    scope: [SHOP_US],
    sensitivity: 'internal' as const,
  }

  it('the second concurrent writer on the same version conflicts', async () => {
    const created = await store.put('order', { ...base, total: 10 }, owner)
    expect(created.version).toBe('1')
    const first = await store.put('order', { ...base, total: 20, version: '1' }, owner)
    expect(first.version).toBe('2')
    expect(await code(() => store.put('order', { ...base, total: 30, version: '1' }, owner))).toBe(
      'conflict',
    )
    const read = await store.get<{ total: number }>('order', 'or_1', owner)
    expect(read?.total).toBe(20)
  })

  it('requires a version on update and rejects a version for a missing record', async () => {
    await store.put('order', { ...base, total: 10 }, owner)
    expect(await code(() => store.put('order', { ...base, total: 11 }, owner))).toBe('conflict')
    expect(
      await code(() => store.put('order', { ...base, id: 'or_gone', version: '1' }, owner)),
    ).toBe('conflict')
  })

  it('created_at is stable, updated_at moves, both come from the injected clock', async () => {
    const a = await store.put('order', { ...base, total: 1 }, owner)
    const b = await store.put('order', { ...base, total: 2, version: a.version }, owner)
    expect(b.created_at).toBe(a.created_at)
    expect(b.updated_at > a.updated_at).toBe(true)
    expect(a.created_at.startsWith('2026-09-09T')).toBe(true)
  })
})

// ── 21 §6 用例 5：售后客服查询 Product 不返回 cost_price ───────────────────
describe('field-level sensitivity (21 §6.5)', () => {
  beforeEach(async () => {
    await store.put(
      'product',
      {
        id: 'pr_1',
        schema_version: 1,
        workspace_id: 'ws_1',
        owners: ['p_owner'],
        scope: [SHOP_US],
        sensitivity: 'internal',
        sku: 'SKU-1',
        title: 'Mug',
        cost_price: 3.5,
        supplier_quote: 'ACME 3.10',
      },
      owner,
    )
  })

  it('after-sales has no product scope at all → empty, not an error', async () => {
    const res = await store.query('product', {}, aftersales)
    expect(res.items).toEqual([])
    expect(await store.get('product', 'pr_1', aftersales)).toBeUndefined()
  })

  it('with a product read/internal grant the record comes back without cost_price', async () => {
    const support = actor({
      person_id: 'p_amy',
      assignment_id: 'as_aftersales',
      grants: [
        ...AFTERSALES_SCOPES,
        { domain: 'product', ops: ['read'], range: 'assigned', max_sensitivity: 'internal' },
      ],
    })
    const res = await store.query<{ title: string }>('product', {}, support)
    expect(res.items).toHaveLength(1)
    const item = res.items[0] as Record<string, unknown>
    expect(item.sku).toBe('SKU-1')
    expect(item.title).toBe('Mug')
    expect(item).not.toHaveProperty('cost_price')
    expect(item).not.toHaveProperty('supplier_quote')
    expect(JSON.stringify(res.items)).not.toContain('cost_price')

    const got = (await store.get('product', 'pr_1', support)) as Record<string, unknown>
    expect(got).not.toHaveProperty('cost_price')
  })

  it('the owner (confidential+) still sees cost_price', async () => {
    const got = (await store.get('product', 'pr_1', owner)) as Record<string, unknown>
    expect(got.cost_price).toBe(3.5)
  })

  it('a filter on a field above max_sensitivity is refused, not silently answered', async () => {
    const support = actor({
      person_id: 'p_amy',
      assignment_id: 'as_aftersales',
      grants: [
        { domain: 'product', ops: ['read'], range: 'assigned', max_sensitivity: 'internal' },
      ],
    })
    expect(await code(() => store.query('product', { cost_price: 3.5 }, support))).toBe('forbidden')
    expect((await store.query('product', { sku: 'SKU-1' }, support)).items).toHaveLength(1)
    expect((await store.query('product', { sku: 'nope' }, support)).items).toHaveLength(0)
    expect(await code(() => store.query('product', { owners: [] }, support))).toBe('invalid_input')
    expect(await code(() => store.query('product', { 'a-b': 1 }, support))).toBe('invalid_input')
  })

  it('writing a field above the write grant is forbidden', async () => {
    const merch = actor({
      person_id: 'p_mia',
      assignment_id: 'as_merch',
      grants: [
        {
          domain: 'product',
          ops: ['read', 'stage'],
          range: 'assigned',
          max_sensitivity: 'internal',
        },
      ],
    })
    const base = {
      id: 'pr_2',
      schema_version: 1,
      workspace_id: 'ws_1',
      owners: ['p_mia'],
      scope: [SHOP_US],
      sensitivity: 'internal' as const,
    }
    expect(await code(() => store.put('product', { ...base, cost_price: 1 }, merch))).toBe(
      'forbidden',
    )
    const ok = await store.put('product', { ...base, title: 'Cup' }, merch)
    expect(ok.id).toBe('pr_2')
    // 记录本身的密级也受 max_sensitivity 约束
    expect(
      await code(() =>
        store.put('product', { ...base, id: 'pr_3', sensitivity: 'confidential' }, merch),
      ),
    ).toBe('forbidden')
  })
})

// ── 31 §3.1：空 range 的 Assignment 查询返回空；range=workspace 全部 ────────
describe('range dimension (31 §3.1)', () => {
  beforeEach(async () => {
    for (const [id, range] of [
      ['or_us', SHOP_US],
      ['or_eu', SHOP_EU],
    ] as const) {
      await store.put(
        'order',
        {
          id,
          schema_version: 1,
          workspace_id: 'ws_1',
          owners: ['p_bob'],
          scope: [range],
          sensitivity: 'internal',
          total: 1,
        },
        owner,
      )
    }
  })

  it('an assigned grant with empty ranges yields nothing (no error)', async () => {
    const unassigned = actor({
      grants: [{ domain: 'order', ops: ['read'], range: 'assigned', max_sensitivity: 'internal' }],
      ranges: [],
    })
    expect((await store.query('order', {}, unassigned)).items).toEqual([])
    expect(await store.get('order', 'or_us', unassigned)).toBeUndefined()
  })

  it('an assigned grant returns only the assigned ranges', async () => {
    const us = actor({
      grants: [{ domain: 'order', ops: ['read'], range: 'assigned', max_sensitivity: 'internal' }],
      ranges: [SHOP_US],
    })
    const res = await store.query('order', {}, us)
    expect(res.items.map((i) => i.id)).toEqual(['or_us'])
  })

  it('a workspace grant returns everything in the workspace', async () => {
    const all = actor({
      grants: [{ domain: 'order', ops: ['read'], range: 'workspace', max_sensitivity: 'internal' }],
      ranges: [],
    })
    expect((await store.query('order', {}, all)).items.map((i) => i.id).sort()).toEqual([
      'or_eu',
      'or_us',
    ])
  })

  it('an own grant matches the owners[] list only', async () => {
    const mine = actor({
      person_id: 'p_bob',
      grants: [{ domain: 'order', ops: ['read'], range: 'own', max_sensitivity: 'internal' }],
      ranges: [],
    })
    expect((await store.query('order', {}, mine)).items).toHaveLength(2)
    const other = actor({
      person_id: 'p_zoe',
      grants: [{ domain: 'order', ops: ['read'], range: 'own', max_sensitivity: 'internal' }],
      ranges: [],
    })
    expect((await store.query('order', {}, other)).items).toEqual([])
  })

  it('a grant for another domain or another op never leaks across', async () => {
    const wrongDomain = actor({
      grants: [
        { domain: 'product', ops: ['read'], range: 'workspace', max_sensitivity: 'restricted' },
      ],
      ranges: [],
    })
    expect((await store.query('order', {}, wrongDomain)).items).toEqual([])
    const wrongOp = actor({
      grants: [
        { domain: 'order', ops: ['stage'], range: 'workspace', max_sensitivity: 'internal' },
      ],
      ranges: [],
    })
    expect((await store.query('order', {}, wrongOp)).items).toEqual([])
    expect(
      await code(() =>
        store.put(
          'order',
          {
            id: 'or_new',
            schema_version: 1,
            workspace_id: 'ws_1',
            owners: [],
            scope: [],
            sensitivity: 'internal',
          },
          wrongDomain,
        ),
      ),
    ).toBe('forbidden')
  })

  it('a record above the grant max_sensitivity is filtered out in SQL', async () => {
    await store.put(
      'order',
      {
        id: 'or_secret',
        schema_version: 1,
        workspace_id: 'ws_1',
        owners: ['p_owner'],
        scope: [SHOP_US],
        sensitivity: 'confidential',
        total: 9,
      },
      owner,
    )
    const internalOnly = actor({
      grants: [{ domain: 'order', ops: ['read'], range: 'workspace', max_sensitivity: 'internal' }],
      ranges: [],
    })
    expect((await store.query('order', {}, internalOnly)).items.map((i) => i.id).sort()).toEqual([
      'or_eu',
      'or_us',
    ])
    expect((await store.query('order', {}, owner)).items).toHaveLength(3)
  })

  it('paginates by cursor', async () => {
    const page1 = await store.query('order', {}, owner, { limit: 1 })
    expect(page1.items).toHaveLength(1)
    expect(page1.cursor).toBe('or_eu')
    const page2 = await store.query('order', {}, owner, { limit: 1, cursor: page1.cursor })
    expect(page2.items.map((i) => i.id)).toEqual(['or_us'])
    const page3 = await store.query('order', {}, owner, { limit: 1, cursor: page2.cursor })
    expect(page3.items).toEqual([])
    expect(page3.cursor).toBeUndefined()
  })
})

// ── 21 §4 / §6 用例 4：erase = 销毁密钥 + 墓碑 ─────────────────────────────
describe('erase and forget (21 §4)', () => {
  const rec = {
    id: 'cu_1',
    schema_version: 1,
    workspace_id: 'ws_1',
    owners: ['p_owner'],
    scope: [SHOP_US],
    sensitivity: 'internal' as const,
    display_name: 'Alice',
    tier: 'vip',
    phone: '+1-555-0100',
    email: 'alice@example.com',
  }

  async function seed(s: SqliteDataStore): Promise<void> {
    await s.put('customer', rec, owner)
  }

  it('stores personal fields encrypted at rest', async () => {
    await seed(store)
    const read = (await store.get('customer', 'cu_1', owner)) as Record<string, unknown>
    expect(read.phone).toBe('+1-555-0100')
    expect(read.email).toBe('alice@example.com')
    expect(read.display_name).toBe('Alice')
  })

  it('after erase the PII is unreadable, the non-PII still reads, the record still exists', async () => {
    await seed(store)
    const event = await store.eraseSubject({ collection: 'customer', id: 'cu_1' }, owner)
    expect(event.type).toBe('privacy.erased')
    expect(event.payload.erased_fields.sort()).toEqual(['email', 'phone'])
    expect(event.payload.key_id).toBe('customer:cu_1')
    expect(event.subject).toEqual({ type: 'customer', id: 'cu_1' })

    const read = (await store.get('customer', 'cu_1', owner)) as Record<string, unknown>
    expect(read).toBeDefined()
    expect(read.phone).toBe('[erased]')
    expect(read.email).toBe('[erased]')
    expect(read.display_name).toBe('Alice')
    expect(read.tier).toBe('vip')
    expect(read.version).toBe('1')
  })

  it('a destroyed subject key is never re-issued', async () => {
    await seed(store)
    await store.erase({ collection: 'customer', id: 'cu_1' }, owner)
    expect(
      await code(() =>
        store.put('customer', { ...rec, version: '1', phone: '+1-555-0199' }, owner),
      ),
    ).toBe('forbidden')
  })

  it('erase needs a write grant on the record and an existing record', async () => {
    await seed(store)
    expect(
      await code(() => store.eraseSubject({ collection: 'customer', id: 'nope' }, owner)),
    ).toBe('not_found')
    const readOnly = actor({
      grants: [
        { domain: 'customer', ops: ['read'], range: 'workspace', max_sensitivity: 'restricted' },
      ],
      ranges: [],
    })
    expect(
      await code(() => store.eraseSubject({ collection: 'customer', id: 'cu_1' }, readOnly)),
    ).toBe('forbidden')
  })

  it('tombstones replay onto a restored backup', async () => {
    await seed(store)
    const event = await store.eraseSubject({ collection: 'customer', id: 'cu_1' }, owner)
    expect(store.tombstones()).toEqual([event])

    // 「备份恢复」：一个还带着主体密钥、PII 仍可读的库
    const restored = newStore()
    await seed(restored)
    const before = (await restored.get('customer', 'cu_1', owner)) as Record<string, unknown>
    expect(before.phone).toBe('+1-555-0100')

    expect(await restored.replayTombstones([event])).toEqual({ applied: 1, skipped: 0 })
    const after = (await restored.get('customer', 'cu_1', owner)) as Record<string, unknown>
    expect(after.phone).toBe('[erased]')
    expect(after.display_name).toBe('Alice')
    expect(restored.tombstones().map((t) => t.payload.key_id)).toEqual(['customer:cu_1'])

    // 幂等重放
    expect(await restored.replayTombstones([event])).toEqual({ applied: 0, skipped: 1 })
    expect(restored.tombstones()).toHaveLength(1)
    restored.close()
  })

  it('replay works even when the erased record was never restored', async () => {
    const fresh = newStore()
    const event: PrivacyErasedEvent = {
      schema_version: 1,
      workspace_id: 'ws_1',
      type: 'privacy.erased',
      at: '2026-09-09T00:00:00.000Z',
      actor: { kind: 'system', id: 'restore' },
      subject: { type: 'customer', id: 'cu_9' },
      correlation: { trace_id: 't1' },
      payload: {
        subject: { collection: 'customer', id: 'cu_9' },
        key_id: 'customer:cu_9',
        destroyed_at: '2026-09-09T00:00:00.000Z',
        erased_fields: ['phone'],
      },
    }
    expect(await fresh.replayTombstones([event])).toEqual({ applied: 1, skipped: 0 })
    fresh.close()
  })
})

describe('collection registration', () => {
  it('re-registering the same definition is a no-op, a different one is refused', () => {
    store.register(product)
    expect(() =>
      store.register(defineCollection({ name: 'product', domain: 'product', fields: {} })),
    ).toThrow(DataError)
  })

  it('records keep their source envelope field', async () => {
    const rec = await store.put(
      'order',
      {
        id: 'or_src',
        schema_version: 1,
        workspace_id: 'ws_1',
        owners: [],
        scope: [SHOP_US],
        sensitivity: 'internal',
        source: { connector: 'shopify', external_id: '1234' },
      },
      owner,
    )
    expect(rec.source).toEqual({ connector: 'shopify', external_id: '1234' })
    const read = await store.get('order', 'or_src', owner)
    expect(read?.source).toEqual({ connector: 'shopify', external_id: '1234' })
  })

  it('rejects malformed owners / scope', async () => {
    const base = {
      id: 'or_bad',
      schema_version: 1,
      workspace_id: 'ws_1',
      sensitivity: 'internal' as const,
      scope: [],
    }
    // biome-ignore lint/suspicious/noExplicitAny: 运行时校验用例
    expect(await code(() => store.put('order', { ...base, owners: [1] as any }, owner))).toBe(
      'invalid_input',
    )
    expect(
      await code(() =>
        store.put(
          'order',
          // biome-ignore lint/suspicious/noExplicitAny: 运行时校验用例
          { ...base, owners: [], scope: [{ k: 1 }] as any },
          owner,
        ),
      ),
    ).toBe('invalid_input')
  })
})

describe('exported types', () => {
  it('the store satisfies the DataStore contract shape', () => {
    const s: Pick<SqliteDataStore, 'get' | 'query' | 'put' | 'erase'> = store
    expect(typeof s.get).toBe('function')
    expect(typeof s.query).toBe('function')
    expect(typeof s.put).toBe('function')
    expect(typeof s.erase).toBe('function')
  })

  it('DataActor carries the single-Assignment grants and ranges', () => {
    const a: DataActor = aftersales
    expect(a.grants).toHaveLength(2)
    expect(a.ranges).toEqual([SHOP_US])
    expect(order.domain).toBe('order')
    expect(customer.fields.phone?.pii).toBe(true)
  })
})
