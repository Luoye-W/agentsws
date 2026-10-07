/**
 * WP258（Luoye 10-07 真机：「为什么这里还需要手动填店铺地址，不是应该自动获取吗」）：
 * 建站岗位登录 Shopify 后**自动找这个账号下的店**，不再让人手填。
 *
 * 假 `shopify` 是真脚本、真子进程（`fixtures/fake-shopify-theme.ts`），`store list` / `organization list`
 * 照 4.8.5 发行包的样子回话。钉住的事：一家自动定 / 多家给下拉（与官网对上默认选它）/ 零家照实说 /
 * 命令失败退回手填 / 会话过期回到登录 / 多组织逐个列 / 手填的永不覆盖 / 换账号重找。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { platformKitOf } from '@agentsws/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cliSessionEnv } from '../src/platform-cli-session.js'
import {
  createSiteTheme,
  NEED_TEXT,
  type SiteThemeAssembly,
  STORE_LOOKUP_TEXT,
  storeChoiceOf,
} from '../src/site-theme.js'
import { fakeThemeBase } from '../src/site-theme-stand-in.js'
import {
  type FakeOrg,
  type FakeShopifyTheme,
  writeFakeShopifyTheme,
} from './fixtures/fake-shopify-theme.js'

const T0 = '2026-10-07T09:00:00.000Z'
const WS = 'ws_rollout'
const ROLLOUT = '6suegp-md.myshopify.com'
const spec = platformKitOf('shopify')?.cli
if (spec === undefined) throw new Error('shopify 那一行没有 CLI')

let dir: string
let cli: FakeShopifyTheme
let clock: { at: string }
let machine: { loggedIn: boolean; shops: string[]; site?: string }
let events: { type: string; payload: Record<string, unknown> }[]

const settingsFile = (): string => join(dir, 'data', 'brand', 'site-theme.json')

function make(): SiteThemeAssembly {
  const base = fakeThemeBase()
  return createSiteTheme({
    workspace_id: WS,
    clock: { now: () => clock.at },
    dataDir: join(dir, 'data'),
    settingsFile: settingsFile(),
    cliSpec: () => spec,
    probe: async () => ({
      installed: true,
      node_ok: true,
      min_node_major: 22,
      checked_at: clock.at,
      source: 'app' as const,
      version: '4.8.5',
    }),
    loggedIn: () => machine.loggedIn,
    invocation: () => ({ command: process.execPath, prefix: [cli.entry] }),
    sessionEnv: () => cliSessionEnv(join(dir, 'sessions', WS)),
    connectedShops: () => machine.shops,
    siteStore: () => machine.site,
    env: {
      ...process.env,
      AGENTSWS_SECRETS_KEY: 'never-leaks',
      SHOPIFY_CLI_THEME_TOKEN: 'shpat_x',
    },
    fetch: base.fetch,
    base: base.pin,
    ledger: { stage: async () => ({ ok: false, reason: 'unused' }) as never },
    effectiveConfig: () => {
      throw new Error('没有分配')
    },
    appendEvent: (type, payload) => events.push({ type, payload }),
  })
}

const ONE: FakeOrg[] = [
  { id: '111', name: 'My Store', stores: [{ store: ROLLOUT, name: 'My Store', plan: 'basic' }] },
]
const MANY: FakeOrg[] = [
  {
    id: '111',
    name: 'Rollout Org',
    stores: [
      { store: ROLLOUT, name: 'My Store', plan: 'basic' },
      { store: 'inmo-dev.myshopify.com', name: 'INMO Dev', plan: 'Development' },
    ],
  },
]
const TWO_ORGS: FakeOrg[] = [
  { id: '111', name: 'Rollout Org', stores: [{ store: ROLLOUT, name: 'My Store', plan: 'basic' }] },
  {
    id: '222',
    name: 'Agency',
    stores: [{ store: 'client-a.myshopify.com', name: 'Client A', plan: 'Shopify' }],
  },
]

const lookupCalls = (): string[][] =>
  cli
    .calls()
    .filter((c) => c.argv[0] === 'store' || c.argv[0] === 'organization')
    .map((c) => c.argv)

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wp258-store-'))
  mkdirSync(join(dir, 'bin'))
  cli = writeFakeShopifyTheme(join(dir, 'bin'))
  clock = { at: T0 }
  machine = { loggedIn: true, shops: [] }
  events = []
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('只有一家店：自动定，岗位页那一格不再出现', () => {
  it('一条 store list --json 就够；不带店铺、不带令牌、用本品牌那一份会话', async () => {
    cli.setOrgs(ONE)
    const r = await make().readiness()
    expect(r).toMatchObject({ store: ROLLOUT, store_source: 'cli', cli: 'ready' })
    expect(r.next).toBeUndefined()
    expect(r.store_lookup).toMatchObject({
      status: 'ok',
      stores: [{ store: ROLLOUT, name: 'My Store', plan: 'basic', organization: 'My Store' }],
    })
    expect(lookupCalls()).toEqual([['store', 'list', '--json']])
    const call = cli.calls().find((c) => c.argv[0] === 'store')
    expect(call?.env).toContain('CI')
    expect(call?.env).not.toContain('SHOPIFY_FLAG_STORE')
    expect(call?.env).not.toContain('SHOPIFY_CLI_THEME_TOKEN')
    expect(call?.env).not.toContain('AGENTSWS_SECRETS_KEY')
    expect(call?.home).toBe(join(dir, 'sessions', WS))
    // 事件里只有个数，没有店名
    expect(events.find((e) => e.type === 'site_theme.store_lookup')?.payload).toEqual({
      workspace_id: WS,
      status: 'ok',
      stores: 1,
    })
    expect(JSON.stringify(events)).not.toContain('My Store')
  })

  it('找过就存下：重启（新建一份）不再跑命令，照样知道是哪家店', async () => {
    cli.setOrgs(ONE)
    await make().readiness()
    const before = lookupCalls().length
    const again = await make().readiness()
    expect(again).toMatchObject({ store: ROLLOUT, store_source: 'cli' })
    expect(lookupCalls().length).toBe(before)
    const saved = JSON.parse(readFileSync(settingsFile(), 'utf8')) as Record<string, unknown>
    expect(saved).toMatchObject({ store: ROLLOUT, store_by: 'cli', lookup: { status: 'ok' } })
  })
})

describe('好几家店：岗位页给下拉框，选了即存', () => {
  it('列出店名 + 域名 + 套餐；没选之前 next = store，工具说「选一家」', async () => {
    cli.setOrgs(MANY)
    const t = make()
    const r = await t.readiness()
    expect(r.next).toBe('store')
    expect(r.store).toBeUndefined()
    expect(r.store_lookup?.stores.map((s) => [s.store, s.name, s.plan])).toEqual([
      [ROLLOUT, 'My Store', 'basic'],
      ['inmo-dev.myshopify.com', 'INMO Dev', 'Development'],
    ])
    await expect(t.initFromBase({})).rejects.toMatchObject({ message: STORE_LOOKUP_TEXT.pick })
    const picked = await t.setStore('inmo-dev.myshopify.com', { source: 'list' })
    expect(picked).toMatchObject({ store: 'inmo-dev.myshopify.com', store_source: 'cli' })
    expect(picked.next).toBeUndefined()
    // 下拉框里换一家
    expect((await t.setStore(ROLLOUT, { source: 'list' })).store).toBe(ROLLOUT)
    // 不在清单里的不能当「选的」
    await expect(t.setStore('evil.myshopify.com', { source: 'list' })).rejects.toMatchObject({
      code: 'invalid_input',
    })
  })

  it('与品牌档案里官网读到的那家对上：默认选它', async () => {
    cli.setOrgs(MANY)
    machine.site = 'inmo-dev.myshopify.com'
    const r = await make().readiness()
    expect(r).toMatchObject({
      store: 'inmo-dev.myshopify.com',
      store_source: 'cli',
      site_store: 'inmo-dev.myshopify.com',
    })
    expect(r.next).toBeUndefined()
    // 下拉框照样有（可以换）
    expect(r.store_lookup?.stores).toHaveLength(2)
    expect(events.find((e) => e.type === 'site_theme.store_auto')?.payload).toMatchObject({
      stores: 2,
      matched_site: true,
    })
  })

  it('官网那家不在这个账号下：不瞎选，等人选', async () => {
    cli.setOrgs(MANY)
    machine.site = 'someone-else.myshopify.com'
    const r = await make().readiness()
    expect(r.store).toBeUndefined()
    expect(r.next).toBe('store')
  })

  it('好几个组织：CLI 要组织 id → 先列组织，再逐个组织列（只接纯数字 id）', async () => {
    cli.setOrgs(TWO_ORGS)
    const r = await make().readiness()
    expect(lookupCalls()).toEqual([
      ['store', 'list', '--json'],
      ['organization', 'list', '--json'],
      ['store', 'list', '--json', '--organization-id', '111'],
      ['store', 'list', '--json', '--organization-id', '222'],
    ])
    expect(r.store_lookup?.stores.map((s) => [s.store, s.organization])).toEqual([
      [ROLLOUT, 'Rollout Org'],
      ['client-a.myshopify.com', 'Agency'],
    ])
    expect(r.next).toBe('store')
  })
})

describe('零家 / 失败 / 会话过期', () => {
  it('这个账号下一家店都没有：照实说，换个账号登录或去开店', async () => {
    cli.setOrgs([])
    const t = make()
    const r = await t.readiness()
    expect(r.store_lookup).toMatchObject({ status: 'none', stores: [] })
    expect(r.next).toBe('store')
    await expect(t.initFromBase({})).rejects.toMatchObject({ message: STORE_LOOKUP_TEXT.none })
  })

  it('命令失败（网络）：退回手填；不每次都重跑，5 分钟后或 fresh 才再试', async () => {
    cli.setOrgs(ONE)
    cli.setStoresFail(true)
    const t = make()
    const r = await t.readiness()
    expect(r.store_lookup).toMatchObject({ status: 'failed', message: STORE_LOOKUP_TEXT.failed })
    expect(JSON.stringify(r)).not.toContain('ENOTFOUND')
    expect(r.next).toBe('store')
    await t.readiness()
    expect(lookupCalls()).toHaveLength(1)
    // 网好了：fresh 现找一次
    cli.setStoresFail(false)
    expect((await t.readiness({ fresh: true })).store).toBe(ROLLOUT)
    expect(lookupCalls()).toHaveLength(2)
  })

  it('失败过 5 分钟再打开岗位页：自己再试一次', async () => {
    cli.setOrgs(ONE)
    cli.setStoresFail(true)
    const t = make()
    await t.readiness()
    cli.setStoresFail(false)
    clock.at = '2026-10-07T09:06:00.000Z'
    expect((await t.readiness()).store).toBe(ROLLOUT)
  })

  it('CLI 不认识这条命令（老版本）：当没找成，手填照旧', async () => {
    cli.setOrgs(undefined)
    const r = await make().readiness()
    expect(r.store_lookup?.status).toBe('failed')
    expect(r.next).toBe('store')
  })

  it('CLI 说会话过期：那一行回到「登录 Shopify」', async () => {
    cli.setOrgs(ONE)
    cli.setLoggedOut(true)
    const t = make()
    const r = await t.readiness()
    expect(r.store_lookup).toMatchObject({ status: 'failed', message: NEED_TEXT.login })
    expect(r.next).toBe('login')
    await expect(t.list()).rejects.toMatchObject({ need: 'login' })
  })

  it('没登录 / 连了店：一条找店命令都不跑', async () => {
    cli.setOrgs(ONE)
    machine.loggedIn = false
    await make().readiness()
    machine.loggedIn = true
    machine.shops = ['connected.myshopify.com']
    const r = await make().readiness()
    expect(r).toMatchObject({ store: 'connected.myshopify.com', store_source: 'connection' })
    expect(r.store_lookup).toBeUndefined()
    expect(lookupCalls()).toEqual([])
  })
})

describe('手填的不被自动覆盖', () => {
  it('手填过：不去找；登录（换账号）之后也不动', async () => {
    cli.setOrgs(ONE)
    const t = make()
    machine.loggedIn = false
    await t.setStore('typed-by-hand.myshopify.com')
    machine.loggedIn = true
    const r = await t.readiness({ fresh: true })
    expect(r).toMatchObject({ store: 'typed-by-hand.myshopify.com', store_source: 'manual' })
    expect(r.store_lookup).toBeUndefined()
    expect(await t.refreshStores({ relogin: true })).toBeUndefined()
    expect(lookupCalls()).toEqual([])
  })

  it('WP253 时手填存下的老地址（没有 store_by）：当手填', async () => {
    mkdirSync(join(dir, 'data', 'brand'), { recursive: true })
    writeFileSync(
      settingsFile(),
      JSON.stringify({ version: 1, store: 'old.myshopify.com', stores: {} }),
    )
    cli.setOrgs(ONE)
    const r = await make().readiness()
    expect(r).toMatchObject({ store: 'old.myshopify.com', store_source: 'manual' })
    expect(lookupCalls()).toEqual([])
  })

  it('「都不是？手动填」：从下拉框那一步改成手填，之后照手填对待', async () => {
    cli.setOrgs(MANY)
    const t = make()
    await t.readiness()
    const r = await t.setStore('https://admin.shopify.com/store/third-one/themes')
    expect(r).toMatchObject({ store: 'third-one.myshopify.com', store_source: 'manual' })
    expect(r.store_lookup).toBeUndefined()
  })
})

describe('重新登录（可能换了账号）', () => {
  it('自动取的那家不在新账号下：清掉重定；新账号只有一家就它', async () => {
    cli.setOrgs(ONE)
    const t = make()
    expect((await t.readiness()).store).toBe(ROLLOUT)
    cli.setOrgs([
      {
        id: '333',
        name: 'INMO',
        stores: [{ store: 'inmo.myshopify.com', name: 'INMO', plan: 'Shopify' }],
      },
    ])
    await t.refreshStores({ relogin: true })
    expect((await t.readiness()).store).toBe('inmo.myshopify.com')
  })

  it('人选的那家还在新账号下：不动', async () => {
    cli.setOrgs(MANY)
    const t = make()
    await t.readiness()
    await t.setStore('inmo-dev.myshopify.com', { source: 'list' })
    await t.refreshStores({ relogin: true })
    expect((await t.readiness()).store).toBe('inmo-dev.myshopify.com')
  })

  it('重登后找店没跑成：原来那家留着', async () => {
    cli.setOrgs(ONE)
    const t = make()
    await t.readiness()
    cli.setStoresFail(true)
    await t.refreshStores({ relogin: true })
    expect((await t.readiness()).store).toBe(ROLLOUT)
  })
})

describe('storeChoiceOf：CLI 的一行 → 下拉框的一行', () => {
  it('只认 myshopify 域名，名字截断，组织名补上', () => {
    expect(storeChoiceOf({ store: 'A.myshopify.com', name: 'A', plan: 'basic' }, 'Org')).toEqual({
      store: 'a.myshopify.com',
      name: 'A',
      plan: 'basic',
      organization: 'Org',
    })
    expect(storeChoiceOf({ store: 'https://brand.example' })).toBeUndefined()
    expect(storeChoiceOf({ name: 'no store' })).toBeUndefined()
    expect(storeChoiceOf(null)).toBeUndefined()
    expect(storeChoiceOf({ store: 'b.myshopify.com', name: 'x'.repeat(300) })?.name).toHaveLength(
      120,
    )
  })
})
