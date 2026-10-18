/**
 * WP418（自查 site 组）：建站 / 网站运营补通。
 *
 * 钉住：
 * - 检查单按用户真实做的授权读（店铺授权 → Admin 只读查询），读不到的照旧「没读到」，高级接法优先；
 * - 建站自己那几类卡有执行器：检查单（只读，查完即好），装 App / 改通知邮件**照实回「没做」+ 去哪里自己点**；
 * - 新补的改店工具（政策、库存、全站自动折扣、标发货 / 回填单号）：出卡不碰店 → 批了才改 → 读回确认；
 *   卡出来之后店里变过 → 不改；
 * - 授权一次要齐整个品牌用得到的权限。
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type EffectiveConfig,
  platformKitOf,
  type RunRequest,
  type StagedChange,
  type WorkspaceId,
} from '@agentsws/contracts'
import { evaluateGuardrail } from '@agentsws/core'
import type { StageInput } from '@agentsws/txn'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ShopifyAdminReader } from '../src/shop-admin.js'
import {
  demoShop,
  type FakeShop,
  resolveFakeShop,
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
import { createSiteService, createSiteStore } from '../src/site.js'
import {
  createLayeredSiteFacts,
  mergeSiteFacts,
  readAdminSiteFacts,
  siteChecklistToolData,
} from '../src/site-facts.js'

const WS = 'ws_rovella' as WorkspaceId
const SHOP = 'rovella-test.myshopify.com'
const spec = platformKitOf('shopify')?.cli
if (spec === undefined) throw new Error('shopify 那一行没有 CLI')

/** 一个只读口子，直接按操作名问假店（不起 CLI）。 */
const readerOf = (shop: FakeShop): ShopifyAdminReader => ({
  via: 'stand_in',
  store: SHOP,
  query: async ({ document, variables }) => {
    const name = /^\s*query\s+(\w+)/.exec(document)?.[1] ?? ''
    const out = resolveFakeShop(shop, name, variables ?? {})
    if (out === undefined) throw new Error(`unknown op ${name}`)
    return out as never
  },
})

describe('上线检查单按店铺授权读（自查 A9 / A15）', () => {
  it('Admin 只读查询填得出店面密码、域名、政策、导航、运费、线上主题、收款；税照实留空', async () => {
    const facts = await readAdminSiteFacts(readerOf(demoShop()))
    expect(facts.storefront).toEqual({ password_enabled: true })
    expect(facts.domain).toMatchObject({ custom: false, ssl: true })
    expect(facts.policies).toEqual({ present: ['refund'] })
    expect(facts.navigation).toEqual({ main_menu_items: 2, footer_menu_items: 0 })
    expect(facts.shipping).toEqual({ zones: 1, rates: 1 })
    expect(facts.theme?.published?.name).toBe('Dawn')
    expect(facts.payment?.providers).toEqual(['shopify_payments'])
    expect(facts.tax).toBeUndefined()
  })

  it('一条查询炸了只丢那一格（缺一项权限不拖垮整次巡检）', async () => {
    const shop = demoShop()
    const base = readerOf(shop)
    const reader: ShopifyAdminReader = {
      ...base,
      query: async (op) => {
        if (op.document.includes('AgentswsSiteShipping')) throw new Error('missing read_shipping')
        return base.query(op)
      },
    }
    const facts = await readAdminSiteFacts(reader)
    expect(facts.shipping).toBeUndefined()
    expect(facts.policies).toBeDefined()
  })

  it('一格一格补：高级接法读到的优先，没读到的才用店铺授权那一层；都没有 = 空', async () => {
    expect(
      mergeSiteFacts(
        { tax: { configured: true } },
        { tax: { configured: false }, shipping: { zones: 1 } },
      ),
    ).toEqual({
      tax: { configured: true },
      shipping: { zones: 1 },
    })
    const layered = createLayeredSiteFacts({
      connect: { storeFacts: async () => ({ tax: { configured: true, regions: ['US'] } }) },
      reader: async () => readerOf(demoShop()),
    })
    const facts = await layered.storeFacts()
    expect(facts.tax).toEqual({ configured: true, regions: ['US'] })
    expect(facts.storefront).toEqual({ password_enabled: true })
    expect(layered.shop?.()).toBe(SHOP)
    const none = createLayeredSiteFacts({
      reader: async () => {
        throw new Error('not authorized')
      },
    })
    expect(await none.storeFacts()).toEqual({})
  })
})

describe('建站自己那几类卡的执行器（自查 A11 / A18 / A19）', () => {
  const make = () => {
    const staged: StageInput[] = []
    const store = createSiteStore({ workspace_id: WS })
    const service = createSiteService({
      workspace_id: WS,
      store,
      clock: { now: () => '2026-10-19T01:00:00.000Z' },
      approvals: {} as never,
      ledger: {
        stage: async (input) => {
          staged.push(input)
          return {
            ok: true,
            change: { id: `chg_${staged.length}` },
            approval: { id: `ap_${staged.length}`, automation: { level_at_creation: input.level } },
          } as never
        },
      },
      effectiveConfig: () => {
        throw new Error('不查')
      },
      facts: createLayeredSiteFacts({ reader: async () => readerOf(demoShop()) }),
      storeDomain: () => SHOP,
      appendEvent: () => {},
      random: () => 0.5,
    })
    return { service, staged, store }
  }
  const actor = {
    workspace_id: WS,
    person_id: 'p_1' as never,
    assignment_id: 'asg_1' as never,
    role_id: 'site.shopify-build' as never,
  }
  const change = (kind: string, after: Record<string, unknown> = {}): StagedChange =>
    ({
      id: 'chg_x',
      workspace_id: WS,
      kind,
      target: { type: 'x', id: 'judge-me' },
      after,
    }) as unknown as StagedChange

  it('检查单：店铺授权读到店面还挂着密码 → 标题说「买不成」；工具回的每一项写人话', async () => {
    const { service, staged } = make()
    const { run } = await service.port.runChecklist(actor)
    expect(run.items.find((i) => i.id === 'storefront_password')?.state).toBe('missing')
    expect(staged[0]?.level).toBe('L3')
    expect(staged[0]?.approval.title).toBe(`上线检查单：${run.blockers} 项会让顾客买不成`)
    const data = siteChecklistToolData(run)
    expect(data.headline).toBe(staged[0]?.approval.title)
    expect(data.items.find((i) => i.item === '店面密码')).toMatchObject({
      state: '缺',
      severity: '顾客买不成',
      who_fixes: '店主自己去后台',
    })
    expect(data.items.find((i) => i.item === '税')?.state).toBe('没读到')
  })

  it('检查单批了：执行器回「查完了」（不落进内存空桩）', () => {
    const { service } = make()
    expect(service.apply(change('launch_check'))).toMatchObject({
      status: 'ok',
      execution_id: 'site_check_judge-me',
    })
  })

  it('装 App / 改 App / 改通知邮件：照实回「没做」，并给出去哪里自己点', () => {
    const { service } = make()
    const install = service.apply(
      change('app_install', { app_id: 'judge-me', operation: 'install' }),
    )
    expect(install?.status).toBe('failed')
    expect(install?.error?.message).toContain('还没接通')
    expect(install?.error?.message).toContain('https://apps.shopify.com/search?q=Judge.me')
    const mail = service.apply(change('email_template_edit'))
    expect(mail?.status).toBe('failed')
    expect(mail?.error?.message).toContain(`https://${SHOP}/admin/settings/notifications`)
    expect(service.apply(change('app_config'))?.error?.message).toContain('settings/apps')
    // 别的 kind / 别的品牌不归它
    expect(service.apply(change('listing_edit'))).toBeUndefined()
    expect(
      service.apply({ ...change('launch_check'), workspace_id: 'ws_other' } as StagedChange),
    ).toBeUndefined()
  })

  it('出装 App / 改邮件卡时就在卡上说清「这一步还没接通」', async () => {
    const { service, staged } = make()
    await service.port.proposeApp(actor, { app_id: 'judge-me', operation: 'install' })
    expect(staged[0]?.notes.join('\n')).toContain('还没接通')
    await service.port.draftEmailTemplate(actor, {
      notification_type: 'order_confirmation',
      subject: '订单 {{ order.name }} 收到了',
      body: '你好 {{ customer.first_name }}，{{ order.name }} 收到了：{{ order.order_status_url }}',
      enabled: false,
    })
    expect(staged[1]?.notes.join('\n')).toContain('settings/notifications')
  })
})

// ── 新补的改店工具 ───────────────────────────────────────────────────────

let dir: string
let shop: FakeShop
let runner: StoreAuthRunner
let auth: ShopAdminAssembly
let ops: ShopOps
let staged: StageInput[]

const ACTIONS = [
  'stage_store_setup',
  'stage_inventory_adjust',
  'stage_promotion',
  'stage_create_fulfillment',
]
const config = (): EffectiveConfig =>
  ({
    actions: ACTIONS.map((id) => ({ id, mandate: { caps: {} }, route_to: 'scope_manager' })),
    automation: Object.fromEntries(ACTIONS.map((id) => [id, { level: 'L1' }])),
  }) as unknown as EffectiveConfig
const req = (role_id: string, id = 'run_1'): RunRequest =>
  ({
    id,
    actor: { person_id: 'per_owner', assignment_id: `asg_${role_id}`, role_id },
  }) as unknown as RunRequest
const changeOf = (i: number): StagedChange =>
  ({
    id: `chg_${i}`,
    workspace_id: WS,
    kind: staged[i]?.kind,
    target: staged[i]?.target,
    before: staged[i]?.before,
    after: staged[i]?.after,
  }) as unknown as StagedChange

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wp418-'))
  mkdirSync(join(dir, 'brand'), { recursive: true })
  shop = demoShop()
  staged = []
  runner = createStoreAuthRunner({
    now: () => new Date().toISOString(),
    spawn: shopAuthSpawnStandIn(shop, { delayMs: 5 }),
  })
  const run = shopAdminRunStandIn(shop)
  auth = createShopAdmin({
    workspace_id: WS,
    clock: { now: () => new Date().toISOString() },
    cliSpec: () => spec,
    probe: async () => ({ installed: true, node_ok: true, min_node_major: 22, checked_at: '' }),
    invocation: () => ({ command: 'node', prefix: ['shopify.js'] }),
    store: async () => SHOP,
    setStore: async () => undefined,
    install: () => undefined,
    installJob: () => undefined,
    auth: runner,
    run,
    // 这个品牌担着建站 + 店铺管理 + 订单履约
    brandRoles: () => ['dtc.fulfillment', 'dtc.store', 'site.shopify-build'],
  })
  ops = createShopOps({
    workspace_id: WS,
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

/** 只在网页模板那个岗位上点了一次授权。 */
const authorizeOnce = async () => {
  await auth.run('authorize', ['site.shopify-theme'])
  for (let i = 0; i < 100 && (await auth.view(['site.shopify-theme'])).state !== 'authorized'; i++)
    await new Promise((r) => setTimeout(r, 10))
}

describe('授权一次要齐整个品牌用得到的（自查 C2）', () => {
  it('在网页模板岗位授权过，建站 / 网站运营 / 订单履约那几条不用再授权', async () => {
    await authorizeOnce()
    for (const roles of [['site.shopify-build'], ['dtc.store'], ['dtc.fulfillment']])
      expect((await auth.view(roles)).state, roles[0]).toBe('authorized')
    const granted = shop.sessions.get(SHOP)?.scopes ?? []
    expect(granted).toEqual(
      expect.arrayContaining([
        'write_files',
        'write_inventory',
        'write_legal_policies',
        'write_merchant_managed_fulfillment_orders',
      ]),
    )
  })

  it('工具面：检查单不靠授权也摆出来；授权后建站多了「改政策」、店铺管理多了库存与全站活动、订单履约有发货', async () => {
    const surface = createShopToolSurface({
      module: async () => ({ auth, ops }),
      siteChecklist: async () => ({ headline: 'x' }),
    })
    expect(await surface.offered('site.shopify-build')).toEqual(['site_checklist_run'])
    expect(await surface.offered('dtc.store')).toEqual([])
    const r = await surface.executeTool({
      name: 'site_checklist_run',
      input: {},
      request: req('site.shopify-build'),
    })
    expect(r).toMatchObject({ status: 'ok', data: { headline: 'x' } })
    await authorizeOnce()
    expect(await surface.offered('site.shopify-build')).toEqual(
      expect.arrayContaining(['shop_save_policy', 'site_checklist_run']),
    )
    expect(await surface.offered('dtc.store')).toEqual(
      expect.arrayContaining(['shop_adjust_inventory', 'shop_create_automatic_discount']),
    )
    expect(await surface.offered('dtc.fulfillment')).toEqual([
      'shop_fulfill_order',
      'shop_get_order',
      'shop_recent_orders',
    ])
    // 店铺管理不能改政策（那是建站的事）
    expect(await surface.offered('dtc.store')).not.toContain('shop_save_policy')
  })
})

describe('补政策页（自查 A13）', () => {
  it('建的是「政策」不是普通页面：出卡不碰店 → 批了 shopPolicyUpdate → 读回检查单认得到', async () => {
    await authorizeOnce()
    const out = await ops.propose(
      'shop_save_policy',
      { type: 'privacy', body_html: '<p>我们只用你的信息来发货。</p>' },
      req('site.shopify-build'),
    )
    expect(out.status).toBe('staged')
    expect(staged[0]?.kind).toBe('store_setup')
    expect(staged[0]?.approval.title).toBe('写上「隐私政策」')
    expect(shop.policies?.map((p) => p.type)).toEqual(['REFUND_POLICY'])
    const applied = await ops.apply(changeOf(0))
    expect(applied).toMatchObject({ status: 'ok' })
    const facts = await readAdminSiteFacts(readerOf(shop))
    expect(facts.policies?.present).toEqual(['privacy', 'refund'])
  })

  it('卡出来之后有人在后台写过这张政策 → 不改', async () => {
    await authorizeOnce()
    await ops.propose(
      'shop_save_policy',
      { type: 'privacy', body_html: '<p>A</p>' },
      req('site.shopify-build'),
    )
    shop.policies?.push({ type: 'PRIVACY_POLICY', body: '<p>店主自己写的</p>' })
    const applied = await ops.apply(changeOf(0))
    expect(applied?.status).toBe('failed')
    expect(applied?.error?.message).toContain('变过')
  })
})

describe('库存调整（自查 B4）', () => {
  it('改前必读 → 出卡写清「现在 → 改后」→ 批了加减 → 读回对得上', async () => {
    await authorizeOnce()
    const blocked = ops.propose(
      'shop_adjust_inventory',
      { product_id: 'gid://shopify/Product/1002', delta: 20 },
      req('dtc.store'),
    )
    await expect(blocked).rejects.toThrow('先用 shop_get_product')
    await ops.read('shop_get_product', { id: 'gid://shopify/Product/1002' }, req('dtc.store'))
    const out = await ops.propose(
      'shop_adjust_inventory',
      { product_id: 'gid://shopify/Product/1002', delta: 20, reason: 'received' },
      req('dtc.store'),
    )
    expect(out.status).toBe('staged')
    const card = staged[0] as StageInput
    expect(card.kind).toBe('inventory_adjust')
    expect(card.approval.title).toBe('库存：「Rovella 车载挂钩」300 → 320（+20，收货）')
    expect(card.before).toMatchObject({ quantity: 300 })
    // guardrail 能判（受保护字段没被 Agent 提议、额度看得到 delta）
    const verdict = evaluateGuardrail(
      { ...card, id: 'c', status: 'staged' } as never,
      { caps: { max_inventory_adjust: 50 } },
      { changeSet: [], windowCount: 0, readFull: [`inventory:${card.target.id}`] } as never,
      'stage',
    )
    expect(verdict.hits.filter((h) => h.severity === 'block')).toEqual([])
    expect(shop.products[1]?.variants[0]?.inventoryQuantity).toBe(300)
    expect(await ops.apply(changeOf(0))).toMatchObject({ status: 'ok' })
    expect(shop.products[1]?.variants[0]?.inventoryQuantity).toBe(320)
    // 同一张卡重放：不加第二次
    expect(await ops.apply(changeOf(0))).toMatchObject({ status: 'ok' })
    expect(shop.products[1]?.variants[0]?.inventoryQuantity).toBe(320)
  })

  it('卡出来之后有人在后台改过库存 → 不改', async () => {
    await authorizeOnce()
    await ops.read('shop_get_product', { id: 'gid://shopify/Product/1002' }, req('dtc.store'))
    await ops.propose(
      'shop_adjust_inventory',
      { product_id: 'gid://shopify/Product/1002', delta: -5 },
      req('dtc.store'),
    )
    const v = shop.products[1]?.variants[0]
    if (v !== undefined) v.inventoryQuantity = 10
    const applied = await ops.apply(changeOf(0))
    expect(applied?.status).toBe('failed')
    expect(v?.inventoryQuantity).toBe(10)
  })
})

describe('全站自动折扣（自查 B5 / B3）', () => {
  it('出卡（永远人审）→ 批了建 → 读回；按力度判额度，按金额减的转人审', async () => {
    await authorizeOnce()
    const out = await ops.propose(
      'shop_create_automatic_discount',
      { title: '国庆全场 85 折', percent: 15, ends_at: '2026-10-08T00:00:00Z' },
      req('dtc.store'),
    )
    expect(out.status).toBe('staged')
    const card = staged[0] as StageInput
    expect(card.kind).toBe('promotion')
    expect(card.approval.title).toBe('全站活动「国庆全场 85 折」：全站减 15%')
    const g = (after: Record<string, unknown>, kind = 'promotion') =>
      evaluateGuardrail(
        { ...card, kind, after, id: 'c', status: 'staged' } as never,
        { caps: { max_promotion_discount_pct: 30, max_promo_discount_pct: 30 } },
        { changeSet: [], windowCount: 0, readFull: [] } as never,
        'stage',
      )
        .hits.map((h) => `${h.severity}:${h.rule}`)
        // 全站活动永远人审（`HARD_L1`）——这一条总在
        .filter((h) => h !== 'review:hard_ceiling')
    expect(g({ percent: 15 })).toEqual([])
    expect(g({ percent: 40 })).toContain('review:max_promotion_discount_pct')
    expect(g({ amount_off: 20 })).toContain('review:max_promotion_discount_pct')
    // 折扣码按金额减的也不再绕开额度（B3）
    expect(g({ amount_off: 20, usage_limit: 10 }, 'discount_code')).toContain(
      'review:max_promo_discount_pct',
    )
    expect(await ops.apply(changeOf(0))).toMatchObject({ status: 'ok' })
    expect(shop.autoDiscounts?.map((d) => d.title)).toEqual(['国庆全场 85 折'])
  })
})

describe('订单发货 / 回填单号（自查 B10）', () => {
  it('看单 → 拆单先发有货的那一件 → 批了建发货 → 读回有这个单号；剩下那件还在', async () => {
    await authorizeOnce()
    const order = (await ops.read('shop_get_order', { name: '#1001' }, req('dtc.fulfillment'))) as {
      to_ship: { id: string; name: string }[]
    }
    expect(order.to_ship).toHaveLength(2)
    const first = order.to_ship[0]?.id as string
    const out = await ops.propose(
      'shop_fulfill_order',
      {
        order_id: 'gid://shopify/Order/1',
        tracking_number: '1Z999',
        carrier: 'UPS',
        line_items: [{ id: first, quantity: 1 }],
      },
      req('dtc.fulfillment'),
    )
    expect(out.status).toBe('staged')
    const card = staged[0] as StageInput
    expect(card.kind).toBe('create_fulfillment')
    expect(card.approval.title).toBe('拆单先发：#1001（1 件）· UPS 1Z999')
    // guardrail：单号与承运商都有、还没发 → 不拦
    const hits = evaluateGuardrail(
      { ...card, id: 'c', status: 'staged' } as never,
      { caps: {} },
      { changeSet: [], windowCount: 0, readFull: [] } as never,
      'stage',
    ).hits.filter((h) => h.severity === 'block')
    expect(hits).toEqual([])
    expect(shop.orders?.[0]?.fulfillments).toEqual([])
    expect(await ops.apply(changeOf(0))).toMatchObject({ status: 'ok' })
    expect(shop.orders?.[0]?.fulfillments[0]?.tracking[0]).toMatchObject({
      number: '1Z999',
      company: 'UPS',
    })
    expect(shop.orders?.[0]?.lines.map((l) => l.remaining)).toEqual([0, 1])
  })

  it('已经发了只缺单号 → 只回填单号', async () => {
    await authorizeOnce()
    await ops.read('shop_get_order', { id: 'gid://shopify/Order/2' }, req('dtc.fulfillment'))
    const out = await ops.propose(
      'shop_fulfill_order',
      {
        order_id: 'gid://shopify/Order/2',
        fulfillment_id: 'gid://shopify/Fulfillment/31',
        tracking_number: 'YT123',
        carrier: '云途',
      },
      req('dtc.fulfillment'),
    )
    expect(out.status).toBe('staged')
    expect(staged[0]?.approval.title).toBe('回填单号：#1002 → 云途 YT123')
    expect(await ops.apply(changeOf(0))).toMatchObject({ status: 'ok' })
    expect(shop.orders?.[1]?.fulfillments[0]?.tracking[0]?.number).toBe('YT123')
  })

  it('没读过这张单 / 没单号：不出卡', async () => {
    await authorizeOnce()
    await expect(
      ops.propose(
        'shop_fulfill_order',
        { order_id: 'gid://shopify/Order/1', tracking_number: 'X', carrier: 'UPS' },
        req('dtc.fulfillment'),
      ),
    ).rejects.toThrow('shop_get_order')
    await expect(
      ops.propose(
        'shop_fulfill_order',
        { order_id: 'gid://shopify/Order/1' },
        req('dtc.fulfillment'),
      ),
    ).rejects.toThrow('单号')
    expect(staged).toEqual([])
  })
})
