/**
 * WP261：独立站运营——查询、出卡、批后执行并读回（店铺是进程内假店 `shop-admin-stand-in.ts`，授权走同一套 `shop-auth.ts`）。
 *
 * 钉住：查询只读（不带 `--allow-mutations`）；改动只出卡、出卡那一刻店里一个字节没变；改前必读；
 * 卡上的「原来」是现读的；执行器批后才改、读回确认；有人在后台先改过 → 不改；同一张卡重放不建第二份；
 * 本机图片只许本品牌文件夹里的真图片，走 staged upload；工具面按职责 × 权限出现 / 隐藏。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

const SHOP = 'rollout-test.myshopify.com'
const spec = platformKitOf('shopify')?.cli
if (spec === undefined) throw new Error('shopify 那一行没有 CLI')

let dir: string
let shop: FakeShop
let runner: StoreAuthRunner
let auth: ShopAdminAssembly
let ops: ShopOps
let staged: StageInput[]
let calls: string[][]
let uploads: { url: string; form: FormData }[]

const ACTIONS = [
  'stage_listing_edit',
  'stage_price_change',
  'stage_publish_product',
  'stage_unpublish_product',
  'stage_collection_edit',
  'stage_discount_code',
  'stage_store_setup',
]
const config = (): EffectiveConfig =>
  ({
    actions: ACTIONS.map((id) => ({ id, mandate: { caps: {} }, route_to: 'scope_manager' })),
    automation: Object.fromEntries(
      ACTIONS.map((id) => [id, { level: id.includes('publish') ? 'L1' : 'L2' }]),
    ),
  }) as unknown as EffectiveConfig

const req = (role_id = 'dtc.store', id = 'run_1'): RunRequest =>
  ({
    id,
    actor: { person_id: 'per_owner', assignment_id: `asg_${role_id}`, role_id },
    work_item: { id: 'mat_1' },
  }) as unknown as RunRequest

const changeOf = (i: number): StagedChange =>
  ({
    id: `chg_${i}`,
    workspace_id: 'ws_rollout',
    kind: staged[i]?.kind,
    target: staged[i]?.target,
    before: staged[i]?.before,
    after: staged[i]?.after,
  }) as unknown as StagedChange

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wp261-ops-'))
  shop = demoShop()
  staged = []
  calls = []
  uploads = []
  runner = createStoreAuthRunner({
    now: () => new Date().toISOString(),
    spawn: shopAuthSpawnStandIn(shop, { delayMs: 5 }),
  })
  const run = shopAdminRunStandIn(shop)
  auth = createShopAdmin({
    workspace_id: 'ws_rollout',
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
    workspace_id: 'ws_rollout',
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
    fetch: (async (url: string, init: RequestInit) => {
      uploads.push({ url, form: init.body as FormData })
      return new Response(null, { status: 204 })
    }) as unknown as typeof fetch,
  })
})
afterEach(() => {
  runner.dispose()
  rmSync(dir, { recursive: true, force: true })
})

const authorize = async (roles = ['dtc.store']) => {
  await auth.run('authorize', roles)
  for (let i = 0; i < 100 && (await auth.view(roles)).state !== 'authorized'; i++)
    await new Promise((r) => setTimeout(r, 10))
}

describe('工具面按授权出现 / 隐藏', () => {
  it('没授权：一个都不出，调了说去授权；授权后按职责给', async () => {
    const surface = createShopToolSurface({ module: async () => ({ auth, ops }) })
    expect(await surface.offered('dtc.store')).toEqual([])
    const r = await surface.executeTool({ name: 'shop_list_products', input: {}, request: req() })
    expect(r.status).toBe('error')
    expect(r.data).toEqual({ needs: 'authorize' })
    await authorize(['site.shopify-theme'])
    // 网页模板只授权了读商品：店铺管理那一条也只看得到读商品的那几个
    expect(await surface.offered('site.shopify-theme')).toEqual([
      'shop_get_collection',
      'shop_get_product',
      'shop_list_collections',
      'shop_list_products',
    ])
    expect(await surface.offered('dtc.store')).not.toContain('shop_save_product')
    await authorize(['dtc.store'])
    expect(await surface.offered('dtc.store')).toHaveLength(17)
    expect(await surface.offered('site.shopify-build')).toEqual(
      expect.arrayContaining(['shop_save_page', 'shop_save_menu']),
    )
    expect(await surface.offered('site.shopify-build')).not.toContain('shop_save_product')
    expect(await surface.offered('kol.discovery')).toEqual([])
    // 职责表里没有的工具：直接拦
    const blocked = await surface.executeTool({
      name: 'shop_save_product',
      input: {},
      request: req('site.shopify-theme'),
    })
    expect(blocked.status).toBe('blocked')
  })
})

describe('查询', () => {
  it('商品列表 / 详情 / 合集 / 页面 / 菜单 / 折扣 / 订单：只读，订单里没有顾客信息', async () => {
    await authorize()
    const list = (await ops.read('shop_list_products', { first: 5 }, req())) as {
      products: { title: string; inventory: number; price: string }[]
    }
    expect(list.products[0]).toMatchObject({
      title: 'Rollout 折叠收纳箱',
      inventory: 168,
      price: '19.90 USD – 29.90 USD',
    })
    const p = (await ops.read('shop_get_product', { handle: 'rollout-hook' }, req())) as {
      variants: unknown[]
      status: string
    }
    expect(p.status).toBe('draft')
    expect(p.variants).toHaveLength(1)
    expect(await ops.read('shop_list_collections', {}, req())).toMatchObject({
      collections: [{ title: '首页精选', kind: 'manual', products: 1 }],
    })
    expect(await ops.read('shop_list_pages', {}, req())).toMatchObject({
      pages: [{ title: '关于我们', published: true }],
    })
    expect(await ops.read('shop_list_menus', {}, req())).toMatchObject({
      menus: [{ title: '主菜单', items: [{ title: '首页' }, { title: '全部商品' }] }],
    })
    expect(await ops.read('shop_list_discounts', {}, req())).toMatchObject({
      discounts: [{ codes: ['WELCOME10'], used: 12 }],
    })
    const orders = (await ops.read('shop_recent_orders', {}, req())) as {
      orders: Record<string, unknown>[]
    }
    expect(Object.keys(orders.orders[0] ?? {}).sort()).toEqual([
      'created_at',
      'fulfillment',
      'id',
      'items',
      'name',
      'payment',
      'total',
    ])
    // 全程没有一次带 --allow-mutations
    expect(calls.every((c) => !c.includes('--allow-mutations'))).toBe(true)
  })
})

describe('改动：只出卡 → 批了才改 → 读回', () => {
  it('改标题：没读过先拦；读过出卡（原来是现读的），店里没变；执行后改了并读回', async () => {
    await authorize()
    const id = 'gid://shopify/Product/1001'
    await expect(
      ops.propose('shop_save_product', { id, title: '新标题' }, req()),
    ).rejects.toMatchObject({ code: 'must_read_first' })
    await ops.read('shop_get_product', { id }, req())
    const r = await ops.propose(
      'shop_save_product',
      { id, title: 'Rollout 折叠收纳箱 Pro', tags: ['收纳', '爆款'] },
      req(),
    )
    expect(r.status).toBe('staged')
    const s0 = staged[0] as StageInput
    expect(s0.kind).toBe('listing_edit')
    expect(s0.before).toEqual({ title: 'Rollout 折叠收纳箱', tags: ['收纳', '新品'] })
    expect(s0.approval.title).toBe('改商品「Rollout 折叠收纳箱」：标题、标签')
    expect(s0.notes).toContain('标签：收纳、新品 → 收纳、爆款')
    expect(s0.provenance?.read_full).toEqual([`product:${id}`])
    expect(shop.products[0]?.title).toBe('Rollout 折叠收纳箱')
    expect(calls.some((c) => c.includes('--allow-mutations'))).toBe(false)
    const res = await ops.apply(changeOf(0))
    expect(res).toMatchObject({ status: 'ok', outcome_ref: { type: 'product', id } })
    expect(shop.products[0]?.title).toBe('Rollout 折叠收纳箱 Pro')
    expect(calls.filter((c) => c.includes('--allow-mutations'))).toHaveLength(1)
    // 同一张卡重放：不再跑一次
    await ops.apply(changeOf(0))
    expect(calls.filter((c) => c.includes('--allow-mutations'))).toHaveLength(1)
  })

  it('有人在后台先改过：执行器不改、照实说', async () => {
    await authorize()
    const id = 'gid://shopify/Product/1001'
    await ops.read('shop_get_product', { id }, req())
    await ops.propose('shop_save_product', { id, title: 'A' }, req())
    ;(shop.products[0] as { title: string }).title = '店员刚改的'
    const res = await ops.apply(changeOf(0))
    expect(res?.status).toBe('failed')
    expect(res?.error?.message).toContain('被改过')
    expect(shop.products[0]?.title).toBe('店员刚改的')
  })

  it('建商品一律草稿；改价带原价与幅度；上架永远 L1、挂到网店；折扣码限次', async () => {
    await authorize()
    await ops.propose(
      'shop_save_product',
      { title: 'Rollout 杯架', price: 12.5, options: [{ name: '颜色', values: ['黑', '白'] }] },
      req(),
    )
    expect(staged[0]).toMatchObject({
      kind: 'listing_edit',
      after: {
        _shop_op: 'product_create',
        _status: 'DRAFT',
        status: 'draft',
        price: 12.5,
        spec: '颜色（黑 / 白）',
      },
    })
    expect(staged[0]?.approval.title).toBe('新建商品「Rollout 杯架」（先存草稿）')
    expect((await ops.apply(changeOf(0)))?.status).toBe('ok')
    const created = shop.products.at(-1)
    expect(created).toMatchObject({ title: 'Rollout 杯架', status: 'DRAFT' })
    expect(created?.variants.map((v) => v.title)).toEqual(['黑', '白'])

    const hook = 'gid://shopify/Product/1002'
    await ops.read('shop_get_product', { id: hook }, req())
    await ops.propose('shop_set_price', { product_id: hook, price: 8.9 }, req())
    expect(staged[1]).toMatchObject({
      kind: 'price_change',
      before: { price: 9.9 },
      after: { price: 8.9 },
    })
    expect(staged[1]?.approval.title).toContain('9.90 → 8.9（-10.1%）')
    expect((await ops.apply(changeOf(1)))?.status).toBe('ok')
    expect(shop.products[1]?.variants[0]?.price).toBe('8.90')

    await ops.propose('shop_set_product_status', { product_id: hook, status: 'active' }, req())
    expect(staged[2]).toMatchObject({
      kind: 'publish_product',
      level: 'L1',
      after: { _status: 'ACTIVE', status: 'active' },
    })
    expect((await ops.apply(changeOf(2)))?.status).toBe('ok')
    expect(shop.products[1]).toMatchObject({ status: 'ACTIVE', published: true })

    await ops.propose(
      'shop_create_discount',
      { title: '国庆', code: 'NATIONAL15', percent: 15, usage_limit: 200 },
      req(),
    )
    expect(staged[3]).toMatchObject({
      kind: 'discount_code',
      after: { percent: 15, usage_limit: 200 },
    })
    await expect(
      ops.propose('shop_create_discount', { title: 'x', code: 'WELCOME10', percent: 5 }, req()),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    expect((await ops.apply(changeOf(3)))?.status).toBe('ok')
    expect(shop.discounts.map((d) => d.code)).toContain('NATIONAL15')
  })

  it('合集加商品 / 页面 / 菜单：整站搭建的页面与菜单落到 store_setup', async () => {
    await authorize()
    const col = 'gid://shopify/Collection/4001'
    await ops.read('shop_get_collection', { id: col }, req())
    await ops.propose('shop_save_collection', { id: col, add_product_ids: ['1002'] }, req())
    expect(staged[0]).toMatchObject({
      kind: 'collection_edit',
      after: { _add: ['gid://shopify/Product/1002'], count: 1, added: '1 件商品' },
    })
    expect((await ops.apply(changeOf(0)))?.status).toBe('ok')
    expect(shop.collections[0]?.products).toContain('gid://shopify/Product/1002')

    const build = req('site.shopify-build', 'run_2')
    await ops.read('shop_get_page', { id: 'gid://shopify/Page/5001' }, build)
    await ops.propose(
      'shop_save_page',
      { id: 'gid://shopify/Page/5001', body_html: '<p>新的介绍</p>' },
      build,
    )
    expect(staged[1]).toMatchObject({
      kind: 'store_setup',
      after: { _shop_op: 'page_update', body_html: '<p>新的介绍</p>' },
    })
    expect((await ops.apply(changeOf(1)))?.status).toBe('ok')
    expect(shop.pages[0]?.body).toBe('<p>新的介绍</p>')

    await ops.read('shop_list_menus', {}, build)
    await ops.propose(
      'shop_save_menu',
      {
        id: 'gid://shopify/Menu/6001',
        items: [
          { id: 'gid://shopify/MenuItem/7001', title: '首页', url: '/' },
          { title: '关于我们', resource_id: 'gid://shopify/Page/5001' },
        ],
      },
      build,
    )
    expect(staged[2]?.kind).toBe('store_setup')
    expect(staged[2]?.notes).toEqual(expect.arrayContaining(['新加：关于我们', '去掉：全部商品']))
    expect((await ops.apply(changeOf(2)))?.status).toBe('ok')
    expect(shop.menus[0]?.items.map((i) => [i.title, i.type])).toEqual([
      ['首页', 'FRONTPAGE'],
      ['关于我们', 'PAGE'],
    ])
  })

  it('本机图片：只认本品牌文件夹里的真图片，批了走临时地址上传再挂到商品上', async () => {
    await authorize()
    const id = 'gid://shopify/Product/1002'
    mkdirSync(join(dir, 'brand'), { recursive: true })
    const png = join(dir, 'brand', 'hook.png')
    writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]))
    writeFileSync(join(dir, 'brand', 'fake.png'), 'not an image')
    writeFileSync(
      join(dir, 'outside.png'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    )
    await ops.read('shop_get_product', { id }, req())
    await expect(
      ops.propose(
        'shop_add_product_images',
        { product_id: id, images: [{ file: join(dir, 'outside.png') }] },
        req(),
      ),
    ).rejects.toThrow('不在本品牌的文件夹里')
    await expect(
      ops.propose(
        'shop_add_product_images',
        { product_id: id, images: [{ file: join(dir, 'brand', 'fake.png') }] },
        req(),
      ),
    ).rejects.toThrow('不是图片文件')
    await expect(
      ops.propose(
        'shop_add_product_images',
        { product_id: id, images: [{ url: 'http://x.test/a.jpg' }] },
        req(),
      ),
    ).rejects.toThrow('https')
    await ops.propose(
      'shop_add_product_images',
      { product_id: id, images: [{ file: png, alt: '挂钩' }, { url: 'https://img.test/a.jpg' }] },
      req(),
    )
    expect(staged[0]?.approval.title).toBe('给商品「Rollout 车载挂钩」加 2 张图')
    const res = await ops.apply(changeOf(0))
    expect(res?.error?.message).toBeUndefined()
    expect(res?.status).toBe('ok')
    // 只有本机那一张走了上传：按 Shopify 给的参数 + 文件 POST 到临时地址
    expect(uploads).toHaveLength(1)
    expect(uploads[0]?.url).toBe('https://uploads.shopify.test/upload')
    expect(uploads[0]?.form.get('key')).toBe('k')
    expect((uploads[0]?.form.get('file') as File | undefined)?.name).toBe('hook.png')
    expect(shop.products[1]?.media.map((m) => m.url)).toEqual([
      expect.stringMatching(/^https:\/\/uploads\.shopify\.test\/r\//),
      'https://img.test/a.jpg',
    ])
  })

  it('别的品牌 / 别的来路的卡不归它', async () => {
    await authorize()
    expect(
      await ops.apply({
        id: 'x',
        workspace_id: 'ws_rollout',
        kind: 'listing_edit',
        after: { title: 'A' },
      } as unknown as StagedChange),
    ).toBeUndefined()
    expect(
      await ops.apply({
        id: 'x',
        workspace_id: 'ws_other',
        kind: 'listing_edit',
        after: { _via: 'shop_admin' },
      } as unknown as StagedChange),
    ).toBeUndefined()
  })
})

describe('WP267（决策 198）：传商品图也认设计岗素材库里的图', () => {
  it('给 asset_id：找到对象存储里那份文件，过同一道检查；批了照样走临时地址上传', async () => {
    await authorize()
    const id = 'gid://shopify/Product/1002'
    const designDir = join(dir, 'blobs', 'design', 'ws_rollout', 'design.ecommerce')
    mkdirSync(designDir, { recursive: true })
    const png = join(designDir, 'dsa_hero.png')
    writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]))
    const assets: Record<string, string> = {
      dsa_hero: png,
      // 别的品牌那一段对象存储：不在这个品牌的根里
      dsa_other: join(dir, 'blobs', 'design', 'ws_other', 'x.png'),
    }
    mkdirSync(join(dir, 'blobs', 'design', 'ws_other'), { recursive: true })
    writeFileSync(assets.dsa_other as string, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]))
    const withAssets = createShopOps({
      workspace_id: 'ws_rollout',
      clock: { now: () => new Date().toISOString() },
      auth,
      ledger: {
        stage: async (input) => {
          staged.push(input)
          return { ok: true, change: { id: 'c' }, approval: { id: 'a' } } as never
        },
      },
      effectiveConfig: config,
      fileRoots: () => [join(dir, 'brand'), join(dir, 'blobs', 'design', 'ws_rollout')],
      assetFile: (assetId) => assets[assetId],
      fetch: (async (url: string, init: RequestInit) => {
        uploads.push({ url, form: init.body as FormData })
        return new Response(null, { status: 204 })
      }) as unknown as typeof fetch,
    })
    await withAssets.read('shop_get_product', { id }, req())
    await expect(
      withAssets.propose(
        'shop_add_product_images',
        { product_id: id, images: [{ asset_id: 'dsa_missing' }] },
        req(),
      ),
    ).rejects.toThrow('素材库里找不到这张图')
    await expect(
      withAssets.propose(
        'shop_add_product_images',
        { product_id: id, images: [{ asset_id: 'dsa_other' }] },
        req(),
      ),
    ).rejects.toThrow('不在本品牌的文件夹里')
    await expect(
      withAssets.propose(
        'shop_add_product_images',
        { product_id: id, images: [{ asset_id: 'dsa_hero', url: 'https://img.test/a.jpg' }] },
        req(),
      ),
    ).rejects.toThrow('其中一个')
    // 没装配素材库（老装配）：照实说找不到
    await expect(
      ops.propose(
        'shop_add_product_images',
        { product_id: id, images: [{ asset_id: 'dsa_hero' }] },
        req(),
      ),
    ).rejects.toThrow('素材库里找不到这张图')
    await withAssets.propose(
      'shop_add_product_images',
      { product_id: id, images: [{ asset_id: 'dsa_hero', alt: '主图' }] },
      req(),
    )
    expect(staged[0]?.approval.title).toBe('给商品「Rollout 车载挂钩」加 1 张图')
    const res = await withAssets.apply(changeOf(0))
    expect(res?.status).toBe('ok')
    expect((uploads[0]?.form.get('file') as File | undefined)?.name).toBe('dsa_hero.png')
  })
})
