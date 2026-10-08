/**
 * WP261：店铺授权（`store auth`）与后台接口（`store execute`）——假 `shopify` 是**真脚本、真子进程**。
 *
 * 钉住：授权成功 / 拒绝 / 缺权限 / 过期 / 被收回；令牌落在**本品牌那一份**会话目录（两个品牌互不碰）；
 * 权限只取登记表里的；同一时间只有一个品牌在授权（回调端口整机一个）；查询那一半跑不了改动（CLI 一次都没起）；
 * 改动才带 `--allow-mutations`；钉的接口版本不认了退回默认；网络失败 / 缺权限说人话。
 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { platformKitOf } from '@agentsws/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PlatformCliProbe } from '../src/platform-cli.js'
import { cliSessionHome } from '../src/platform-cli-session.js'
import { ShopAdminError } from '../src/shop-admin.js'
import {
  createShopAdmin,
  createStoreAuthRunner,
  type ShopAdminAssembly,
  STORE_SESSION_CLI_ID,
  type StoreAuthRunner,
} from '../src/shop-auth.js'
import { createRunCli } from '../src/shopify-theme.js'
import { type FakeStoreCli, fakeStoreCli } from './fixtures/fake-shopify-store.js'

const SHOP = 'rollout-test.myshopify.com'
const spec = platformKitOf('shopify')?.cli
if (spec === undefined) throw new Error('shopify 那一行没有 CLI')
const STORE_ROLES = ['dtc.store']
const THEME_ROLES = ['site.shopify-theme']

let dir: string
let cli: FakeStoreCli
let auth: StoreAuthRunner
let machine: { installed: boolean; store: string | undefined }

const probe = async (): Promise<PlatformCliProbe> => ({
  installed: machine.installed,
  node_ok: true,
  min_node_major: 22,
  checked_at: new Date().toISOString(),
  ...(machine.installed ? { version: '4.8.5', source: 'app' as const } : {}),
})

function make(
  ws = 'ws_rollout',
  store: () => string | undefined = () => machine.store,
): ShopAdminAssembly {
  return createShopAdmin({
    workspace_id: ws,
    clock: { now: () => new Date().toISOString() },
    settingsFile: join(dir, 'brands', ws, 'shop-admin.json'),
    cliSpec: () => spec,
    probe,
    invocation: () => ({ command: process.execPath, prefix: [cli.entry] }),
    sessionHome: cliSessionHome(join(dir, 'tools'), STORE_SESSION_CLI_ID, ws),
    store: async () => store(),
    setStore: async (raw) => {
      machine.store = raw
    },
    install: () => undefined,
    installJob: () => undefined,
    auth,
    run: createRunCli(() => ({ command: process.execPath, prefix: [cli.entry] })),
    env: {
      PATH: process.env.PATH,
      AGENTSWS_SECRETS_KEY: 'k',
      HTTPS_PROXY: 'http://proxy.test:8080',
    },
  })
}

const until = async (cond: () => Promise<boolean>, ms = 5000): Promise<void> => {
  const end = Date.now() + ms
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('timeout')
    await new Promise((r) => setTimeout(r, 20))
  }
}

const authorizeAndWait = async (a: ShopAdminAssembly, roles = STORE_ROLES) => {
  await a.run('authorize', roles)
  await until(async () => (await a.view(roles)).job?.phase !== 'waiting_browser')
  return a.view(roles)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wp261-auth-'))
  cli = fakeStoreCli(dir)
  auth = createStoreAuthRunner({ now: () => new Date().toISOString() })
  machine = { installed: true, store: SHOP }
})
afterEach(() => {
  auth.dispose()
  rmSync(dir, { recursive: true, force: true })
})

describe('授权那一行走到哪一档', () => {
  it('没装 → no_cli；不知道哪家店 → no_store；没职责要它 → 不出', async () => {
    machine.installed = false
    expect((await make().view(STORE_ROLES)).state).toBe('no_cli')
    machine.installed = true
    machine.store = undefined
    expect((await make().view(STORE_ROLES)).state).toBe('no_store')
    expect((await make().view(['kol.discovery'])).applicable).toBe(false)
  })

  it('授权成功：只要登记表里的权限、令牌落在本品牌会话目录、记下权限与过期时间', async () => {
    const a = make()
    const before = await a.view(STORE_ROLES)
    expect(before.state).toBe('unauthorized')
    expect(before.scopes_needed).toContain('write_products')
    const v = await authorizeAndWait(a)
    expect(v.state).toBe('authorized')
    expect(v.job?.phase).toBe('done')
    expect(v.missing).toEqual([])
    expect(v.scopes_granted).toEqual(expect.arrayContaining(['read_products', 'write_discounts']))
    expect(v.refreshable).toBe(false)
    expect(Date.parse(v.expires_at ?? '') - Date.now()).toBeGreaterThan(23 * 3600_000)
    const call = cli.calls()[0]
    expect(call?.argv.slice(0, 5)).toEqual(['store', 'auth', '--json', '--store', SHOP])
    expect(call?.argv[6]?.split(',').sort()).toEqual(
      [...(spec.store_admin?.scopes_by_role['dtc.store'] ?? [])].sort(),
    )
    const home = cliSessionHome(join(dir, 'tools'), STORE_SESSION_CLI_ID, 'ws_rollout')
    expect(call?.home).toBe(home)
    expect(existsSync(join(home, '.fake-store-session.json'))).toBe(true)
    // 白名单：我们的秘密一个都不传，代理照传；授权不带 CI（同登录）
    expect(call?.env).not.toContain('AGENTSWS_SECRETS_KEY')
    expect(call?.env).toContain('HTTPS_PROXY')
    expect(call?.ci).toBe(false)
  })

  it('两个品牌各一份会话：INMO 没授权就是没授权，Rollout 的令牌碰不到', async () => {
    await authorizeAndWait(make('ws_rollout'))
    const inmo = make('ws_inmo')
    expect((await inmo.view(STORE_ROLES)).state).toBe('unauthorized')
    // 即使 INMO 的设置文件里伪造一条授权，CLI 那边也是没授权（会话目录是分开的）
    await expect(
      (await authorizeAndWaitFake(inmo)).query({
        name: 'x',
        document: 'query AgentswsShop { shop { name } }',
      }),
    ).rejects.toMatchObject({ code: 'not_authorized' })
  })

  it('拒绝 / 缺权限 / 端口被占：那一行说清楚，仍是没授权', async () => {
    cli.setAuthMode('deny')
    let v = await authorizeAndWait(make())
    expect(v.job?.error).toEqual({ code: 'denied', detail: 'access_denied' })
    expect(v.state).toBe('unauthorized')
    cli.setAuthMode('fewer:write_discounts,write_publications')
    v = await authorizeAndWait(make())
    expect(v.job?.error).toEqual({
      code: 'missing_scopes',
      missing: ['write_discounts', 'write_publications'],
    })
    cli.setAuthMode('port')
    v = await authorizeAndWait(make())
    expect(v.job?.error?.code).toBe('port_busy')
  })

  it('CLI 开不了浏览器：把授权网址原样交给工作台（client_id 不被抹掉）', async () => {
    cli.setAuthMode('no-browser')
    const v = await authorizeAndWait(make())
    expect(v.job?.auth_url).toContain(`https://${SHOP}/admin/oauth/authorize?client_id=7e9cb568`)
    expect(v.job?.browser_opened).toBe(false)
  })

  it('等浏览器时：同一时间只有一个品牌在授权；取消后回到没授权', async () => {
    cli.setAuthMode('hang')
    const a = make('ws_rollout')
    await a.run('authorize', STORE_ROLES)
    expect((await a.view(STORE_ROLES)).state).toBe('authorizing')
    await expect(make('ws_inmo').run('authorize', STORE_ROLES)).rejects.toBeInstanceOf(
      ShopAdminError,
    )
    await a.cancel(STORE_ROLES)
    await until(async () => (await a.view(STORE_ROLES)).job?.phase === 'cancelled')
    expect((await a.view(STORE_ROLES)).state).toBe('unauthorized')
  })

  it('过期：没有续期令牌到点就过期；有续期令牌照旧能用', async () => {
    cli.set('expires-in', '60')
    expect((await authorizeAndWait(make())).state).toBe('expired')
    cli.set('refresh')
    const v = await authorizeAndWait(make())
    expect(v.state).toBe('authorized')
    expect(v.refreshable).toBe(true)
  })

  it('网页模板只授权了读商品：店铺管理那一岗位看到缺哪几项，重新授权时把已有的并进来', async () => {
    const a = make()
    expect((await authorizeAndWait(a, THEME_ROLES)).state).toBe('authorized')
    const v = await a.view(STORE_ROLES)
    expect(v.state).toBe('missing_scopes')
    expect(v.missing).toEqual(expect.arrayContaining(['write_products', 'write_discounts']))
    expect((await authorizeAndWait(a)).state).toBe('authorized')
    const scopes = cli.calls().at(-1)?.argv[6]?.split(',') ?? []
    expect(scopes).toContain('read_products')
    expect(scopes).toContain('write_discounts')
  })
})

/** 伪造：设置文件里有授权、CLI 会话里没有（看 CLI 报「没授权」时我们怎么认）。 */
async function authorizeAndWaitFake(a: ShopAdminAssembly) {
  const { writeFileSync, mkdirSync } = await import('node:fs')
  mkdirSync(join(dir, 'brands', 'ws_inmo'), { recursive: true })
  writeFileSync(
    join(dir, 'brands', 'ws_inmo', 'shop-admin.json'),
    JSON.stringify({
      version: 1,
      grants: {
        [SHOP]: {
          store: SHOP,
          scopes: ['read_products'],
          acquired_at: new Date().toISOString(),
          refreshable: true,
        },
      },
    }),
  )
  return a.reader()
}

describe('store execute', () => {
  const Q = { name: 'shop', document: 'query AgentswsShop { shop { name } }' }
  const M = {
    name: 'update',
    document:
      'mutation AgentswsProductUpdate($product: ProductUpdateInput!) { productUpdate(product: $product) { product { id } userErrors { field message } } }',
    variables: { product: { id: 'gid://shopify/Product/1', title: 'A' } },
  }

  it('查询：文档与变量走文件、带钉的版本、不带 --allow-mutations、跑完临时文件删掉', async () => {
    const a = make()
    await authorizeAndWait(a)
    cli.respond('AgentswsShop', { shop: { name: 'Rollout' } })
    const r = await a.reader()
    expect(await r.query(Q)).toEqual({ shop: { name: 'Rollout' } })
    const call = cli.calls().at(-1)
    expect(call?.op).toBe('AgentswsShop')
    expect(call?.mutations).toBe(false)
    expect(call?.version).toBe(spec.store_admin?.api_version)
    expect(call?.ci).toBe(true)
    expect(call?.argv).toContain('--query-file')
    const work = join(
      cliSessionHome(join(dir, 'tools'), STORE_SESSION_CLI_ID, 'ws_rollout'),
      'work',
    )
    expect(readdirSync(work)).toEqual([])
  })

  it('查询那一半跑不了改动：CLI 一次都没起；执行器那一半才带 --allow-mutations', async () => {
    const a = make()
    await authorizeAndWait(a)
    const n = cli.calls().length
    await expect((await a.reader()).query(M)).rejects.toMatchObject({ code: 'mutation_refused' })
    expect(cli.calls()).toHaveLength(n)
    cli.respond('AgentswsProductUpdate', {
      productUpdate: { product: { id: 'gid://shopify/Product/1' }, userErrors: [] },
    })
    await (await a.admin()).mutate(M)
    expect(cli.calls().at(-1)?.mutations).toBe(true)
    expect(cli.calls().at(-1)?.vars).toEqual(M.variables)
  })

  it('钉的版本 Shopify 不认了：退回 CLI 默认的最新稳定版', async () => {
    const a = make()
    await authorizeAndWait(a)
    cli.set('old-version')
    cli.respond('AgentswsShop', { shop: { name: 'Rollout' } })
    expect(await (await a.reader()).query(Q)).toEqual({ shop: { name: 'Rollout' } })
    expect(cli.calls().at(-1)?.version).toBeUndefined()
  })

  it('网络失败 / GraphQL 错误：说人话；不动授权状态', async () => {
    const a = make()
    await authorizeAndWait(a)
    cli.set('net-fail')
    await expect((await a.reader()).query(Q)).rejects.toMatchObject({ code: 'network' })
    cli.clear('net-fail')
    await expect((await a.reader()).query(Q)).rejects.toMatchObject({ code: 'graphql' })
    expect((await a.view(STORE_ROLES)).state).toBe('authorized')
  })

  it('缺权限：Shopify 说要哪一项 → 那一行变「缺权限」并点名；工具面也跟着少', async () => {
    const a = make()
    await authorizeAndWait(a, THEME_ROLES)
    cli.requireScope('AgentswsShop', 'read_locations')
    await expect((await a.reader()).query(Q)).rejects.toMatchObject({
      code: 'missing_scope',
      opts: { missing: ['read_locations'] },
    })
    const v = await a.view(THEME_ROLES)
    expect(v.state).toBe('missing_scopes')
    expect(v.missing).toEqual(['read_locations'])
  })

  it('被收回：那一行回到「重新授权」，再用就说去重新授权', async () => {
    const a = make()
    await authorizeAndWait(a)
    cli.set('revoked')
    await expect((await a.reader()).query(Q)).rejects.toMatchObject({ code: 'revoked' })
    expect((await a.view(STORE_ROLES)).state).toBe('expired')
    expect(await a.access()).toBeUndefined()
    await expect(a.reader()).rejects.toMatchObject({ code: 'revoked' })
    cli.clear('revoked')
    expect((await authorizeAndWait(a)).state).toBe('authorized')
    expect(await a.access()).toMatchObject({ store: SHOP })
  })
})
