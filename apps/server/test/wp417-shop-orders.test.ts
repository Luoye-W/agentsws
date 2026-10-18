/**
 * WP417（自查客服 A24–A27、D5）：客服退款 / 改地址 / 补发 / 发码——出卡只读、批后经 Shopify 真改并读回；
 * 权限不够照实说；超额 / 已发货 / 读不到地址不出卡（店铺是进程内假店，授权走同一套 `shop-auth.ts`）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type EffectiveConfig,
  platformKitOf,
  type RunRequest,
  type StagedChange,
} from '@agentsws/contracts'
import type { StageInput } from '@agentsws/txn'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  demoShop,
  type FakeShop,
  shopAdminRunStandIn,
  shopAuthSpawnStandIn,
} from '../src/shop-admin-stand-in.js'
import {
  createShopAdmin,
  createStoreAuthRunner,
  type ShopAdminAssembly,
  type StoreAuthRunner,
} from '../src/shop-auth.js'
import type { ShopOps } from '../src/shop-ops.js'
import { createShopOps } from '../src/shop-service.js'
import { createShopToolSurface } from '../src/shop-tools.js'

const SHOP = 'rovella-test.myshopify.com'
const spec = platformKitOf('shopify')?.cli
if (spec === undefined) throw new Error('shopify 那一行没有 CLI')

const ACTIONS = ['stage_refund', 'stage_reship', 'stage_address_change', 'stage_discount_code']
const config = (): EffectiveConfig =>
  ({
    actions: ACTIONS.map((id) => ({ id, mandate: { caps: {} }, route_to: 'role_holder' })),
    automation: Object.fromEntries(ACTIONS.map((id) => [id, { level: 'L2' }])),
  }) as unknown as EffectiveConfig

const req = (role_id = 'dtc.support', id = 'run_1'): RunRequest =>
  ({
    id,
    actor: { person_id: 'per_owner', assignment_id: `asg_${role_id}`, role_id },
    work_item: { id: 'mat_1' },
  }) as unknown as RunRequest

let dir: string
let shop: FakeShop
let runner: StoreAuthRunner
let auth: ShopAdminAssembly
let ops: ShopOps
let staged: StageInput[]
let calls: string[][]

const changeOf = (i: number): StagedChange =>
  ({
    id: `chg_${i}`,
    workspace_id: 'ws_rovella',
    kind: staged[i]?.kind,
    target: staged[i]?.target,
    before: staged[i]?.before,
    after: staged[i]?.after,
  }) as unknown as StagedChange

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wp417-orders-'))
  shop = demoShop()
  staged = []
  calls = []
  runner = createStoreAuthRunner({
    now: () => new Date().toISOString(),
    spawn: shopAuthSpawnStandIn(shop, { delayMs: 5 }),
  })
  const run = shopAdminRunStandIn(shop)
  auth = createShopAdmin({
    workspace_id: 'ws_rovella',
    clock: { now: () => new Date().toISOString() },
    cliSpec: () => spec,
    probe: async () => ({ installed: true, node_ok: true, min_node_major: 22, checked_at: '' }),
    invocation: () => ({ command: 'node', prefix: ['shopify.js'] }),
    store: async () => SHOP,
    setStore: async () => undefined,
    install: () => undefined,
    installJob: () => undefined,
    auth: runner,
    run: async (args, opts) => {
      calls.push([...args])
      return run(args, opts)
    },
  })
  ops = createShopOps({
    workspace_id: 'ws_rovella',
    clock: { now: () => new Date().toISOString() },
    auth,
    ledger: {
      stage: async (input) => {
        staged.push(input)
        return {
          ok: true,
          change: { id: `chg_${staged.length - 1}` },
          approval: { id: `apr_${staged.length - 1}` },
        } as never
      },
    },
    effectiveConfig: config,
    fileRoots: () => [join(dir, 'brand')],
    stateFile: join(dir, 'brand', 'shop-ops.json'),
  })
})
afterEach(() => {
  runner.dispose()
  rmSync(dir, { recursive: true, force: true })
})

const authorize = async (roles = ['dtc.support']) => {
  await auth.run('authorize', roles)
  for (let i = 0; i < 100 && (await auth.view(roles)).state !== 'authorized'; i++)
    await new Promise((r) => setTimeout(r, 10))
}
const mutations = () => calls.filter((c) => c.includes('--allow-mutations')).length

describe('WP417 客服动订单', () => {
  it('授权按客服要的权限要（订单写、草稿单、折扣）', async () => {
    await authorize()
    const scopes = shop.sessions.get(SHOP)?.scopes ?? []
    expect(scopes).toEqual(
      expect.arrayContaining(['write_orders', 'write_draft_orders', 'write_discounts']),
    )
  })

  it('退款：出卡只读、额度内；批了真退并读回已退金额', async () => {
    await authorize()
    const out = await ops.propose(
      'shop_refund_order',
      { order_id: '#1001', amount: 19.9, reason: '小号破损' },
      req(),
    )
    expect(out.status).toBe('staged')
    expect(mutations()).toBe(0)
    expect(shop.orders?.[0]?.refunded).toBe(0)
    const card = staged[0]
    expect(card?.kind).toBe('refund')
    expect(card?.title ?? card?.approval.title).toContain('退款：#1001 退 19.9 USD')
    expect(card?.money?.amount).toBe(19.9)
    expect(card?.level).toBe('L1')
    // 卡面不露执行器用的格子（收款 id、网关）
    expect(JSON.stringify(card?.after)).not.toContain('"gateway"')
    const res = await ops.apply(changeOf(0))
    expect(res?.status).toBe('ok')
    expect(shop.orders?.[0]?.refunded).toBe(19.9)
    // 同一张卡重放不退第二次
    expect((await ops.apply(changeOf(0)))?.status).toBe('ok')
    expect(shop.orders?.[0]?.refunded).toBe(19.9)
  })

  it('退款超过能退的不出卡；卡出来之后后台又退过 → 不退、照实说', async () => {
    await authorize()
    await expect(
      ops.propose('shop_refund_order', { order_id: '#1001', amount: 80, reason: 'x' }, req()),
    ).rejects.toThrow(/最多还能退 49.8/)
    await ops.propose('shop_refund_order', { order_id: '#1001', amount: 10, reason: 'x' }, req())
    const o = shop.orders?.[0]
    if (o !== undefined) o.refunded = 5
    const res = await ops.apply(changeOf(0))
    expect(res?.status).toBe('failed')
    expect(res?.error?.message).toContain('又退过')
    expect(o?.refunded).toBe(5)
  })

  it('改地址：只改没发货的；卡上原来 → 改成；批了改并读回', async () => {
    await authorize()
    await ops.propose(
      'shop_change_order_address',
      {
        order_id: '#1001',
        address1: '99 New Rd',
        city: 'Dallas',
        zip: '75001',
        country_code: 'us',
      },
      req(),
    )
    const card = staged[0]
    expect(card?.kind).toBe('address_change')
    expect(card?.notes?.join('\n')).toContain('原来：Anna Lee，12 Demo St')
    expect(card?.notes?.join('\n')).toContain('改成：Anna Lee，99 New Rd，Dallas')
    expect((await ops.apply(changeOf(0)))?.status).toBe('ok')
    expect(shop.orders?.[0]?.address.address1).toBe('99 New Rd')
    // 发了货就不出卡
    const o = shop.orders?.[0]
    if (o !== undefined) o.fulfillment = 'FULFILLED'
    await expect(
      ops.propose(
        'shop_change_order_address',
        { order_id: '#1001', address1: '1 A', city: 'B', zip: '1', country_code: 'US' },
        req(),
      ),
    ).rejects.toThrow(/已经发货/)
  })

  it('读不到原地址（受保护的顾客数据）→ 改地址 / 补发照实说，退款照常', async () => {
    await authorize()
    shop.hide_addresses = true
    await expect(
      ops.propose(
        'shop_change_order_address',
        { order_id: '#1001', address1: '1 A', city: 'B', zip: '1', country_code: 'US' },
        req(),
      ),
    ).rejects.toThrow(/读不到 #1001 的原收货地址/)
    await expect(
      ops.propose(
        'shop_reship_order',
        { order_id: '#1001', line_item_id: 'gid://shopify/LineItem/11', reason: '漏发' },
        req(),
      ),
    ).rejects.toThrow(/读不到 #1001 的收货地址/)
    const out = await ops.propose('shop_refund_order', { order_id: '#1001', reason: '全退' }, req())
    expect(out.status).toBe('staged')
    expect(staged[0]?.money?.amount).toBe(49.8)
  })

  it('补发：挑一件、0 元补发单寄原地址；批了建单并读回', async () => {
    await authorize()
    await expect(
      ops.propose('shop_reship_order', { order_id: '#1001', reason: '漏发' }, req()),
    ).rejects.toThrow(/有 2 件商品/)
    await ops.propose(
      'shop_reship_order',
      { order_id: '#1001', line_item_id: 'gid://shopify/LineItem/11', reason: '漏发' },
      req(),
    )
    expect(staged[0]?.kind).toBe('reship')
    const before = shop.orders?.length ?? 0
    const res = await ops.apply(changeOf(0))
    expect(res?.status).toBe('ok')
    expect(shop.orders?.length).toBe(before + 1)
  })

  it('发折扣码：客服也能出卡（以前只有店铺管理映射了）', async () => {
    await authorize()
    const out = await ops.propose(
      'shop_create_discount',
      { title: '安抚券', code: 'SORRY10', percent: 10, usage_limit: 1, once_per_customer: true },
      req(),
    )
    expect(out.status).toBe('staged')
    expect(staged[0]?.kind).toBe('discount_code')
  })

  it('店铺授权里缺改订单的权限 → 工具照摆、调用时照实说去重新授权', async () => {
    await authorize(['dtc.store'])
    const surface = createShopToolSurface({ module: async () => ({ auth, ops }) })
    const offered = await surface.offered('dtc.support')
    expect(offered).toEqual(
      expect.arrayContaining([
        'shop_refund_order',
        'shop_change_order_address',
        'shop_reship_order',
      ]),
    )
    const res = await surface.executeTool({
      name: 'shop_refund_order',
      input: { order_id: '#1001', reason: 'x' },
      request: req(),
    } as never)
    expect(res.status).toBe('error')
    expect(res.reason).toContain('重新授权')
    expect((res.data as { needs?: string } | undefined)?.needs).toBe('authorize')
    expect(staged).toHaveLength(0)
    // 店铺管理不拿订单改动
    expect(await surface.offered('dtc.store')).not.toContain('shop_refund_order')
  })
})
