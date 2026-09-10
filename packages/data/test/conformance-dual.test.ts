/**
 * 共享数据层：SQLite 与 Postgres 各跑一遍同一份一致性套件（WP40 §2）。
 *
 * 用例对着 21 §6：
 * 3. 无 workspace_id 的记录写入被拒
 * 4. 销毁密钥后历史仍在、内容读不出来
 * 5. 售后客服查 Product 不返回 cost_price（**过滤在数据层**，不是应用层）
 * 6. 乐观锁：并发写同一记录第二个 conflict
 * 另加 JSON 字段过滤下推——这一条是两个方言写法唯一不同的地方（`json_extract` ←→ `->>`），
 * 不双跑就等于没验。
 */
import type { PermissionScope } from '@agentsws/contracts'
import { openSqliteDriver, type SqlDriver } from '@agentsws/core/sql'
import { openScratchPostgres, postgresTestUrl } from '@agentsws/core/sql/testing'
import { afterAll, describe, expect, it } from 'vitest'
import { DataError, type SqlDataStore } from '../src/index.js'
import { SqlDataStore as Store } from '../src/store.js'
import {
  AFTERSALES_SCOPES,
  ALL_COLLECTIONS,
  actor,
  SHOP_EU,
  SHOP_US,
  stepClock,
} from './fixtures.js'

const ALL_DOMAINS_RESTRICTED: PermissionScope[] = [
  { domain: 'product', ops: ['read', 'stage'], range: 'workspace', max_sensitivity: 'restricted' },
  { domain: 'order', ops: ['read', 'stage'], range: 'workspace', max_sensitivity: 'restricted' },
  { domain: 'customer', ops: ['read', 'stage'], range: 'workspace', max_sensitivity: 'restricted' },
]

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

const pgUrl = await postgresTestUrl()
const cleanups: (() => Promise<void>)[] = []

afterAll(async () => {
  for (const cleanup of cleanups) await cleanup()
})

interface Backend {
  name: string
  skip: boolean
  open(): Promise<{ store: SqlDataStore; driver: SqlDriver }>
}

const BACKENDS: Backend[] = [
  {
    name: 'sqlite',
    skip: false,
    open: async () => {
      const driver = openSqliteDriver({ path: ':memory:' })
      const store = await Store.open({
        driver,
        clock: stepClock(),
        collections: ALL_COLLECTIONS,
        env: {},
      })
      return { store, driver }
    },
  },
  {
    name: 'postgres',
    skip: pgUrl === undefined,
    open: async () => {
      const scratch = await openScratchPostgres(pgUrl as string, 'data')
      cleanups.push(() => scratch.dispose())
      const store = await Store.open({
        driver: scratch.driver,
        clock: stepClock(),
        collections: ALL_COLLECTIONS,
        env: {},
      })
      return { store, driver: scratch.driver }
    },
  },
]

async function code(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn()
  } catch (e) {
    expect(e).toBeInstanceOf(DataError)
    return (e as DataError).code
  }
  throw new Error('expected a DataError')
}

for (const backend of BACKENDS) {
  describe.skipIf(backend.skip)(`共享数据层一致性 · ${backend.name}`, () => {
    const withStore = async (fn: (store: SqlDataStore) => Promise<void>): Promise<void> => {
      const handle = await backend.open()
      try {
        await fn(handle.store)
      } finally {
        if (backend.name === 'sqlite') await handle.driver.close()
      }
    }

    it('写读一圈：信封列 + body JSON 原样回来', async () => {
      await withStore(async (store) => {
        await store.put(
          'product',
          {
            id: 'sku_1',
            schema_version: 1,
            workspace_id: 'ws_1',
            owners: ['p_owner'],
            scope: [SHOP_US],
            sensitivity: 'internal',
            sku: 'A-1',
            title: '保温杯',
            cost_price: 12.5,
          } as never,
          owner,
        )
        const rec = (await store.get('product', 'sku_1', owner)) as Record<string, unknown>
        expect(rec?.sku).toBe('A-1')
        expect(rec?.title).toBe('保温杯')
        expect(rec?.cost_price).toBe(12.5)
        expect(rec?.version).toBe('1')
      })
    })

    it('用例 3：无 workspace_id 拒写', async () => {
      await withStore(async (store) => {
        expect(
          await code(() =>
            store.put(
              'product',
              {
                id: 'x',
                schema_version: 1,
                owners: [],
                scope: [],
                sensitivity: 'internal',
              } as never,
              owner,
            ),
          ),
        ).toBe('invalid_input')
      })
    })

    it('用例 5：售后客服查 Product 不返回 cost_price（过滤在数据层）', async () => {
      await withStore(async (store) => {
        await store.put(
          'product',
          {
            id: 'sku_2',
            schema_version: 1,
            workspace_id: 'ws_1',
            owners: ['p_owner'],
            scope: [SHOP_US],
            sensitivity: 'internal',
            sku: 'A-2',
            cost_price: 9,
          } as never,
          owner,
        )
        // 售后根本没有 product 域的 grant → 读不到
        expect(await store.get('product', 'sku_2', aftersales)).toBeUndefined()

        // 有 order 域但密级只到 internal：restricted 的 payout_note 被数据层剪掉
        await store.put(
          'order',
          {
            id: 'o_1',
            schema_version: 1,
            workspace_id: 'ws_1',
            owners: ['p_owner'],
            scope: [SHOP_US],
            sensitivity: 'internal',
            total: 100,
            payout_note: '内部结算备注',
          } as never,
          owner,
        )
        const seen = (await store.get('order', 'o_1', aftersales)) as Record<string, unknown>
        expect(seen?.total).toBe(100)
        expect(seen).not.toHaveProperty('payout_note')
      })
    })

    it('用例 6：乐观锁——第二个写同一版本的 conflict', async () => {
      await withStore(async (store) => {
        const base = {
          id: 'o_2',
          schema_version: 1,
          workspace_id: 'ws_1',
          owners: ['p_owner'],
          scope: [SHOP_US],
          sensitivity: 'internal',
          total: 1,
        }
        await store.put('order', base as never, owner)
        await store.put('order', { ...base, version: '1', total: 2 } as never, owner)
        expect(
          await code(() => store.put('order', { ...base, version: '1' } as never, owner)),
        ).toBe('conflict')
        expect(await code(() => store.put('order', base as never, owner))).toBe('conflict')
      })
    })

    it('用例 4：PII 加密落盘，销毁密钥后行还在、内容读成 [erased]', async () => {
      await withStore(async (store) => {
        await store.put(
          'customer',
          {
            id: 'c_1',
            schema_version: 1,
            workspace_id: 'ws_1',
            owners: ['p_owner'],
            scope: [SHOP_US],
            sensitivity: 'internal',
            display_name: '陈女士',
            phone: '13800000000',
          } as never,
          owner,
        )
        const before = (await store.get('customer', 'c_1', owner)) as Record<string, unknown>
        expect(before?.phone).toBe('13800000000')

        const event = await store.erase({ collection: 'customer', id: 'c_1' }, owner)
        expect(event.type).toBe('privacy.erased')
        expect(event.payload.erased_fields).toContain('phone')

        const after = (await store.get('customer', 'c_1', owner)) as Record<string, unknown>
        expect(after?.display_name).toBe('陈女士')
        expect(after?.phone).toBe('[erased]')

        // 墓碑可读；重放幂等
        expect((await store.listTombstones()).map((t) => t.payload.key_id)).toContain(
          'customer:c_1',
        )
        expect(await store.replayTombstones([event])).toEqual({ applied: 0, skipped: 1 })
      })
    })

    it('21 §3：JSON 字段等值过滤下推到 SQL（两个方言各一套写法）', async () => {
      await withStore(async (store) => {
        for (const [id, tier] of [
          ['c_a', 'vip'],
          ['c_b', 'normal'],
        ] as const) {
          await store.put(
            'customer',
            {
              id,
              schema_version: 1,
              workspace_id: 'ws_1',
              owners: ['p_owner'],
              scope: [SHOP_US],
              sensitivity: 'internal',
              display_name: id,
              tier,
            } as never,
            owner,
          )
        }
        const vip = await store.query('customer', { tier: 'vip' }, owner)
        expect(vip.items.map((i) => (i as { id: string }).id)).toEqual(['c_a'])

        // 加密字段不可当探针（否则等于用查询把密文当索引用）
        expect(await code(() => store.query('customer', { phone: '138' }, owner))).toBe(
          'invalid_input',
        )
      })
    })

    it('分页游标在两边同序（id ASC）', async () => {
      await withStore(async (store) => {
        for (const id of ['o_a', 'o_b', 'o_c']) {
          await store.put(
            'order',
            {
              id,
              schema_version: 1,
              workspace_id: 'ws_1',
              owners: ['p_owner'],
              scope: [SHOP_US],
              sensitivity: 'internal',
              total: 1,
            } as never,
            owner,
          )
        }
        const first = await store.query('order', {}, owner, { limit: 2 })
        expect(first.items.map((i) => (i as { id: string }).id)).toEqual(['o_a', 'o_b'])
        expect(first.cursor).toBe('o_b')
        const second = await store.query('order', {}, owner, { limit: 2, cursor: first.cursor })
        expect(second.items.map((i) => (i as { id: string }).id)).toEqual(['o_c'])
      })
    })
  })
}

if (pgUrl === undefined) {
  console.warn(
    '[WP40] data 的 Postgres 一致性用例已跳过：没有可连的库（设 AGENTSWS_TEST_DATABASE_URL，或 docker compose --profile postgres up -d）。',
  )
}
